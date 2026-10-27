/* =========================================================
   DYNASTYVAULT — AI REUNION PHOTO CREDITS SERVER
   One small server that:
     1. Sells "AI reunion photo" credits to customers via Razorpay
     2. Holds YOUR Gemini API key secretly (never sent to the browser)
     3. Spends one credit each time a customer generates a photo
   Nabu — you do not need to understand every line. Follow SERVER-SETUP.txt
   to put this online, then paste the server's URL into index.html (DV_SERVER).
   ========================================================= */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
let Razorpay = null; try { Razorpay = require('razorpay'); } catch (e) { /* optional */ }
const { makeLedger, verifyRazorpaySignature } = require('./ledger');

const PORT = process.env.PORT || 8787;
const GEMINI_KEY = process.env.GEMINI_KEY || '';
// Photo models are paid-only on Google. Keep photos switched off until billing is on for the key's project:
// Render → Environment →  GEMINI_BILLING = on   (stories work on the free key without this)
const PHOTO_ON = !!GEMINI_KEY && /^(on|yes|true|1)$/i.test(String(process.env.GEMINI_BILLING || '').trim());
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';   // e.g. https://kapoor-family.dynastyvault.app — lock this down once you have a real domain

if (!GEMINI_KEY) console.warn('[WARN] GEMINI_KEY is not set — AI stories and photos are off until you add it.');
else if (!PHOTO_ON) console.warn('[INFO] GEMINI_KEY set — AI stories ON. Photos stay OFF until you add GEMINI_BILLING=on (after turning on Google billing).');
if (!RZP_KEY_ID || !RZP_KEY_SECRET) console.warn('[WARN] Razorpay keys are not set — buying credits will fail until you add them.');

const rzp = RZP_KEY_ID && Razorpay ? new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET }) : null;

// --- pricing: how many credits a pack gives, and its price in the smallest currency unit (paise) ---
const PACKS = {
  pack5:  { credits: 5,  inr: 14900,  usd: 299 },   // ₹149 / $2.99 — 5 photos
  pack20: { credits: 20, inr: 44900,  usd: 899 },   // ₹449 / $8.99 — 20 photos, better per-photo price
};

// --- tiny JSON-file ledger: { [deviceId]: { credits, history: [...] } } ---
// Fine for a first launch. If you grow past a few hundred families, move this to a real database
// (e.g. Postgres on Render/Supabase) — ask Claude to help when you get there.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'credits.json');
const { getBalance, addCredits, spendCredit } = makeLedger(DB_PATH);

// --- family profiles, visitor numbers and documentary jobs live here (Supabase = kept forever; file = wiped on Render restarts) ---
const { makeStore } = require('./store');
const store = makeStore({ supabaseUrl: process.env.SUPABASE_URL, supabaseKey: process.env.SUPABASE_SERVICE_KEY, filePath: process.env.DATA_PATH || path.join(path.dirname(DB_PATH), 'data.json') });
if (store.kind !== 'supabase') console.warn('[WARN] SUPABASE_URL / SUPABASE_SERVICE_KEY are not set — family profiles and visitor numbers are saved in a temporary file that Render wipes on restart.');

