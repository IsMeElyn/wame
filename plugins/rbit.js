'use strict';
/**
 * .rbit — kompres video/dokumen video (turunkan bitrate) agar jauh lebih kecil tapi tetap HD & lancar.
 * Pakai ffmpeg: H.264 CRF terbatas (-maxrate) + skala maks 720p + AAC. Contoh target: 48MB -> ~19MB.
 *  .rbit            otomatis (±40% dari ukuran asli, maks 720p)
 *  .rbit 19         target ±19 MB      .rbit 30%    target 30% dari asli
 *  .rbit 1080p      pertahankan hingga 1080p      .rbit hd = 720p
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function run(cmd, args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (onStdout) onStdout(String(d)); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

async function probe(file) {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  if (!v) throw new Error('tidak ada track video');
  return {
    duration: Number(j.format.duration) || Number(v.duration) || 0,
    width: v.width, height: v.height, hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'),
    bitrateKbps: Math.round((Number(j.format.bit_rate) || 0) / 1000), size: Number(j.format.size) || 0,
  };
}

function parseOptions(args, cfg) {
  const o = { ratio: cfg.ratio, targetMb: 0, maxHeight: cfg.maxHeight };
  for (const a of args) {
    let m;
    if ((m = /^(\d+(?:\.\d+)?)\s*mb?$/i.exec(a))) o.targetMb = Number(m[1]);
    else if ((m = /^(\d+(?:\.\d+)?)%$/.exec(a))) o.ratio = Math.min(0.95, Math.max(0.05, Number(m[1]) / 100));
    else if ((m = /^(\d{3,4})p$/i.exec(a))) o.maxHeight = Number(m[1]);
    else if (/^hd$/i.test(a)) o.maxHeight = 720;
    else if (/^fhd$/i.test(a)) o.maxHeight = 1080;
    else if ((m = /^(\d+(?:\.\d+)?)$/.exec(a))) o.targetMb = Number(m[1]);
  }
  return o;
}

const fmtMb = (b) => `${(b / 1048576).toFixed(1)} MB`;

module.exports = {
  name: 'rbit',
  version: '1.0.0',
  description: 'Kompres video/dokumen video (bitrate) tetap HD & ringan memakai ffmpeg',
  category: 'Media',
  config: {
    defaults: { ratio: 0.4, maxHeight: 720, crf: 26, preset: 'veryfast', audioKbps: 96, concurrency: 1, maxInputMb: 1500 },
    schema: {
      ratio: { type: 'number', min: 0.05, max: 0.95 }, maxHeight: { type: 'number', min: 240, max: 2160 }, crf: { type: 'number', min: 18, max: 38 },
      preset: { type: 'enum', values: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'] },
      audioKbps: { type: 'number', min: 32, max: 192 }, concurrency: { type: 'number', min: 1, max: 4 }, maxInputMb: { type: 'number', min: 10, max: 10000 },
    },
  },
  commands: [
    {
      name: 'rbit', aliases: ['compress'], usage: '.rbit [MB|%|720p] (+ video/dokumen)', description: 'Kompres video/dokumen agar kecil tapi tetap HD',
      async run(ctx, m, args) {
        const media = m.target;
        const isVideoDoc = media && media.type === 'document' && (/^video\//.test(media.mimetype) || /\.(mp4|mkv|mov|avi|webm|3gp|m4v)$/i.test(media.fileName));
        if (!media || !(media.type === 'video' || isVideoDoc)) return m.reply('Kirim *video/dokumen video* dengan caption `.rbit` (atau reply videonya).\nOpsi: `.rbit 19` (target MB) · `.rbit 30%` · `.rbit 1080p`');
        const cfg = ctx.config.all();
        if (media.size && media.size > cfg.maxInputMb * 1048576) return m.reply(`❌ File terlalu besar (maks ${cfg.maxInputMb} MB).`);
        if (!(await ctx.utils.hasBinary('ffmpeg')) || !(await ctx.utils.hasBinary('ffprobe'))) return m.reply('❌ ffmpeg/ffprobe belum terpasang di server.');
        const opt = parseOptions(args, cfg);

        const queue = ctx.utils.semaphore('ffmpeg', cfg.concurrency);
        const waiting = queue.active >= cfg.concurrency ? `\n⏳ Antrean: ${queue.waiting + 1}` : '';
        const status = await m.reply(`🗜️ Memproses video…${waiting}`);
        const edit = (t) => ctx.send.edit(m.chat, status.key, t).catch(() => {});
        const input = ctx.utils.tmpFile(path.extname(media.fileName || '') || '.mp4');
        const output = ctx.utils.tmpFile('.mp4');

        try {
          await queue.run(async () => {
            await edit('⬇️ Mengunduh video…');
            await m.downloadTo(input);
            const info = await probe(input);
            const origBytes = fs.statSync(input).size;
            const target = opt.targetMb ? opt.targetMb * 1048576 : origBytes * opt.ratio;
            const audioK = info.hasAudio ? (target < 6 * 1048576 ? Math.min(64, cfg.audioKbps) : cfg.audioKbps) : 0;
            const totalK = (target * 8) / 1000 / Math.max(1, info.duration);
            const videoK = Math.max(120, Math.floor(totalK * 0.96 - audioK));
            const height = Math.min(info.height, opt.maxHeight);

            const ffArgs = ['-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
              '-vf', `scale=-2:'min(${opt.maxHeight},ih)'`,
              '-c:v', 'libx264', '-preset', cfg.preset, '-crf', String(cfg.crf), '-maxrate', `${videoK}k`, '-bufsize', `${videoK * 2}k`,
              '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', `${audioK || cfg.audioKbps}k`, '-ac', '2',
              '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-loglevel', 'error', output];
            ctx.logger.info({ event: 'rbit.start', jid: m.chat, origBytes, target: Math.round(target), videoK, audioK, height, duration: info.duration }, `rbit: ${fmtMb(origBytes)} → target ±${fmtMb(target)} (video ${videoK}kbps, ${height}p)`);

            let last = 0;
            await edit(`🗜️ Mengompres ${fmtMb(origBytes)} → ±${fmtMb(target)} (${height}p)…`);
            await run('ffmpeg', ffArgs, {
              onStdout: (chunk) => {
                const mm = /out_time_ms=(\d+)/g; let r, v;
                while ((r = mm.exec(chunk))) v = Number(r[1]);
                if (v && Date.now() - last > 8000) {
                  last = Date.now();
                  const pct = Math.min(99, Math.round((v / 1e6 / info.duration) * 100));
                  edit(`🗜️ Mengompres… ${pct}%`);
                }
              },
            });
            const outBytes = fs.statSync(output).size;
            if (outBytes >= origBytes * 0.97) {
              await edit(`ℹ️ Video sudah cukup ringan (${fmtMb(origBytes)}); hasil kompres ${fmtMb(outBytes)} tidak lebih kecil, jadi tidak dikirim.`);
              return;
            }
            const saved = Math.round((1 - outBytes / origBytes) * 100);
            const caption = `✅ ${fmtMb(origBytes)} → ${fmtMb(outBytes)} (-${saved}%) · ${height}p`;
            await edit('⬆️ Mengunggah hasil…');
            const base = path.basename(media.fileName || 'video', path.extname(media.fileName || '')) || 'video';
            if (media.type === 'document') await ctx.sendMessage(m.chat, { document: { url: output }, mimetype: 'video/mp4', fileName: `${base}-rbit.mp4`, caption }, { quoted: m.raw });
            else await ctx.sendMessage(m.chat, { video: { url: output }, mimetype: 'video/mp4', caption }, { quoted: m.raw });
            await edit(caption);
            ctx.logger.info({ event: 'rbit.done', jid: m.chat, origBytes, outBytes, saved }, `rbit selesai: ${caption}`);
          });
        } catch (err) {
          await edit(`❌ Gagal mengompres: ${err.message}`);
          throw err;
        } finally {
          for (const f of [input, output]) fs.rm(f, { force: true }, () => {});
        }
      },
    },
  ],
};
