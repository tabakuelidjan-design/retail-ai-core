// Deterministic money arithmetic. Everything is an integer: amounts in minor units (cents), quantity in
// thousandths, unit price in ten-thousandths, rates and percentages in basis points. Nothing here uses
// floating point for money, and nothing here is ever delegated to a language model.

export const QTY_SCALE = 1000n;
export const PRICE_SCALE = 10000n;
export const BP = 10000n;

/** Round-half-up (away from zero) integer division of BigInt values. */
export function divRound(n, d) {
  if (d === 0n) throw new Error('division by zero');
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an * 2n + ad) / (ad * 2n);
  return neg ? -q : q;
}

/** Parse a decimal (string or number) into a scaled integer with at most `decimals` places; null if invalid. */
export function toScaled(value, decimals) {
  if (value === null || value === undefined || value === '') return null;
  const s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[3] ?? '';
  if (frac.length > decimals) return null; // never silently truncate a monetary input
  const scaled = BigInt(m[2] + frac.padEnd(decimals, '0'));
  return Number(m[1] === '-' ? -scaled : scaled);
}

export const toCents = (v) => toScaled(v, 2);
export const toQtyMilli = (v) => toScaled(v, 3);
export const toPriceMicro = (v) => toScaled(v, 4);
export const percentToBp = (v) => toScaled(v, 2);

/** Format minor units as a plain decimal string ("1234.50"). */
export function formatCents(cents) {
  const neg = cents < 0;
  const a = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** Line gross before discount: round(qty * unitPrice) in cents. */
export function lineGrossCents(qtyMilli, priceMicro) {
  return Number(divRound(BigInt(qtyMilli) * BigInt(priceMicro), QTY_SCALE * PRICE_SCALE / 100n));
}

/** Percentage of an amount in cents, rate in basis points, rounded half-up. */
export function percentOfCents(cents, bp) {
  return Number(divRound(BigInt(cents) * BigInt(bp), BP));
}

/** Exact inverse of toScaled: scaled integer -> decimal string, no floating point. */
export function fromScaled(n, decimals) {
  const neg = n < 0;
  const a = String(Math.abs(n)).padStart(decimals + 1, '0');
  const out = decimals ? `${a.slice(0, -decimals)}.${a.slice(-decimals)}` : a;
  return neg ? `-${out}` : out;
}
