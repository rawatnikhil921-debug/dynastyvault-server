/* =========================================================
   DYNASTYVAULT — FAMILY PROFILES (public / private, like Instagram) + VISITOR NUMBERS
   Profiles
     • A family claims an @handle. The app keeps a secret "owner key" on that phone — only it can change the profile.
     • Public  → anyone can open it and it shows in Explore. Follow = one tap.
     • Private → Explore shows only the name, place and member count. People send a follow request;
                 the owner approves it in the app, and only then they see the tree.
   Visitor numbers (admin dashboard)
     • The website sends tiny anonymous events (visit, tree made …). Phone IDs are hashed — no names, no IP addresses kept.
   ========================================================= */
const crypto = require('crypto');

const H = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const RESERVED = new Set(['admin', 'api', 'dynastyvault', 'support', 'help', 'explore', 'login', 'settings', 'official', 'team', 'royal', 'about', 'privacy', 'terms']);
const day = (t = Date.now()) => new Date(t + 5.5 * 3600000).toISOString().slice(0, 10);   // India date, so "today" matches Nabu's day
const S = (x, n) => String(x == null ? '' : x).slice(0, n);
const N = x => Math.max(0, Math.min(1e9, Math.round(+x || 0)));

function makeSocial({ store, adminKey }) {
  const vh = d => H('v|' + d).slice(0, 24);        // viewer id (from the phone's random device id)
  const oh = k => H('o|' + k);                     // owner id (from the secret owner key)
  const okHandle = h => /^[a-z0-9](?:[a-z0-9._]{1,22})[a-z0-9]$/.test(h) && !/[._]{2}/.test(h) && !RESERVED.has(h);
  const normH = h => S(h, 40).trim().toLowerCase().replace(/^@+/, '');

  // ---------- write limiter (per IP) ----------
  const hits = new Map();
  function limited(ip, max = 40, ms = 600000) {
    const now = Date.now(); const a = (hits.get(ip) || []).filter(t => now - t < ms); a.push(now); hits.set(ip, a);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > ms) hits.delete(k);
    return a.length > max;
  }

  // ---------- Explore cache (cards only — small) ----------
  let cards = null, cardsAt = 0;
  async function allCards() {
    if (cards && Date.now() - cardsAt < 60000) return cards;
    const rows = await store.list('c:', 1000); cards = rows.map(r => r.v).filter(c => c && !c.hidden); cardsAt = Date.now(); return cards;
  }
  const dropCache = () => { cards = null; };

  const cardOf = (p) => ({ h: p.h, vis: p.vis, n: p.card.n, pl: p.card.pl, f: p.card.f, mo: p.card.mo, st: p.card.st, ph: p.card.ph || '', fol: (p.fol || []).length, at: p.up, hidden: !!p.hidden });
  function cleanCard(c) {
    c = c || {}; const st = c.st || {};
    const ph = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(S(c.ph, 120000)) && String(c.ph).length < 120000 ? c.ph : '';
    return { n: S(c.n, 60) || 'Family', pl: S(c.pl, 60), f: S(c.f, 8) || '🏰', mo: S(c.mo, 90), ph, st: { m: N(st.m), g: N(st.g), s: N(st.s), vo: N(st.vo), ph: N(st.ph) } };
  }

  // ---------- profiles ----------
  async function check(q) {
    const h = normH(q.h); if (!okHandle(h)) return { status: 200, json: { ok: true, free: false, why: 'format' } };
    const p = await store.get('p:' + h); return { status: 200, json: { ok: true, free: !p } };
  }
  async function save(b, ip) {
    if (limited(ip)) return { status: 429, json: { error: 'Too many changes — try again in a few minutes.' } };
    const key = S(b.key, 80); if (key.length < 20) return { status: 400, json: { error: 'Missing owner key.' } };
    const h = normH(b.h); if (!okHandle(h)) return { status: 400, json: { error: 'Handle must be 3–24 letters or numbers (dots and underscores allowed).', code: 'BAD_HANDLE' } };
    const raw = JSON.stringify(b.d || {}); if (raw.length > 1600000) return { status: 413, json: { error: 'Profile is too big — untick member photos and try again.', code: 'TOO_BIG' } };
    const own = oh(key);
    const mine = await store.get('o:' + own);
    if (mine && mine !== h) {   // owner renames the handle → move the profile
      const old = await store.get('p:' + mine);
      const taken = await store.get('p:' + h); if (taken && taken.own !== own) return { status: 409, json: { error: 'That handle is taken.', code: 'TAKEN' } };
      if (old && old.own === own) { await store.set('p:' + h, Object.assign(old, { h })); await store.del('p:' + mine); await store.del('c:' + mine); }
    }
    let p = await store.get('p:' + h);
    if (p && p.own !== own) return { status: 409, json: { error: 'That handle is taken.', code: 'TAKEN' } };
    const now = Date.now(); const isNew = !p;
    p = Object.assign(p || { h, own, at: now, views: 0, fol: [], req: [] }, { h, vis: b.vis === 'public' ? 'public' : 'private', card: cleanCard(b.card), d: b.d || {}, up: now });
    await store.set('p:' + h, p); await store.set('c:' + h, cardOf(p)); await store.set('o:' + own, h); dropCache();
    return { status: 200, json: { ok: true, h, vis: p.vis, isNew, followers: p.fol.length, views: p.views, requests: p.req.length } };
  }
  async function remove(b) {
    const own = oh(S(b.key, 80)); const h = await store.get('o:' + own); if (!h) return { status: 404, json: { error: 'No profile.' } };
    await store.del('p:' + h); await store.del('c:' + h); await store.del('o:' + own); dropCache();
    return { status: 200, json: { ok: true } };
  }
  async function mine(q) {
    const own = oh(S(q.key, 80)); const h = await store.get('o:' + own); if (!h) return { status: 404, json: { error: 'No profile yet.', code: 'NONE' } };
    const p = await store.get('p:' + h); if (!p) return { status: 404, json: { error: 'No profile yet.', code: 'NONE' } };
    return { status: 200, json: { ok: true, h, vis: p.vis, views: p.views || 0, followers: (p.fol || []).length, hidden: !!p.hidden, requests: (p.req || []).map(r => ({ id: r.v, n: r.n, h: r.h || '', t: r.t })) } };
  }
  async function answer(b) {
    const own = oh(S(b.key, 80)); const h = await store.get('o:' + own); if (!h) return { status: 404, json: { error: 'No profile.' } };
    const p = await store.get('p:' + h); if (!p) return { status: 404, json: { error: 'No profile.' } };
    const id = S(b.id, 40); const r = (p.req || []).find(x => x.v === id);
    p.req = (p.req || []).filter(x => x.v !== id);
    if (r && b.ok) { p.fol = p.fol || []; if (!p.fol.includes(id)) p.fol.push(id); }
    if (b.remove) p.fol = (p.fol || []).filter(x => x !== id);
    await store.set('p:' + h, p); await store.set('c:' + h, cardOf(p)); dropCache();
    return { status: 200, json: { ok: true, followers: p.fol.length, requests: p.req.length } };
  }
  const seenView = new Map();   // viewer|handle|day → counted
  async function get(q) {
    const h = normH(q.h); const p = h && await store.get('p:' + h);
    if (!p || p.hidden) return { status: 404, json: { error: 'This family profile does not exist any more.', code: 'NONE' } };
    const v = q.d ? vh(S(q.d, 80)) : ''; const isOwner = q.key && oh(S(q.key, 80)) === p.own;
    const following = !!v && (p.fol || []).includes(v); const requested = !!v && (p.req || []).some(r => r.v === v);
    const open = p.vis === 'public' || following || isOwner;
    if (v && !isOwner) {
      const k = v + '|' + h + '|' + day();
      if (!seenView.has(k)) { seenView.set(k, 1); p.views = (p.views || 0) + 1; await store.set('p:' + h, p); if (seenView.size > 20000) seenView.clear(); }
    }
    const out = { ok: true, h, vis: p.vis, card: cardOf(p), views: p.views || 0, followers: (p.fol || []).length, following, requested, open, owner: !!isOwner, at: p.up };
    if (open) out.d = p.d;
    return { status: 200, json: out };
  }
  async function follow(b, ip) {
    if (limited('f' + ip, 120)) return { status: 429, json: { error: 'Too many taps — try again in a few minutes.' } };
    const h = normH(b.h); const d = S(b.d, 80); if (!d) return { status: 400, json: { error: 'deviceId required' } };
    const p = await store.get('p:' + h); if (!p || p.hidden) return { status: 404, json: { error: 'Profile not found.' } };
    const v = vh(d); p.fol = p.fol || []; p.req = p.req || [];
    const on = b.on !== false;
    if (!on) { p.fol = p.fol.filter(x => x !== v); p.req = p.req.filter(x => x.v !== v); }
    else if (p.vis === 'public') { if (!p.fol.includes(v)) p.fol.push(v); }
    else if (!p.fol.includes(v) && !p.req.some(x => x.v === v)) { p.req.unshift({ v, n: S(b.n, 60) || 'A family', h: normH(b.from || ''), t: Date.now() }); p.req = p.req.slice(0, 300); }
    await store.set('p:' + h, p); await store.set('c:' + h, cardOf(p)); dropCache();
    return { status: 200, json: { ok: true, following: p.fol.includes(v), requested: p.req.some(x => x.v === v), followers: p.fol.length } };
  }
  async function list(q) {
    const term = S(q.q, 60).trim().toLowerCase();
    let c = await allCards();
    if (term) c = c.filter(x => (x.h + ' ' + x.n + ' ' + x.pl + ' ' + x.mo).toLowerCase().includes(term));
    c = c.slice().sort((a, b) => (b.vis === 'public') - (a.vis === 'public') || (b.fol + b.st.m / 10) - (a.fol + a.st.m / 10) || b.at - a.at);
    return { status: 200, json: { ok: true, total: c.length, items: c.slice(0, Math.min(60, N(q.limit) || 40)) } };
  }
  async function report(b, ip) {
    if (limited('r' + ip, 10)) return { status: 429, json: { error: 'Too many reports.' } };
    const h = normH(b.h); if (!h) return { status: 400, json: { error: 'handle required' } };
    const t = Date.now(); await store.set('r:' + t + ':' + h, { h, why: S(b.why, 300), t });
    return { status: 200, json: { ok: true } };
  }
  async function hide(b) {
    if (!adminKey || b.key !== adminKey) return { status: 401, json: { error: 'Wrong admin key.' } };
    const h = normH(b.h); const p = await store.get('p:' + h); if (!p) return { status: 404, json: { error: 'Not found.' } };
    p.hidden = b.hide !== false; await store.set('p:' + h, p); await store.set('c:' + h, cardOf(p)); dropCache();
    return { status: 200, json: { ok: true, hidden: p.hidden } };
  }

  // ---------- visitor numbers ----------
  const EVENTS = ['visit', 'app', 'tree', 'pub', 'follow', 'film', 'royal', 'share', 'story', 'pay'];
  const live = new Map();          // viewer → last seen (for "online now")
  let buf = {};                    // day → pending counts
  function track(b) {
    const e = EVENTS.includes(b.e) ? b.e : null; if (!e) return;
    const d = day(); const B = buf[d] = buf[d] || { ev: {}, u: {}, pg: {}, lg: {}, rf: {} };
    B.ev[e] = (B.ev[e] || 0) + 1;
    if (b.d) { const v = vh(S(b.d, 80)).slice(0, 12); B.u[v] = 1; live.set(v, Date.now()); }
    if (b.p) { const pg = S(b.p, 30).replace(/[^a-z0-9_-]/gi, ''); if (pg) B.pg[pg] = (B.pg[pg] || 0) + 1; }
    if (b.l) { const lg = S(b.l, 12).replace(/[^a-zA-Z-]/g, ''); if (lg) B.lg[lg] = (B.lg[lg] || 0) + 1; }
    if (b.r && e === 'visit') { const rf = S(b.r, 30).replace(/[^a-z0-9._-]/gi, '').toLowerCase(); if (rf) B.rf[rf] = (B.rf[rf] || 0) + 1; }
  }
  const add = (a, b) => { Object.keys(b || {}).forEach(k => { a[k] = (a[k] || 0) + b[k]; }); return a; };
  let flushing = false;
  async function flush() {
    if (flushing) return; const pending = buf; if (!Object.keys(pending).length) return; buf = {}; flushing = true;
    try {
      for (const d of Object.keys(pending)) {
        const B = pending[d]; const cur = (await store.get('s:' + d)) || { ev: {}, u: {}, pg: {}, lg: {}, rf: {} };
        add(cur.ev, B.ev); add(cur.pg, B.pg); add(cur.lg, B.lg); add(cur.rf, B.rf);
        const u = cur.u || {}; if (Object.keys(u).length < 20000) Object.assign(u, B.u); cur.u = u;
        await store.set('s:' + d, cur);
      }
    } catch (e) { console.error('[stats] flush failed:', e.message); Object.keys(pending).forEach(d => { const B = buf[d] = buf[d] || { ev: {}, u: {}, pg: {}, lg: {}, rf: {} }; add(B.ev, pending[d].ev); Object.assign(B.u, pending[d].u); add(B.pg, pending[d].pg); add(B.lg, pending[d].lg); add(B.rf, pending[d].rf); }); }
    finally { flushing = false; }
  }
  setInterval(flush, 60000).unref();

  async function stats(q, extra) {
    if (!adminKey || q.key !== adminKey) return { status: 401, json: { error: 'Wrong admin key.' } };
    await flush();
    const nd = Math.min(90, Math.max(7, N(q.days) || 30)); const days = []; const allU = new Set();
    const tot = { ev: {}, pg: {}, lg: {}, rf: {} };
    for (let i = nd - 1; i >= 0; i--) {
      const d = day(Date.now() - i * 86400000); const s = (await store.get('s:' + d)) || { ev: {}, u: {} };
      const u = Object.keys(s.u || {}); u.forEach(x => allU.add(x));
      days.push({ d, users: u.length, visit: s.ev.visit || 0, app: s.ev.app || 0, tree: s.ev.tree || 0, pub: s.ev.pub || 0, film: s.ev.film || 0, royal: s.ev.royal || 0, share: s.ev.share || 0, pay: s.ev.pay || 0 });
      add(tot.ev, s.ev); add(tot.pg, s.pg); add(tot.lg, s.lg); add(tot.rf, s.rf);
    }
    const now = Date.now(); let online = 0; for (const [k, t] of live) { if (now - t < 300000) online++; else if (now - t > 3600000) live.delete(k); }
    const c = await allCards(); const all = (await store.list('c:', 1000)).map(r => r.v);
    const reports = (await store.list('r:', 50)).map(r => r.v);
    return { status: 200, json: Object.assign({ ok: true, storage: store.kind, online, uniqueUsers: allU.size, days, totals: tot,
      profiles: { total: all.length, public: c.filter(x => x.vis === 'public').length, private: c.filter(x => x.vis !== 'public').length, hidden: all.filter(x => x && x.hidden).length,
        recent: all.slice(0, 15).map(x => ({ h: x.h, n: x.n, vis: x.vis, m: x.st && x.st.m, fol: x.fol, hidden: !!x.hidden, at: x.at })) },
      reports }, extra || {}) };
  }

  return { check, save, remove, mine, answer, get, follow, list, report, hide, track, flush, stats, _vh: vh };
}
module.exports = { makeSocial, day };
