// Targeted mutation sweep for the Core reliability fixes: each mutant removes ONE guard (the serial queue, the journal protection, the stale-head check, the torn-tail diagnosis,
// the strict reads, the recovery confirmation, the backup integrity checks ...). A mutant is KILLED when test/core-reliability.test.js or test/core-backup-integrity.test.js fails.
// A SURVIVOR is a guard no test notices. Every file is restored, even on failure. Usage: node tools/core-reliability-mutation.mjs [--only <id>]
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const J = 'src/core-pilot/journal.js'; const D = 'src/core-pilot/durable-file.js'; const R = 'src/core-pilot/runtime.js'; const C = 'src/core-pilot/campaign.js'; const K = 'src/core-pilot/creation.js'; const B = 'tools/sourcing-backup.mjs'; const V = 'src/core-pilot/journal-recovery.js';
// [id, file, [[find, replace], ...]]
const MUTANTS = [
  // journal: protection, stale head, diagnosis
  ['journal/no-protection', J, [['if (fault) throw protectedError();', '']]],
  ['journal/no-stale-check', J, [['if (actual !== expectedSize) throw new JournalError(\'JOURNAL_STALE\'', 'if (false) throw new JournalError(\'JOURNAL_STALE\'']]],
  ['journal/lock-refusal-poisons', J, [["if (err?.code === 'JOURNAL_LOCKED') throw err; // transient: nothing was attempted", '']]],
  ['journal/no-size-check', J, [['if (after !== expectedSize + n) throw', 'if (false) throw']]],
  ['journal/torn-tail-not-told-apart', J, [['if (last && !terminated) {', 'if (false) {']]],
  ['journal/unterminated-event-accepted', J, [['if (!terminated) throw new JournalError(\'JOURNAL_TORN_TAIL\', `the last event', 'if (false) throw new JournalError(\'JOURNAL_TORN_TAIL\', `the last event']]],
  ['journal/middle-vs-last-not-told-apart', J, [["diagnostic: last ? 'CORRUPT_LAST_LINE' : 'CORRUPT_MIDDLE'", "diagnostic: 'CORRUPT_MIDDLE'"]]],
  ['journal/no-fault-evidence', J, [['try { await onFault?.(fault); }', 'try { /* skipped */ }']]],
  ['journal/chain-not-verified', J, [['events = verifyChain(r.events, merchantId);', 'events = r.events;']]],
  ['journal/ack-before-write', J, [['try { size = await write(e, { expectedSize: size }); } catch (err) {', 'try { size = Promise.resolve(write(e, { expectedSize: size })).catch(() => {}) && size; } catch (err) {']]],
  // durable file primitives
  ['durable/no-stale-lock-takeover', D, [['if (st && now() - st.mtimeMs > staleMs) {', 'if (false) {']]],
  ['durable/read-swallows-errors', D, [["if (e.code === 'ENOENT') return [];\n    throw new DurableFileError(`${label}_UNREADABLE`", 'return [];\n    throw new DurableFileError(`${label}_UNREADABLE`']]],
  ['durable/torn-tail-as-corrupt', D, [['if (last && !terminated) throw new DurableFileError(`${label}_TORN_TAIL`', 'if (false) throw new DurableFileError(`${label}_TORN_TAIL`']]],
  ['durable/short-write-ignored', D, [['if (!bytesWritten) throw new DurableFileError', 'if (false) throw new DurableFileError']]],
  // runtime: one logical writer
  ['runtime/decide-not-serialised', R, [['return serial(() => decideHumanSerial(entryId, body, actor));', 'return decideHumanSerial(entryId, body, actor);']]],
  ['runtime/analyse-not-serialised', R, [['return serial(() => analyseCaseSerial(state, { externals, actor }));', 'return analyseCaseSerial(state, { externals, actor });']]],
  ['runtime/result-not-serialised', R, [['return serial(() => recordResultSerial(entryId, body, actor));', 'return recordResultSerial(entryId, body, actor);']]],
  ['runtime/apply-failure-not-protected', R, [["protectedBy = err?.code ?? 'APPLY_FAILED'; throw new CoreError", "throw new CoreError"]]],
  // campaigns and creations
  ['campaign/read-swallows-errors', C, [["const entries = () => readJsonlStrict(file, 'CAMPAIGN_JOURNAL');", "const entries = () => readJsonlStrict(file, 'CAMPAIGN_JOURNAL').catch(() => []);"]]],
  ['campaign/no-serial-no-lock', C, [['const serial = createSerial();', 'const serial = (fn) => fn();'], ['withWriteLock(file, async () => {', '((f, g) => g())(file, async () => {']]],
  ['campaign/decision-check-outside-unit', C, [["if (all.some((e) => e.kind === 'DECISION' && e.id === id)) throw", "if (false) throw"]]],
  ['creation/read-swallows-errors', K, [["const entries = () => readJsonlStrict(journal, 'CREATION_JOURNAL');", "const entries = () => readJsonlStrict(journal, 'CREATION_JOURNAL').catch(() => []);"]]],
  ['creation/no-serial-no-lock', K, [['const serial = createSerial();', 'const serial = (fn) => fn();'], ['withWriteLock(journal, async () => {', '((f, g) => g())(journal, async () => {']]],
  ['creation/kept-once-removed', K, [["if (same) return { result: same };", ""]]],
  ['creation/decision-check-removed', K, [["if (all.some((e) => e.kind === 'DECISION' && e.id === id)) throw err('ALREADY_DECIDED'", "if (false) throw err('ALREADY_DECIDED'"]]],
  // backup / restore integrity
  ['backup/restore-accepts-bad-journal', B, [['if (!journalsRestorable(journals) && !opts.allowInconsistentJournal) throw new BackupError(\'RESTORE_JOURNAL_INCONSISTENT\', `the archive', 'if (false) throw new BackupError(\'RESTORE_JOURNAL_INCONSISTENT\', `the archive']]],
  ['backup/verify-always-ok', B, [['ok: journalsRestorable(journals), created_at', 'ok: true, created_at']]],
  ['backup/torn-copy-not-trimmed', B, [["if (r.status === 'TORN_TAIL') {", 'if (false) {']]],
  ['backup/restorable-always-true', B, [['restorable: journalsRestorable(journals) };', 'restorable: true };']]],
  ['backup/restored-journal-not-rechecked', B, [["if (!journalsRestorable(after) && !opts.allowInconsistentJournal) throw", "if (false) throw"]]],
  // controlled recovery
  ['recovery/no-confirmation', V, [['if (confirm !== v.confirmation_code) throw', 'if (false) throw']]],
  ['recovery/live-change-undetected', V, [['if (sha(live) !== v.manifest.original.sha256) throw', 'if (false) throw']]],
  ['recovery/active-writer-undetected', V, [['if (now().getTime() - st.mtimeMs < lockStaleMs) throw', 'if (false) throw']]],
  ['recovery/original-not-kept', V, [['await copyFile(file, kept, constants.COPYFILE_EXCL); // never overwrite an earlier keep', '']]],
  ['recovery/prepares-any-damage', V, [["if (d.status !== 'TORN_TAIL') throw", 'if (false) throw']]],
  ['recovery/dir-not-empty-ignored', V, [['if (names.length) throw new RecoveryError(\'RECOVERY_DIR_NOT_EMPTY\'', 'if (false) throw new RecoveryError(\'RECOVERY_DIR_NOT_EMPTY\'']]],
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const TESTS = ['test/core-reliability.test.js', 'test/core-backup-integrity.test.js'];
const results = [];
for (const [id, file, edits] of MUTANTS) {
  if (only && id !== only) continue;
  const original = readFileSync(file, 'utf8'); let text = original.replace(/\r\n/g, '\n'); let ok = true;
  for (const [a, b] of edits) { if (!text.includes(a)) { ok = false; break; } text = text.split(a).join(b); }
  if (!ok) { results.push({ id, status: 'NOT_APPLIED' }); continue; }
  try {
    writeFileSync(file, text);
    const r = spawnSync(process.execPath, ['--test', ...TESTS], { encoding: 'utf8', timeout: 420_000 });
    results.push({ id, status: r.status !== 0 ? 'KILLED' : 'SURVIVED' });
  } finally { writeFileSync(file, original); }
}
for (const r of results) console.log(`${r.status.padEnd(11)} ${r.id}`);
const n = (s) => results.filter((r) => r.status === s).length;
console.log(`mutants: ${results.length}, killed: ${n('KILLED')}, survived: ${n('SURVIVED')}, not applied: ${n('NOT_APPLIED')}`);
process.exitCode = n('SURVIVED') || n('NOT_APPLIED') ? 1 : 0;
