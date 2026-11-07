'use strict';
/** .catur — catur lengkap sebagai Rich Message. Mode: lawan AI, atau berdua dalam satu perangkat (duo). Game tersimpan di LowDB. */
const { Chess } = require('../lib/chess');

const GLYPH = { wp: '♙', wn: '♘', wb: '♗', wr: '♖', wq: '♕', wk: '♔', bp: '♟︎', bn: '♞', bb: '♝', br: '♜', bq: '♛', bk: '♚' };
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const MOVE_RE = /^([a-h][1-8]\s?[a-h][1-8][qrbn]?|[nbrqk]?[a-h]?[1-8]?x?[a-h][1-8](=?[qrbn])?|o-o(-o)?|0-0(-0)?)[+#]?$/i;
const LEVEL_ALIAS = { easy: 'easy', mudah: 'easy', normal: 'normal', sedang: 'normal', hard: 'hard', sulit: 'hard', susah: 'hard' };
const COLOR_ALIAS = { putih: 'w', white: 'w', w: 'w', hitam: 'b', black: 'b', b: 'b', acak: 'r', random: 'r' };
const colorName = (c) => (c === 'w' ? '⚪ Putih' : '⚫ Hitam');

const games = (ctx) => (ctx.database.raw.games || (ctx.database.raw.games = {}));
const normUser = (m) => ({ jid: m.sender, number: m.senderNumber });
const isPlayer = (m, p) => !!p && (p.jid === m.sender || p.number === m.senderNumber);

function load(ctx, chat) {
  const meta = games(ctx)[chat];
  if (!meta) return null;
  let entry = ctx.state.cache && ctx.state.cache.get(chat);
  if (!entry || entry.len !== meta.moves.length) {
    const g = new Chess();
    for (const u of meta.moves) g.move(u);
    entry = { g, len: meta.moves.length };
    (ctx.state.cache || (ctx.state.cache = new Map())).set(chat, entry);
  }
  return { g: entry.g, meta };
}
function save(ctx, chat, g, meta) {
  meta.lastAt = Date.now();
  games(ctx)[chat] = meta;
  (ctx.state.cache || (ctx.state.cache = new Map())).set(chat, { g, len: meta.moves.length });
  ctx.database.save();
}
function drop(ctx, chat) {
  delete games(ctx)[chat];
  if (ctx.state.cache) ctx.state.cache.delete(chat);
  ctx.database.save();
}

function captured(g) {
  const have = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const row of g.board()) for (const c of row) if (c && c.type !== 'k') have[c.color][c.type]++;
  const lost = (color) => Object.entries(START_COUNT).map(([t, n]) => GLYPH[color + t].repeat(Math.max(0, n - have[color][t]))).join('');
  const w = lost('w'), b = lost('b');
  return w || b ? `Dimakan — ⚪: ${b || '-'} · ⚫: ${w || '-'}` : '';
}

function view(ctx, g, meta, { lastMoves = [], help = false } = {}) {
  const flipped = meta.flip !== (meta.mode === 'ai' && meta.playerColor === 'b');
  const board = g.board();
  const ranks = flipped ? [...board].reverse() : board;
  const rows = ranks.map((row, i) => {
    const r = flipped ? i + 1 : 8 - i;
    const cells = (flipped ? [...row].reverse() : row).map((c, f) => (c ? GLYPH[c.color + c.type] : '·'));
    return { rank: String(r), cells };
  });
  const files = flipped ? [...'hgfedcba'] : [...'abcdefgh'];
  const res = g.result();
  const n = Math.floor(g.history().length / 2) + 1;
  let statusLine;
  let checkLine = '';
  if (res.over) {
    statusLine = res.winner ? `🏁 ${colorName(res.winner)} menang — ${res.reason}` : `🤝 ${res.reason}`;
  } else {
    const who = meta.mode === 'ai' ? (g.turn === meta.playerColor ? ' (kamu)' : ' (AI)') : '';
    statusLine = `Giliran: ${colorName(g.turn)}${who} · langkah ke-${n}`;
    if (g.inCheck()) checkLine = `⚠️ SKAK! ${colorName(g.turn)} sedang diskak.`;
  }
  if (meta.resigned) { statusLine = `🏳️ ${colorName(meta.resigned)} menyerah — ${colorName(meta.resigned === 'w' ? 'b' : 'w')} menang`; }
  return {
    modeLabel: meta.mode === 'ai' ? `vs AI (${meta.level})` : 'Berdua (1 perangkat)',
    statusLine, boardTitle: `${flipped ? 'Sudut hitam' : 'Sudut putih'}`, files, rows,
    lastMoveLine: lastMoves.filter(Boolean).length ? `Langkah: ${lastMoves.filter(Boolean).join(' → ')}` : '', checkLine, capturedLine: captured(g), help,
  };
}

