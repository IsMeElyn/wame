'use strict';
/** .sw  -> jadikan foto/video (atau teks) sebagai Status WhatsApp.   .here -> kirim ulang media/dokumen oleh BotNoi dengan caption baru. */

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
      name: 'here', usage: '.here <caption> (+ media/dokumen)', description: 'Kirim ulang media/dokumen oleh BotNoi dengan caption baru',
      async run(ctx, m) {
        const media = m.target;
        if (!media) return m.reply('Kirim media/dokumen dengan caption `.here Holaa!` atau reply media dengan `.here Holaa!`.');
        const caption = m.argText;
        const buffer = await m.download();
        let content;
        switch (media.type) {
          case 'image': content = { image: buffer, caption }; break;
          case 'video': content = { video: buffer, caption, gifPlayback: media.gif, ptv: media.ptv, mimetype: media.mimetype || 'video/mp4' }; break;
          case 'audio': content = { audio: buffer, mimetype: media.mimetype || 'audio/mpeg', ptt: media.ptt }; break;
          case 'sticker': content = { sticker: buffer }; break;
          default: content = { document: buffer, mimetype: media.mimetype || 'application/octet-stream', fileName: media.fileName || 'file', caption };
        }
        await ctx.sendMessage(m.chat, content);
        if ((media.type === 'audio' || media.type === 'sticker') && caption) await ctx.sendMessage(m.chat, { text: caption });
        if (m.isBotNoi && ctx.config.get('deleteOriginal')) await ctx.send.delete(m);
      },
    },
  ],
};