const app = express();
app.use('/api/t', express.text({ type: '*/*', limit: '4kb' }));   // visitor beacons arrive as plain text
app.use(express.json({ limit: '25mb' }));   // family photos are base64-encoded in the request body
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Gemini request helper: retries rate limits (429) and busy servers (500/503) ----------
// Works with free Google AI Studio keys too: waits the time Google asks for, backs off, and tells the
// caller when a model is simply not on the free tier ("limit: 0") or today's quota is used up.
const GEM_BASE = (process.env.GEM_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');   // only changed for testing
const GEM_HOST = GEM_BASE + '/v1beta/models/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function gemKind(status, j) {
  const e = (j && j.error) || {}; const all = (e.message || '') + ' ' + JSON.stringify(e.details || []);
  if (status === 429) {
    if (/limit:\s*0\b|"quotaValue":\s*"0"/i.test(all)) return 'not-free';
    if (/PerDay|per[ _-]?day|daily/i.test(all)) return 'daily';
    return 'rate';
  }
  if ([500, 502, 503, 504].includes(status)) return 'busy';
  if (status === 404) return 'missing';
  return 'fail';
}
function gemRetryDelay(j) {
  const e = (j && j.error) || {};
  const d = (e.details || []).find(x => /RetryInfo/.test((x || {})['@type'] || ''));
  const s = d ? parseFloat(String(d.retryDelay || '')) : 0; if (s > 0) return s * 1000;
  const m = /retry in ([\d.]+)\s*s/i.exec(e.message || ''); return m ? parseFloat(m[1]) * 1000 : 0;
}
async function gemRequest(model, body, tries = 4) {
  let r = null, j = {}, kind = 'fail';
  for (let a = 0; a < tries; a++) {
    try {
      r = await fetch(GEM_HOST + model + ':generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body: JSON.stringify(body) });
    } catch (e) { if (a === tries - 1) return { ok: false, status: 0, j: { error: { message: e.message } }, kind: 'busy' }; await sleep(2000 * 2 ** a); continue; }
    j = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, status: r.status, j, kind: 'ok' };
    kind = gemKind(r.status, j);
    if ((kind !== 'rate' && kind !== 'busy') || a === tries - 1) break;
    const ms = (gemRetryDelay(j) || (kind === 'rate' ? 8000 : 2000) * 2 ** a) + Math.random() * 700;
    if (ms > 65000) { kind = 'daily'; break; }
    console.log(`[gemini] ${model} ${r.status} (${kind}) — retrying in ${Math.round(ms / 1000)}s`);
    await sleep(ms);
  }
  return { ok: false, status: r ? r.status : 0, j, kind };
}
const gemErr = res => res.kind === 'not-free' ? 'this model is not on the free tier of the server key (switch billing on in Google AI Studio)'
  : res.kind === 'daily' ? "today's Google quota is used up" : res.kind === 'rate' ? 'Google rate limit — try again in a minute'
  : res.kind === 'busy' ? 'Google servers are busy — try again in a minute' : ((res.j.error && res.j.error.message) || ('HTTP ' + res.status));

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'dynastyvault-server', gemini: !!GEMINI_KEY, portrait: PHOTO_ON, film: PHOTO_ON, profiles: true, storage: store.kind, razorpay: !!rzp, voice: !!process.env.DEEPINFRA_KEY, unlock: !!(process.env.UNLOCK_SECRET && process.env.ADMIN_KEY) }));

app.get('/api/credits/balance', (req, res) => {
  const deviceId = String(req.query.deviceId || '');
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  res.json({ credits: getBalance(deviceId) });
});

// Step 1 of buying credits: the browser asks us to open an order; we never see their card details — Razorpay handles that.
app.post('/api/credits/order', async (req, res) => {
  if (!rzp) return res.status(500).json({ error: 'Razorpay is not configured on this server yet.' });
  const { pack, currency } = req.body || {};
  const p = PACKS[pack];
  if (!p) return res.status(400).json({ error: 'Unknown pack' });
  const cur = currency === 'USD' ? 'USD' : 'INR';
  try {
    const order = await rzp.orders.create({
      amount: cur === 'USD' ? p.usd : p.inr, currency: cur,
      receipt: 'dv_' + pack + '_' + Date.now(),
      notes: { pack, credits: String(p.credits) }
    });
    res.json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId: RZP_KEY_ID, credits: p.credits });
  } catch (e) { res.status(500).json({ error: (e && e.error && e.error.description) || 'Could not create the order.' }); }
});

// Step 2: after the customer pays, Razorpay's checkout hands the browser a signature. We verify it
// ourselves (never trust the browser) before crediting the account — this is what stops someone from
// faking a "successful payment" by editing the page.
app.post('/api/credits/verify', (req, res) => {
  if (!RZP_KEY_SECRET) return res.status(500).json({ error: 'Razorpay is not configured on this server yet.' });
  const { deviceId, pack, orderId, paymentId, signature } = req.body || {};
  const p = PACKS[pack];
  if (!deviceId || !p || !orderId || !paymentId || !signature) return res.status(400).json({ error: 'Missing fields' });
  if (!verifyRazorpaySignature(RZP_KEY_SECRET, orderId, paymentId, signature)) return res.status(400).json({ error: 'Payment could not be verified.' });
  const credits = addCredits(deviceId, p.credits, 'bought ' + pack);
  res.json({ ok: true, credits });
});

