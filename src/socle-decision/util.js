import { createHash } from 'node:crypto';

export class SocleError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'SocleError';
    this.code = code;
  }
}

export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function numOrNull(v, field) {
  if (v === undefined || v === null) return null;
  if (!isNum(v)) throw new SocleError('INVALID_NUMBER', `${field} must be a finite number or null`);
  return v;
}

export function nonEmpty(v, field) {
  if (typeof v !== 'string' || v.trim() === '') throw new SocleError('INVALID_FIELD', `${field} is required`);
  return v.trim();
}

export function oneOf(v, enumObj, field) {
  if (!Object.values(enumObj).includes(v)) {
    throw new SocleError('INVALID_FIELD', `${field} must be one of ${Object.values(enumObj).join('|')} (got ${v})`);
  }
  return v;
}

export function toIso(value, field) {
  if (value === undefined || value === null) throw new SocleError('INVALID_DATE', `${field} is required`);
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new SocleError('INVALID_DATE', `${field} is not a valid date`);
  return d.toISOString();
}

// Deterministic ids (no randomness, no clock).
export function hashId(prefix, ...parts) {
  return `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12)}`;
}

export const DAY_MS = 86_400_000;
