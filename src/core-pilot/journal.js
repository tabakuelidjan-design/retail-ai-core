// Append-only, hash-chained decision journal (one JSON line per event). It is the persistence of the Core path: the Socle store is
// rebuilt from it at start (replay), so every subject, decision, human approval and follow-up survives a restart and can be audited.
// Each line carries the hash of the previous one: an edited, removed or reordered line is detected at load and the Core refuses to
// start on it (the file is never repaired, truncated or deleted by code). There is no delete and no update.
//
// Reliability contract (docs/integration/core-journal-reliability.md):
//  - one writer at a time inside the process (queue) and between cooperating processes (a lock file around check-and-append);
//  - an event is ACKNOWLEDGED (append resolves) only after the line is written in full AND datasync'ed; otherwise append REJECTS;
//  - any failed or uncertain write puts the journal in PROTECTED state: every later append is refused until a controlled restart; the file is left
//    exactly as found and the evidence is kept next to it (`<file>.faults.jsonl`);
//  - a stale head (the file is not what this process last wrote) is refused, never appended to;
//  - a damaged file is diagnosed, not guessed: JOURNAL_TORN_TAIL (last line cut short) / JOURNAL_CORRUPT with `diagnostic` CORRUPT_MIDDLE, CORRUPT_LAST_LINE,
//    CHAIN_BROKEN, SEQUENCE, WRONG_MERCHANT. Recovery is a separate, human-confirmed procedure on a COPY (journal-recovery.js).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DurableFileError, appendLineDurably, fileSize, withWriteLock } from './durable-file.js';

export class JournalError extends DurableFileError { constructor(code, message, { status = 503, diagnostic = null, details = null } = {}) { super(code, message, { status, details }); this.name = 'JournalError'; this.diagnostic = diagnostic; } }
export const GENESIS = '0'.repeat(64);

const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
export const eventHash = (e) => createHash('sha256').update(stable({ seq: e.seq, at: e.at, merchant_id: e.merchant_id, kind: e.kind, actor: e.actor, payload: e.payload, prev: e.prev })).digest('hex');

const corrupt = (diagnostic, line, message) => new JournalError('JOURNAL_CORRUPT', `line ${line}: ${message}`, { diagnostic, details: { line } });

/** Verifies a list of events (order, merchant, chain). Returns them or throws JOURNAL_CORRUPT naming the first bad line and the kind of damage. */
export function verifyChain(events, merchantId) {
  let prev = GENESIS;
  events.forEach((e, i) => {
    if (e.seq !== i + 1) throw corrupt('SEQUENCE', i + 1, `sequence ${e.seq} out of order`);
    if (e.merchant_id !== merchantId) throw corrupt('WRONG_MERCHANT', i + 1, 'belongs to another merchant');
    if (e.prev !== prev) throw corrupt('CHAIN_BROKEN', i + 1, 'previous hash does not match (a line was removed or edited)');
    if (eventHash(e) !== e.hash) throw corrupt('CHAIN_BROKEN', i + 1, 'content does not match its hash (edited)');
    prev = e.hash;
  });
  return events;
}

/**
 * Reads the text of a journal and returns its events, or throws the precise diagnosis. `merchantId` may be null (an inspector that does not know it:
 * the first event's merchant is then the reference). Never modifies anything.
 *   JOURNAL_TORN_TAIL  the LAST line has no terminating newline (and is cut short, or is a whole event whose newline never reached the disk), everything before it verifies
 *   JOURNAL_CORRUPT    CORRUPT_MIDDLE (a line before the last is not JSON) | CORRUPT_LAST_LINE (the last line is terminated but not JSON) | CHAIN_BROKEN | SEQUENCE | WRONG_MERCHANT
 * `details` carries `line`, `offset` (bytes before the first unverifiable line), `valid_events`, `size`.
 */
export function inspectJournalText(raw, merchantId = null) {
  const size = Buffer.byteLength(raw);
  const terminated = raw === '' || raw.endsWith('\n');
  const parts = raw.split('\n'); if (parts.at(-1) === '') parts.pop();
  const events = []; let offset = 0; let bad = -1; let badOffset = 0;
  for (let i = 0; i < parts.length; i += 1) {
    try { events.push(JSON.parse(parts[i])); } catch { bad = i; badOffset = offset; break; }
    offset += Buffer.byteLength(parts[i]) + 1;
  }
  const ref = merchantId ?? events[0]?.merchant_id ?? null;
  const verifiedPrefix = () => { try { verifyChain(events, ref); } catch (e) { e.details = { ...(e.details ?? {}), size }; throw e; } };
  if (bad >= 0) {
    const last = bad === parts.length - 1;
    if (last && !terminated) {
      verifiedPrefix();
      throw new JournalError('JOURNAL_TORN_TAIL', `line ${bad + 1} is incomplete (an interrupted write); the ${events.length} events before it verify`, { diagnostic: 'TORN_TAIL', details: { line: bad + 1, offset: badOffset, tail_bytes: size - badOffset, valid_events: events.length, size, complete_event: false } });
    }
    throw new JournalError('JOURNAL_CORRUPT', `line ${bad + 1}: not JSON (${last ? 'the last line, terminated' : 'in the middle of the journal'})`, { diagnostic: last ? 'CORRUPT_LAST_LINE' : 'CORRUPT_MIDDLE', details: { line: bad + 1, offset: badOffset, valid_events: events.length, size } });
  }
  verifiedPrefix();
  if (!terminated) throw new JournalError('JOURNAL_TORN_TAIL', `the last event (line ${parts.length}) verifies but its terminating newline never reached the disk`, { diagnostic: 'TORN_TAIL', details: { line: parts.length, offset: size, tail_bytes: 0, valid_events: events.length, size, complete_event: true } });
  return { events, size };
}

