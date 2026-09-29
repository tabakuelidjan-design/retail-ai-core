// Nordla HTTP security (Core C4) - method, Content-Type and JSON body checks.
//
// readJsonBody(): exact method, Content-Type application/json (charset utf-8 optional), a hard byte limit enforced while reading
// (Content-Length is checked first, then the stream), valid JSON, a plain object, no duplicated key at any depth (JSON.parse would
// silently keep the last one), only the allowed properties, the required ones present. Every refusal is a generic public error
// (HttpSecurityError with a public code) and the body is never logged or echoed.

import { HttpSecurityError } from './redact.js';

export const LOGIN_BODY = Object.freeze({
  method: 'POST',
  maxBytes: 16 * 1024,
  allowed: Object.freeze(['email', 'password']),
  required: Object.freeze(['email', 'password']),
});
/** Fields that must never come from a login request (the service's configuration and the session decide them). */
export const FORBIDDEN_LOGIN_FIELDS = Object.freeze(['merchantId', 'merchant_id', 'module', 'moduleCode', 'expectedModule', 'role', 'session', 'sessionId', 'token']);

const fail = (publicCode, code) => { throw new HttpSecurityError(publicCode, code); };

/** Throws when an object in the JSON text repeats a key (any depth). Assumes the text already parsed as JSON. */
export function assertNoDuplicateKeys(text) {
  const stack = []; // one Set per open object, null for arrays
  let i = 0;
  const readString = () => { let s = ''; i += 1; while (i < text.length && text[i] !== '"') { if (text[i] === '\\') { s += text[i] + text[i + 1]; i += 2; } else { s += text[i]; i += 1; } } i += 1; return s; };
  while (i < text.length) {
    const c = text[i];
    if (c === '{') { stack.push(new Set()); i += 1; }
    else if (c === '[') { stack.push(null); i += 1; }
    else if (c === '}' || c === ']') { stack.pop(); i += 1; }
    else if (c === '"') {
      const s = readString();
      let j = i; while (j < text.length && /\s/.test(text[j])) j += 1;
      const top = stack[stack.length - 1];
      if (text[j] === ':' && top) { if (top.has(s)) fail('BAD_REQUEST', 'BODY_DUPLICATE_KEY'); top.add(s); }
    } else i += 1;
  }
}

/**
 * @param {AsyncIterable<Buffer>|import('node:http').IncomingMessage} req
 * @param {{ method: string, maxBytes: number, allowed: readonly string[], required?: readonly string[], forbidden?: readonly string[] }} rule
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJsonBody(req, rule) {
  if (String(req.method ?? '').toUpperCase() !== rule.method) fail('METHOD_NOT_ALLOWED', 'METHOD_NOT_ALLOWED');
  const type = String(req.headers?.['content-type'] ?? '').toLowerCase().replace(/\s+/g, '');
  if (type !== 'application/json' && type !== 'application/json;charset=utf-8') fail('UNSUPPORTED_MEDIA_TYPE', 'CONTENT_TYPE_NOT_JSON');
  const declared = req.headers?.['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > rule.maxBytes)) fail('PAYLOAD_TOO_LARGE', 'BODY_TOO_LARGE');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > rule.maxBytes) fail('PAYLOAD_TOO_LARGE', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let value;
  try { value = JSON.parse(text); } catch { fail('BAD_REQUEST', 'BODY_NOT_JSON'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('BAD_REQUEST', 'BODY_NOT_OBJECT');
  assertNoDuplicateKeys(text);
  for (const k of Object.keys(value)) {
    if ((rule.forbidden ?? []).includes(k)) fail('BAD_REQUEST', 'BODY_FORBIDDEN_FIELD');
    if (!rule.allowed.includes(k)) fail('BAD_REQUEST', 'BODY_UNEXPECTED_FIELD');
  }
  for (const k of rule.required ?? []) if (!(k in value)) fail('BAD_REQUEST', 'BODY_MISSING_FIELD');
  return value;
}

/** A future login body: POST, <= 16 KiB, only e-mail and password (both strings). */
export async function readLoginBody(req, { maxBytes = LOGIN_BODY.maxBytes } = {}) {
  const body = await readJsonBody(req, { ...LOGIN_BODY, maxBytes, forbidden: FORBIDDEN_LOGIN_FIELDS });
  if (typeof body.email !== 'string' || typeof body.password !== 'string') fail('BAD_REQUEST', 'BODY_FIELD_TYPE');
  return Object.freeze({ email: body.email, password: body.password });
}
