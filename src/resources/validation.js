// Small pure validators of the Socle Resource Resolver. Messages never echo submitted values.

import { createHash } from 'node:crypto';
import { RES_ERROR as E, ResourceResolverError } from './constants.js';

export const fail = (code, message, detail = {}) => { throw new ResourceResolverError(code, message, detail); };
export const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export function deepFreeze(value) {
  if (value != null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export function closedObject(value, allowed, field, code = E.INVALID_RESOLUTION) {
  if (!isPlainObject(value)) fail(code, `${field} must be a plain object`, { field });
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(code, `${field}.${key} is not part of this contract`, { field, key });
  }
  return value;
}

const REF = /^[A-Za-z0-9][A-Za-z0-9:_./#-]*$/;
const LOCATION_SCHEME = /^(https?|ftps?|sftp|ssh|file|data|blob|wss?|javascript|mailto|tel|s3|gs|gcs|drive):/i;
const HOST_PATH = /^(www\.|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\/)/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const TOKEN = /^[A-Z][A-Z0-9_]*$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** An opaque reference: never a URL, a host path, a data / blob / file location or a query string. */
export function ref(value, field, { max = 300 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !REF.test(value) || LOCATION_SCHEME.test(value) || HOST_PATH.test(value)) {
    fail(E.INVALID_REFERENCE, `${field} must be an opaque reference (no URL, no host, no whitespace, no query)`, { field });
  }
  return value;
}
export const idToken = (value, field) => {
  if (typeof value !== 'string' || !ID.test(value)) fail(E.INVALID_ADAPTER, `${field} must be an identifier`, { field });
  return value;
};
export const upperToken = (value, field) => {
  if (typeof value !== 'string' || value.length > 64 || !TOKEN.test(value)) fail(E.METADATA_INVALID, `${field} must be an UPPER_SNAKE token`, { field });
  return value;
};
export const hex64 = (value, field) => {
  if (typeof value !== 'string' || !HEX64.test(value)) fail(E.METADATA_INVALID, `${field} must be a lower-case sha-256 hex digest`, { field });
  return value;
};
export function enumValue(value, allowed, field, code = E.METADATA_INVALID) {
  const list = Array.isArray(allowed) ? allowed : Object.values(allowed);
  if (typeof value !== 'string' || !list.includes(value)) fail(code, `${field} is not an allowed value`, { field });
  return value;
}
export function number(value, field, { min = -Infinity, max = Infinity, integer = false, code = E.METADATA_INVALID } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(code, `${field} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}]`, { field });
  }
  return value;
}
export function text(value, field, { max = 300, code = E.METADATA_INVALID } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(code, `${field} must be 1..${max} characters`, { field });
  return value.normalize('NFC');
}

const LOCATION_IN_TEXT = /\b(?:https?|ftps?|file|data|blob|wss?):\/?\/?[^\s"']*|\bdata:[a-z]+\/[a-z0-9.+-]+;base64,/i;
/** A metadata value can describe a resource; it can never carry a location or a payload. */
export function assertNoLocation(value, path = 'metadata') {
  if (typeof value === 'string' && LOCATION_IN_TEXT.test(value)) fail(E.METADATA_LOCATION, `${path} must not carry a location or a payload`, { path });
  if (Array.isArray(value)) value.forEach((v, i) => assertNoLocation(v, `${path}[${i}]`));
  else if (isPlainObject(value)) for (const [k, v] of Object.entries(value)) assertNoLocation(v, `${path}.${k}`);
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
