// Phase 2 - journal of refused API requests (401 / 403), one JSON line each, so a refusal can be explained from its requestId.
// What is written: time, requestId, method, path WITHOUT query string, status, refusal code, role, and a short hash of the user id.
// What is never written: cookies, tokens, keys, query strings, request or response bodies, the raw user id, IP addresses.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const SAFE_CODE = /^[A-Z0-9_]{2,60}$/;

export function actorRefOf(userId) {
  if (!userId) return null;
  return createHash('sha256').update(String(userId)).digest('hex').slice(0, 12);
}

/** Pure: builds the line that is written. Anything not on the whitelist is dropped. */
export function refusalEntry({ at, requestId, method, path, status, code, role, userId }) {
  const cleanPath = String(path ?? '').split('?')[0].slice(0, 200);
  return {
    at: new Date(at).toISOString(),
    requestId: String(requestId ?? '').slice(0, 64),
    method: String(method ?? '').slice(0, 10),
    path: cleanPath,
    status: Number(status),
    code: SAFE_CODE.test(String(code ?? '')) ? String(code) : 'UNSPECIFIED',
    role: role ? String(role).slice(0, 20) : null,
    actor: actorRefOf(userId),
  };
}

export function createAccessJournal({ file, now = () => Date.now() }) {
  if (!file) throw new TypeError('createAccessJournal needs a file path');
  return Object.freeze({
    record(input) {
      const line = JSON.stringify(refusalEntry({ at: now(), ...input })) + '\n';
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, line, { encoding: 'utf8' });
    },
    /** Entries for one requestId, or the last `limit` entries (newest last). Read-only. */
    read({ requestId = null, limit = 50 } = {}) {
      if (!existsSync(file)) return [];
      const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const picked = requestId ? rows.filter((r) => r.requestId === requestId) : rows;
      return picked.slice(-Math.min(Math.max(Number(limit) || 50, 1), 200));
    },
  });
}
