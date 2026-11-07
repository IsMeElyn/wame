'use strict';
/** .sw  -> jadikan foto/video (atau teks) sebagai Status WhatsApp.   .here -> kirim ulang media/dokumen oleh BotNoi dengan caption baru. */

/* ---------- deteksi tipe sebenarnya dari dokumen (mime -> ekstensi -> magic bytes) ---------- */
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg; codecs=opus', oga: 'audio/ogg', flac: 'audio/flac',
};
const GENERIC = /^(application\/(octet-stream|x-unknown|binary)|)$/i;

function sniff(buf) {
  if (!buf || buf.length < 12) return '';
  const h = (a, o = 0) => a.every((v, i) => buf[o + i] === v);
  if (h([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (h([0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (h([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buf.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  if (h([0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'M4A ') return 'audio/mp4';
    if (/^3g/.test(brand)) return 'video/3gpp';
    return 'video/mp4';
  }
  return '';
}

/** Kembalikan { kind: 'image'|'video'|'audio'|'document', mimetype } untuk dokumen yang dikirim user. */
function classifyDocument(media, buffer) {
  let mime = String(media.mimetype || '').toLowerCase().split(';')[0].trim();
  if (GENERIC.test(mime)) {
    const ext = String(media.fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    mime = (ext && EXT_MIME[ext[1]] || '').split(';')[0] || sniff(buffer) || mime;
  }
  const kind = /^image\//.test(mime) ? 'image' : /^video\//.test(mime) ? 'video' : /^audio\//.test(mime) ? 'audio' : 'document';
  // format gambar yang tidak bisa ditampilkan sebagai foto WhatsApp tetap dikirim sebagai dokumen
  if (kind === 'image' && !/^image\/(jpeg|png|webp|gif)$/.test(mime)) return { kind: 'document', mimetype: mime };
  return { kind, mimetype: mime };
}

const COLORS = ['#128C7E', '#7D3C98', '#B9770E', '#1F618D', '#922B21', '#117A65', '#34495E'];

module.exports = {
  name: 'status-tools',
  version: '1.0.0',
  description: 'Posting status WhatsApp (.sw) dan kirim ulang media (.here)',
  category: 'Media',
  config: {
    defaults: { deleteOriginal: false },
    schema: { deleteOriginal: { type: 'boolean' } },
  },
  commands: [
    {
      name: 'sw', usage: '.sw <caption> (+ foto/video)', description: 'Jadikan foto/video sebagai status WhatsApp dengan caption',
      async run(ctx, m) {
        const media = m.target;
        const caption = m.argText;
        const audience = ctx.session.raw.getStatusAudience();
        const opts = { statusJidList: audience, broadcast: true };
        if (audience.length < 2) await m.reply('ℹ️ Bot belum mengenal kontak (hanya diri sendiri). Status tetap diposting, tapi daftar penerima akan bertambah seiring bot melihat chat/kontak.');

        if (!media || !['image', 'video'].includes(media.type)) {
          if (!caption) return m.reply('Kirim *foto/video* dengan caption `.sw Halooo!!` (atau reply foto/video dengan `.sw Halooo!!`).\nTeks saja juga bisa: `.sw teks status`.');
          await ctx.sendMessage('status@broadcast', { text: caption }, { ...opts, backgroundColor: COLORS[Math.floor(Math.random() * COLORS.length)], font: 1 });
          await m.react('✅');
          return m.reply(`✅ Status teks diposting ke ${audience.length} penerima.`);
        }
        await m.react('⏳');
        const buffer = await m.download();
        const content = media.type === 'image' ? { image: buffer, caption } : { video: buffer, caption, mimetype: media.mimetype || 'video/mp4' };
        await ctx.sendMessage('status@broadcast', content, opts);
        await m.react('✅');
        await m.reply(`✅ Status ${media.type === 'image' ? 'foto' : 'video'} diposting${caption ? ` dengan caption "${caption}"` : ''} ke ${audience.length} penerima.`);
      },
    },
    {
      name: 'here', usage: '.here <caption> (+ media/dokumen)', description: 'Kirim ulang media; dokumen foto/video/audio dikirim sebagai foto/video/audio',
      async run(ctx, m) {
        const media = m.target;
        if (!media) return m.reply('Kirim media/dokumen dengan caption `.here Holaa!` atau reply media dengan `.here Holaa!`.');
        const caption = m.argText;
        const buffer = await m.download();
        let kind = media.type, mimetype = media.mimetype;
        if (media.type === 'document') ({ kind, mimetype } = classifyDocument(media, buffer));
        const asDocument = { document: buffer, mimetype: media.mimetype || mimetype || 'application/octet-stream', fileName: media.fileName || 'file', caption };
        let content;
        switch (kind) {
          case 'image': content = { image: buffer, caption }; break;
          case 'video': content = { video: buffer, caption, gifPlayback: media.gif, ptv: media.ptv, mimetype: mimetype || 'video/mp4' }; break;
          case 'audio': content = { audio: buffer, mimetype: mimetype || 'audio/mpeg', ptt: media.type === 'audio' ? media.ptt : false }; break;
          case 'sticker': content = { sticker: buffer }; break;
          default: content = asDocument;
        }
        try {
          await ctx.sendMessage(m.chat, content);
        } catch (err) {
          // dokumen yang gagal dikirim sebagai media (format tidak didukung) -> kirim apa adanya sebagai dokumen
          if (content === asDocument) throw err;
          ctx.logger.warn({ event: 'here.fallback', kind, mimetype, err }, `Gagal kirim sebagai ${kind}, kirim sebagai dokumen: ${err.message}`);
          await ctx.sendMessage(m.chat, asDocument);
          kind = 'document';
        }
        if ((kind === 'audio' || kind === 'sticker') && caption) await ctx.sendMessage(m.chat, { text: caption });
        if (m.isBotNoi && ctx.config.get('deleteOriginal')) await ctx.send.delete(m);
      },
    },
  ],
};
