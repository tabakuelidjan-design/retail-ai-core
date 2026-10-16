// Controlled recovery of a decision journal whose LAST line was cut short (JOURNAL_TORN_TAIL). The live journal is never repaired, truncated or deleted
// by the Core. Recovery is four explicit, separate steps run by a person:
//   diagnose  read-only: what is wrong, where, how much is trustworthy
//   prepare   on COPIES, in an empty directory: the original (byte for byte), the quarantined tail, a candidate journal made of the verified events,
//             and a manifest with every hash and a confirmation code. Nothing about the live file changes.
//   verify    re-checks the prepared directory (hashes, chain, candidate = exact prefix of the original)
//   apply     only with the confirmation code, only if the live file is still byte-identical to the original copy, only if no writer is active:
//             keeps a copy of the live file next to it (`<file>.replaced-<time>`), then replaces it with the candidate by one atomic rename.
// Damage other than a torn tail (a bad line in the middle, a broken chain) is NOT prepared automatically: it needs a human investigation.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STALE_LOCK_MS } from './durable-file.js';
import { inspectJournalText, JournalError } from './journal.js';

export class RecoveryError extends Error { constructor(code, message) { super(`${code}: ${message}`); this.name = 'RecoveryError'; this.code = code; } }
const sha = (b) => createHash('sha256').update(b).digest('hex');
export const RECOVERY_FORMAT = 'nordla-journal-recovery@1';

/** Read-only. Never throws on a damaged journal: it reports it. */
export async function diagnoseJournal(file, merchantId = null) {
  let buf; try { buf = await readFile(file); } catch (e) { if (e.code === 'ENOENT') return { status: 'MISSING', file }; throw new RecoveryError('RECOVERY_UNREADABLE', `${file}: ${e.code ?? e.message}`); }
  const base = { file, size: buf.length, sha256: sha(buf) };
  try {
    const { events } = inspectJournalText(buf.toString('utf8'), merchantId);
    return { ...base, status: 'OK', events: events.length, head: events.at(-1)?.hash ?? null, merchant_id: events[0]?.merchant_id ?? merchantId };
  } catch (e) {
    if (!(e instanceof JournalError)) throw e;
    return { ...base, status: e.code === 'JOURNAL_TORN_TAIL' ? 'TORN_TAIL' : 'CORRUPT', code: e.code, diagnostic: e.diagnostic, message: e.message, details: e.details };
  }
}