function createJournal({ merchantId, load, write, onFault = null }) {
  if (!merchantId) throw new JournalError('MERCHANT_REQUIRED', 'a journal belongs to exactly one merchant', { status: 500 });
  let events = null; let size = 0; let fault = null; let tail = Promise.resolve();
  async function all() { if (!events) { const r = await load(); events = verifyChain(r.events, merchantId); size = r.size; } return events; }
  const protectedError = () => new JournalError('JOURNAL_PROTECTED', `the journal is in protection since ${fault.code} (${fault.at}): nothing more is written until it is verified and the Core restarted; the file was left exactly as found`, { diagnostic: 'PROTECTED', details: { fault } });
  /**
   * Appends one event. Resolves ONLY when the line is on disk (written in full and datasync'ed): that resolution is what "decision recorded" may be built on.
   * Serialised: one writer. A failed or uncertain write rejects AND protects the journal.
   */
  function append({ kind, actor = null, payload, at }) {
    const run = tail.then(async () => {
      if (fault) throw protectedError();
      const list = await all();
      const e = { seq: list.length + 1, at, merchant_id: merchantId, kind, actor, payload, prev: list.at(-1)?.hash ?? GENESIS };
      e.hash = eventHash(e);
      try { size = await write(e, { expectedSize: size }); } catch (err) {
        if (err?.code === 'JOURNAL_LOCKED') throw err; // transient: nothing was attempted
        fault = { at: new Date().toISOString(), code: err instanceof JournalError || err?.code === 'JOURNAL_LOCK_PERMISSION' ? err.code : 'JOURNAL_WRITE_FAILED', cause_code: err?.details?.cause_code ?? err?.code ?? null, message: String(err?.message ?? err).slice(0, 300), seq: e.seq, expected_size: size, diagnostic: err?.diagnostic ?? null };
        try { await onFault?.(fault); } catch { /* the evidence is best effort; the protection is not */ }
        throw err instanceof JournalError || err?.code === 'JOURNAL_LOCK_PERMISSION' ? err : new JournalError('JOURNAL_WRITE_FAILED', `the event was NOT confirmed as recorded (${fault.message}); the journal is now protected`, { details: { cause: fault.message, seq: e.seq } });
      }
      list.push(e); return e;
    });
    tail = run.catch(() => {}); return run;
  }
  return { merchantId, all, append, head: async () => (await all()).at(-1)?.hash ?? GENESIS, status: () => ({ state: fault ? 'PROTECTED' : 'OK', fault }) };
}

export function createMemoryJournal({ merchantId, lines = [] }) {
  const store = lines.map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
  return { ...createJournal({ merchantId, load: async () => ({ events: store.map((e) => ({ ...e })), size: 0 }), write: async (e) => { store.push({ ...e }); return 0; } }), lines: () => store.map((e) => JSON.stringify(e)) };
}

/** The file journal. `hooks.beforeWrite` / `hooks.afterWrite` exist only for tests that interrupt a write at an exact point; `lock` tunes the write lock (waitMs, staleMs). */
export function createFileJournal({ merchantId, file, hooks = {}, lock = {} }) {
  const faultFile = `${file}.faults.jsonl`;
  return createJournal({
    merchantId,
    load: async () => {
      let buf; try { buf = await readFile(file); } catch (e) { if (e.code === 'ENOENT') return { events: [], size: 0 }; throw new JournalError('JOURNAL_UNREADABLE', `${file} cannot be read (${e.code ?? e.message}); the Core does not start on a journal it cannot read`, { details: { cause: e.code ?? String(e.message) } }); }
      return inspectJournalText(buf.toString('utf8'), merchantId);
    },
    write: (e, { expectedSize }) => withWriteLock(file, async () => {
      const actual = await fileSize(file);
      if (actual !== expectedSize) throw new JournalError('JOURNAL_STALE', `the journal on disk is ${actual} bytes but this process last wrote ${expectedSize}: another writer or an edit changed it; nothing was written`, { diagnostic: 'STALE_HEAD', details: { expected: expectedSize, actual } });
      await hooks.beforeWrite?.(e);
      const n = await appendLineDurably(file, JSON.stringify(e));
      await hooks.afterWrite?.(e);
      const after = await fileSize(file);
      if (after !== expectedSize + n) throw new JournalError('JOURNAL_DURABILITY_UNCERTAIN', `after the write the file is ${after} bytes, expected ${expectedSize + n}`, { diagnostic: 'SIZE_MISMATCH', details: { expected: expectedSize + n, actual: after } });
      return after;
    }, lock),
    onFault: async (f) => { await appendLineDurably(faultFile, JSON.stringify(f)); },
  });
}
