// Small shared helpers for the M3 contracts (the generic ones live in understand-validation.js and m2-validation.js, reused as-is).

import { MKT_ERROR as E } from './understand-constants.js';
import { closedObject, fail, isPlainObject, opaqueRef, refList } from './understand-validation.js';

export { canonical } from './m2-validation.js';

/**
 * Refuses a forbidden key ANYWHERE in the input (objects and arrays, any depth), compared case-insensitively.
 * It looks at KEYS only; free text is never parsed.
 */
export function rejectKeysDeep(value, forbidden, code, field) {
  const banned = new Set(forbidden.map((key) => key.toLowerCase()));
  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${path}[${i}]`)); return; }
    if (!isPlainObject(node)) return;
    for (const key of Object.keys(node)) {
      if (banned.has(key.toLowerCase())) fail(code, `${path}.${key} is not allowed here`, { field: path, key });
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, field);
}

// References are opaque tokens (no space, '@', '?', '&', '=', ',' or ';'), and on top of that they never point at raw media
// or a web / file / data location: a URL, a signed provider URL, a credentialed URL, a data URI or a blob cannot be a ref.
const FORBIDDEN_SCHEME = /^(https?|ftp|ftps|file|data|blob|ws|wss):/i;

/** true when the string is a web / file / data location rather than an opaque reference */
export const isLocation = (value) => FORBIDDEN_SCHEME.test(String(value));

export function safeRef(value, field, options) {
  const ref = opaqueRef(value, field, options);
  if (FORBIDDEN_SCHEME.test(ref)) fail(E.INVALID_FIELD, `${field} must be an opaque reference, not a location`, { field });
  return ref;
}

export function safeRefList(value, field, options) {
  const refs = refList(value, field, options);
  for (const ref of refs) {
    if (FORBIDDEN_SCHEME.test(ref)) fail(E.INVALID_FIELD, `${field} must contain opaque references, not locations`, { field });
  }
  return refs;
}

export { closedObject };
