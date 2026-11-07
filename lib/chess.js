'use strict';
/**
 * Mesin catur lengkap (tanpa dependency): aturan resmi (rokade, en passant, promosi, skak/skakmat, remis),
 * parser langkah (koordinat & SAN), dan AI (negamax alpha-beta + iterative deepening + quiescence).
 * Papan: mailbox 120 petak. Bidak: putih positif (1..6 = P N B R Q K), hitam negatif.
 */
const OFF = 7;
const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
const FILES = 'abcdefgh';
const LETTER = ['', 'P', 'N', 'B', 'R', 'Q', 'K'];
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const KNIGHT = [-21, -19, -12, -8, 8, 12, 19, 21];
const BISHOP = [-11, -9, 9, 11];
const ROOK = [-10, -1, 1, 10];
const KING = [-11, -10, -9, -1, 1, 9, 10, 11];

const sq = (name) => 21 + (name.charCodeAt(1) - 49) * 10 + (name.charCodeAt(0) - 97);
const name = (i) => FILES[(i - 21) % 10] + (Math.floor((i - 21) / 10) + 1);
const rankOf = (i) => Math.floor((i - 21) / 10);
const fileOf = (i) => (i - 21) % 10;
const isOn = (i) => i >= 21 && i <= 98 && i % 10 >= 1 && i % 10 <= 8;

const CH = { p: P, n: N, b: B, r: R, q: Q, k: K };

function emptyBoard() {
  const b = new Int8Array(120).fill(OFF);
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) b[21 + r * 10 + f] = 0;
  return b;
}

function parseFen(fen) {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) throw new Error('FEN tidak valid');
  const b = emptyBoard();
  const rows = parts[0].split('/');
  if (rows.length !== 8) throw new Error('FEN tidak valid (baris)');
  const king = [0, 0];
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[7 - r]) {
      if (/\d/.test(ch)) f += Number(ch);
      else {
        const t = CH[ch.toLowerCase()];
        if (!t || f > 7) throw new Error('FEN tidak valid (bidak)');
        const idx = 21 + r * 10 + f;
        b[idx] = ch === ch.toUpperCase() ? t : -t;
        if (t === K) king[ch === ch.toUpperCase() ? 0 : 1] = idx;
        f++;
      }
    }
    if (f !== 8) throw new Error('FEN tidak valid (lebar baris)');
  }
  if (!king[0] || !king[1]) throw new Error('FEN tidak valid (raja)');
  let castle = 0;
  if (parts[2].includes('K')) castle |= 1;
  if (parts[2].includes('Q')) castle |= 2;
  if (parts[2].includes('k')) castle |= 4;
  if (parts[2].includes('q')) castle |= 8;
  return { b, turn: parts[1] === 'b' ? -1 : 1, castle, ep: parts[3] !== '-' ? sq(parts[3]) : 0, half: Number(parts[4]) || 0, full: Number(parts[5]) || 1, king };
}

