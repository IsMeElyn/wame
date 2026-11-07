'use strict';
/**
 * hot('router') -> modul src/router.js versi terbaru.
 * Dicek mtime-nya (maks. 1x/detik). Jika file diubah, modul dimuat ulang tanpa restart bot.
 * Jika versi baru error (syntax/runtime), versi lama tetap dipakai dan error dicatat di hot.errors.
 * Hanya untuk modul stateless (router, messages, rich, groups, ...). Modul yang memegang state
 * (session, manager, logger, db, crypto-auth, cli) butuh restart proses.
 */
const fs = require('fs');
const path = require('path');

const cache = new Map();
const errors = new Map();
const listeners = new Set();

function hot(name) {
  const file = path.join(__dirname, name.endsWith('.js') ? name : `${name}.js`);
  const now = Date.now();
  let e = cache.get(file);
  if (e && now - e.checked < 1000) return e.mod;
  let st;
  try { st = fs.statSync(file); } catch (err) {
    if (e) return e.mod;
    throw err;
  }
  if (!e || e.mtime !== st.mtimeMs) {
    const first = !e;
    const old = e;
    try {
      delete require.cache[file];
      const mod = require(file);
      e = { mtime: st.mtimeMs, mod, checked: now };
      cache.set(file, e);
      errors.delete(name);
      if (!first) for (const l of listeners) { try { l({ name, ok: true }); } catch { /* ignore */ } }
    } catch (err) {
      require.cache[file] && delete require.cache[file];
      errors.set(name, err);
      for (const l of listeners) { try { l({ name, ok: false, error: err }); } catch { /* ignore */ } }
      if (old) { old.checked = now; old.mtime = st.mtimeMs; return old.mod; }
      throw err;
    }
  } else e.checked = now;
  return e.mod;
}

hot.errors = errors;
hot.onReload = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
hot.invalidate = () => { for (const e of cache.values()) e.checked = 0; };

module.exports = hot;
