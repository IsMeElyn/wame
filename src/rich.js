'use strict';
/**
 * Renderer template HTML -> Rich Message (richResponse) WhatsApp.
 *
 * Template disimpan di folder `views/*.html` sehingga file JS bebas dari markup. Contoh:
 *
 *   <rich disclaimer="Statistik">
 *     <h2>Halo {{name|upper}}</h2>
 *     <p>Total: <b>{{count|num}}</b></p>
 *     <table title="Daftar">
 *       <tr><th>No</th><th>Nama</th></tr>
 *       <for each="items" as="it"><tr><td>{{@n}}</td><td>{{it.name}}</td></tr></for>
 *     </table>
 *     <pre lang="javascript">{{code}}</pre>
 *   </rich>
 *
 * Tag blok : h1-h6, p, ul/ol/li, hr, br, blockquote, pre[lang], table[title]/tr/th/td, include[name]
 * Tag inline: b/strong, i/em, s/del, code, a[href], span
 * Logika    : <for each="path" as="x" [limit="N"] [reverse]>, <if test="path">, <if not="path">,
 *             <if eq="path" value="x">, <unless test="path">
 * Variabel  : {{path.ke.nilai}}  {{path|filter:arg|filter2}}  — loop menyediakan {{@n}} (1..), {{@index}}, {{@first}}, {{@last}}
 * Filter    : upper lower trunc:N bytes num date time datetime dur pad:N padl:N json default:x len
 *
 * Hasil render: { content, text, blocks }
 *   content = bentuk siap kirim:  { disclaimerText, richResponse: [...] }
 *   text    = cadangan teks WhatsApp biasa (bila Rich Message dimatikan / gagal)
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const U = require('./utils');

const VOID = new Set(['br', 'hr', 'include', 'img']);
const tplCache = new Map();

/* ------------------------------------- parser ------------------------------------- */

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function parseAttrs(str) {
  const attrs = {};
  const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(str || ''))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

function parse(src) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  let m;
  const pushText = (t) => { if (t) stack[stack.length - 1].children.push({ text: t }); };
  while ((m = re.exec(src))) {
    if (m.index > last) pushText(src.slice(last, m.index));
    last = re.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
    } else {
      const node = { tag, attrs: parseAttrs(m[3]), children: [] };
      stack[stack.length - 1].children.push(node);
      if (!VOID.has(tag) && !m[4]) stack.push(node);
    }
  }
  if (last < src.length) pushText(src.slice(last));
  return root;
}

function loadTemplate(name) {
  if (!/^[a-z0-9_\-/]+$/i.test(name)) throw new Error(`nama template tidak valid: ${name}`);
  const file = path.join(paths.VIEWS, `${name}.html`);
  const st = fs.statSync(file);
  const c = tplCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.tree;
  const tree = parse(fs.readFileSync(file, 'utf8'));
  tplCache.set(file, { mtime: st.mtimeMs, tree });
  return tree;
}
function exists(name) {
  try { return fs.existsSync(path.join(paths.VIEWS, `${name}.html`)); } catch { return false; }
}
function list() {
  try { return fs.readdirSync(paths.VIEWS).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)); } catch { return []; }
}

/* ------------------------------ variabel & filter ------------------------------ */

const FILTERS = {
  upper: (v) => String(v ?? '').toUpperCase(),
  lower: (v) => String(v ?? '').toLowerCase(),
  trunc: (v, n) => U.truncate(v, Number(n) || 40),
  bytes: (v) => U.formatBytes(v),
  num: (v) => (Number(v) || 0).toLocaleString('id-ID'),
  date: (v) => (v ? U.formatDate(v) : '-'),
  time: (v) => (v ? U.formatTime(v) : '-'),
  datetime: (v) => (v ? U.formatDateTime(v) : '-'),
  dur: (v) => U.formatDuration(v),
  pad: (v, n) => String(v ?? '').padEnd(Number(n) || 0),
  padl: (v, n) => String(v ?? '').padStart(Number(n) || 0),
  json: (v) => JSON.stringify(v),
  default: (v, d) => (v === undefined || v === null || v === '' ? d : v),
  len: (v) => (v == null ? 0 : v.length ?? Object.keys(v).length),
  oneline: (v) => String(v ?? '').replace(/\s+/g, ' ').trim(),
};

