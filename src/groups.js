'use strict';
/**
 * Layanan grup: cache metadata di LowDB (db.groups), pencarian berdasarkan nama/inisial, daftar anggota.
 * Hot-reloadable — state hanya disimpan di session.db / session._grp.
 */
const U = require('./utils');

function normalize(meta) {
  const parts = (meta.participants || []).map((p) => ({
    id: p.id || p,
    lid: p.lid || (String(p.id || p).endsWith('@lid') ? p.id : undefined),
    phoneNumber: p.phoneNumber || (String(p.id || p).endsWith('@s.whatsapp.net') ? p.id : undefined),
    admin: p.admin || null,
  }));
  return {
    id: meta.id,
    subject: meta.subject || '',
    subjectOwner: meta.subjectOwnerPn || meta.subjectOwner || '',
    subjectTime: meta.subjectTime || 0,
    owner: meta.ownerPn || meta.owner || '',
    desc: meta.desc || '',
    descOwner: meta.descOwnerPn || meta.descOwner || '',
    creation: meta.creation || 0,
    size: meta.size || parts.length,
    announce: !!meta.announce,
    restrict: !!meta.restrict,
    isCommunity: !!meta.isCommunity,
    isCommunityAnnounce: !!meta.isCommunityAnnounce,
    linkedParent: meta.linkedParent || '',
    ephemeralDuration: meta.ephemeralDuration || 0,
    joinApprovalMode: !!meta.joinApprovalMode,
    memberAddMode: meta.memberAddMode || '',
    participants: parts,
    updatedAt: Date.now(),
  };
}

function put(session, meta) {
  if (!meta || !meta.id) return null;
  const g = normalize(meta);
  session.db.data.groups[g.id] = g;
  session.db.save();
  return g;
}

async function refreshAll(session) {
  const all = await session.sock.groupFetchAllParticipating();
  const ids = new Set();
  for (const meta of Object.values(all || {})) { put(session, meta); ids.add(meta.id); }
  for (const jid of Object.keys(session.db.data.groups)) {
    if (!ids.has(jid)) session.db.data.groups[jid].left = true;
    else delete session.db.data.groups[jid].left;
  }
  session.db.save();
  return ids.size;
}

async function refresh(session, jid) {
  const meta = await session.sock.groupMetadata(jid);
  return put(session, meta);
}

/** Ambil dari cache; bila tidak ada / kedaluwarsa, ambil dari WhatsApp. */
async function get(session, jid, { maxAgeMs = 6 * 3600e3, force = false } = {}) {
  const cached = session.db.data.groups[jid];
  if (cached && !force && Date.now() - (cached.updatedAt || 0) < maxAgeMs) return cached;
  try { return await refresh(session, jid); } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

function list(session) {
  return Object.values(session.db.data.groups).filter((g) => !g.left);
}

function name(session, jid) {
  const g = session.db.data.groups[jid];
  return g && g.subject ? g.subject : '';
}

/**
 * Cari grup dari teks: cocok nama persis > awalan nama > inisial kata (mis. "dtl" = "Diskusi Teknologi Lokal")
 * > awalan kata mana pun > mengandung teks. Mengembalikan terurut dari yang paling relevan.
 */
function find(session, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const g of list(session)) {
    const s = (g.subject || '').toLowerCase();
    if (!s) continue;
    const words = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const acronym = words.map((w) => w[0]).join('');
    let score = 0;
    if (s === q) score = 100;
    else if (s.startsWith(q)) score = 80;
    else if (acronym.startsWith(q) && q.length >= 2) score = 70;
    else if (words.some((w) => w.startsWith(q))) score = 60;
    else if (s.includes(q)) score = 40;
    if (score) scored.push({ g, score });
  }
  return scored.sort((a, b) => b.score - a.score || (b.g.size || 0) - (a.g.size || 0)).map((x) => x.g);
}

function displayName(session, jid) {
  if (!jid) return '';
  const c = session.db.data.contacts[U.normalizeJid(jid)];
  return (c && (c.name || c.notify)) || '';
}

function memberRows(session, g) {
  return (g.participants || []).map((p) => {
    const number = p.phoneNumber ? U.jidUser(p.phoneNumber) : p.id.endsWith('@s.whatsapp.net') ? U.jidUser(p.id) : '';
    const nm = displayName(session, p.phoneNumber) || displayName(session, p.id) || displayName(session, p.lid);
    return {
      jid: p.id,
      number: number || `${U.jidUser(p.id)} (lid)`,
      name: nm,
      role: p.admin === 'superadmin' ? 'owner' : p.admin ? 'admin' : 'member',
      isAdmin: !!p.admin,
    };
  });
}

function admins(session, g) {
  return memberRows(session, g).filter((r) => r.isAdmin);
}

/** Terapkan event groups.update (parsial) ke cache. */
function applyUpdate(session, upd) {
  const g = session.db.data.groups[upd.id];
  if (!g) return false;
  for (const k of ['subject', 'desc', 'announce', 'restrict', 'ephemeralDuration', 'joinApprovalMode', 'memberAddMode', 'subjectOwner', 'descOwner']) {
    if (upd[k] !== undefined) g[k] = upd[k];
  }
  g.updatedAt = Date.now();
  session.db.save();
  return true;
}

/** Terapkan event group-participants.update ke cache lalu jadwalkan refresh penuh. */
function applyParticipants(session, ev) {
  const g = session.db.data.groups[ev.id];
  if (g) {
    const ids = (ev.participants || []).map((p) => (typeof p === 'string' ? p : p.id));
    if (ev.action === 'add') {
      for (const p of ev.participants || []) {
        const id = typeof p === 'string' ? p : p.id;
        if (!g.participants.some((x) => x.id === id)) g.participants.push(typeof p === 'string' ? { id, admin: null } : { id, lid: p.lid, phoneNumber: p.phoneNumber, admin: p.admin || null });
      }
    } else if (ev.action === 'remove') g.participants = g.participants.filter((p) => !ids.includes(p.id));
    else if (ev.action === 'promote' || ev.action === 'demote') {
      for (const p of g.participants) if (ids.includes(p.id)) p.admin = ev.action === 'promote' ? 'admin' : null;
    }
    g.size = g.participants.length;
    session.db.save();
  }
  session._grp = session._grp || new Map();
  clearTimeout(session._grp.get(ev.id));
  const t = setTimeout(() => { session._grp.delete(ev.id); refresh(session, ev.id).catch(() => {}); }, 3000);
  if (t.unref) t.unref();
  session._grp.set(ev.id, t);
}

module.exports = { normalize, put, refreshAll, refresh, get, list, name, find, displayName, memberRows, admins, applyUpdate, applyParticipants };
