'use strict';
// Entry point — jalankan: node index.js   (lihat README.md untuk opsi CLI)
const path = require('path');
require('./src/env').load(path.join(__dirname, '.env'));

require('./src/cli').main(process.argv.slice(2)).catch((err) => {
  console.error('Fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