function resolvePath(p, scope) {
  p = p.trim();
  if (p === '') return undefined;
  if (/^'.*'$|^".*"$/.test(p)) return p.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(p)) return Number(p);
  if (p === 'true') return true;
  if (p === 'false') return false;
  let cur = scope;
  for (const part of p.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function stringify(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function interpolate(text, scope) {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    const [pathExpr, ...filters] = expr.split('|');
    let v = resolvePath(pathExpr, scope);
    for (const f of filters) {
      const [fname, ...rest] = f.trim().split(':');
      const fn = FILTERS[fname.trim()];
      if (fn) v = fn(v, rest.join(':'));
    }
    return stringify(v);
  });
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return !!v;
}
function checkCond(node, scope) {
  const a = node.attrs;
  if ('test' in a) return truthy(resolvePath(a.test, scope));
  if ('not' in a) return !truthy(resolvePath(a.not, scope));
  if ('eq' in a) return String(resolvePath(a.eq, scope)) === String(a.value);
  if ('ne' in a) return String(resolvePath(a.ne, scope)) !== String(a.value);
  if ('gt' in a) return Number(resolvePath(a.gt, scope)) > Number(a.value);
  return true;
}

function loopScopes(node, scope) {
  let arr = resolvePath(node.attrs.each || '', scope);
  if (arr && !Array.isArray(arr) && typeof arr === 'object') arr = Object.entries(arr).map(([key, value]) => ({ key, value }));
  if (!Array.isArray(arr)) return [];
  arr = arr.slice();
  if ('reverse' in node.attrs) arr.reverse();
  if (node.attrs.limit) arr = arr.slice(0, Number(node.attrs.limit));
  const as = node.attrs.as || 'it';
  return arr.map((item, i) => ({ ...scope, [as]: item, '@index': i, '@n': i + 1, '@first': i === 0, '@last': i === arr.length - 1 }));
}

/* ------------------------------------ renderer ------------------------------------ */

const collapse = (s) => s.replace(/\s+/g, ' ');

class Ctx {
  constructor(opts) {
    this.opts = opts;
    this.blocks = []; // {type:'text',value}|{type:'code',lang,code}|{type:'table',title,rows}
    this.disclaimer = opts.disclaimer || '';
    this.depth = 0;
  }
  text(s) {
    const last = this.blocks[this.blocks.length - 1];
    if (last && last.type === 'text') last.lines.push(s);
    else this.blocks.push({ type: 'text', lines: [s] });
  }
}

function inline(nodes, scope, ctx) {
  let out = '';
  for (const n of nodes) {
    if (n.text !== undefined) { out += interpolate(collapse(decodeEntities(n.text)), scope); continue; }
    switch (n.tag) {
      case 'b': case 'strong': out += `**${inline(n.children, scope, ctx).trim()}**`; break;
      case 'i': case 'em': out += `_${inline(n.children, scope, ctx).trim()}_`; break;
      case 's': case 'del': out += `~${inline(n.children, scope, ctx).trim()}~`; break;
      case 'code': out += `\`${inline(n.children, scope, ctx).trim()}\``; break;
      case 'br': out += '\n'; break;
      case 'a': {
        const t = inline(n.children, scope, ctx).trim();
        const href = interpolate(n.attrs.href || '', scope);
        out += !href || t === href ? t || href : `${t} (${href})`;
        break;
      }
      case 'for': for (const s of loopScopes(n, scope)) out += inline(n.children, s, ctx); break;
      case 'if': if (checkCond(n, scope)) out += inline(n.children, scope, ctx); break;
      case 'unless': if (!checkCond(n, scope)) out += inline(n.children, scope, ctx); break;
      default: out += inline(n.children, scope, ctx);
    }
  }
  return out;
}

