// Validation and money helpers for Stock / Achats. No dependency, no float arithmetic on money.
// Money: integer MINOR units (cents) for totals; unit prices in MICRO units (1e-6 of the currency unit) because supplier prices such as 0.035 USD
// do not fit in cents. A line total is round-half-away(qty * micro / 10000) minor units.
import { createHash } from 'node:crypto';
import { fail } from './errors.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
export const isId = (v) => typeof v === 'string' && ID.test(v);
export const reqId = (v, name) => (isId(v) ? v : fail('INVALID_INPUT', `${name} must be an id string`, { field: name }));
export const reqStr = (v, name, { min = 1, max = 500 } = {}) => {
  if (typeof v !== 'string') fail('INVALID_INPUT', `${name} must be a string`, { field: name });
  const t = v.trim();
  if (t.length < min || t.length > max) fail('INVALID_INPUT', `${name} must have ${min}-${max} characters`, { field: name });
  return t;
};
export const optStr = (v, name, o) => (v === undefined || v === null || v === '' ? null : reqStr(v, name, o));
export const reqInt = (v, name, { min = 1, max = 1e9 } = {}) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail('INVALID_INPUT', `${name} must be an integer between ${min} and ${max}`, { field: name });
  return v;
};
export const optInt = (v, name, o) => (v === undefined || v === null ? null : reqInt(v, name, o));
export const reqEnum = (v, name, allowed) => (allowed.includes(v) ? v : fail('INVALID_INPUT', `${name} must be one of ${allowed.join(', ')}`, { field: name, value: v }));
export const reqCurrency = (v, name = 'currency') => (typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : fail('INVALID_INPUT', `${name} must be an ISO 4217 code`, { field: name }));
export function reqDate(v, name) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) fail('INVALID_INPUT', `${name} must be a real YYYY-MM-DD date`, { field: name });
  return v;
}
export const optDate = (v, name) => (v === undefined || v === null ? null : reqDate(v, name));

/** "0.035" -> 35000. Decimal strings only (at most 6 decimals): a JS number is refused because binary-float errors must never reach money. */
export function microOf(v, name = 'price') {
  if (typeof v !== 'string' || !/^\d{1,9}(\.\d{1,6})?$/.test(v)) fail('INVALID_INPUT', `${name} must be a decimal string with at most 6 decimals`, { field: name });
  const [i, f = ''] = v.split('.');
  const micro = Number(i) * 1e6 + Number(f.padEnd(6, '0'));
  if (!Number.isSafeInteger(micro) || micro <= 0) fail('INVALID_INPUT', `${name} must be greater than zero`, { field: name });
  return micro;
}
export const microToString = (m) => `${Math.floor(m / 1e6)}.${String(m % 1e6).padStart(6, '0')}`.replace(/0+$/, '').replace(/\.$/, '.0');
/** qty * unit price (micro) -> minor units, round half away from zero, exact via BigInt. */
export function lineTotalMinor(qty, unitMicro) {
  const n = BigInt(qty) * BigInt(unitMicro); const d = 10000n;
  const out = Number((n + d / 2n) / d);
  if (!Number.isSafeInteger(out)) fail('AMOUNT_OVERFLOW', 'amount too large');
  return out;
}
/** Percent (decimal string, 0-100, <=2 decimals) -> basis points. */
export function pctToBps(v, name = 'pct') {
  if (typeof v !== 'string' || !/^\d{1,3}(\.\d{1,2})?$/.test(v)) fail('INVALID_INPUT', `${name} must be a percent string such as "30" or "12.5"`, { field: name });
  const [i, f = ''] = v.split('.'); const bps = Number(i) * 100 + Number(f.padEnd(2, '0'));
  if (bps > 10000) fail('INVALID_INPUT', `${name} cannot exceed 100`, { field: name });
  return bps;
}
export const shareMinor = (totalMinor, bps) => Number((BigInt(totalMinor) * BigInt(bps) + 5000n) / 10000n);
/** Explicit FX: EUR per 1 unit of `from`. Never assumed. */
export function reqFx(fx, from) {
  if (!fx || typeof fx !== 'object') fail('FX_REQUIRED', `an explicit exchange rate ${from}->EUR is required`);
  if (fx.from !== from || fx.to !== 'EUR') fail('FX_MISMATCH', `fx must be ${from}->EUR`);
  if (typeof fx.rate !== 'string' || !/^\d{1,4}(\.\d{1,8})?$/.test(fx.rate) || Number(fx.rate) <= 0) fail('INVALID_INPUT', 'fx.rate must be a positive decimal string');
  reqDate(fx.date, 'fx.date'); reqStr(fx.source, 'fx.source', { max: 80 });
  return { from, to: 'EUR', rate: fx.rate, date: fx.date, source: fx.source };
}
export function microToEurMicro(micro, fx) {
  const [i, f = ''] = fx.rate.split('.'); const scale = 10n ** 8n; const r = BigInt(i) * scale + BigInt(f.padEnd(8, '0'));
  return Number((BigInt(micro) * r + scale / 2n) / scale);
}

export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
export const fingerprint = (v) => createHash('sha256').update(canonical(v)).digest('hex');
export const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