async function showBoard(ctx, m, g, meta, opts) {
  return ctx.sendRich(m.chat, 'chess', view(ctx, g, meta, opts), { quoted: m.raw });
}

function menu(ctx, m) {
  const p = m.prefix;
  return ctx.sendInteractive(m.chat, {
    text: '♟️ *Catur*\nPilih mode permainan:',
    footer: 'Aturan lengkap: rokade, en passant, promosi, skakmat, remis',
    nativeFlow: [
      { text: '🤖 Lawan AI', id: `${p}catur ai normal` },
      { text: '🧠 AI Sulit', id: `${p}catur ai hard` },
      { text: '👥 Main berdua', id: `${p}catur duo` },
      { text: '❓ Bantuan', id: `${p}catur help` },
    ],
  }, { quoted: m.raw });
}

async function finish(ctx, m, g, meta, opts) {
  await showBoard(ctx, m, g, meta, opts);
  if (g.isGameOver() || meta.resigned) { drop(ctx, m.chat); ctx.logger.info({ event: 'chess.end', jid: m.chat, result: g.result(), moves: g.history().length }, 'Game catur selesai'); }
}

async function doMove(ctx, m, text, { silent = false } = {}) {
  const s = load(ctx, m.chat);
  if (!s) { if (!silent) await m.reply('Belum ada game. Mulai: `.catur ai` atau `.catur duo`'); return false; }
  const { g, meta } = s;
  if (meta.mode === 'ai' && !m.isBotNoi && !isPlayer(m, meta.player)) { if (!silent) await m.reply('⛔ Game ini dimainkan orang lain. Mulai game sendiri setelah `.catur new`.'); return false; }
  if (meta.mode === 'ai' && g.turn !== meta.playerColor) { if (!silent) await m.reply('⏳ Giliran AI.'); return false; }
  const r = g.move(text);
  if (r.error) { if (!silent) await m.reply(`❌ ${r.error}\nLihat langkah legal: .catur moves`); return false; }
  meta.moves.push(r.uci);
  const last = [meta.mode === 'ai' ? `Kamu ${r.san}` : `${colorName(g.turn === 'w' ? 'b' : 'w')} ${r.san}`];
  if (meta.mode === 'ai' && !g.isGameOver()) {
    const a = g.aiMove(meta.level);
    if (!a.error) { meta.moves.push(a.uci); last.push(`AI ${a.san}`); }
  }
  save(ctx, m.chat, g, meta);
  await finish(ctx, m, g, meta, { lastMoves: last });
  return true;
}

async function startGame(ctx, m, meta) {
  if (load(ctx, m.chat)) return m.reply('♟️ Masih ada game berjalan di chat ini. `.catur` untuk melihat papan, `.catur new` untuk mengakhiri & mulai baru.');
  const g = new Chess();
  const full = { ...meta, moves: [], flip: false, startedAt: Date.now(), starter: normUser(m) };
  const last = [];
  if (full.mode === 'ai') {
    full.player = normUser(m);
    if (full.playerColor === 'b') { const a = g.aiMove(full.level); full.moves.push(a.uci); last.push(`AI ${a.san}`); }
  }
  save(ctx, m.chat, g, full);
  ctx.logger.info({ event: 'chess.start', jid: m.chat, mode: full.mode, level: full.level, sender: m.senderNumber }, `Game catur dimulai (${full.mode})`);
  await showBoard(ctx, m, g, full, { help: true, lastMoves: last });
}

const CMD_USAGE = '.catur [ai|duo|moves|undo|hint|flip|fen|resign|new|help]';

