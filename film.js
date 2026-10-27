/* =========================================================
   DYNASTYVAULT — 🎬 AI FAMILY DOCUMENTARY (Royal)
   One photo + the life story → Gemini writes 3 short scenes → Google's video model
   (Gemini Omni Flash, image-to-video) animates the photo for each scene.
   • Paid on Google: about $0.10 per second of 720p video (≈ ₹70 for an 8-second scene).
     That is why films are counted per order (FILMS_PER_ORDER) and there is a daily safety cap.
   • Needs GEMINI_KEY + GEMINI_BILLING=on, exactly like reunion portraits.
   ========================================================= */
const crypto = require('crypto');

const S = (x, n) => String(x == null ? '' : x).slice(0, n);

function findVideo(x, depth = 0) {   // the video sits somewhere inside steps[].content[] — search for it
  if (!x || depth > 8) return null;
  if (Array.isArray(x)) { for (const y of x) { const f = findVideo(y, depth + 1); if (f) return f; } return null; }
  if (typeof x === 'object') {
    if ((x.type === 'video' || /^video\//.test(x.mime_type || x.mimeType || '')) && typeof x.data === 'string' && x.data.length > 100) return { data: x.data, mime: x.mime_type || x.mimeType || 'video/mp4' };
    for (const k of Object.keys(x)) { if (k === 'data') continue; const f = findVideo(x[k], depth + 1); if (f) return f; }
  }
  return null;
}

function makeFilm(o) {
  const { store, voice, gemKey, base = 'https://generativelanguage.googleapis.com', writeText, photoOn,
    filmsPerOrder = 1, scenes = 3, model = 'gemini-omni-1.1-flash', dailyCap = 20, fetchImpl } = o;
  const F = fetchImpl || ((...a) => fetch(...a));
  const API = base.replace(/\/+$/, '') + '/v1beta/interactions';
  const hdr = { 'Content-Type': 'application/json', 'x-goog-api-key': gemKey };
  const cache = new Map();            // job:i → Buffer (recent clips, so repeated downloads don't hit Google)
  const lastPoll = new Map();
  const norm = id => String(id || '').trim().toUpperCase().slice(0, 40);
  const today = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

  function owner(b) {
    const ord = voice.check(b.orderId, b.code);
    if (!ord || !['royal', 'gift'].includes(ord.item)) return null;
    return norm(b.orderId);
  }
  async function usage(oid) { return (await store.get('fu:' + oid)) || { used: 0, extra: 0 }; }
  const allowance = u => Math.max(0, filmsPerOrder + (u.extra || 0) - (u.used || 0));

  async function balance(q) {
    const oid = owner(q); if (!oid) return { status: 401, json: { error: 'Documentaries come with Royal. Enter your Royal unlock code in Plans.', code: 'NOT_UNLOCKED' } };
    const u = await usage(oid); return { status: 200, json: { ok: true, left: allowance(u), ready: photoOn() } };
  }

  async function scenesFor(name, years, story, lang) {
    const fallback = [
      { cap: `${name}${years ? ' · ' + years : ''}`, act: 'looks gently at the camera, blinks and breathes softly; a warm, slow push-in' },
      { cap: S(story.split(/(?<=[.!?।])\s+/)[0] || 'A life full of stories.', 140), act: 'smiles slightly and turns the head a little, as if remembering something; soft window light' },
      { cap: 'Remembered with love.', act: 'a calm, proud expression; the camera slowly pulls back; golden evening light' }
    ].slice(0, scenes);
    if (!writeText || !story.trim()) return fallback;
    const prompt = `You write a ${scenes}-scene micro-documentary about one person, made by animating ONE old photograph of them.
Person: ${name}${years ? ' (' + years + ')' : ''}
Their life story (from the family):
"""${S(story, 3000)}"""
Return ONLY a JSON array of ${scenes} objects: [{"cap":"subtitle line, max 110 characters, ${lang === 'hi' ? 'in Hindi (Devanagari)' : lang === 'hn' ? 'in Hinglish (Roman Hindi)' : 'in English'}, from the story","act":"what the person in the photo subtly does and how the camera moves, in English, max 160 characters"}].
Rules: the photo shows only this person, so actions must be small and natural (blink, breathe, slight smile, small head turn, eyes looking up as if remembering). Never invent new people, places or text on screen. Scene 1 introduces them, the last scene is a gentle goodbye.`;
    try {
      const t = await writeText(prompt);
      const m = /\[[\s\S]*\]/.exec(t || ''); const arr = m ? JSON.parse(m[0]) : null;
      if (!Array.isArray(arr) || !arr.length) return fallback;
      return arr.slice(0, scenes).map((x, i) => ({ cap: S(x && x.cap, 140) || fallback[i].cap, act: S(x && x.act, 200) || fallback[i].act }));
    } catch (e) { return fallback; }
  }
  const STYLE = {
    vintage: 'warm vintage film look, gentle grain, soft sepia tones',
    natural: 'natural, true-to-life colours, soft daylight',
    cinema: 'cinematic documentary look, shallow depth of field, rich warm contrast'
  };
  function videoPrompt(name, sc, style) {
    return `Animate this real family photograph of ${name} into a short, respectful documentary shot. ${sc.act}. ` +
      `Keep the person's face, age, hair and clothes exactly the same as in the photo — it must still clearly be the same person. ` +
      `Subtle, natural, realistic motion only. ${STYLE[style] || STYLE.cinema}. ` +
      `Sound: soft room ambience and a gentle, emotional instrumental score. No speech, no singing, no text, no captions, no logos.`;
  }
  async function create(img, text, aspect) {
    const input = [{ type: 'image', data: img.b64, mime_type: img.mime }, { type: 'text', text }];
    const full = { model, input, background: true, generation_config: { video_config: { task: 'image_to_video' } }, response_format: { type: 'video', aspect_ratio: aspect, resolution: '720p' } };
    let r = await F(API, { method: 'POST', headers: hdr, body: JSON.stringify(full) });
    let j = await r.json().catch(() => ({}));
    if (r.status === 400) {      // field names change while the API is new — retry with the plainest request
      r = await F(API, { method: 'POST', headers: hdr, body: JSON.stringify({ model, input, background: true }) }); j = await r.json().catch(() => ({}));
    }
    if (!r.ok || !j.id) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    return j.id;
  }

  async function start(b) {
    const oid = owner(b); if (!oid) return { status: 401, json: { error: 'Documentaries come with Royal. Enter your Royal unlock code in Plans.', code: 'NOT_UNLOCKED' } };
    if (!photoOn()) return { status: 503, json: { error: 'Documentaries are being set up.', code: 'NOT_READY' } };
    const img = b.photo || {}; const mime = /^image\/(jpeg|png|webp)$/.test(img.mime) ? img.mime : 'image/jpeg';
    if (!img.b64 || String(img.b64).length < 2000) return { status: 400, json: { error: 'Add a clear photo of this person first.' } };
    const u = await usage(oid); if (!allowance(u)) return { status: 402, json: { error: 'All documentaries in your plan are used.', code: 'NO_FILMS', left: 0 } };
    const dk = 'fd:' + today(); const dn = (await store.get(dk)) || 0;
    if (dn >= dailyCap) return { status: 429, json: { error: 'Today’s documentary limit is reached — please try again tomorrow.', code: 'DAILY' } };
    const name = S(b.name, 80) || 'them'; const aspect = b.aspect === '16:9' ? '16:9' : '9:16';
    u.used = (u.used || 0) + 1; await store.set('fu:' + oid, u); await store.set(dk, dn + 1);
    const plan = await scenesFor(name, S(b.years, 30), S(b.story, 4000), S(b.lang, 4));
    const made = await Promise.all(plan.map(sc => create({ b64: String(img.b64), mime }, videoPrompt(name, sc, b.style), aspect).then(iid => ({ iid, cap: sc.cap, st: 'run' }), e => ({ iid: '', cap: sc.cap, st: 'fail', err: S(e.message, 200) }))));
    if (!made.some(s => s.st === 'run')) {
      u.used = Math.max(0, u.used - 1); await store.set('fu:' + oid, u);
      return { status: 502, json: { error: 'Google could not start the film: ' + (made[0].err || 'unknown error') + '. Nothing was used — please try again.', left: allowance(u) } };
    }
    const job = crypto.randomBytes(9).toString('base64url');
    await store.set('fj:' + job, { o: oid, t: Date.now(), name, aspect, scenes: made, refunded: false });
    return { status: 200, json: { ok: true, job, left: allowance(u), scenes: made.map(s => ({ st: s.st, cap: s.cap })) } };
  }

  async function poll(job, J) {
    for (let i = 0; i < J.scenes.length; i++) {
      const s = J.scenes[i]; if (s.st !== 'run') continue;
      try {
        const r = await F(API + '/' + encodeURIComponent(s.iid), { headers: hdr }); const j = await r.json().catch(() => ({}));
        if (!r.ok) { if (r.status === 404) { s.st = 'fail'; s.err = 'expired'; } continue; }
        if (j.status === 'completed') {
          const v = findVideo(j); if (v) { s.st = 'done'; s.mime = v.mime; cache.set(job + ':' + i, Buffer.from(v.data, 'base64')); trim(); }
          else { s.st = 'fail'; s.err = 'Google blocked this scene (safety filter) or returned no video'; }
        } else if (['failed', 'cancelled', 'requires_action'].includes(j.status)) { s.st = 'fail'; s.err = S((j.error && j.error.message) || j.status, 200); }
      } catch (e) { /* network hiccup — try again next poll */ }
    }
  }
  function trim() { while (cache.size > 24) cache.delete(cache.keys().next().value); }

  async function status(q) {
    const oid = owner(q); if (!oid) return { status: 401, json: { error: 'Not allowed.', code: 'NOT_UNLOCKED' } };
    const job = S(q.job, 20); const J = await store.get('fj:' + job); if (!J || J.o !== oid) return { status: 404, json: { error: 'Film not found.' } };
    if (J.scenes.some(s => s.st === 'run') && Date.now() - (lastPoll.get(job) || 0) > 4000) {
      lastPoll.set(job, Date.now()); await poll(job, J);
      if (J.scenes.every(s => s.st === 'fail') && !J.refunded) { const u = await usage(oid); u.used = Math.max(0, (u.used || 0) - 1); await store.set('fu:' + oid, u); J.refunded = true; }
      await store.set('fj:' + job, J);
    }
    const run = J.scenes.some(s => s.st === 'run');
    return { status: 200, json: { ok: true, job, done: !run, refunded: !!J.refunded, aspect: J.aspect, scenes: J.scenes.map(s => ({ st: s.st, cap: s.cap, err: s.st === 'fail' ? (s.err || 'failed') : undefined })), mins: Math.round((Date.now() - J.t) / 60000) } };
  }

  async function clip(q) {
    const oid = owner(q); if (!oid) return { status: 401, json: { error: 'Not allowed.' } };
    const job = S(q.job, 20); const i = Math.max(0, Math.min(9, +q.i || 0));
    const J = await store.get('fj:' + job); if (!J || J.o !== oid || !J.scenes[i] || J.scenes[i].st !== 'done') return { status: 404, json: { error: 'Clip not ready.' } };
    let buf = cache.get(job + ':' + i);
    if (!buf) {   // server restarted → fetch it from Google again (Google keeps it for 55 days on paid keys)
      try { const r = await F(API + '/' + encodeURIComponent(J.scenes[i].iid), { headers: hdr }); const v = findVideo(await r.json()); if (v) { buf = Buffer.from(v.data, 'base64'); cache.set(job + ':' + i, buf); trim(); } } catch (e) { /* fall through */ }
    }
    if (!buf) return { status: 410, json: { error: 'This clip is no longer available.' } };
    return { status: 200, buf, type: J.scenes[i].mime || 'video/mp4' };
  }

  async function addFilms(b, adminKey) {
    if (!adminKey || b.key !== adminKey) return { status: 401, json: { error: 'Wrong admin key.' } };
    const oid = norm(b.orderId); if (!oid) return { status: 400, json: { error: 'orderId required' } };
    const u = await usage(oid); u.extra = (u.extra || 0) + Math.max(-20, Math.min(20, Math.round(+b.add || 1))); await store.set('fu:' + oid, u);
    return { status: 200, json: { ok: true, orderId: oid, left: allowance(u) } };
  }
  return { balance, start, status, clip, addFilms, _findVideo: findVideo };
}
module.exports = { makeFilm };
