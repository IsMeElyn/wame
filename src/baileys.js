'use strict';
/**
 * @itsliaaa/baileys adalah paket ESM. Dari CommonJS kita memuatnya lewat import() dinamis (dicache).
 * Semua modul lain mengambil Baileys dari sini: `const bl = await baileys.load()`.
 */
let cache = null;

async function load() {
  if (cache) return cache;
  const ns = await import('@itsliaaa/baileys');
  // Namespace ESM -> objek biasa; dukung juga bentuk { default: {...} }
  const flat = { ...(ns.default && typeof ns.default === 'object' ? ns.default : {}), ...ns };
  delete flat.default;
  const need = ['makeWASocket', 'DisconnectReason', 'useMultiFileAuthState'];
  const missing = need.filter((k) => flat[k] === undefined);
  if (missing.length) throw new Error(`@itsliaaa/baileys tidak mengekspor: ${missing.join(', ')}`);
  cache = flat;
  return cache;
}

module.exports = { load, get: () => cache };