function rawText(nodes, scope) {
  let s = '';
  for (const n of nodes) {
    if (n.text !== undefined) s += interpolate(decodeEntities(n.text), scope);
    else if (n.tag === 'br') s += '\n';
    else s += rawText(n.children, scope);
  }
  return s.replace(/^\n/, '').replace(/\s+$/, '');
}

function collectItems(nodes, scope, ctx, ordered, items) {
  for (const n of nodes) {
    if (n.text !== undefined) continue;
    if (n.tag === 'li') items.push(inline(n.children, scope, ctx).trim());
    else if (n.tag === 'for') for (const s of loopScopes(n, scope)) collectItems(n.children, s, ctx, ordered, items);
    else if (n.tag === 'if' && checkCond(n, scope)) collectItems(n.children, scope, ctx, ordered, items);
    else if (n.tag === 'unless' && !checkCond(n, scope)) collectItems(n.children, scope, ctx, ordered, items);
  }
  return items;
}

function collectCells(nodes, scope, ctx, row) {
  for (const n of nodes) {
    if (n.text !== undefined) continue;
    if (n.tag === 'td' || n.tag === 'th') {
      if (n.tag === 'th') row.heading = true;
      row.cells.push(inline(n.children, scope, ctx).trim());
    } else if (n.tag === 'for') for (const s of loopScopes(n, scope)) collectCells(n.children, s, ctx, row);
    else if (n.tag === 'if' && checkCond(n, scope)) collectCells(n.children, scope, ctx, row);
    else if (n.tag === 'unless' && !checkCond(n, scope)) collectCells(n.children, scope, ctx, row);
  }
}
function collectRows(nodes, scope, ctx, rows) {
  for (const n of nodes) {
    if (n.text !== undefined) continue;
    if (n.tag === 'tr') {
      const row = { heading: false, cells: [] };
      collectCells(n.children, scope, ctx, row);
      rows.push(row);
    } else if (n.tag === 'for') for (const s of loopScopes(n, scope)) collectRows(n.children, s, ctx, rows);
    else if (n.tag === 'if' && checkCond(n, scope)) collectRows(n.children, scope, ctx, rows);
    else if (n.tag === 'unless' && !checkCond(n, scope)) collectRows(n.children, scope, ctx, rows);
    else collectRows(n.children, scope, ctx, rows); // thead/tbody
  }
  return rows;
}

function walk(nodes, scope, ctx) {
  for (const n of nodes) {
    if (n.text !== undefined) {
      const t = interpolate(collapse(decodeEntities(n.text)), scope).trim();
      if (t) ctx.text(t);
      continue;
    }
    const tag = n.tag;
    if (/^h[1-6]$/.test(tag)) { ctx.text(`${'#'.repeat(Number(tag[1]))} ${inline(n.children, scope, ctx).trim()}`); continue; }
    switch (tag) {
      case 'rich':
        if (n.attrs.disclaimer !== undefined) ctx.disclaimer = interpolate(n.attrs.disclaimer, scope);
        walk(n.children, scope, ctx);
        break;
      case 'disclaimer': ctx.disclaimer = inline(n.children, scope, ctx).trim(); break;
      case 'div': case 'section': case 'body': case 'main': walk(n.children, scope, ctx); break;
      case 'p': { const t = inline(n.children, scope, ctx).trim(); if (t) ctx.text(t); break; }
      case 'br': ctx.text(''); break;
      case 'hr': ctx.text('---'); break;
      case 'blockquote': ctx.text(`> ${inline(n.children, scope, ctx).trim()}`); break;
      case 'ul': case 'ol': {
        const items = collectItems(n.children, scope, ctx, tag === 'ol', []);
        items.forEach((it, i) => ctx.text(tag === 'ol' ? `${i + 1}. ${it}` : `- ${it}`));
        break;
      }
      case 'pre': ctx.blocks.push({ type: 'code', lang: n.attrs.lang || n.attrs.language || '', code: rawText(n.children, scope) }); break;
      case 'table': {
        const rows = collectRows(n.children, scope, ctx, []);
        if (rows.length) {
          const width = Math.max(...rows.map((r) => r.cells.length));
          for (const r of rows) while (r.cells.length < width) r.cells.push('');
          if (n.attrs.heading === 'false') rows.forEach((r) => { r.heading = false; });
          else if (!rows.some((r) => r.heading) && n.attrs.heading === 'true') rows[0].heading = true;
          ctx.blocks.push({ type: 'table', title: interpolate(n.attrs.title || '', scope), rows });
        }
        break;
      }
      case 'for': for (const s of loopScopes(n, scope)) walk(n.children, s, ctx); break;
      case 'if': if (checkCond(n, scope)) walk(n.children, scope, ctx); break;
      case 'unless': if (!checkCond(n, scope)) walk(n.children, scope, ctx); break;
      case 'include': {
        if (ctx.depth >= 5) break;
        ctx.depth++;
        try { walk(loadTemplate(n.attrs.name).children, scope, ctx); } finally { ctx.depth--; }
        break;
      }
      default: { // tag inline di level blok -> jadikan satu paragraf
        const t = inline([n], scope, ctx).trim();
        if (t) ctx.text(t);
      }
    }
  }
}

