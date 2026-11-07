'use strict';
const fs = require('fs');

/** Loader .env sederhana (tanpa dependency). Variabel yang sudah ada di process.env tidak ditimpa. */
function load(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env) || process.env[m[1]] === '') process.env[m[1]] = v;
  }
}

module.exports = { load };