async function emptyDir(dir) {
  let names = []; try { names = await readdir(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (names.length) throw new RecoveryError('RECOVERY_DIR_NOT_EMPTY', `${dir} is not empty: a recovery is prepared in a new directory, never over another one`);
  await mkdir(dir, { recursive: true });
}

/** Prepares (never applies) a recovery from a torn tail. Writes only into `outDir`. */
export async function prepareRecovery({ file, merchantId, outDir, now = () => new Date() }) {
  const buf = await readFile(file); // the live file is only READ
  const d = await diagnoseJournal(file, merchantId);
  if (d.status !== 'TORN_TAIL') throw new RecoveryError('RECOVERY_NOT_APPLICABLE', `the journal is ${d.status}${d.diagnostic ? ` (${d.diagnostic})` : ''}: only a torn tail can be prepared; any other damage needs a human investigation`);
  await emptyDir(outDir);
  const goodBytes = d.details.offset; const completeEvent = d.details.complete_event === true;
  const tail = completeEvent ? Buffer.alloc(0) : buf.subarray(goodBytes);
  const candidate = completeEvent ? Buffer.concat([buf, Buffer.from('\n')]) : buf.subarray(0, goodBytes);
  const { events } = inspectJournalText(candidate.toString('utf8'), merchantId); // the candidate must verify completely
  await writeFile(join(outDir, 'original.jsonl'), buf, { flag: 'wx', mode: 0o600 });
  await writeFile(join(outDir, 'quarantined-tail.bin'), tail, { flag: 'wx', mode: 0o600 });
  await writeFile(join(outDir, 'recovered.jsonl'), candidate, { flag: 'wx', mode: 0o600 });
  const manifest = {
    format: RECOVERY_FORMAT, created_at: now().toISOString(), merchant_id: merchantId, source_file: file,
    original: { sha256: sha(buf), size: buf.length }, candidate: { sha256: sha(candidate), size: candidate.length, events: events.length, last_seq: events.at(-1)?.seq ?? 0, head: events.at(-1)?.hash ?? null },
    quarantined_tail: { sha256: sha(tail), bytes: tail.length, preview: tail.subarray(0, 80).toString('utf8').replace(/[^\x20-\x7e]/g, '?') },
    diagnosis: { code: d.code, diagnostic: d.diagnostic, message: d.message, details: d.details },
    human_confirmation_code: sha(`${sha(buf)}:${sha(candidate)}`).slice(0, 12),
    steps: ['stop the service', 'verify this directory', 'apply with the confirmation code', 'start the service: the decision lost in the torn write (if any) must be asked of the owner again'],
  };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return manifest;
}

/** Re-checks a prepared recovery directory. Throws RecoveryError on any inconsistency. */
export async function verifyRecovery({ outDir, merchantId }) {
  let manifest; try { manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8')); } catch { throw new RecoveryError('RECOVERY_MANIFEST_MISSING', `${outDir} holds no readable manifest.json`); }
  if (manifest.format !== RECOVERY_FORMAT || manifest.merchant_id !== merchantId) throw new RecoveryError('RECOVERY_MANIFEST_MISMATCH', 'the manifest is not a recovery manifest for this merchant');
  const read = (n) => readFile(join(outDir, n));
  const [original, candidate, tail] = await Promise.all([read('original.jsonl'), read('recovered.jsonl'), read('quarantined-tail.bin')]);
  if (sha(original) !== manifest.original.sha256 || sha(candidate) !== manifest.candidate.sha256 || sha(tail) !== manifest.quarantined_tail.sha256) throw new RecoveryError('RECOVERY_HASH_MISMATCH', 'a prepared file does not match its recorded hash');
  const { events } = inspectJournalText(candidate.toString('utf8'), merchantId);
  if (events.length !== manifest.candidate.events || (events.at(-1)?.hash ?? null) !== manifest.candidate.head) throw new RecoveryError('RECOVERY_CANDIDATE_MISMATCH', 'the candidate does not replay to the recorded head');
  const isPrefix = original.length >= candidate.length && original.subarray(0, candidate.length).equals(candidate);
  const isOriginalPlusNewline = candidate.length === original.length + 1 && candidate.subarray(0, original.length).equals(original) && candidate.at(-1) === 10;
  if (!isPrefix && !isOriginalPlusNewline) throw new RecoveryError('RECOVERY_NOT_A_PREFIX', 'the candidate is not an exact prefix of the original');
  return { ok: true, events: events.length, head: manifest.candidate.head, quarantined_bytes: tail.length, confirmation_code: manifest.human_confirmation_code, manifest };
}

/** Applies a prepared recovery to the live file. Requires the human confirmation code. Keeps a copy of what it replaces. */
export async function applyRecovery({ file, outDir, merchantId, confirm, now = () => new Date(), lockStaleMs = STALE_LOCK_MS }) {
  const v = await verifyRecovery({ outDir, merchantId });
  if (confirm !== v.confirmation_code) throw new RecoveryError('RECOVERY_CONFIRMATION_REQUIRED', 'apply needs the confirmation code printed by prepare/verify; it is a person who decides');
  const live = await readFile(file);
  if (sha(live) !== v.manifest.original.sha256) throw new RecoveryError('RECOVERY_LIVE_CHANGED', 'the live journal is no longer byte-identical to the prepared original: prepare again');
  try { const st = await stat(`${file}.lock`); if (now().getTime() - st.mtimeMs < lockStaleMs) throw new RecoveryError('RECOVERY_WRITER_ACTIVE', 'a writer lock is present and recent: stop the service first'); } catch (e) { if (e instanceof RecoveryError) throw e; if (e.code !== 'ENOENT') throw e; }
  const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const kept = `${file}.replaced-${stamp}`;
  await copyFile(file, kept, constants.COPYFILE_EXCL); // never overwrite an earlier keep
  const candidate = await readFile(join(outDir, 'recovered.jsonl'));
  const staging = `${file}.recovering`;
  const h = await open(staging, 'w', 0o600); try { await h.writeFile(candidate); await h.datasync(); } finally { await h.close(); }
  await rename(staging, file); // atomic replacement: there is never a moment without a journal
  await writeFile(join(outDir, `applied-${stamp}.json`), `${JSON.stringify({ applied_at: now().toISOString(), live_file: file, kept_copy: kept, candidate_sha256: v.manifest.candidate.sha256 }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { ok: true, kept_copy: kept, events: v.events, head: v.head };
}
