'use strict';
/**
 * Parsing pesan masuk -> objek `m` yang nyaman dipakai plugin, plus ringkasan untuk log.
 * Modul ini hot-reloadable (diakses lewat hot('messages')).
 */
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const U = require('./utils');
const paths = require('./paths');

const MEDIA_KEYS = {
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

const toNum = (v) => (v && typeof v.toNumber === 'function' ? v.toNumber() : Number(v) || 0);

function extractText(content, type) {
  if (!content || !type) return '';
  const inner = content[type];
  switch (type) {
    case 'conversation': return String(inner || '');
    case 'extendedTextMessage': return inner?.text || '';
    case 'imageMessage': case 'videoMessage': case 'documentMessage': return inner?.caption || '';
    case 'buttonsResponseMessage': return inner?.selectedButtonId || inner?.selectedDisplayText || '';
    case 'listResponseMessage': return inner?.singleSelectReply?.selectedRowId || inner?.title || '';
    case 'templateButtonReplyMessage': return inner?.selectedId || inner?.selectedDisplayText || '';
    case 'interactiveResponseMessage': {
      const p = inner?.nativeFlowResponseMessage?.paramsJson;
      if (p) {
        try {
          const j = JSON.parse(p);
          return j.id || j.selectedId || j.row_id || j.description || '';
        } catch { /* bukan JSON */ }
      }
      return inner?.body?.text || '';
    }
    case 'reactionMessage': return inner?.text || '';
    default: return '';
  }
}

function mediaInfo(content, type, source) {
  const kind = MEDIA_KEYS[type];
  if (!kind) return null;
  const inner = content[type] || {};
  return {
    type: kind,
    rawType: type,
    mimetype: inner.mimetype || '',
    fileName: inner.fileName || '',
    size: toNum(inner.fileLength),
    seconds: inner.seconds || 0,
    width: inner.width || 0,
    height: inner.height || 0,
    caption: inner.caption || '',
    gif: !!inner.gifPlayback,
    ptt: !!inner.ptt,
    ptv: type === 'ptvMessage',
    animated: !!inner.isAnimated,
    source, // objek WAMessage-like yang dipakai untuk mengunduh
  };
}

/**
 * Bangun objek `m` dari WAMessage mentah.
 * @param {object} session Session
 * @param {object} raw WAMessage
 * @param {string} upsertType 'notify' | 'append' | ...
 */
function build(session, raw, upsertType) {
  const bl = session.baileys;
  const key = raw.key || {};
  const chat = key.remoteJid || '';
  const isGroup = chat.endsWith('@g.us');
  const content = raw.message ? bl.normalizeMessageContent(raw.message) : undefined;
  const type = content ? bl.getContentType(content) : undefined;
  const inner = content && type ? content[type] : undefined;
  const text = extractText(content, type);

  const fromMe = !!key.fromMe;
  const meJid = session.botJid || '';
  const sender = fromMe ? meJid : isGroup ? key.participant || raw.participant || '' : chat;
  const senderAlt = fromMe ? session.botLid || '' : key.participantPn || key.participantAlt || key.remoteJidAlt || '';
  const senderNumber = U.jidUser(/@s\.whatsapp\.net$/.test(senderAlt) ? senderAlt : sender);

  const prefix = session.getPrefix();
  const trimmed = text.trim();
  let isCommand = false, command = '', argText = '';
  if (trimmed.startsWith(prefix) && trimmed.length > prefix.length) {
    const mm = trimmed.slice(prefix.length).match(/^(\S+)\s*([\s\S]*)$/);
    if (mm) { isCommand = true; command = mm[1].toLowerCase(); argText = mm[2].trim(); }
  }

  const media = content && type ? mediaInfo(content, type, raw) : null;

  // quoted
  let quoted = null;
  const ci = inner && typeof inner === 'object' ? inner.contextInfo : undefined;
  if (ci && ci.quotedMessage) {
    const qContent = bl.normalizeMessageContent(ci.quotedMessage);
    const qType = qContent ? bl.getContentType(qContent) : undefined;
    const qSender = ci.participant || (isGroup ? '' : chat);
    const qRaw = {
      key: { remoteJid: chat, id: ci.stanzaId, participant: ci.participant || undefined, fromMe: session.isBotNoi(ci.participant) },
      message: ci.quotedMessage,
    };
    quoted = {
      id: ci.stanzaId,
      sender: qSender,
      type: qType,
      text: extractText(qContent, qType),
      media: qContent && qType ? mediaInfo(qContent, qType, qRaw) : null,
      raw: qRaw,
    };
  }

  const mentions = (ci && ci.mentionedJid) || [];
  const m = {
    session,
    raw,
    key,
    id: key.id,
    chat,
    jid: chat,
    isGroup,
    fromMe,
    sender,
    senderAlt,
    senderNumber,
    pushName: raw.pushName || '',
    timestamp: toNum(raw.messageTimestamp) * 1000 || Date.now(),
    upsertType,
    type,
    text,
    prefix,
    isCommand,
    command,
    argText,
    args: argText ? argText.split(/\s+/) : [],
    media,
    quoted,
    quotedMedia: quoted ? quoted.media : null,
    mentions,
    isBotNoi: fromMe || session.isBotNoi(sender) || session.isBotNoi(senderAlt),
  };
  /** media pada pesan ini ATAU pada pesan yang di-reply */
  m.target = m.media || m.quotedMedia || null;

  m.reply = (c, opts = {}) => session.sock.sendMessage(chat, typeof c === 'string' ? { text: c } : c, { quoted: raw, ...opts });
  m.react = (emoji) => session.sock.sendMessage(chat, { react: { key, text: emoji } });
  m.download = (which) => download(session, which || m.target);
  m.downloadTo = (file, which) => downloadToFile(session, which || m.target, file);
  m.info = () => info(m);
  return m;
}

async function download(session, media) {
  if (!media || !media.source) throw new Error('tidak ada media untuk diunduh');
  return session.baileys.downloadMediaMessage(media.source, 'buffer', {}, {
    logger: session.baileysLogger,
    reuploadRequest: session.sock.updateMediaMessage,
  });
}

async function downloadToFile(session, media, file) {
  if (!media || !media.source) throw new Error('tidak ada media untuk diunduh');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = await session.baileys.downloadMediaMessage(media.source, 'stream', {}, {
    logger: session.baileysLogger,
    reuploadRequest: session.sock.updateMediaMessage,
  });
  await pipeline(stream, fs.createWriteStream(file));
  return file;
}

function info(m) {
  const pub = (x) => x && { type: x.type, mimetype: x.mimetype, fileName: x.fileName, size: x.size, seconds: x.seconds, caption: x.caption };
  return {
    id: m.id,
    chat: m.chat,
    isGroup: m.isGroup,
    sender: m.sender,
    senderNumber: m.senderNumber,
    pushName: m.pushName,
    fromMe: m.fromMe,
    isBotNoi: m.isBotNoi,
    timestamp: m.timestamp,
    type: m.type,
    text: m.text,
    isCommand: m.isCommand,
    command: m.command,
    media: pub(m.media),
    quoted: m.quoted && { id: m.quoted.id, sender: m.quoted.sender, type: m.quoted.type, text: m.quoted.text, media: pub(m.quoted.media) },
    mentions: m.mentions,
  };
}

/* --------------------------- ringkasan untuk logging --------------------------- */

const SEND_KINDS = [
  'react', 'delete', 'edit', 'forward', 'pin', 'keep', 'album', 'cards', 'richResponse', 'nativeFlow', 'buttons', 'sections',
  'templateButtons', 'poll', 'pollResult', 'event', 'groupInvite', 'contacts', 'location', 'product', 'sticker', 'cover',
  'image', 'video', 'audio', 'document', 'text', 'headerText', 'orderText',
];

function summarizeContent(content) {
  if (!content || typeof content !== 'object') return { kind: typeof content };
  const kind = SEND_KINDS.find((k) => content[k] !== undefined) || Object.keys(content)[0] || 'unknown';
  const out = { kind };
  const text = content.text ?? content.caption ?? content.body ?? content.headerText ?? content.contentText;
  if (typeof text === 'string') out.text = text;
  if (content.fileName) out.fileName = content.fileName;
  if (content.mimetype) out.mimetype = content.mimetype;
  const media = content.image || content.video || content.audio || content.document || content.sticker;
  if (media) out.media = Buffer.isBuffer(media) ? `<bytes:${media.length}>` : media.url ? String(media.url) : media.stream ? '<stream>' : undefined;
  if (Array.isArray(content.richResponse)) out.richBlocks = content.richResponse.length;
  if (Array.isArray(content.buttons)) out.buttons = content.buttons.length;
  if (Array.isArray(content.nativeFlow)) out.nativeFlow = content.nativeFlow.length;
  if (Array.isArray(content.album)) out.albumItems = content.album.length;
  if (Array.isArray(content.cards)) out.cards = content.cards.length;
  if (content.react) out.react = content.react.text;
  if (content.viewOnce) out.viewOnce = true;
  return out;
}

module.exports = { build, extractText, mediaInfo, summarizeContent, download, downloadToFile, info, MEDIA_KEYS };
