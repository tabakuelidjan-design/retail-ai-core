// Finance dashboard sessions that survive a restart / redeploy.
//
// Sessions used to live only in memory, so every deploy signed everybody out. This store keeps the same small Map-like interface
// (get / set / has / delete, keyed by the session id from the cookie) and, when a persistence is given, mirrors it to a file:
//   * the file never contains a session id, only its SHA-256 (a leaked file cannot be replayed as a cookie);
//   * logout / expiry still revoke server-side (the entry is removed from memory AND from the file);
//   * expired entries are dropped when the file is loaded and when they are met;
//   * writes are serialised and atomic (temp file + rename); a failed write is logged and never breaks a request.
// Without a persistence (tests, demo) it behaves exactly like the previous in-memory Map.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';

const keyOf = (sid) => createHash('sha256').update(String(sid ?? '')).digest('hex');

/**
 * @param {{ persistence?: { load: () => Array<[string, {csrf: string, expires: number}]>, save: (entries) => Promise<void> } | null, now?: () => number }} [o]
 */
export function createSessionStore({ persistence = null, now = () => Date.now() } = {}) {
  const map = new Map(); // sha256(sid) -> { csrf, expires }
  if (persistence) {
    let entries = [];
    try { entries = persistence.load() ?? []; } catch (e) { console.error('finance sessions: could not read the session file, starting empty:', e?.message); }
    for (const [k, v] of entries) if (typeof k === 'string' && v && typeof v.csrf === 'string' && Number(v.expires) > now()) map.set(k, { csrf: v.csrf, expires: Number(v.expires) });
  }
  let writing = Promise.resolve();
  const persist = () => {
    if (!persistence) return;
    const snapshot = [...map.entries()].filter(([, v]) => v.expires > now());
    writing = writing.then(() => persistence.save(snapshot)).catch((e) => console.error('finance sessions: could not save the session file:', e?.message));
  };
  return {
    get: (sid) => map.get(keyOf(sid)),
    has: (sid) => map.has(keyOf(sid)),
    set(sid, value) { map.set(keyOf(sid), { csrf: value.csrf, expires: value.expires }); persist(); return this; },
    delete(sid) { const had = map.delete(keyOf(sid)); if (had) persist(); return had; },
    /** Resolves when pending writes are on disk (tests, graceful shutdown). */
    flush: () => writing,
  };
}

/** File persistence for createSessionStore: JSON { v: 1, sessions: [[sha256, {csrf, expires}]] }, written atomically. */
export function createFileSessionPersistence(path) {
  return {
    load() {
      let text;
      try { text = readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      const data = JSON.parse(text);
      return data?.v === 1 && Array.isArray(data.sessions) ? data.sessions : [];
    },
    async save(entries) {
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ v: 1, sessions: entries }), { mode: 0o600 });
      await rename(tmp, path);
    },
  };
}