/* ---------------------------------- keluaran ---------------------------------- */

function toWhatsAppMarkdown(s) {
  return s
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^>\s?/gm, '▎ ')
    .replace(/^---$/gm, '────────────');
}

function plainTable(rows) {
  const widths = rows[0].cells.map((_, c) => Math.max(...rows.map((r) => [...String(r.cells[c])].length)));
  return rows
    .map((r, i) => {
      const line = r.cells.map((cell, c) => String(cell) + ' '.repeat(Math.max(0, widths[c] - [...String(cell)].length))).join(' │ ');
      return i === 0 && r.heading ? `${line}\n${widths.map((w) => '─'.repeat(w)).join('─┼─')}` : line;
    })
    .join('\n');
}

function build(ctx, opts) {
  const richResponse = [];
  const textParts = [];
  for (const b of ctx.blocks) {
    if (b.type === 'text') {
      const value = b.lines.join('\n').trim();
      if (!value) continue;
      richResponse.push({ text: value });
      textParts.push(toWhatsAppMarkdown(value));
    } else if (b.type === 'code') {
      const lang = b.lang || 'text';
      let code;
      try { code = opts.tokenize ? opts.tokenize(b.code, lang) : null; } catch { code = null; }
      if (!Array.isArray(code) || !code.length) code = [{ highlightType: 0, codeContent: b.code }];
      richResponse.push({ language: lang, code });
      textParts.push('```\n' + b.code + '\n```');
    } else if (b.type === 'table') {
      richResponse.push({ title: b.title || '', table: b.rows.map((r) => ({ isHeading: r.heading, items: r.cells })) });
      textParts.push((b.title ? `*${b.title}*\n` : '') + '```\n' + plainTable(b.rows) + '\n```');
    }
  }
  if (!richResponse.length) richResponse.push({ text: ' ' });
  const content = { richResponse };
  if (ctx.disclaimer) content.disclaimerText = ctx.disclaimer;
  return { content, text: textParts.join('\n\n'), blocks: ctx.blocks };
}

function renderString(src, vars = {}, opts = {}) {
  const ctx = new Ctx(opts);
  walk(parse(src).children, vars, ctx);
  return build(ctx, opts);
}

/** @param {string} name nama file di views/ tanpa .html */
function render(name, vars = {}, opts = {}) {
  const ctx = new Ctx(opts);
  walk(loadTemplate(name).children, vars, ctx);
  return build(ctx, opts);
}

module.exports = { render, renderString, parse, exists, list, toWhatsAppMarkdown, FILTERS };
