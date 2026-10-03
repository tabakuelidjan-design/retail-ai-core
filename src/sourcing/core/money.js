// Money for the sourcing calculators: integer minor units (cents), decimal strings parsed WITHOUT float error, rates as percent -> basis points.
// Rounding is half away from zero, applied once per derived line and documented in the result. No FX is ever assumed (see landed.js).
export class MoneyError extends Error { constructor(code, message) { super(message ?? code); this.name = 'MoneyError'; this.code = code; } }

/** '4.20' | 4.2 | '1 234,50' -> 420 minor units. Throws on garbage; returns null for null/undefined/''. */
export function toMinor(x) {
  if (x === null || x === undefined || x === '') return null;
  if (typeof x === 'number') { if (!Number.isFinite(x)) throw new MoneyError('AMOUNT_INVALID', String(x)); return roundHalfAway(x * 100); }
  const s = String(x).trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new MoneyError('AMOUNT_INVALID', String(x));
  const neg = s.startsWith('-'); const [i, f = ''] = s.replace('-', '').split('.');
  const frac = (f + '00').slice(0, 2); const rest = f.length > 2 ? Number(`0.${f.slice(2)}`) : 0;
  const base = Number(i) * 100 + Number(frac) + (rest >= 0.5 ? 1 : 0);
  return neg ? -base : base;
}
export const roundHalfAway = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));
export const fromMinor = (m) => (m === null || m === undefined ? null : Math.round(m) / 100);
export const fmt = (m, cur = 'EUR') => (m === null || m === undefined ? '-' : `${(Math.round(m) / 100).toFixed(2)} ${cur}`);
/** percent (21 or '21') -> basis points (2100). */
export const pctToBps = (p) => { if (p === null || p === undefined || p === '') return null; const n = Number(String(p).replace(',', '.')); if (!Number.isFinite(n)) throw new MoneyError('RATE_INVALID', String(p)); return roundHalfAway(n * 100); };
/** minor units x basis points -> minor units (half away from zero). */
export const applyBps = (minor, bps) => roundHalfAway((minor * bps) / 10000);
