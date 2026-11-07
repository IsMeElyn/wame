'use strict';
/** Pencatatan statistik per akun ke LowDB (hot-reloadable). */
const U = require('./utils');

const MAX_CHATS = 500;
const MAX_DAYS = 60;

function day() { return U.formatDate(new Date()); }

function touchDay(s, field) {
  const d = day();
  const row = s.perDay[d] || (s.perDay[d] = { rx: 0, tx: 0, cmd: 0 });
  row[field]++;
  const keys = Object.keys(s.perDay);
  if (keys.length > MAX_DAYS) for (const k of keys.sort().slice(0, keys.length - MAX_DAYS)) delete s.perDay[k];
}

function pruneChats(s) {
  const keys = Object.keys(s.perChat);
  if (keys.length <= MAX_CHATS) return;
  keys.sort((a, b) => (s.perChat[a].lastAt || 0) - (s.perChat[b].lastAt || 0));
  for (const k of keys.slice(0, keys.length - MAX_CHATS)) delete s.perChat[k];
}

function chatEntry(s, jid, name) {
  const c = s.perChat[jid] || (s.perChat[jid] = { in: 0, out: 0, name: name || '', lastAt: 0 });
  if (name) c.name = name;
  return c;
}

function recordIn(session, m) {
  const s = session.db.data.stats;
  if (!s.firstSeenAt) s.firstSeenAt = new Date().toISOString();
  s.messagesReceived++;
  touchDay(s, 'rx');
  const c = chatEntry(s, m.chat, m.isGroup ? session.groupName(m.chat) : m.pushName);
  c.in++;
  c.lastAt = Date.now();
  pruneChats(s);
  session.db.save();
}

function recordOut(session, jid) {
  const s = session.db.data.stats;
  s.messagesSent++;
  touchDay(s, 'tx');
  if (typeof jid === 'string' && jid !== 'status@broadcast') {
    const c = chatEntry(s, jid, jid.endsWith('@g.us') ? session.groupName(jid) : undefined);
    c.out++;
    c.lastAt = Date.now();
  }
  session.db.save();
}

function recordCommand(session, name, ok) {
  const s = session.db.data.stats;
  s.commandsRun++;
  if (!ok) s.commandErrors++;
  s.commands[name] = (s.commands[name] || 0) + 1;
  touchDay(s, 'cmd');
  session.db.save();
}

module.exports = { recordIn, recordOut, recordCommand };