async function catur(ctx, m, args) {
  const sub = (args[0] || '').toLowerCase();
  const p = m.prefix;
  switch (sub) {
    case '': case 'status': case 'board': case 'papan': {
      const s = load(ctx, m.chat);
      if (!s) return menu(ctx, m);
      await showBoard(ctx, m, s.g, s.meta, { help: true });
      return ctx.sendInteractive(m.chat, { text: 'Aksi cepat:', nativeFlow: [{ text: '↩️ Undo', id: `${p}catur undo` }, { text: '💡 Saran', id: `${p}catur hint` }, { text: '📋 Langkah legal', id: `${p}catur moves` }, { text: '🏳️ Menyerah', id: `${p}catur resign` }] });
    }
    case 'ai': case 'bot': case 'komputer': {
      let level = 'normal', color = 'w';
      for (const a of args.slice(1).map((x) => x.toLowerCase())) { if (LEVEL_ALIAS[a]) level = LEVEL_ALIAS[a]; else if (COLOR_ALIAS[a]) color = COLOR_ALIAS[a]; }
      if (color === 'r') color = Math.random() < 0.5 ? 'w' : 'b';
      return startGame(ctx, m, { mode: 'ai', level, playerColor: color });
    }
    case 'duo': case 'teman': case '2p': case 'berdua': return startGame(ctx, m, { mode: 'duo' });
    case 'move': case 'm': case 'jalan': return doMove(ctx, m, args.slice(1).join(' '));
    case 'moves': case 'langkah': {
      const s = load(ctx, m.chat);
      if (!s) return m.reply('Belum ada game.');
      const from = (args[1] || '').toLowerCase();
      const list = s.g.moves().filter((x) => !from || x.from === from);
      if (!list.length) return m.reply(from ? `Tidak ada langkah legal dari ${from}.` : 'Tidak ada langkah legal.');
      const byPiece = {};
      for (const x of list) (byPiece[x.piece] ||= []).push(x.san);
      const sym = (pc) => GLYPH[(s.g.turn) + pc] || pc;
      return m.reply(`📋 *Langkah legal (${list.length})*${from ? ` dari ${from}` : ''}\n${Object.entries(byPiece).map(([pc, a]) => `${sym(pc)} ${a.join(' ')}`).join('\n')}`);
    }
    case 'undo': case 'batal': {
      const s = load(ctx, m.chat);
      if (!s || !s.meta.moves.length) return m.reply('Tidak ada langkah untuk dibatalkan.');
      if (s.meta.mode === 'ai' && !m.isBotNoi && !isPlayer(m, s.meta.player)) return m.reply('⛔ Hanya pemain yang bisa undo.');
      s.g.undo(); s.meta.moves.pop();
      if (s.meta.mode === 'ai' && s.g.turn !== s.meta.playerColor && s.meta.moves.length) { s.g.undo(); s.meta.moves.pop(); }
      save(ctx, m.chat, s.g, s.meta);
      return showBoard(ctx, m, s.g, s.meta, { lastMoves: ['↩️ undo'] });
    }
    case 'hint': case 'saran': {
      const s = load(ctx, m.chat);
      if (!s) return m.reply('Belum ada game.');
      const mv = s.g.suggest('hard');
      return m.reply(mv ? `💡 Saran: *${s.g.sanOf(mv)}*` : 'Tidak ada langkah.');
    }
    case 'flip': case 'putar': {
      const s = load(ctx, m.chat);
      if (!s) return m.reply('Belum ada game.');
      s.meta.flip = !s.meta.flip; save(ctx, m.chat, s.g, s.meta);
      return showBoard(ctx, m, s.g, s.meta, {});
    }
    case 'fen': { const s = load(ctx, m.chat); return m.reply(s ? s.g.fen() : 'Belum ada game.'); }
    case 'resign': case 'menyerah': {
      const s = load(ctx, m.chat);
      if (!s) return m.reply('Belum ada game.');
      s.meta.resigned = s.meta.mode === 'ai' ? s.meta.playerColor : s.g.turn;
      return finish(ctx, m, s.g, s.meta, {});
    }
    case 'new': case 'reset': case 'stop': case 'end': case 'akhiri': {
      const s = load(ctx, m.chat);
      if (s && s.meta.mode === 'ai' && !m.isBotNoi && !isPlayer(m, s.meta.player)) return m.reply('⛔ Hanya pemain/BotNoi yang bisa mengakhiri game ini.');
      drop(ctx, m.chat);
      return menu(ctx, m);
    }
    case 'help': case 'bantuan': return ctx.sendRich(m.chat, 'catur-help', {}, { quoted: m.raw });
    default:
      if (MOVE_RE.test(args.join(' '))) return doMove(ctx, m, args.join(' '));
      return m.reply(`Gunakan: ${CMD_USAGE}`);
  }
}

module.exports = {
  name: 'chess',
  version: '1.0.0',
  description: 'Catur lengkap (lawan AI / berdua) dengan papan Rich Message',
  category: 'Game',
  commands: [
    { name: 'catur', aliases: ['chess'], usage: '.catur', description: 'Catur: vs AI atau main berdua (1 perangkat)', run: catur },
    { name: 'm', usage: '.m e2e4', description: 'Langkah catur (juga bisa ketik langsung e2e4 / Nf3)', run: (ctx, m, args) => doMove(ctx, m, args.join(' ')) },
  ],
  events: {
    // langkah tanpa prefix saat game aktif
    async 'message.received'(ctx, { m }) {
      if (m.isCommand || !m.text || m.text.length > 12) return;
      const meta = games(ctx)[m.chat];
      if (!meta) return;
      const t = m.text.trim();
      if (!MOVE_RE.test(t) || !ctx.canRun(m, 'catur')) return;
      await doMove(ctx, m, t, { silent: true });
    },
  },
};