// Step 3: spend one credit and ask Gemini to make the photo. The family's own Gemini key is never
// involved here — only YOUR server-side key is used, and only after a credit is confirmed spent.
app.post('/api/reunion/generate', async (req, res) => {
  const { deviceId, prompt, images, aspectRatio, imageSize } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  if (!PHOTO_ON) return res.status(503).json({ error: 'AI photos are being set up.', code: 'NOT_READY' });
  if (!Array.isArray(images) || !images.length) return res.status(400).json({ error: 'No photos were sent.' });
  const left = spendCredit(deviceId);
  if (left == null) return res.status(402).json({ error: 'No credits left.', code: 'NO_CREDITS' });
  try {
    const parts = [{ text: String(prompt || '') }].concat(images.map(d => ({ inline_data: { mime_type: d.mime, data: d.b64 } })));
    // NOTE: image models are paid-only — the server's Gemini key MUST have billing switched on.
    const models = ['gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'];   // 2.1 = newest and cheapest (~$0.034 per 1K photo)
    let lastErr = null;
    for (const model of models) {
      const body = { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspectRatio || '4:5', imageSize: imageSize || '1K' } } };
      let g = await gemRequest(model, body, 3);
      if (!g.ok && g.status === 400) { delete body.generationConfig; g = await gemRequest(model, body, 3); }   // some models reject the image-config fields — retry plainer
      if (g.ok) {
        const cand = (g.j.candidates || [])[0] || {};
        const img = ((cand.content || {}).parts || []).map(p => p.inlineData || p.inline_data).find(x => x && x.data);
        if (img) return res.json({ ok: true, mime: img.mimeType || img.mime_type || 'image/png', b64: img.data, credits: left, model });
        lastErr = cand.finishReason || 'no image returned';
        break;
      }
      lastErr = gemErr(g);
      if (g.kind === 'not-free') break;   // free key: no image model will work, stop early
    }
    // Generation failed after trying every model — refund the credit, it's only fair.
    addCredits(deviceId, 1, 'refund: generation failed');
    res.status(502).json({ error: 'Gemini could not make a photo this time: ' + lastErr + '. Your credit was refunded.' });
  } catch (e) {
    addCredits(deviceId, 1, 'refund: server error');
    res.status(500).json({ error: 'Server error: ' + (e.message || e) + '. Your credit was refunded.' });
  }
});

// current free-tier text models (Oct 2026) — each has its own quota, so we fall through them
const TEXT_MODELS = ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite',   // 4 Argon = best quality (paid key); free keys fall through to 3.8 Flash
                     'gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash'];
async function writeText(prompt) {
  let last = '';
  for (const model of TEXT_MODELS) {
    const gc = { temperature: 0.7, maxOutputTokens: 4096 };
    if (/^gemini-3/.test(model)) gc.thinkingConfig = { thinkingLevel: 'low' };
    const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: gc };
    let g = await gemRequest(model, body);
    if (!g.ok && g.status === 400 && /thinking/i.test((g.j.error && g.j.error.message) || '')) { delete gc.thinkingConfig; g = await gemRequest(model, body); }
    if (g.ok) {
      const text = ((((g.j.candidates || [])[0] || {}).content || {}).parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
      if (text) return { text, model };
      last = 'empty answer'; continue;
    }
    if (!last || g.kind !== 'missing') last = gemErr(g);
    if (!['missing', 'not-free', 'daily', 'rate', 'busy'].includes(g.kind)) break;
  }
  return { text: '', error: last };
}

// ✨ AI writes a family member's life story from the family's notes. Text is very cheap, so this is
// free for customers — with a simple per-device daily cap so nobody can run up your Google bill.
const STORY_DAILY_CAP = Number(process.env.STORY_DAILY_CAP || 30);
const storyUse = new Map();   // deviceId|YYYY-MM-DD -> count (resets when the server restarts — fine for a cap)
app.post('/api/story/write', async (req, res) => {
  const { deviceId, prompt } = req.body || {};
  if (!deviceId || !prompt) return res.status(400).json({ error: 'deviceId and prompt required' });
  if (!GEMINI_KEY) return res.status(500).json({ error: 'The server is not set up with a Gemini key yet.' });
  const k = deviceId + '|' + new Date().toISOString().slice(0, 10); const n = (storyUse.get(k) || 0) + 1;
  if (n > STORY_DAILY_CAP) return res.status(429).json({ error: 'Daily story limit reached — try again tomorrow.' });
  storyUse.set(k, n);
  const out = await writeText(String(prompt).slice(0, 6000));
  if (out.text) return res.json({ text: out.text, model: out.model });
  const last = out.error;
  storyUse.set(k, n - 1);   // a failed attempt does not count against the cap
  res.status(502).json({ error: 'Could not write the story: ' + last });
});

