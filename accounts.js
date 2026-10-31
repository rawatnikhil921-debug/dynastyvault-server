/* =========================================================
   DYNASTYVAULT — PERSONAL ACCOUNTS (like Instagram / Facebook)
   • Everyone makes their own account: @username + name + password (email optional, for recovery).
   • Profile: photo, bio, city, public or private, and their family tree from the app.
   • Follow people: public = instant, private = request that the owner approves.
   • Feed: posts and memories from the people you follow.
   • Log in on any phone: the family tree is backed up to the account.
   Passwords are stored only as scrypt hashes. Nabu can reset a forgotten password from admin.html.
   ========================================================= */
const crypto = require('crypto');

const S = (x, n) => String(x == null ? '' : x).slice(0, n);
const N = x => Math.max(0, Math.min(1e9, Math.round(+x || 0)));
const H = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const RESERVED = new Set(['admin', 'api', 'dynastyvault', 'support', 'help', 'explore', 'login', 'signup', 'settings', 'official', 'team', 'royal', 'about', 'privacy', 'terms', 'nabu', 'root', 'null', 'undefined']);
const IMG = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

function scryptHash(pw, salt) { return new Promise((res, rej) => crypto.scrypt(String(pw), salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k.toString('hex')))); }

function makeAccounts({ store, adminKey }) {
  const okUser = u => /^[a-z0-9](?:[a-z0-9._]{1,22})[a-z0-9]$/.test(u) && !/[._]{2}/.test(u) && !RESERVED.has(u);
  const normU = u => S(u, 40).trim().toLowerCase().replace(/^@+/, '');
  const normE = e => S(e, 120).trim().toLowerCase();
  const okEmail = e => !e || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

  // ---------- rate limits ----------
  const hits = new Map();
  function limited(k, max, ms) {
    const now = Date.now(); const a = (hits.get(k) || []).filter(t => now - t < ms); a.push(now); hits.set(k, a);
    if (hits.size > 8000) for (const [x, v] of hits) if (!v.length || now - v[v.length - 1] > ms) hits.delete(x);
    return a.length > max;
  }
  const tooMany = { status: 429, json: { error: 'Too many tries — wait a few minutes and try again.', code: 'RATE' } };

  // ---------- records ----------
  const getA = id => id ? store.get('u:' + id) : null;
  const cardOf = a => ({ id: a.id, un: a.un, name: a.name, ph: a.thumb || '', city: a.city || '', bio: S(a.bio, 80), vis: a.vis, m: a.m || 0, g: a.g || 0, fam: !!a.famOn && !!a.hasFam, fol: (a.fol || []).length, at: a.up || a.at, hidden: !!a.hidden });
  async function putA(a) { a.up = Date.now(); await store.set('u:' + a.id, a); await store.set('c2:' + a.id, cardOf(a)); cards = null; }
  let cards = null, cardsAt = 0;
  async function allCards() { if (cards && Date.now() - cardsAt < 45000) return cards; cards = (await store.list('c2:', 2000)).map(r => r.v).filter(c => c && !c.hidden); cardsAt = Date.now(); return cards; }

  const meOut = (a, extra) => Object.assign({ id: a.id, un: a.un, name: a.name, ph: a.ph || '', bio: a.bio || '', city: a.city || '', email: a.em || '', vis: a.vis, famOn: !!a.famOn, hasFam: !!a.hasFam,
    followers: (a.fol || []).length, following: (a.fing || []).length, views: a.views || 0, at: a.at,
    requests: (a.req || []).map(r => r.id), notes: (a.notes || []).slice(0, 40) }, extra || {});

  // ---------- sessions ----------
  const sessCache = new Map();
  async function newSession(id) { const tok = 'dvs_' + crypto.randomBytes(24).toString('base64url'); await store.set('t:' + H(tok), { id, at: Date.now() }); return tok; }
  async function auth(req) {
    const h = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim() || S((req.body || {}).token, 80) || S((req.query || {}).token, 80);
    if (!h || h.length < 20) return null;
    const k = H(h); const c = sessCache.get(k); if (c && Date.now() - c.t < 60000) return c.a ? getA(c.a) : null;
    const s = await store.get('t:' + k); sessCache.set(k, { a: s && s.id, t: Date.now() }); if (sessCache.size > 5000) sessCache.clear();
    if (!s) return null; const a = await getA(s.id); return a && !a.disabled ? a : null;
  }
  const NEED = { status: 401, json: { error: 'Please log in again.', code: 'LOGIN' } };

  // ---------- notes (notifications) ----------
  function note(a, type, from) { a.notes = a.notes || []; a.notes = a.notes.filter(n => !(n.type === type && n.id === from)); a.notes.unshift({ type, id: from, t: Date.now() }); a.notes = a.notes.slice(0, 60); }
  async function expandIds(ids) { const out = []; for (const id of ids.slice(0, 200)) { const c = await store.get('c2:' + id); if (c) out.push(c); } return out; }

  // ---------- sign up / log in ----------
  async function check(q) { const u = normU(q.u); if (!okUser(u)) return { status: 200, json: { ok: true, free: false, why: 'format' } }; return { status: 200, json: { ok: true, free: !(await store.get('n:' + u)) } }; }
  async function signup(b, ip) {
    if (limited('su' + ip, 40, 3600000)) return tooMany;   // generous: Indian mobile networks put many phones behind one IP
    const un = normU(b.username); const name = S(b.name, 60).trim(); const pw = String(b.password || ''); const em = normE(b.email);
    if (!okUser(un)) return { status: 400, json: { error: 'Username: 3–24 small letters or numbers (dots and underscores allowed).', code: 'BAD_USER' } };
    if (name.length < 2) return { status: 400, json: { error: 'Please write your name.', code: 'BAD_NAME' } };
    if (pw.length < 6) return { status: 400, json: { error: 'Password must be at least 6 characters.', code: 'BAD_PASS' } };
    if (!okEmail(em)) return { status: 400, json: { error: 'That email does not look right.', code: 'BAD_EMAIL' } };
    if (await store.get('n:' + un)) return { status: 409, json: { error: 'That username is taken.', code: 'TAKEN' } };
    if (em && await store.get('e:' + em)) return { status: 409, json: { error: 'An account with this email already exists — log in instead.', code: 'EMAIL_TAKEN' } };
    const id = crypto.randomBytes(9).toString('base64url'); const salt = crypto.randomBytes(16).toString('hex');
    const a = { id, un, name, em, pw: { s: salt, h: await scryptHash(pw, salt) }, ph: '', thumb: '', bio: S(b.bio, 300), city: S(b.city, 60), vis: b.vis === 'private' ? 'private' : 'public', famOn: b.famOn !== false,
      at: Date.now(), fol: [], fing: [], req: [], notes: [], views: 0 };
    await store.set('n:' + un, id); if (em) await store.set('e:' + em, id); await putA(a);
    return { status: 200, json: { ok: true, token: await newSession(id), me: meOut(a) } };
  }
  async function login(b, ip) {
    const who = S(b.username, 120).trim().toLowerCase().replace(/^@+/, '');
    if (limited('li' + ip, 80, 900000) || limited('lu' + who, 10, 900000)) return tooMany;
    const id = who.includes('@') ? await store.get('e:' + who) : await store.get('n:' + who);
    const a = id && await getA(id);
    const bad = { status: 401, json: { error: 'Wrong username or password.', code: 'BAD_LOGIN' } };
    if (!a || !a.pw) { await scryptHash('x', 'y'); return bad; }   // same delay either way
    if (await scryptHash(String(b.password || ''), a.pw.s) !== a.pw.h) return bad;
    if (a.disabled) return { status: 403, json: { error: 'This account is switched off. Message support on WhatsApp.' } };
    return { status: 200, json: { ok: true, token: await newSession(a.id), me: meOut(a) } };
  }
  async function logout(req) { const h = String((req.headers.authorization || '')).replace(/^Bearer\s+/i, '').trim(); if (h) { await store.del('t:' + H(h)); sessCache.delete(H(h)); } return { status: 200, json: { ok: true } }; }
  async function me(req) { const a = await auth(req); if (!a) return NEED; const reqs = await expandIds((a.req || []).map(r => r.id)); const nids = [...new Set((a.notes || []).slice(0, 20).map(n => n.id))]; const nc = await expandIds(nids); return { status: 200, json: { ok: true, me: meOut(a, { requestCards: reqs, noteCards: nc }) } }; }

  async function update(req) {
    const a = await auth(req); if (!a) return NEED; const b = req.body || {};
    if (b.username != null && normU(b.username) !== a.un) {
      const un = normU(b.username); if (!okUser(un)) return { status: 400, json: { error: 'Username: 3–24 small letters or numbers.', code: 'BAD_USER' } };
      if (await store.get('n:' + un)) return { status: 409, json: { error: 'That username is taken.', code: 'TAKEN' } };
      await store.del('n:' + a.un); await store.set('n:' + un, a.id); a.un = un;
    }
    if (b.name != null) { const n = S(b.name, 60).trim(); if (n.length >= 2) a.name = n; }
    if (b.bio != null) a.bio = S(b.bio, 300);
    if (b.city != null) a.city = S(b.city, 60);
    if (b.vis != null) a.vis = b.vis === 'private' ? 'private' : 'public';
    if (b.famOn != null) a.famOn = !!b.famOn;
    if (b.email != null) { const em = normE(b.email); if (!okEmail(em)) return { status: 400, json: { error: 'That email does not look right.' } }; if (em !== (a.em || '')) { if (em && await store.get('e:' + em)) return { status: 409, json: { error: 'That email is used by another account.' } }; if (a.em) await store.del('e:' + a.em); if (em) await store.set('e:' + em, a.id); a.em = em; } }
    if (b.photo != null) { const p = String(b.photo); if (!p) { a.ph = ''; a.thumb = ''; } else if (IMG.test(p) && p.length < 260000) { a.ph = p; a.thumb = IMG.test(String(b.thumb || '')) && String(b.thumb).length < 30000 ? b.thumb : ''; } else return { status: 400, json: { error: 'Photo is too big.' } }; }
    if (a.vis === 'public' && (a.req || []).length) { a.fol = a.fol || []; for (const r of a.req) { if (!a.fol.includes(r.id)) { a.fol.push(r.id); const o = await getA(r.id); if (o) { o.fing = o.fing || []; if (!o.fing.includes(a.id)) o.fing.push(a.id); note(o, 'accepted', a.id); await putA(o); } } } a.req = []; }
    await putA(a); return { status: 200, json: { ok: true, me: meOut(a) } };
  }
  async function password(req) {
    const a = await auth(req); if (!a) return NEED; const b = req.body || {};
    if (await scryptHash(String(b.old || ''), a.pw.s) !== a.pw.h) return { status: 401, json: { error: 'Your current password is wrong.' } };
    if (String(b.new || '').length < 6) return { status: 400, json: { error: 'New password must be at least 6 characters.' } };
    a.pw = { s: crypto.randomBytes(16).toString('hex') }; a.pw.h = await scryptHash(String(b.new), a.pw.s); await putA(a);
    return { status: 200, json: { ok: true } };
  }
  async function removeAcct(req) {
    const a = await auth(req); if (!a) return NEED; const b = req.body || {};
    if (await scryptHash(String(b.password || ''), a.pw.s) !== a.pw.h) return { status: 401, json: { error: 'Password is wrong.' } };
    for (const id of a.fing || []) { const o = await getA(id); if (o) { o.fol = (o.fol || []).filter(x => x !== a.id); o.req = (o.req || []).filter(r => r.id !== a.id); await putA(o); } }
    for (const id of a.fol || []) { const o = await getA(id); if (o) { o.fing = (o.fing || []).filter(x => x !== a.id); await putA(o); } }
    await store.del('n:' + a.un); if (a.em) await store.del('e:' + a.em); await store.del('f:' + a.id); await store.del('b:' + a.id); await store.del('c2:' + a.id); await store.del('u:' + a.id); cards = null;
    return { status: 200, json: { ok: true } };
  }

  // ---------- family tree on the profile + backup for other phones ----------
  const postCache = new Map();
  async function family(req) {
    const a = await auth(req); if (!a) return NEED; const b = req.body || {};
    if (b.off) { a.hasFam = false; await store.del('f:' + a.id); postCache.delete(a.id); await putA(a); return { status: 200, json: { ok: true } }; }
    const raw = JSON.stringify(b.d || {}); if (raw.length > 1600000) return { status: 413, json: { error: 'Family is too big — untick member photos.', code: 'TOO_BIG' } };
    const st = (b.d && b.d.st) || {}; a.m = N(st.m); a.g = N(st.g); a.hasFam = true; a.famName = S(b.d && b.d.n, 60);
    await store.set('f:' + a.id, { d: b.d, at: Date.now() }); postCache.set(a.id, postsOf(b.d)); await putA(a); kinIdx = null; exCache = null;
    return { status: 200, json: { ok: true } };
  }
  async function backupPut(req) {
    const a = await auth(req); if (!a) return NEED; const raw = JSON.stringify((req.body || {}).vault || null);
    if (raw.length > 4500000) return { status: 413, json: { error: 'Backup is too big.', code: 'TOO_BIG' } };
    await store.set('b:' + a.id, { v: (req.body || {}).vault, at: Date.now() }); return { status: 200, json: { ok: true } };
  }
  async function backupGet(req) { const a = await auth(req); if (!a) return NEED; const b = await store.get('b:' + a.id); return { status: 200, json: { ok: true, vault: b ? b.v : null, at: b ? b.at : 0 } }; }

  // ---------- look at someone ----------
  const seen = new Map();
  async function view(req) {
    const q = req.query || {}; const id = await store.get('n:' + normU(q.u)); const a = id && await getA(id);
    if (!a || a.hidden || a.disabled) return { status: 404, json: { error: 'This account does not exist any more.', code: 'NONE' } };
    const v = await auth(req); const self = !!v && v.id === a.id;
    const following = !!v && (a.fol || []).includes(v.id); const requested = !!v && (a.req || []).some(r => r.id === v.id);
    const open = self || a.vis === 'public' || following;
    const vk = (v ? v.id : 'd' + S(q.d, 40)) + '|' + a.id + '|' + new Date().toISOString().slice(0, 10);
    if (!self && !seen.has(vk)) { seen.set(vk, 1); if (seen.size > 30000) seen.clear(); a.views = (a.views || 0) + 1; await store.set('u:' + a.id, a); }
    const out = { ok: true, p: Object.assign(cardOf(a), { ph: a.ph || a.thumb || '', bio: a.bio || '', following: (a.fing || []).length, followers: (a.fol || []).length, views: a.views || 0, famName: a.famName || '' }),
      self, isFollowing: following, requested, followsYou: !!v && (a.fing || []).includes(v.id), open };
    out.p.allies = (a.fol || []).filter(x => (a.fing || []).includes(x)).length;
    if (open && a.famOn && a.hasFam) { const f = await store.get('f:' + a.id); if (f) out.d = f.d; }
    return { status: 200, json: out };
  }
  async function follow(req, ip) {
    const v = await auth(req); if (!v) return NEED; if (limited('fo' + v.id, 150, 600000)) return tooMany;
    const b = req.body || {}; const id = await store.get('n:' + normU(b.u)); const a = id && await getA(id);
    if (!a || a.hidden) return { status: 404, json: { error: 'Account not found.' } }; if (a.id === v.id) return { status: 400, json: { error: 'That is you.' } };
    a.fol = a.fol || []; a.req = a.req || []; v.fing = v.fing || [];
    if (b.on === false) {
      a.fol = a.fol.filter(x => x !== v.id); a.req = a.req.filter(r => r.id !== v.id); v.fing = v.fing.filter(x => x !== a.id);
      if (b.both) { v.fol = (v.fol || []).filter(x => x !== a.id); v.req = (v.req || []).filter(r => r.id !== a.id); a.fing = (a.fing || []).filter(x => x !== v.id); }   // "remove ally": both directions
    }
    else if (a.vis === 'public') { if (!a.fol.includes(v.id)) { a.fol.push(v.id); note(a, (a.fing || []).includes(v.id) ? 'ally' : 'follow', v.id); } if (!v.fing.includes(a.id)) v.fing.push(a.id); }
    else if (!a.fol.includes(v.id) && !a.req.some(r => r.id === v.id)) { a.req.unshift({ id: v.id, t: Date.now() }); a.req = a.req.slice(0, 500); note(a, 'request', v.id); }
    await putA(a); await putA(v);
    return { status: 200, json: { ok: true, isFollowing: a.fol.includes(v.id), requested: a.req.some(r => r.id === v.id), followers: a.fol.length } };
  }
  async function answer(req) {
    const a = await auth(req); if (!a) return NEED; const b = req.body || {}; const rid = S(b.id, 20);
    const had = (a.req || []).some(r => r.id === rid); a.req = (a.req || []).filter(r => r.id !== rid);
    if (b.removeFollower) { a.fol = (a.fol || []).filter(x => x !== rid); const o = await getA(rid); if (o) { o.fing = (o.fing || []).filter(x => x !== a.id); await putA(o); } }
    if (had && b.ok) { a.fol = a.fol || []; if (!a.fol.includes(rid)) a.fol.push(rid); const o = await getA(rid); if (o) { o.fing = o.fing || []; if (!o.fing.includes(a.id)) o.fing.push(a.id); note(o, 'accepted', a.id); await putA(o); } }
    await putA(a); return { status: 200, json: { ok: true, followers: a.fol.length, requests: a.req.length } };
  }
  async function people(req) {
    const q = req.query || {}; const id = await store.get('n:' + normU(q.u)); const a = id && await getA(id); if (!a || a.hidden) return { status: 404, json: { error: 'Not found.' } };
    const v = await auth(req); const open = (v && v.id === a.id) || a.vis === 'public' || (v && (a.fol || []).includes(v.id));
    if (!open) return { status: 403, json: { error: 'This account is private.', code: 'PRIVATE' } };
    const ids = q.kind === 'allies' ? (a.fol || []).filter(x => (a.fing || []).includes(x)) : q.kind === 'following' ? (a.fing || []) : (a.fol || []);
    return { status: 200, json: { ok: true, items: (await expandIds(ids.slice().reverse())).filter(c => !c.hidden) } };
  }
  // ---------- 🔍 search & "people you may know" ----------
  const lastWord = n => String(n || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(-1)[0] || '';
  const fold = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  async function mutualMap(v, limit = 40) {   // candidate id -> ids of people I follow who follow them
    const m = new Map(); if (!v) return m;
    for (const fid of (v.fing || []).slice(-limit)) { const f = await getA(fid); if (!f || f.hidden) continue; for (const x of f.fing || []) { if (x === v.id) continue; if (!m.has(x)) m.set(x, []); m.get(x).push(fid); } }
    return m;
  }
  async function nameOf(ids, n = 2) { const out = []; for (const id of ids.slice(0, n)) { const c = await store.get('c2:' + id); if (c) out.push(c.name.split(' ')[0]); } return out; }
  async function search(req) {
    const q = req.query || {}; const term = fold(S(q.q, 60).trim()).replace(/^@/, ''); const v = await auth(req); const filt = S(q.f, 12);
    let c = await allCards(); if (v) c = c.filter(x => x.id !== v.id);
    const sur = new Set(String(q.sn || '').toLowerCase().split(',').map(x => x.trim()).filter(x => x.length > 1).slice(0, 12));
    const city = fold(S(q.city || (v && v.city) || '', 60).trim());
    if (filt === 'surname') c = c.filter(x => sur.has(lastWord(x.name)));
    if (filt === 'city') c = c.filter(x => city && fold(x.city).includes(city));
    const scored = [];
    for (const x of c) {
      let sc = 0; const un = x.un, nm = fold(x.name), words = nm.split(/\s+/);
      if (term) {
        if (un === term) sc += 120; else if (un.startsWith(term)) sc += 70; else if (un.includes(term)) sc += 30;
        if (nm === term) sc += 110; else if (nm.startsWith(term)) sc += 65; else if (words.some(w => w.startsWith(term))) sc += 55; else if (nm.includes(term)) sc += 25;
        if (fold(x.city).includes(term)) sc += 20; if (fold(x.bio).includes(term)) sc += 6;
        if (!sc) continue;
      }
      if (sur.has(lastWord(x.name))) sc += 12; if (city && fold(x.city).includes(city)) sc += 8;
      sc += Math.min(20, (x.fol || 0) / 2) + (x.ph ? 3 : 0) + (x.vis === 'public' ? 2 : 0);
      scored.push([sc, x]);
    }
    scored.sort((a, b) => b[0] - a[0] || b[1].at - a[1].at);
    const fing = new Set(v ? v.fing || [] : []); const fol = new Set(v ? v.fol || [] : []); const pend = new Set();
    const mm = v && scored.length ? await mutualMap(v, 25) : new Map();
    const items = [];
    for (const [, x] of scored.slice(0, Math.min(60, N(q.limit) || 40))) {
      const mu = mm.get(x.id) || [];
      items.push(Object.assign({}, x, { isFollowing: fing.has(x.id), followsYou: fol.has(x.id), mutual: mu.length, mutualNames: mu.length ? await nameOf(mu) : [], sameSurname: sur.has(lastWord(x.name)) }));
    }
    return { status: 200, json: { ok: true, total: scored.length, items } };
  }
  async function suggest(req) {
    const q = req.query || {}; const v = await auth(req);
    const sur = new Set(String(q.sn || '').toLowerCase().split(',').map(x => x.trim()).filter(x => x.length > 1).slice(0, 12));
    const city = fold(S(q.city || (v && v.city) || '', 60).trim());
    const fing = new Set(v ? v.fing || [] : []); const fol = new Set(v ? v.fol || [] : []); const pend = new Set();
    let c = (await allCards()).filter(x => (!v || x.id !== v.id) && !fing.has(x.id));
    const mm = await mutualMap(v, 40); const out = [];
    for (const x of c) {
      const mu = mm.get(x.id) || []; let sc = 0, why = 'popular';
      if (fol.has(x.id)) { sc += 80; why = 'followsYou'; }
      if (mu.length) { sc += 30 + mu.length * 12; if (why === 'popular') why = 'mutual'; }
      if (sur.has(lastWord(x.name))) { sc += 35; if (why === 'popular') why = 'surname'; }
      if (city && fold(x.city).includes(city)) { sc += 18; if (why === 'popular') why = 'city'; }
      sc += Math.min(15, (x.fol || 0) / 2) + (x.ph ? 4 : 0) + (x.fam ? 3 : 0);
      out.push([sc, x, why, mu]);
    }
    out.sort((a, b) => b[0] - a[0] || b[1].at - a[1].at);
    const items = [];
    for (const [, x, why, mu] of out.slice(0, Math.min(30, N(q.limit) || 15))) items.push(Object.assign({}, x, { why, mutual: mu.length, mutualNames: mu.length ? await nameOf(mu) : [], followsYou: fol.has(x.id), isFollowing: false }));
    return { status: 200, json: { ok: true, items } };
  }
  // Explore: recent posts from public families, newest first, a few per family so one family can't fill the page
  let exCache = null, exAt = 0;
  async function explore(req) {
    const q = req.query || {}; const v = await auth(req);
    if (!exCache || Date.now() - exAt > 60000) {
      const c = (await allCards()).filter(x => x.vis === 'public' && x.fam).sort((a, b) => (b.fol || 0) - (a.fol || 0) || b.at - a.at).slice(0, 60);
      const out = [];
      for (const x of c) {
        let posts = postCache.get(x.id); if (!posts) { const f = await store.get('f:' + x.id); posts = f ? postsOf(f.d) : []; postCache.set(x.id, posts); }
        posts.slice(0, 4).forEach(p => out.push(Object.assign({}, p, { who: { un: x.un, name: x.name, ph: x.ph || '' } })));
      }
      out.sort((a, b) => b.at - a.at); exCache = out; exAt = Date.now();
    }
    const me = v ? v.un : ''; const items = exCache.filter(p => p.who.un !== me).slice(0, Math.min(90, N(q.limit) || 60));
    return { status: 200, json: { ok: true, items } };
  }
  // 🧬 Kin Finder: which public family trees contain the same ancestors as mine?
  const normName = n => fold(n).replace(/[^a-z\u0900-\u097f\s]/g, ' ').replace(/\s+/g, ' ').trim();
  let kinIdx = null, kinAt = 0;
  async function kinIndex() {
    if (kinIdx && Date.now() - kinAt < 300000) return kinIdx;
    const idx = new Map();
    const c = (await allCards()).filter(x => x.vis === 'public' && x.fam).slice(0, 1500);
    for (const x of c) {
      const f = await store.get('f:' + x.id); const rows = f && f.d && f.d.ts && Array.isArray(f.d.ts.p) ? f.d.ts.p : [];
      for (const r of rows.slice(0, 400)) {
        const nm = normName(r && r[0]); if (nm.split(' ').length < 2) continue;
        const y = (/^(\d{4})/.exec(String((r && r[3]) || '')) || [])[1] || '';
        if (!idx.has(nm)) idx.set(nm, []); idx.get(nm).push({ id: x.id, un: x.un, name: x.name, ph: x.ph || '', person: S(r[0], 80), y, pos: S(r[1], 60) });
      }
    }
    kinIdx = idx; kinAt = Date.now(); return idx;
  }
  async function kin(req, ip) {
    if (limited('kn' + ip, 60, 600000)) return tooMany;
    const v = await auth(req); const b = req.body || {};
    const names = (Array.isArray(b.names) ? b.names : []).slice(0, 300);
    const idx = await kinIndex(); const by = new Map();
    for (const it of names) {
      const nm = normName(Array.isArray(it) ? it[0] : it); if (nm.split(' ').length < 2) continue;
      const y = String((Array.isArray(it) ? it[1] : '') || '').slice(0, 4);
      for (const h of idx.get(nm) || []) {
        if (v && h.id === v.id) continue;
        if (y && h.y && Math.abs(+y - +h.y) > 2) continue;
        if (!by.has(h.id)) by.set(h.id, { un: h.un, name: h.name, ph: h.ph, people: [] });
        const g = by.get(h.id); if (!g.people.some(p => p.person === h.person)) g.people.push({ person: h.person, y: h.y, pos: h.pos, sure: !!(y && h.y) });
      }
    }
    const items = [...by.values()].sort((a, b) => b.people.length - a.people.length || b.people.filter(p => p.sure).length - a.people.filter(p => p.sure).length).slice(0, 20);
    return { status: 200, json: { ok: true, items, families: idx.size ? (await allCards()).filter(x => x.vis === 'public' && x.fam).length : 0 } };
  }
  // 🤝 Allies (like Facebook friends): we follow each other. Requests = they added me, I haven't added back.
  const alliesOf = a => (a.fol || []).filter(x => (a.fing || []).includes(x));
  const dynScore = (a, n) => (a.m || 0) * 10 + (a.g || 0) * 40 + n * 15 + (a.hasFam ? 20 : 0);
  async function allies(req) {
    const v = await auth(req); if (!v) return NEED;
    const fing = new Set(v.fing || []); const fol = new Set(v.fol || []);
    const allyIds = (v.fing || []).filter(x => fol.has(x)); const mine = new Set(allyIds);
    const pend = new Set((v.req || []).map(r => r.id));
    const reqIds = [...new Set([...(v.req || []).map(r => r.id), ...(v.fol || []).slice().reverse().filter(x => !fing.has(x))])];
    const sentIds = (v.fing || []).slice().reverse().filter(x => !fol.has(x));
    const enrich = async (ids, n) => {
      const out = [];
      for (const id of ids.slice(0, n)) {
        const o = await getA(id); if (!o || o.hidden || o.disabled) continue; const oa = alliesOf(o);
        out.push(Object.assign(cardOf(o), { famName: o.famName || '', allies: oa.length, mutualAllies: oa.filter(x => mine.has(x)).length, score: dynScore(o, oa.length), pending: pend.has(id) }));
      }
      return out;
    };
    const list = await enrich(allyIds.slice().reverse(), 300);
    return { status: 200, json: { ok: true, allies: list, requests: await enrich(reqIds, 60), sent: await enrich(sentIds, 60),
      me: Object.assign(cardOf(v), { famName: v.famName || '', allies: allyIds.length, score: dynScore(v, allyIds.length) }) } };
  }
  async function following(req) {   // people I follow, newest first — for the story-ring row
    const v = await auth(req); if (!v) return NEED;
    const fol = new Set(v.fol || []); const out = [];
    for (const id of (v.fing || []).slice(-60).reverse()) { const c = await store.get('c2:' + id); if (c && !c.hidden) out.push(Object.assign({}, c, { mutual: fol.has(id) })); }   // mutual = we follow each other
    out.sort((a, b) => (b.mutual ? 1 : 0) - (a.mutual ? 1 : 0));
    return { status: 200, json: { ok: true, items: out } };
  }
  function postsOf(d) {
    const KIND = { p: 'post', m: 'memory', v: 'voice' };
    const pp = Array.isArray(d && d.pp) ? d.pp : [];
    return (Array.isArray(d && d.p) ? d.p : []).slice(0, 15).map((r, i) => ({ k: KIND[r[0]] || 'post', by: S(r[1], 60), text: S(r[2], 400), at: +r[3] || 0, about: S(r[4], 80), ph: typeof pp[i] === 'string' && IMG.test(pp[i]) && pp[i].length < 90000 ? pp[i] : '' })).filter(p => p.text || p.ph);
  }
  async function feed(req) {
    const v = await auth(req); if (!v) return NEED; const out = [];
    for (const id of (v.fing || []).slice(-150)) {
      const a = await getA(id); if (!a || a.hidden || !a.famOn) continue;
      let posts = postCache.get(id); if (!posts) { const f = await store.get('f:' + id); posts = f ? postsOf(f.d) : []; postCache.set(id, posts); }
      const who = { un: a.un, name: a.name, ph: a.thumb || '', fam: a.famName || '' };
      posts.forEach(p => out.push(Object.assign({}, p, { who })));
      if (a.at > Date.now() - 14 * 86400000) out.push({ k: 'joined', at: a.at, text: '', who });
    }
    out.sort((x, y) => y.at - x.at);
    return { status: 200, json: { ok: true, items: out.slice(0, 80) } };
  }
  async function report(req, ip) { if (limited('rp' + ip, 10, 3600000)) return tooMany; const b = req.body || {}; const t = Date.now(); await store.set('r:' + t + ':' + normU(b.u), { h: normU(b.u), why: S(b.why, 300), t, acct: true }); return { status: 200, json: { ok: true } }; }

  // ---------- admin ----------
  async function adminHide(b) {
    if (!adminKey || b.key !== adminKey) return { status: 401, json: { error: 'Wrong admin key.' } };
    const id = await store.get('n:' + normU(b.u)); const a = id && await getA(id); if (!a) return { status: 404, json: { error: 'Not found.' } };
    a.hidden = b.hide !== false; await putA(a); return { status: 200, json: { ok: true, hidden: a.hidden } };
  }
  async function adminReset(b) {
    if (!adminKey || b.key !== adminKey) return { status: 401, json: { error: 'Wrong admin key.' } };
    const id = await store.get('n:' + normU(b.u)); const a = id && await getA(id); if (!a) return { status: 404, json: { error: 'Not found.' } };
    const temp = 'dv' + crypto.randomBytes(4).toString('hex'); a.pw = { s: crypto.randomBytes(16).toString('hex') }; a.pw.h = await scryptHash(temp, a.pw.s); await putA(a);
    return { status: 200, json: { ok: true, username: a.un, temp } };
  }
  async function adminStats() {
    const all = (await store.list('c2:', 2000)).map(r => r.v).filter(Boolean);
    return { total: all.length, public: all.filter(c => c.vis === 'public' && !c.hidden).length, private: all.filter(c => c.vis !== 'public' && !c.hidden).length, hidden: all.filter(c => c.hidden).length,
      withFamily: all.filter(c => c.fam).length, recent: all.slice(0, 15).map(c => ({ un: c.un, name: c.name, vis: c.vis, m: c.m, fol: c.fol, hidden: c.hidden, at: c.at })) };
  }

  return { check, signup, login, logout, me, update, password, removeAcct, family, backupPut, backupGet, view, follow, answer, people, search, suggest, following, allies, explore, kin, feed, report, adminHide, adminReset, adminStats };
}
module.exports = { makeAccounts };