function toFen(s) {
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = '', empty = 0;
    for (let f = 0; f < 8; f++) {
      const v = s.b[21 + r * 10 + f];
      if (!v) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      const ch = 'pnbrqk'[Math.abs(v) - 1];
      row += v > 0 ? ch.toUpperCase() : ch;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  const c = (s.castle & 1 ? 'K' : '') + (s.castle & 2 ? 'Q' : '') + (s.castle & 4 ? 'k' : '') + (s.castle & 8 ? 'q' : '');
  return `${rows.join('/')} ${s.turn === 1 ? 'w' : 'b'} ${c || '-'} ${s.ep ? name(s.ep) : '-'} ${s.half} ${s.full}`;
}

/** Apakah petak `at` diserang oleh warna `by` (1/-1)? */
function attacked(b, at, by) {
  if (by === 1) { if (b[at - 9] === P || b[at - 11] === P) return true; }
  else if (b[at + 9] === -P || b[at + 11] === -P) return true;
  for (const d of KNIGHT) if (b[at + d] === by * N) return true;
  for (const d of KING) if (b[at + d] === by * K) return true;
  for (const d of BISHOP) {
    let t = at + d;
    while (b[t] === 0) t += d;
    if (b[t] === by * B || b[t] === by * Q) return true;
  }
  for (const d of ROOK) {
    let t = at + d;
    while (b[t] === 0) t += d;
    if (b[t] === by * R || b[t] === by * Q) return true;
  }
  return false;
}

const inCheck = (s) => attacked(s.b, s.king[s.turn === 1 ? 0 : 1], -s.turn);

function pseudo(s) {
  const { b, turn } = s;
  const out = [];
  const push = (from, to, piece, cap, promo = 0, flag = 0) => out.push({ from, to, piece, cap, promo, flag });
  for (let i = 21; i <= 98; i++) {
    const v = b[i];
    if (v === OFF || v === 0 || v * turn < 0) continue;
    const t = Math.abs(v);
    if (t === P) {
      const dir = turn * 10;
      const startRank = turn === 1 ? 1 : 6;
      const lastRank = turn === 1 ? 7 : 0;
      const one = i + dir;
      if (b[one] === 0) {
        if (rankOf(one) === lastRank) for (const pr of [Q, R, B, N]) push(i, one, v, 0, pr);
        else {
          push(i, one, v, 0);
          if (rankOf(i) === startRank && b[one + dir] === 0) push(i, one + dir, v, 0, 0, 1);
        }
      }
      for (const dx of [-1, 1]) {
        const to = i + dir + dx;
        const tv = b[to];
        if (tv === OFF) continue;
        if (tv !== 0 && tv * turn < 0) {
          if (rankOf(to) === lastRank) for (const pr of [Q, R, B, N]) push(i, to, v, tv, pr);
          else push(i, to, v, tv);
        } else if (to === s.ep && s.ep) push(i, to, v, -turn * P, 0, 2);
      }
    } else if (t === N || t === K) {
      for (const d of t === N ? KNIGHT : KING) {
        const to = i + d, tv = b[to];
        if (tv === OFF || tv * turn > 0) continue;
        push(i, to, v, tv);
      }
      if (t === K) {
        const home = turn === 1 ? 25 : 95;
        if (i === home && !attacked(b, home, -turn)) {
          const ks = turn === 1 ? 1 : 4, qs = turn === 1 ? 2 : 8;
          if ((s.castle & ks) && b[home + 1] === 0 && b[home + 2] === 0 && b[home + 3] === turn * R && !attacked(b, home + 1, -turn) && !attacked(b, home + 2, -turn)) push(i, home + 2, v, 0, 0, 3);
          if ((s.castle & qs) && b[home - 1] === 0 && b[home - 2] === 0 && b[home - 3] === 0 && b[home - 4] === turn * R && !attacked(b, home - 1, -turn) && !attacked(b, home - 2, -turn)) push(i, home - 2, v, 0, 0, 4);
        }
      }
    } else {
      const dirs = t === B ? BISHOP : t === R ? ROOK : KING;
      for (const d of dirs) {
        let to = i + d;
        while (b[to] === 0) { push(i, to, v, 0); to += d; }
        if (b[to] !== OFF && b[to] * turn < 0) push(i, to, v, b[to]);
      }
    }
  }
  return out;
}

function make(s, mv) {
  const b = s.b.slice();
  const turn = s.turn;
  const king = s.king.slice();
  let castle = s.castle;
  b[mv.from] = 0;
  b[mv.to] = mv.promo ? turn * mv.promo : mv.piece;
  if (mv.flag === 2) b[mv.to - turn * 10] = 0;
  if (mv.flag === 3) { b[mv.to + 1] = 0; b[mv.to - 1] = turn * R; }
  if (mv.flag === 4) { b[mv.to - 2] = 0; b[mv.to + 1] = turn * R; }
  if (Math.abs(mv.piece) === K) { king[turn === 1 ? 0 : 1] = mv.to; castle &= turn === 1 ? ~3 : ~12; }
  for (const x of [mv.from, mv.to]) {
    if (x === 21) castle &= ~2; else if (x === 28) castle &= ~1; else if (x === 91) castle &= ~8; else if (x === 98) castle &= ~4;
  }
  return {
    b, turn: -turn, castle, king,
    ep: mv.flag === 1 ? mv.from + turn * 10 : 0,
    half: Math.abs(mv.piece) === P || mv.cap ? 0 : s.half + 1,
    full: s.full + (turn === -1 ? 1 : 0),
  };
}

/** Langkah legal: [{...mv, ns}] */
function legal(s) {
  const out = [];
  const ki = s.turn === 1 ? 0 : 1;
  for (const mv of pseudo(s)) {
    const ns = make(s, mv);
    if (!attacked(ns.b, ns.king[ki], -s.turn)) { mv.ns = ns; out.push(mv); }
  }
  return out;
}

function perft(s, depth) {
  if (depth === 0) return 1;
  const moves = legal(s);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft(m.ns, depth - 1);
  return n;
}

function insufficient(s) {
  const minors = [];
  for (let i = 21; i <= 98; i++) {
    const v = s.b[i];
    if (v === OFF || v === 0) continue;
    const t = Math.abs(v);
    if (t === P || t === R || t === Q) return false;
    if (t === N || t === B) minors.push({ t, c: v > 0 ? 1 : -1, sqc: (rankOf(i) + fileOf(i)) % 2 });
  }
  if (minors.length <= 1) return true;
  if (minors.every((m) => m.t === B) && minors.every((m) => m.sqc === minors[0].sqc)) return true;
  return false;
}

/* ------------------------------------- AI ------------------------------------- */

const VAL = [0, 100, 320, 330, 500, 900, 0];
// PST dari sudut pandang putih, indeks [rank 0..7][file 0..7] (rank 0 = baris 1)
const PST = {
  [P]: [[0, 0, 0, 0, 0, 0, 0, 0], [5, 10, 10, -20, -20, 10, 10, 5], [5, -5, -10, 0, 0, -10, -5, 5], [0, 0, 0, 20, 20, 0, 0, 0], [5, 5, 10, 25, 25, 10, 5, 5], [10, 10, 20, 30, 30, 20, 10, 10], [50, 50, 50, 50, 50, 50, 50, 50], [0, 0, 0, 0, 0, 0, 0, 0]],
  [N]: [[-50, -40, -30, -30, -30, -30, -40, -50], [-40, -20, 0, 5, 5, 0, -20, -40], [-30, 5, 10, 15, 15, 10, 5, -30], [-30, 0, 15, 20, 20, 15, 0, -30], [-30, 5, 15, 20, 20, 15, 5, -30], [-30, 0, 10, 15, 15, 10, 0, -30], [-40, -20, 0, 0, 0, 0, -20, -40], [-50, -40, -30, -30, -30, -30, -40, -50]],
  [B]: [[-20, -10, -10, -10, -10, -10, -10, -20], [-10, 5, 0, 0, 0, 0, 5, -10], [-10, 10, 10, 10, 10, 10, 10, -10], [-10, 0, 10, 10, 10, 10, 0, -10], [-10, 5, 5, 10, 10, 5, 5, -10], [-10, 0, 5, 10, 10, 5, 0, -10], [-10, 0, 0, 0, 0, 0, 0, -10], [-20, -10, -10, -10, -10, -10, -10, -20]],
  [R]: [[0, 0, 0, 5, 5, 0, 0, 0], [-5, 0, 0, 0, 0, 0, 0, -5], [-5, 0, 0, 0, 0, 0, 0, -5], [-5, 0, 0, 0, 0, 0, 0, -5], [-5, 0, 0, 0, 0, 0, 0, -5], [-5, 0, 0, 0, 0, 0, 0, -5], [5, 10, 10, 10, 10, 10, 10, 5], [0, 0, 0, 0, 0, 0, 0, 0]],
  [Q]: [[-20, -10, -10, -5, -5, -10, -10, -20], [-10, 0, 5, 0, 0, 0, 0, -10], [-10, 5, 5, 5, 5, 5, 0, -10], [0, 0, 5, 5, 5, 5, 0, -5], [-5, 0, 5, 5, 5, 5, 0, -5], [-10, 0, 5, 5, 5, 5, 0, -10], [-10, 0, 0, 0, 0, 0, 0, -10], [-20, -10, -10, -5, -5, -10, -10, -20]],
  [K]: [[20, 30, 10, 0, 0, 10, 30, 20], [20, 20, 0, 0, 0, 0, 20, 20], [-10, -20, -20, -20, -20, -20, -20, -10], [-20, -30, -30, -40, -40, -30, -30, -20], [-30, -40, -40, -50, -50, -40, -40, -30], [-30, -40, -40, -50, -50, -40, -40, -30], [-30, -40, -40, -50, -50, -40, -40, -30], [-30, -40, -40, -50, -50, -40, -40, -30]],
};

function evaluate(s) {
  let score = 0;
  for (let i = 21; i <= 98; i++) {
    const v = s.b[i];
    if (v === OFF || v === 0) continue;
    const t = Math.abs(v), r = rankOf(i), f = fileOf(i);
    if (v > 0) score += VAL[t] + PST[t][r][f];
    else score -= VAL[t] + PST[t][7 - r][f];
  }
  return score * s.turn; // dari sudut pandang pihak yang jalan
}

const MATE = 100000;
const order = (moves) => moves.sort((a, c) => (c.cap ? 10 * VAL[Math.abs(c.cap)] - VAL[Math.abs(c.piece)] : 0) + (c.promo ? 800 : 0) - ((a.cap ? 10 * VAL[Math.abs(a.cap)] - VAL[Math.abs(a.piece)] : 0) + (a.promo ? 800 : 0)));

class Timeout extends Error {}

function search(s, depth, alpha, beta, ply, ctx) {
  if ((++ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) throw new Timeout();
  if (depth <= 0) return quiesce(s, alpha, beta, ctx, 0);
  const moves = order(legal(s));
  if (!moves.length) return inCheck(s) ? -MATE + ply : 0;
  if (s.half >= 100 || insufficient(s)) return 0;
  let best = -Infinity;
  for (const m of moves) {
    const sc = -search(m.ns, depth - 1, -beta, -alpha, ply + 1, ctx);
    if (sc > best) best = sc;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function quiesce(s, alpha, beta, ctx, qd) {
  const stand = evaluate(s);
  if (qd >= 6) return stand;
  if (stand >= beta) return stand;
  if (stand > alpha) alpha = stand;
  const caps = order(legal(s).filter((m) => m.cap || m.promo));
  for (const m of caps) {
    const sc = -quiesce(m.ns, -beta, -alpha, ctx, qd + 1);
    if (sc >= beta) return sc;
    if (sc > alpha) alpha = sc;
  }
  return alpha;
}

const LEVELS = {
  easy: { depth: 1, ms: 300, noise: 90 },
  normal: { depth: 3, ms: 1200, noise: 0 },
  hard: { depth: 5, ms: 3500, noise: 0 },
};

/** Pilih langkah terbaik untuk state `s`. @returns langkah legal (mv) atau null */
function bestMove(s, level = 'normal') {
  const cfg = LEVELS[level] || LEVELS.normal;
  const moves = legal(s);
  if (!moves.length) return null;
  if (moves.length === 1) return moves[0];
  const deadline = Date.now() + cfg.ms;
  let best = order(moves)[0];
  if (cfg.noise) {
    let top = -Infinity;
    for (const m of moves) {
      m.score = -search(m.ns, 0, -MATE, MATE, 1, { nodes: 0, deadline: Infinity }) + Math.random() * cfg.noise;
      if (m.score > top) { top = m.score; best = m; }
    }
    return best;
  }
  for (let d = 1; d <= cfg.depth; d++) {
    const ctx = { nodes: 0, deadline };
    let curBest = null, alpha = -Infinity;
    try {
      const ordered = best ? [best, ...moves.filter((m) => m !== best)] : moves;
      for (const m of ordered) {
        const sc = -search(m.ns, d - 1, -MATE, -alpha, 1, ctx);
        if (sc > alpha) { alpha = sc; curBest = m; }
      }
      best = curBest || best;
      if (alpha > MATE - 100) break; // mat ditemukan
    } catch (e) {
      if (e instanceof Timeout) break;
      throw e;
    }
  }
  return best;
}

/* -------------------------------- kelas Chess -------------------------------- */

class Chess {
  constructor(fen = START_FEN) {
    this.state = parseFen(fen);
    this.initialFen = fen;
    this.stack = []; // { state, san, mv }
    this.keys = [this._key(this.state)];
  }

  _key(s) { return `${Array.from(s.b.subarray(21, 99)).join('')}${s.turn}${s.castle}${s.ep}`; }

  get turn() { return this.state.turn === 1 ? 'w' : 'b'; }
  fen() { return toFen(this.state); }
  inCheck() { return inCheck(this.state); }
  legalMoves() { return legal(this.state); }
  history() { return this.stack.map((h) => h.san); }
  lastMove() { const h = this.stack[this.stack.length - 1]; return h ? { from: name(h.mv.from), to: name(h.mv.to), san: h.san } : null; }

  isCheckmate() { return this.inCheck() && !this.legalMoves().length; }
  isStalemate() { return !this.inCheck() && !this.legalMoves().length; }
  isInsufficientMaterial() { return insufficient(this.state); }
  isFiftyMove() { return this.state.half >= 100; }
  isThreefold() {
    const k = this.keys[this.keys.length - 1];
    return this.keys.filter((x) => x === k).length >= 3;
  }
  isDraw() { return this.isStalemate() || this.isInsufficientMaterial() || this.isFiftyMove() || this.isThreefold(); }
  isGameOver() { return this.isCheckmate() || this.isDraw(); }
  /** @returns {{over:boolean, winner:'w'|'b'|null, reason:string}} */
  result() {
    if (this.isCheckmate()) return { over: true, winner: this.turn === 'w' ? 'b' : 'w', reason: 'skakmat' };
    if (this.isStalemate()) return { over: true, winner: null, reason: 'stalemate (remis)' };
    if (this.isInsufficientMaterial()) return { over: true, winner: null, reason: 'material tidak cukup (remis)' };
    if (this.isThreefold()) return { over: true, winner: null, reason: 'posisi berulang 3x (remis)' };
    if (this.isFiftyMove()) return { over: true, winner: null, reason: 'aturan 50 langkah (remis)' };
    return { over: false, winner: null, reason: '' };
  }

  /** Papan 8x8, baris pertama = rank 8. Isi: { type:'p'|'n'|..., color:'w'|'b' } atau null. */
  board() {
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      const row = [];
      for (let f = 0; f < 8; f++) {
        const v = this.state.b[21 + r * 10 + f];
        row.push(v ? { type: 'pnbrqk'[Math.abs(v) - 1], color: v > 0 ? 'w' : 'b' } : null);
      }
      rows.push(row);
    }
    return rows;
  }

  _san(mv, moves) {
    if (mv.flag === 3) return 'O-O' + this._suffix(mv);
    if (mv.flag === 4) return 'O-O-O' + this._suffix(mv);
    const t = Math.abs(mv.piece);
    let s = '';
    if (t === P) {
      if (mv.cap) s += FILES[fileOf(mv.from)] + 'x';
      s += name(mv.to);
      if (mv.promo) s += '=' + LETTER[mv.promo];
    } else {
      s += LETTER[t];
      const others = moves.filter((o) => o !== mv && o.to === mv.to && Math.abs(o.piece) === t);
      if (others.length) {
        if (!others.some((o) => fileOf(o.from) === fileOf(mv.from))) s += FILES[fileOf(mv.from)];
        else if (!others.some((o) => rankOf(o.from) === rankOf(mv.from))) s += rankOf(mv.from) + 1;
        else s += name(mv.from);
      }
      if (mv.cap) s += 'x';
      s += name(mv.to);
    }
    return s + this._suffix(mv);
  }
  _suffix(mv) {
    const ns = mv.ns || make(this.state, mv);
    if (!inCheck(ns)) return '';
    return legal(ns).length ? '+' : '#';
  }

  /** Daftar langkah legal berbentuk polos. */
  moves() {
    const ms = this.legalMoves();
    return ms.map((m) => ({ from: name(m.from), to: name(m.to), piece: 'pnbrqk'[Math.abs(m.piece) - 1], captured: !!m.cap, promotion: m.promo ? 'pnbrqk'[m.promo - 1] : undefined, san: this._san(m, ms) }));
  }

  /**
   * Cari langkah dari teks pengguna: "e2e4", "e2 e4", "e4", "Nf3", "exd5", "O-O", "e7e8q", "e8=Q".
   * @returns {{mv?:object, error?:string}}
   */
  parse(input) {
    const raw = String(input || '').trim();
    if (!raw) return { error: 'langkah kosong' };
    const moves = this.legalMoves();
    let clean = raw.replace(/[\s\-x:+#!?]/g, '').replace('=', '');
    clean = clean.replace(/^[NBRQK](?=[a-h][1-8][a-h][1-8][qrbn]?$)/i, '');
    const castleKey = raw.replace(/[\s+#!?]/g, '').toLowerCase().replace(/0/g, 'o');
    if (/^o-?o-?o$/.test(castleKey)) { const m = moves.find((x) => x.flag === 4); return m ? { mv: m } : { error: 'rokade panjang tidak legal sekarang' }; }
    if (/^o-?o$/.test(castleKey)) { const m = moves.find((x) => x.flag === 3); return m ? { mv: m } : { error: 'rokade pendek tidak legal sekarang' }; }

    const coord = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i.exec(clean);
    if (coord) {
      const from = sq(coord[1].toLowerCase()), to = sq(coord[2].toLowerCase());
      const cands = moves.filter((m) => m.from === from && m.to === to);
      if (!cands.length) return { error: `langkah ${coord[1].toLowerCase()}→${coord[2].toLowerCase()} tidak legal` };
      if (cands.length === 1) return { mv: cands[0] };
      const pr = coord[3] ? CH[coord[3].toLowerCase()] : Q;
      return { mv: cands.find((m) => m.promo === pr) || cands[0] };
    }
    const strip = (san) => san.replace(/[x+#=]/g, '');
    const entries = moves.map((m) => ({ m, san: strip(this._san(m, moves)) }));
    let hit = entries.filter((e) => e.san === clean);
    if (!hit.length) hit = entries.filter((e) => e.san.toLowerCase() === clean.toLowerCase());
    if (hit.length === 1) return { mv: hit[0].m };
    if (hit.length > 1) return { error: `langkah ambigu, tulis lengkap (mis. ${hit.slice(0, 2).map((h) => name(h.m.from) + name(h.m.to)).join(' / ')})` };
    return { error: `langkah "${raw}" tidak dikenali atau tidak legal` };
  }

  /** Jalankan langkah (teks / objek mv dari parse). @returns {{san, from, to, captured}} atau {error} */
  move(input) {
    const r = typeof input === 'string' ? this.parse(input) : { mv: input };
    if (r.error) return { error: r.error };
    const moves = this.legalMoves();
    const mv = moves.find((m) => m.from === r.mv.from && m.to === r.mv.to && m.promo === r.mv.promo);
    if (!mv) return { error: 'langkah tidak legal' };
    const san = this._san(mv, moves);
    this.stack.push({ state: this.state, san, mv });
    this.state = mv.ns;
    this.keys.push(this._key(this.state));
    return { san, from: name(mv.from), to: name(mv.to), captured: !!mv.cap, uci: name(mv.from) + name(mv.to) + (mv.promo ? 'pnbrqk'[mv.promo - 1] : '') };
  }

  undo() {
    const h = this.stack.pop();
    if (!h) return false;
    this.state = h.state;
    this.keys.pop();
    return true;
  }

  /** Langkah terbaik AI (tidak dijalankan). */
  suggest(level = 'normal') { return bestMove(this.state, level); }
  aiMove(level = 'normal') {
    const mv = this.suggest(level);
    return mv ? this.move(mv) : { error: 'tidak ada langkah' };
  }
  sanOf(mv) { return this._san(mv, this.legalMoves()); }
}

module.exports = { Chess, START_FEN, perft: (fen, d) => perft(parseFen(fen), d), LEVELS };
