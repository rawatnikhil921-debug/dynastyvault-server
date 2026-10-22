/* =========================================================
   DYNASTYVAULT — UNLOCK CODES + CLOUD VOICE CLONE (paid customers)
   • Nabu approves a paid order from the admin page → this server makes the unlock code
     (secret stays here, never in the website, so nobody can make fake codes)
   • The customer enters the code → the website asks this server whether it is valid
   • Paying customers' stories are read in the cloned voice by DeepInfra (Chatterbox Multilingual),
     about $1 per 1,000,000 characters ≈ ₹0.09 per 1,000-character story, paid from YOUR DeepInfra balance.
     Every order has a character budget so costs stay tiny and predictable.
   ========================================================= */
const crypto = require('crypto');
const fs = require('fs');

const BUDGET = {            // characters of cloned-voice speech included (≈1,000 characters per story)
  royal: 100000,            // Royal Dynasty Lifetime → ~100 stories
  gift: 100000,             // Heritage Gift Box (includes Royal)
  voicepack: 25000,         // Voice Story Pack → ~20–25 stories
  export: 0, portrait4k: 0
};
const ITEMS = Object.keys(BUDGET);
const LANGS = ['ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh'];
const DI = 'https://api.deepinfra.com';

function makeVoice(opts) {
  const { secret, adminKey, deepinfraKey, model = 'ResembleAI/chatterbox-multilingual', storePath, fetchImpl } = opts;
  const F = fetchImpl || ((...a) => fetch(...a));
  let db = {};
  try { db = JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch (e) { db = {}; }
  const save = () => { try { fs.writeFileSync(storePath + '.tmp', JSON.stringify(db)); fs.renameSync(storePath + '.tmp', storePath); } catch (e) { console.error('[voice] could not save orders:', e.message); } };
  const norm = id => String(id || '').trim().toUpperCase().slice(0, 40);
  const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  function codeFor(orderId, item) {
    const h = crypto.createHmac('sha256', secret).update(`${norm(orderId)}|${item}`).digest();
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let out = '';
    for (let i = 0; i < 8; i++) out += A[h[i] & 31];
    return out.slice(0, 4) + '-' + out.slice(4);
  }
  // codes are checked from the secret itself, so they keep working even if the server forgets its files
  // (Render's free plan wipes files on restart — then only the story count starts again from the full budget)
  function check(orderId, code) {
    const id = norm(orderId); const c = normCode(code); if (!id || c.length !== 8) return null;
    const o = db[id];
    if (o) return c === normCode(o.code) ? o : null;
    const item = ITEMS.find(it => normCode(codeFor(id, it)) === c); if (!item) return null;
    db[id] = { item, code: codeFor(id, item), chars: BUDGET[item], used: 0, voices: {}, createdAt: Date.now(), restored: true }; save();
    return db[id];
  }
  const left = o => Math.max(0, (o.chars || 0) - (o.used || 0));

  // ---- Nabu: approve a paid order (or add more characters to an existing one) ----
  function approve(b) {
    if (!adminKey || String(b.key || '') !== String(adminKey)) return { status: 401, json: { error: 'Wrong admin key.' } };
    const id = norm(b.orderId); const item = String(b.item || '');
    if (!/^[A-Z0-9-]{4,40}$/.test(id)) return { status: 400, json: { error: 'Type the order ID, e.g. DV-AB12CDE.' } };
    if (!ITEMS.includes(item)) return { status: 400, json: { error: 'Unknown item.' } };
    const o = db[id] || { item, code: codeFor(id, item), chars: 0, used: 0, voices: {}, createdAt: Date.now() };
    if (!db[id]) o.chars = BUDGET[item];
    if (b.addChars) o.chars += Math.max(0, Math.min(1e6, Number(b.addChars) || 0));
    if (db[id] && o.item !== item) { o.item = item; o.code = codeFor(id, item); o.chars = Math.max(o.chars, BUDGET[item]); }
    db[id] = o; save();
    return { status: 200, json: { ok: true, orderId: id, item: o.item, code: o.code, left: left(o) } };
  }
  // ---- customer: is this code valid? ----
  function unlock(b) {
    const o = check(b.orderId, b.code);
    if (!o) return { status: 404, json: { error: 'That code does not match this order.' } };
    o.unlockedAt = o.unlockedAt || Date.now(); save();
    return { status: 200, json: { ok: true, item: o.item, left: left(o) } };
  }
  function balance(q) {
    const o = check(q.orderId, q.code);
    return o ? { status: 200, json: { ok: true, item: o.item, left: left(o) } } : { status: 404, json: { error: 'Order not found.' } };
  }

  async function addVoice(buf, name) {
    const fd = new FormData();
    fd.append('audio', new Blob([buf], { type: 'audio/wav' }), 'reference.wav');
    fd.append('name', name); fd.append('description', 'DynastyVault family voice');
    const r = await F(`${DI}/v1/voices/add`, { method: 'POST', headers: { Authorization: `Bearer ${deepinfraKey}` }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.voice_id) throw Object.assign(new Error((j.detail && JSON.stringify(j.detail)) || j.error || `voice upload failed (HTTP ${r.status})`), { status: r.status });
    return j.voice_id;
  }
  async function speak(voiceId, text, lang) {
    // ElevenLabs-style endpoint documented by DeepInfra; falls back to the model's inference endpoint
    let r = await F(`${DI}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3`, {
      method: 'POST', headers: { Authorization: `Bearer ${deepinfraKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: model, output_format: 'mp3', language_code: lang })
    });
    if (!r.ok && ![401, 402, 403, 429].includes(r.status)) {
      r = await F(`${DI}/v1/inference/${model}`, { method: 'POST', headers: { Authorization: `Bearer ${deepinfraKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice_id: voiceId, language: lang, response_format: 'mp3' }) });
    }
    const type = String(r.headers.get('content-type') || '');
    if (!r.ok) { const t = await r.text().catch(() => ''); throw Object.assign(new Error(`speech failed (HTTP ${r.status}) ${t.slice(0, 200)}`), { status: r.status }); }
    if (/json/.test(type)) {
      const j = await r.json(); const a = j.audio || (j.results && j.results[0] && j.results[0].audio) || '';
      const b64 = String(a).replace(/^data:[^,]+,/, ''); if (!b64) throw new Error('speech failed (no audio in reply)');
      return { buf: Buffer.from(b64, 'base64'), type: (String(a).match(/^data:([^;]+)/) || [, 'audio/mpeg'])[1] };
    }
    return { buf: Buffer.from(await r.arrayBuffer()), type: type.startsWith('audio/') ? type : 'audio/mpeg' };
  }
  // ---- customer: read this part of the story in the cloned voice ----
  async function clone(b) {
    if (!deepinfraKey) return { status: 503, json: { error: 'Cloud voice is not set up on the server yet (DEEPINFRA_KEY).' } };
    const o = check(b.orderId, b.code);
    if (!o) return { status: 401, json: { error: 'This device is not unlocked for cloud voice. Enter your unlock code in Plans.', code: 'NOT_UNLOCKED' } };
    const text = String(b.text || '').trim().slice(0, 600);
    if (!text) return { status: 400, json: { error: 'No text to speak.' } };
    const lang = String(b.language || 'en').toLowerCase().slice(0, 5);
    if (!LANGS.includes(lang)) return { status: 400, json: { error: `Language '${lang}' is not supported by the voice model.` } };
    if (left(o) < text.length) return { status: 402, json: { error: 'Your cloned-voice stories are used up. Buy a Voice Story Pack to add more.', code: 'NO_STORIES', left: left(o) } };
    const m = /^data:audio\/[\w.+-]+;base64,(.+)$/s.exec(String(b.reference || ''));
    if (!m) return { status: 400, json: { error: 'Record or upload a voice sample first.' } };
    const ref = Buffer.from(m[1], 'base64');
    if (ref.length < 8000 || ref.length > 4e6) return { status: 400, json: { error: 'The voice sample should be 5–20 seconds long.' } };
    const refHash = crypto.createHash('sha1').update(ref).digest('hex').slice(0, 16);
    o.voices = o.voices || {};
    try {
      let vid = o.voices[refHash];
      if (!vid) { vid = await addVoice(ref, `dv-${norm(b.orderId)}-${refHash.slice(0, 6)}`); o.voices[refHash] = vid; save(); }
      let out;
      try { out = await speak(vid, text, lang); }
      catch (e) { if (e.status === 404) { vid = await addVoice(ref, `dv-${norm(b.orderId)}-${refHash.slice(0, 6)}`); o.voices[refHash] = vid; save(); out = await speak(vid, text, lang); } else throw e; }
      o.used = (o.used || 0) + text.length; save();
      return { status: 200, buf: out.buf, type: out.type, left: left(o) };
    } catch (e) {
      console.error('[voice] clone failed:', e.message);
      const busy = e.status === 429 || e.status >= 500;
      return { status: busy ? 503 : 502, json: { error: busy ? 'The voice service is busy — try again in a minute.' : (e.status === 402 ? 'The voice service balance is empty — please message DynastyVault.' : 'The cloned voice could not be made this time. Try again.') } };
    }
  }
  return { approve, unlock, balance, clone, codeFor, check, save, _db: () => db };
}
module.exports = { makeVoice, BUDGET };
