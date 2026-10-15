// Append-only, hash-chained decision journal (one JSON line per event). It is the persistence of the Core path: the Socle store is
// rebuilt from it at start (replay), so every subject, decision, human approval and follow-up survives a restart and can be audited.
// Each line carries the hash of the previous one: an edited, removed or reordered line is detected at load and the Core refuses to
// start on it (the file is never repaired, truncated or deleted by code). There is no delete and no update.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class JournalError extends Error { constructor(code, message) { super(`${code}: ${message}`); this.name = 'JournalError'; this.code = code; } }
export const GENESIS = '0'.repeat(64);

const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
export const eventHash = (e) => createHash('sha256').update(stable({ seq: e.seq, at: e.at, merchant_id: e.merchant_id, kind: e.kind, actor: e.actor, payload: e.payload, prev: e.prev })).digest('hex');

/** Verifies a list of events (order, merchant, chain). Returns them or throws JOURNAL_CORRUPT naming the first bad line. */
export function verifyChain(events, merchantId) {
  let prev = GENESIS;
  events.forEach((e, i) => {
    if (e.seq !== i + 1) throw new JournalError('JOURNAL_CORRUPT', `line ${i + 1}: sequence ${e.seq} out of order`);
    if (e.merchant_id !== merchantId) throw new JournalError('JOURNAL_CORRUPT', `line ${i + 1}: belongs to another merchant`);
    if (e.prev !== prev) throw new JournalError('JOURNAL_CORRUPT', `line ${i + 1}: previous hash does not match (a line was removed or edited)`);
    if (eventHash(e) !== e.hash) throw new JournalError('JOURNAL_CORRUPT', `line ${i + 1}: content does not match its hash (edited)`);
    prev = e.hash;
  });
  return events;
}

function createJournal({ merchantId, load, write }) {
  if (!merchantId) throw new JournalError('MERCHANT_REQUIRED', 'a journal belongs to exactly one merchant');
  let events = null; let tail = Promise.resolve();
  async function all() { if (!events) events = verifyChain(await load(), merchantId); return events; }
  /** Appends one event (serialised: one writer). */
  function append({ kind, actor = null, payload, at }) {
    const run = tail.then(async () => {
      const list = await all();
      const e = { seq: list.length + 1, at, merchant_id: merchantId, kind, actor, payload, prev: list.at(-1)?.hash ?? GENESIS };
      e.hash = eventHash(e);
      await write(e); list.push(e); return e;
    });
    tail = run.catch(() => {}); return run;
  }
  return { merchantId, all, append, head: async () => (await all()).at(-1)?.hash ?? GENESIS };
}

export function createMemoryJournal({ merchantId, lines = [] }) {
  const store = lines.map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
  return { ...createJournal({ merchantId, load: async () => store.map((e) => ({ ...e })), write: async (e) => { store.push({ ...e }); } }), lines: () => store.map((e) => JSON.stringify(e)) };
}

export function createFileJournal({ merchantId, file }) {
  return createJournal({
    merchantId,
    load: async () => {
      let raw; try { raw = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      const lines = raw.split('\n'); if (lines.at(-1) === '') lines.pop();
      return lines.map((l, i) => { try { return JSON.parse(l); } catch { throw new JournalError('JOURNAL_CORRUPT', `line ${i + 1}: not JSON (partial write or edit)`); } });
    },
    write: async (e) => {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
      const h = await open(file, 'r'); try { await h.datasync(); } finally { await h.close(); }
    },
  });
}
