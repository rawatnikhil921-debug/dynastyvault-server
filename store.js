/* =========================================================
   DYNASTYVAULT — SMALL KEY/VALUE STORE
   • With SUPABASE_URL + SUPABASE_SERVICE_KEY on Render → data is kept forever in Supabase (free plan is enough).
   • Without them → a JSON file on the server. Render's free plan WIPES that file on every restart,
     so profiles and visitor numbers would disappear. Fine for testing, not for launch.
   Supabase table (SERVER-SETUP.txt has the exact SQL):  dv_kv (k text primary key, v jsonb, updated_at timestamptz)
   ========================================================= */
const fs = require('fs');

function makeStore(opts = {}) {
  const url = String(opts.supabaseUrl || '').trim().replace(/\/+$/, '');
  const key = String(opts.supabaseKey || '').trim();
  const F = opts.fetchImpl || ((...a) => fetch(...a));
  if (url && key) {
    const H = Object.assign({ apikey: key, 'Content-Type': 'application/json' }, /^sb_/.test(key) ? {} : { Authorization: 'Bearer ' + key });
    const base = url + '/rest/v1/dv_kv';
    const call = async (path, init) => {
      const r = await F(base + path, Object.assign({ headers: H }, init || {}));
      const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
      if (!r.ok) { const e = new Error('store ' + r.status + ': ' + ((j && (j.message || j.hint)) || t).slice(0, 200)); e.status = r.status; throw e; }
      return j;
    };
    const enc = encodeURIComponent;
    return {
      kind: 'supabase',
      async get(k) { const j = await call(`?k=eq.${enc(k)}&select=v`); return j && j[0] ? j[0].v : null; },
      async set(k, v) {
        await call('', { method: 'POST', headers: Object.assign({}, H, { Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify([{ k, v, updated_at: new Date().toISOString() }]) });
        return true;
      },
      async del(k) { await call(`?k=eq.${enc(k)}`, { method: 'DELETE' }); return true; },
      async list(prefix, limit = 500) {
        const like = String(prefix).replace(/[*%_\\]/g, m => '\\' + m) + '*';
        const j = await call(`?k=like.${enc(like)}&select=k,v&order=updated_at.desc&limit=${Math.max(1, Math.min(1000, limit))}`);
        return (j || []).map(r => ({ k: r.k, v: r.v }));
      }
    };
  }
  // ---- JSON-file fallback (temporary on Render free) ----
  const file = opts.filePath;
  let db = {}; try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { db = {}; }
  const upd = {};
  let timer = null;
  const flush = () => { timer = null; try { fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); } catch (e) { console.error('[store] could not save:', e.message); } };
  const later = () => { if (!timer) timer = setTimeout(flush, 300); };
  const clone = v => v == null ? null : JSON.parse(JSON.stringify(v));
  return {
    kind: 'file',
    async get(k) { return Object.prototype.hasOwnProperty.call(db, k) ? clone(db[k]) : null; },
    async set(k, v) { db[k] = clone(v); upd[k] = Date.now(); later(); return true; },
    async del(k) { delete db[k]; delete upd[k]; later(); return true; },
    async list(prefix, limit = 500) {
      return Object.keys(db).filter(k => k.startsWith(prefix)).sort((a, b) => (upd[b] || 0) - (upd[a] || 0)).slice(0, limit).map(k => ({ k, v: clone(db[k]) }));
    },
    flush
  };
}
module.exports = { makeStore };
