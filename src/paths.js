'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.resolve(process.env.BOT_DATA_DIR || path.join(ROOT, 'data'));

const paths = {
  ROOT,
  DATA,
  SRC: __dirname,
  PLUGINS: path.join(ROOT, 'plugins'),
  VIEWS: path.join(ROOT, 'views'), // template HTML untuk Rich Message
  LIB: path.join(ROOT, 'lib'),
  DB: path.join(DATA, 'db'),
  ACCOUNT_DB: path.join(DATA, 'db', 'accounts'),
  LOGS: path.join(DATA, 'logs'),
  AUTH: path.join(DATA, 'auth'),
  BACKUPS: path.join(DATA, 'backups'),
  TMP: path.join(DATA, 'tmp'),
  SECRET_FILE: path.join(DATA, '.secret'),
  ensure() {
    for (const k of ['DATA', 'DB', 'ACCOUNT_DB', 'LOGS', 'AUTH', 'BACKUPS', 'TMP', 'PLUGINS', 'VIEWS']) {
      fs.mkdirSync(paths[k], { recursive: true });
    }
  },
};

module.exports = paths;
