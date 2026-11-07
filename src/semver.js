'use strict';
/** Semver mini (cukup untuk versi & dependensi plugin). Rentang: * x.y.z >=x >x <=x <x ^x ~x, dipisah spasi = AND. */
const RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(v) {
  const m = RE.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}
function valid(v) { return parse(v) !== null; }
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
function satisfies(version, range) {
  const v = parse(version);
  if (!v) return false;
  const r = String(range ?? '*').trim();
  if (r === '' || r === '*' || r === 'x') return true;
  return r.split(/\s+/).every((part) => {
    const m = /^(>=|<=|>|<|\^|~|=)?\s*(.+)$/.exec(part);
    if (!m) return false;
    const op = m[1] || '=';
    const t = parse(m[2]);
    if (!t) return false;
    const c = cmp(v, t);
    switch (op) {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      case '=': return c === 0;
      case '^': {
        const upper = t[0] > 0 ? [t[0] + 1, 0, 0] : t[1] > 0 ? [0, t[1] + 1, 0] : [0, 0, t[2] + 1];
        return c >= 0 && cmp(v, upper) < 0;
      }
      case '~': return c >= 0 && cmp(v, [t[0], t[1] + 1, 0]) < 0;
      default: return false;
    }
  });
}

module.exports = { parse, valid, cmp, satisfies };