// ---------- 🔑 unlock codes + 🧬 cloud voice clone for paying customers (see voice.js) ----------
const { makeVoice } = require('./voice');
const UNLOCK_SECRET = process.env.UNLOCK_SECRET || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
if (!UNLOCK_SECRET || !ADMIN_KEY) console.warn('[WARN] UNLOCK_SECRET / ADMIN_KEY are not set — unlock codes will not work until you add them.');
if (!process.env.DEEPINFRA_KEY) console.warn('[WARN] DEEPINFRA_KEY is not set — cloud voice clone will not work until you add it.');
const voice = makeVoice({ secret:UNLOCK_SECRET || crypto.randomBytes(16).toString('hex'), adminKey:ADMIN_KEY, deepinfraKey:process.env.DEEPINFRA_KEY || '',
  model:process.env.VOICE_MODEL || 'ResembleAI/chatterbox-multilingual', storePath:process.env.ORDERS_PATH || path.join(path.dirname(DB_PATH), 'orders.json') });
const sendR = (res, r) => r.buf ? res.status(r.status).set({ 'Content-Type':r.type, 'X-Stories-Left':String(r.left), 'Access-Control-Expose-Headers':'X-Stories-Left' }).send(r.buf) : res.status(r.status).json(r.json);
app.post('/api/admin/approve', (req, res) => { const b = req.body || {}; const isNew = !voice._db()[String(b.orderId || '').trim().toUpperCase().slice(0, 40)]; const r = voice.approve(b); if (r.status === 200 && isNew && !b.addChars) social.track({ e: 'royal' }); sendR(res, r); });
app.post('/api/unlock', (req, res) => sendR(res, voice.unlock(req.body || {})));
app.get('/api/voice/balance', (req, res) => sendR(res, voice.balance(req.query || {})));
app.post('/api/voice/clone', async (req, res) => sendR(res, await voice.clone(req.body || {})));
// ✨ Reunion portrait for Royal customers: one tap in the app → this server makes the photo with YOUR image key.
// Each Royal / Gift order includes PORTRAITS_PER_ORDER portraits (≈ ₹3 each), so costs stay small and fixed.
const PORTRAITS_PER_ORDER = Number(process.env.PORTRAITS_PER_ORDER || 10);
app.post('/api/portrait', async (req, res) => {
  const b = req.body || {};
  const o = voice.check(b.orderId, b.code);
  if (!o || !['royal', 'gift'].includes(o.item)) return res.status(401).json({ error: 'Reunion portraits come with Royal. Enter your Royal unlock code in Plans.', code: 'NOT_UNLOCKED' });
  if (!PHOTO_ON) return res.status(503).json({ error: 'Portraits are being set up.', code: 'NOT_READY' });
  const used = o.portraits || 0; const left = Math.max(0, PORTRAITS_PER_ORDER - used);
  if (!left) return res.status(402).json({ error: 'All portraits in this plan are used.', code: 'NO_PORTRAITS', left: 0 });
  const images = Array.isArray(b.images) ? b.images.slice(0, 14) : [];
  if (!images.length) return res.status(400).json({ error: 'No photos were sent.' });
  try {
    const parts = [{ text: String(b.prompt || '').slice(0, 4000) }].concat(images.map(d => ({ inline_data: { mime_type: String(d.mime || 'image/jpeg'), data: String(d.b64 || '') } })));
    const models = ['gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'];
    let lastErr = null;
    for (const model of models) {
      const body = { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: b.aspectRatio === '16:9' ? '16:9' : '4:5', imageSize: '1K' } } };
      let g = await gemRequest(model, body, 3);
      if (!g.ok && g.status === 400) { delete body.generationConfig; g = await gemRequest(model, body, 3); }
      if (g.ok) {
        const cand = (g.j.candidates || [])[0] || {};
        const img = ((cand.content || {}).parts || []).map(p => p.inlineData || p.inline_data).find(x => x && x.data);
        if (img) { o.portraits = used + 1; voice.save(); return res.json({ ok: true, mime: img.mimeType || img.mime_type || 'image/png', b64: img.data, left: left - 1 }); }
        lastErr = cand.finishReason || 'no image'; break;
      }
      lastErr = gemErr(g);
      if (g.kind === 'not-free') break;
    }
    res.status(502).json({ error: 'The portrait could not be made this time. Please try again. (' + lastErr + ')', left });
  } catch (e) { res.status(500).json({ error: 'Server error — please try again.', left }); }
});

// ---------- 👨‍👩‍👧 family profiles (public / private) + 📊 visitor numbers (see social.js) ----------
const { makeSocial } = require('./social');
const social = makeSocial({ store, adminKey: ADMIN_KEY });
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const wrap = fn => async (req, res) => { try { sendR(res, await fn(req)); } catch (e) { console.error('[api]', req.path, e.message); res.status(500).json({ error: 'Server error — please try again.' }); } };
app.get('/api/dyn/check', wrap(req => social.check(req.query)));
app.post('/api/dyn/save', wrap(req => social.save(req.body || {}, ipOf(req))));
app.post('/api/dyn/remove', wrap(req => social.remove(req.body || {})));
app.get('/api/dyn/mine', wrap(req => social.mine(req.query)));
app.post('/api/dyn/answer', wrap(req => social.answer(req.body || {})));
app.get('/api/dyn/get', wrap(req => social.get(req.query)));
app.post('/api/dyn/follow', wrap(req => social.follow(req.body || {}, ipOf(req))));
app.get('/api/dyn/list', wrap(req => social.list(req.query)));
app.post('/api/dyn/report', wrap(req => social.report(req.body || {}, ipOf(req))));
app.post('/api/admin/dyn/hide', wrap(req => social.hide(req.body || {})));
app.post('/api/t', (req, res) => { try { social.track(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})); } catch (e) { /* ignore bad beacons */ } res.status(204).end(); });
app.get('/api/admin/stats', wrap(req => social.stats(req.query, { keys: { gemini: !!GEMINI_KEY, billing: PHOTO_ON, voice: !!process.env.DEEPINFRA_KEY, unlock: !!(UNLOCK_SECRET && ADMIN_KEY) } })));

// ---------- 🎬 AI family documentary for Royal (see film.js) ----------
const { makeFilm } = require('./film');
const film = makeFilm({ store, voice, gemKey: GEMINI_KEY, base: GEM_BASE, photoOn: () => PHOTO_ON, writeText: async p => { const o = await writeText(p); if (!o.text) throw new Error(o.error); return o.text; },
  filmsPerOrder: Number(process.env.FILMS_PER_ORDER || 1), scenes: Math.max(1, Math.min(5, Number(process.env.FILM_SCENES || 3))),
  model: process.env.FILM_MODEL || 'gemini-omni-1.1-flash', dailyCap: Number(process.env.FILM_DAILY_CAP || 20) });
app.get('/api/film/balance', wrap(req => film.balance(req.query)));
app.post('/api/film/start', wrap(async req => { const r = await film.start(req.body || {}); if (r.status === 200) social.track({ e: 'film' }); return r; }));
app.get('/api/film/status', wrap(req => film.status(req.query)));
app.get('/api/film/clip', async (req, res) => { try { const r = await film.clip(req.query); if (r.buf) return res.status(200).set({ 'Content-Type': r.type, 'Cache-Control': 'private, max-age=3600' }).send(r.buf); res.status(r.status).json(r.json); } catch (e) { res.status(500).json({ error: 'Server error.' }); } });
app.post('/api/admin/films', wrap(req => film.addFilms(req.body || {}, ADMIN_KEY)));
process.on('SIGTERM', async () => { try { await social.flush(); if (store.flush) store.flush(); } catch (e) { /* ignore */ } process.exit(0); });

app.listen(PORT, () => console.log(`[DynastyVault server] listening on :${PORT}`));
