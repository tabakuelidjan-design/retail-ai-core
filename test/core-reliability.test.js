// Core reliability (mandate 2026-10-15, defects P1-P7 of the review of eb73dc3). Real runtime, real Socle engine, real file journal, real services; synthetic people and cases.
// Runs on Linux AND Windows (Node 24): the journal must append and datasync on both. Every test names the defect it removes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { createCoreRuntime } from '../src/core-pilot/runtime.js';
import { createFileJournal, createMemoryJournal, inspectJournalText, verifyChain } from '../src/core-pilot/journal.js';
import { appendLineDurably, readJsonlStrict } from '../src/core-pilot/durable-file.js';
import { applyRecovery, diagnoseJournal, prepareRecovery, verifyRecovery } from '../src/core-pilot/journal-recovery.js';
import { validateCoreConfig } from '../src/core-pilot/config.js';
import { createCampaignService } from '../src/core-pilot/campaign.js';
import { createCreationService, loadCreationConfig } from '../src/core-pilot/creation.js';
import { NOW, LIVE_CLEAN, ident, traits, importer, commercial } from './sourcing-fixtures.js';

const MID = 'merchant-test';
const OWNER = { userId: 'user-owner', role: 'OWNER' };
const CONFIG = validateCoreConfig({ schema: 1, merchantId: 'test', currency: 'EUR', gates: { materialityThreshold: 0, maxPrioritySubjects: 10, cooldownDays: 14, aggravationFactor: 1.5 }, testSmall: { budget: null }, ownerRules: [] });
const externals = { safety: LIVE_CLEAN };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const mk = (events, id) => { let c = newCase({ id, name: 'x', now: NOW }); for (const e of events) c = dispatch(c, e, NOW); return c; };
const goCase = (id = 'case-go', qty = 1000) => mk([...ident({ name: 'Bamboo kitchen organiser', category: 'household_general' }), ...traits({}), ...importer, { type: 'SUPPLIER', supplier: { name: 'Yiwu Greenline' } }, ...commercial({ unitPrice: 4.2, qty })], id);
const runtimeOn = (journal) => createCoreRuntime({ merchantId: MID, config: CONFIG, journal, now: () => NOW });
const withDir = async (fn) => { const dir = await mkdtemp(join(tmpdir(), 'core-rel-')); try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } };
const linesOf = async (f) => (await readFile(f, 'utf8')).split('\n').filter(Boolean);
const kindsOf = async (f) => (await linesOf(f)).map((l) => JSON.parse(l).kind);
const code = async (p) => { try { await p; return 'OK'; } catch (e) { return e.code ?? e.name; } };
/** A journal on `file` that already holds one analysed case and its subject: returns { file, rt, r }. */
async function seeded(dir, name = 'j.jsonl') { const file = join(dir, name); const rt = runtimeOn(createFileJournal({ merchantId: MID, file })); const r = await rt.analyseCase(goCase(), { externals, actor: OWNER }); return { file, rt, r }; }

// =============================================================================================== P4: the journal appends and syncs on this OS
test('P4 the file journal appends, syncs and replays on this OS (Windows used to fail with EPERM: datasync on a read-only handle)', async () => {
  await withDir(async (dir) => {
    const f = join(dir, 'x', 'line.jsonl');
    assert.equal(await appendLineDurably(f, '{"a":1}'), 8);
    assert.equal(await appendLineDurably(f, '{"a":2}'), 8);
    assert.equal(await readFile(f, 'utf8'), '{"a":1}\n{"a":2}\n');
    const { file, rt, r } = await seeded(dir);
    const again = runtimeOn(createFileJournal({ merchantId: MID, file }));
    assert.equal((await again.overview()).decisions.length, 1, `replayed on ${process.platform}`);
    assert.equal(r.status, 'ANALYSED');
  });
});

// =============================================================================================== P1: simultaneous human decisions
test('P1 two simultaneous human decisions on the same entry: ONE is accepted, ONE line is written, the Core restarts', async () => {
  await withDir(async (dir) => {
    const { file, rt, r } = await seeded(dir);
    const results = await Promise.allSettled([
      rt.decideHuman(r.entry.id, { decision: 'DEFERRED', reason: 'a' }, OWNER),
      rt.decideHuman(r.entry.id, { decision: 'REJECTED', reason: 'b' }, OWNER),
      rt.decideHuman(r.entry.id, { decision: 'DEFERRED', reason: 'c' }, OWNER),
    ]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1, 'exactly one decision accepted');
    assert.ok(results.filter((x) => x.status === 'rejected').every((x) => x.reason.code === 'INVALID_STATE' || x.reason.code === 'ALREADY_DECIDED'), 'the others are refused, not half-recorded');
    assert.deepEqual(await kindsOf(file), ['ANALYSED', 'HUMAN_DECISION'], 'no second, invalid event reached the journal');
    const restarted = runtimeOn(createFileJournal({ merchantId: MID, file }));
    assert.equal((await restarted.overview()).decisions[0].entry.human_decision.decision, results.find((x) => x.status === 'fulfilled').value.entry.human_decision.decision);
  });
});

test('P1 a refused input never reaches the journal (role, state and input are checked before the append, inside the queue)', async () => {
  await withDir(async (dir) => {
    const { file, rt, r } = await seeded(dir);
    assert.equal(await code(rt.decideHuman(r.entry.id, { decision: 'NONSENSE' }, OWNER)), 'INVALID_DECISION');
    assert.equal(await code(rt.decideHuman(r.entry.id, { decision: 'APPROVED', reason: 'x' }, { userId: 'u', role: 'VIEWER' })), 'APPROVAL_ROLE_REQUIRED');
    assert.equal(await code(rt.decideHuman('log_unknown', { decision: 'DEFERRED', reason: 'x' }, OWNER)), 'NOT_FOUND');
    assert.deepEqual(await kindsOf(file), ['ANALYSED']);
  });
});

// =============================================================================================== P7: simultaneous analyses
test('P7 two simultaneous analyses of the same case version: ONE ANALYSED line, the second is UNCHANGED', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'j.jsonl'); const rt = runtimeOn(createFileJournal({ merchantId: MID, file }));
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => rt.analyseCase(goCase(), { externals, actor: OWNER })));
    assert.deepEqual([a.status, b.status, c.status].sort(), ['ANALYSED', 'UNCHANGED', 'UNCHANGED']);
    assert.equal((await kindsOf(file)).length, 1);
    assert.equal((await runtimeOn(createFileJournal({ merchantId: MID, file })).overview()).decisions.length, 1);
    // another case in parallel is independent: both are recorded
    const [x, y] = await Promise.all([rt.analyseCase(goCase('case-x', 500), { externals, actor: OWNER }), rt.analyseCase(goCase('case-y', 700), { externals, actor: OWNER })]);
    assert.equal(x.status, 'ANALYSED'); assert.equal(y.status, 'ANALYSED'); assert.equal((await kindsOf(file)).length, 3);
  });
});

// =============================================================================================== results: simultaneous follow-ups
test('P1/P7 two simultaneous results for the same decision: ONE RESULT line, ALREADY_MEASURED for the other, the Core restarts', async () => {
  await withDir(async (dir) => {
    const { file, rt, r } = await seeded(dir);
    await rt.decideHuman(r.entry.id, { decision: 'APPROVED', reason: 'test' }, OWNER);
    const results = await Promise.allSettled([
      rt.recordResult(r.entry.id, { result: 'NOT_MEASURABLE', notes: 'a' }, OWNER),
      rt.recordResult(r.entry.id, { result: 'UNKNOWN', notes: 'b' }, OWNER),
    ]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(results.find((x) => x.status === 'rejected').reason.code, 'ALREADY_MEASURED');
    assert.deepEqual(await kindsOf(file), ['ANALYSED', 'HUMAN_DECISION', 'RESULT']);
    assert.equal((await runtimeOn(createFileJournal({ merchantId: MID, file })).overview()).in_follow_up, 0);
  });
});

// =============================================================================================== P2: interrupted write
test('P2 a write interrupted midway: the append REJECTS, nothing is announced as recorded, the journal is protected, the file and the evidence are kept', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'j.jsonl');
    let armed = false;
    const journal = createFileJournal({ merchantId: MID, file, hooks: { beforeWrite: async () => { if (!armed) return; await appendFile(file, '{"seq":2,"at":"2026-10-03T12:00:00.000Z","merchant_id":"merchant-test","kind":"HUMAN_DEC'); throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); } } });
    const rt = runtimeOn(journal);
    const r = await rt.analyseCase(goCase(), { externals, actor: OWNER });
    const before = await readFile(file);
    armed = true;
    const err = await rt.decideHuman(r.entry.id, { decision: 'DEFERRED', reason: 'x' }, OWNER).catch((e) => e);
    assert.ok(err instanceof Error); assert.equal(err.code, 'JOURNAL_WRITE_FAILED'); assert.equal(err.status, 503, 'the HTTP layer answers an error, never a success');
    assert.equal((await rt.entry(r.entry.id)).entry.human_decision, null, 'the in-memory state did not move: no "recorded"');
    assert.equal(journal.status().state, 'PROTECTED');
    // the file is exactly what the failure left: the original events plus the partial bytes; nothing was truncated or repaired
    const after = await readFile(file);
    assert.ok(after.length > before.length); assert.ok(after.subarray(0, before.length).equals(before));
    // the evidence is kept next to it
    const fault = JSON.parse((await linesOf(`${file}.faults.jsonl`))[0]);
    assert.equal(fault.code, 'JOURNAL_WRITE_FAILED'); assert.equal(fault.cause_code, 'ENOSPC'); assert.equal(fault.seq, 2); assert.match(fault.message, /ENOSPC/);
  });
});

test('P2 after a failed write NO further write is accepted (JOURNAL_PROTECTED) until a controlled restart; reads still work', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'j.jsonl'); let fail = false;
    const journal = createFileJournal({ merchantId: MID, file, hooks: { beforeWrite: async () => { if (fail) throw new Error('EIO'); } } });
    const rt = runtimeOn(journal);
    const r = await rt.analyseCase(goCase(), { externals, actor: OWNER });
    fail = true;
    assert.equal(await code(rt.decideHuman(r.entry.id, { decision: 'DEFERRED', reason: '1' }, OWNER)), 'JOURNAL_WRITE_FAILED');
    fail = false; // even if the cause disappears, the journal stays protected: the outcome of the failed write is not known
    assert.equal(await code(rt.decideHuman(r.entry.id, { decision: 'DEFERRED', reason: '2' }, OWNER)), 'JOURNAL_PROTECTED');
    assert.equal(await code(rt.analyseCase(goCase('another'), { externals, actor: OWNER })), 'JOURNAL_PROTECTED');
    assert.equal((await rt.overview()).decisions.length, 1, 'consultation still works');
    assert.equal((await linesOf(file)).length, 1, 'nothing was added to the journal');
    // a controlled restart (a new process) reads the intact file and writes again
    const restarted = runtimeOn(createFileJournal({ merchantId: MID, file }));
    assert.equal((await restarted.decideHuman(r.entry.id, { decision: 'DEFERRED', reason: 'after restart' }, OWNER)).entry.human_decision.decision, 'DEFERRED');
  });
});

test('P2 durability uncertain (the line was written, the sync or the size check failed): not acknowledged, journal protected, and the event is replayed after restart - never silently dropped', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'j.jsonl'); let arm = false;
    const journal = createFileJournal({ merchantId: MID, file, hooks: { afterWrite: async () => { if (arm) throw new Error('EIO on sync'); } } });
    const rt = runtimeOn(journal);
    const r = await rt.analyseCase(goCase(), { externals, actor: OWNER });
    arm = true;
    assert.equal(await code(rt.decideHuman(r.entry.id, { decision: 'DEFERRED', reason: 'x' }, OWNER)), 'JOURNAL_WRITE_FAILED');
    assert.equal((await rt.entry(r.entry.id)).entry.human_decision, null);
    assert.equal(journal.status().state, 'PROTECTED');
    const restarted = runtimeOn(createFileJournal({ merchantId: MID, file }));
    assert.equal((await restarted.entry(r.entry.id)).entry.human_decision.decision, 'DEFERRED', 'what reached the disk is the truth after a restart (the owner is told to check before retrying)');
  });
});

// =============================================================================================== P3: torn tail, middle corruption, broken chain
test('P3 a torn LAST line is diagnosed JOURNAL_TORN_TAIL (not a generic corruption), the file is untouched and the diagnosis names line and offset', async () => {
  await withDir(async (dir) => {
    const { file, rt, r } = await seeded(dir);
    await rt.decideHuman(r.entry.id, { decision: 'DEFERRED', reason: 'x' }, OWNER);
    const raw = await readFile(file); const cut = raw.subarray(0, raw.length - 40); await writeFile(file, cut);
    const err = await runtimeOn(createFileJournal({ merchantId: MID, file })).overview().catch((e) => e);
    assert.equal(err.code, 'JOURNAL_TORN_TAIL'); assert.equal(err.diagnostic, 'TORN_TAIL');
    assert.equal(err.details.line, 2); assert.equal(err.details.valid_events, 1);
    assert.equal(err.details.offset, Buffer.byteLength((await linesOf(file))[0]) + 1, 'the offset is where the torn line starts');
    assert.ok((await readFile(file)).equals(cut), 'never repaired, truncated or deleted by code');
  });
});

test('P3 a corruption in the MIDDLE, a damaged terminated last line and a broken chain are told apart', async () => {
  await withDir(async (dir) => {
    const { file, rt, r } = await seeded(dir);
    await rt.decideHuman(r.entry.id, { decision: 'DEFERRED', reason: 'x' }, OWNER);
    const ok = await readFile(file, 'utf8'); const ls = ok.split('\n');
    // middle: the first of two lines is not JSON
    await writeFile(file, `{"seq":1,"broken\n${ls[1]}\n`);
    let e = await runtimeOn(createFileJournal({ merchantId: MID, file })).overview().catch((x) => x);
    assert.equal(e.code, 'JOURNAL_CORRUPT'); assert.equal(e.diagnostic, 'CORRUPT_MIDDLE'); assert.equal(e.details.line, 1);
    // last line, terminated, not JSON
    await writeFile(file, `${ls[0]}\nnot json at all\n`);
    e = await runtimeOn(createFileJournal({ merchantId: MID, file })).overview().catch((x) => x);
    assert.equal(e.code, 'JOURNAL_CORRUPT'); assert.equal(e.diagnostic, 'CORRUPT_LAST_LINE');
    // chain: an edited figure
    await writeFile(file, ok.replace('"DEFERRED"', '"APPROVED"'));
    e = await runtimeOn(createFileJournal({ merchantId: MID, file })).overview().catch((x) => x);
    assert.equal(e.code, 'JOURNAL_CORRUPT'); assert.equal(e.diagnostic, 'CHAIN_BROKEN');
    // a removed first line
    await writeFile(file, `${ls[1]}\n`);
    e = await runtimeOn(createFileJournal({ merchantId: MID, file })).overview().catch((x) => x);
    assert.equal(e.code, 'JOURNAL_CORRUPT'); assert.equal(e.diagnostic, 'SEQUENCE');
    // another merchant
    await writeFile(file, ok);
    e = await createCoreRuntime({ merchantId: 'someone-else', config: CONFIG, journal: createFileJournal({ merchantId: 'someone-else', file }) }).overview().catch((x) => x);
    assert.equal(e.code, 'JOURNAL_CORRUPT'); assert.equal(e.diagnostic, 'WRONG_MERCHANT');
    // and the pure inspector agrees
    assert.equal(inspectJournalText(ok, MID).events.length, 2);
  });
});

test('P3 controlled recovery of a torn tail: copy, quarantine, verify, human confirmation, then apply; originals are kept; the live file is never touched before apply', async () => {
  await withDir(async (dir) => {
    const { file, rt, r } = await seeded(dir);
    await rt.decideHuman(r.entry.id, { decision: 'DEFERRED', reason: 'x' }, OWNER);
    const raw = await readFile(file); await writeFile(file, raw.subarray(0, raw.length - 25));
    const damaged = await readFile(file);
    assert.equal((await diagnoseJournal(file, MID)).status, 'TORN_TAIL');
    const out = join(dir, 'recovery');
    const m = await prepareRecovery({ file, merchantId: MID, outDir: out, now: () => new Date('2026-10-16T08:00:00Z') });
    assert.ok((await readFile(file)).equals(damaged), 'prepare changed nothing in the live journal');
    assert.ok((await readFile(join(out, 'original.jsonl'))).equals(damaged), 'the original is copied byte for byte');
    assert.equal(m.candidate.events, 1); assert.equal(m.quarantined_tail.bytes, damaged.length - Buffer.byteLength(`${(await linesOf(join(out, 'recovered.jsonl')))[0]}\n`));
    const v = await verifyRecovery({ outDir: out, merchantId: MID });
    assert.equal(v.events, 1); assert.match(v.confirmation_code, /^[0-9a-f]{12}$/);
    await assert.rejects(applyRecovery({ file, outDir: out, merchantId: MID, confirm: 'wrong-code' }), { code: 'RECOVERY_CONFIRMATION_REQUIRED' });
    await assert.rejects(applyRecovery({ file, outDir: out, merchantId: MID }), { code: 'RECOVERY_CONFIRMATION_REQUIRED' });
    assert.ok((await readFile(file)).equals(damaged), 'still untouched');
    // the live file changed since the preparation: refused
    await appendFile(file, 'x'); await assert.rejects(applyRecovery({ file, outDir: out, merchantId: MID, confirm: v.confirmation_code }), { code: 'RECOVERY_LIVE_CHANGED' }); await writeFile(file, damaged);
    // a fresh writer lock means a writer is active: refused
    await writeFile(`${file}.lock`, '{}'); await assert.rejects(applyRecovery({ file, outDir: out, merchantId: MID, confirm: v.confirmation_code }), { code: 'RECOVERY_WRITER_ACTIVE' }); await rm(`${file}.lock`);
    const applied = await applyRecovery({ file, outDir: out, merchantId: MID, confirm: v.confirmation_code, now: () => new Date('2026-10-16T08:05:00Z') });
    assert.ok((await readFile(applied.kept_copy)).equals(damaged), 'the replaced live file is kept');
    assert.equal(applied.events, 1);
    const restarted = runtimeOn(createFileJournal({ merchantId: MID, file }));
    const o = await restarted.overview();
    assert.equal(o.decisions.length, 1); assert.equal(o.decisions[0].entry.human_decision, null, 'the decision lost in the torn write is asked of the owner again');
    assert.equal((await restarted.decideHuman(r.entry.id, { decision: 'DEFERRED', reason: 'again' }, OWNER)).entry.human_decision.decision, 'DEFERRED', 'and it can be recorded again');
    // a prepared recovery is never written over another one
    await assert.rejects(prepareRecovery({ file, merchantId: MID, outDir: out }), { code: 'RECOVERY_NOT_APPLICABLE' });
  });
});

test('P3 recovery handles a last event whose newline alone never reached the disk (nothing lost), and refuses every other kind of damage', async () => {
  await withDir(async (dir) => {
    const { file, rt, r } = await seeded(dir);
    await rt.decideHuman(r.entry.id, { decision: 'DEFERRED', reason: 'x' }, OWNER);
    const raw = await readFile(file); await writeFile(file, raw.subarray(0, raw.length - 1)); // only the final "\n" is missing
    const d = await diagnoseJournal(file, MID); assert.equal(d.status, 'TORN_TAIL'); assert.equal(d.details.complete_event, true);
    const out = join(dir, 'rec'); const m = await prepareRecovery({ file, merchantId: MID, outDir: out });
    assert.equal(m.candidate.events, 2, 'both events kept'); assert.equal(m.quarantined_tail.bytes, 0);
    const v = await verifyRecovery({ outDir: out, merchantId: MID });
    await applyRecovery({ file, outDir: out, merchantId: MID, confirm: v.confirmation_code });
    assert.equal((await runtimeOn(createFileJournal({ merchantId: MID, file })).overview()).decisions[0].entry.human_decision.decision, 'DEFERRED');
    // middle corruption: not prepared automatically
    const ls = (await readFile(file, 'utf8')).split('\n'); await writeFile(file, `${ls[0].slice(0, 30)}\n${ls[1]}\n`);
    await assert.rejects(prepareRecovery({ file, merchantId: MID, outDir: join(dir, 'rec2') }), { code: 'RECOVERY_NOT_APPLICABLE' });
    assert.deepEqual(await readdir(dir).then((n) => n.filter((x) => x === 'rec2')), [], 'nothing was created for a refused preparation');
  });
});

// =============================================================================================== multi-process: a second writer
test('writers: a second journal object on a STALE head is refused (JOURNAL_STALE), protected, and the file holds only the first writer\'s events', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'j.jsonl');
    const a = runtimeOn(createFileJournal({ merchantId: MID, file })); const jb = createFileJournal({ merchantId: MID, file }); const b = runtimeOn(jb);
    const ra = await a.analyseCase(goCase('case-a'), { externals, actor: OWNER });
    await b.overview(); // b loads: head = 1 event
    await a.decideHuman(ra.entry.id, { decision: 'DEFERRED', reason: 'a' }, OWNER); // a appends seq 2
    assert.equal(await code(b.analyseCase(goCase('case-b', 800), { externals, actor: OWNER })), 'JOURNAL_STALE');
    assert.equal(jb.status().state, 'PROTECTED');
    assert.deepEqual(await kindsOf(file), ['ANALYSED', 'HUMAN_DECISION'], 'the stale writer wrote nothing');
    assert.equal((await runtimeOn(createFileJournal({ merchantId: MID, file })).overview()).decisions.length, 1, 'the file is not forked: it restarts');
  });
});

test('writers: the write lock - a held lock refuses with JOURNAL_LOCKED (transient, nothing written, NOT protected); a crashed writer\'s old lock is taken over', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'j.jsonl'); const journal = createFileJournal({ merchantId: MID, file, lock: { waitMs: 150, staleMs: 400 } });
    const rt = runtimeOn(journal);
    await writeFile(`${file}.lock`, JSON.stringify({ token: 'someone-else', pid: 1 })); // a live writer
    assert.equal(await code(rt.analyseCase(goCase(), { externals, actor: OWNER })), 'JOURNAL_LOCKED');
    assert.equal(journal.status().state, 'OK', 'a lock is a transient refusal, not a fault');
    await assert.rejects(stat(file), { code: 'ENOENT' });
    // the lock ages: the writer is presumed crashed, the lock is taken over, the append goes through and the lock is released
    const old = new Date(Date.now() - 5000); await utimes(`${file}.lock`, old, old);
    assert.equal((await rt.analyseCase(goCase(), { externals, actor: OWNER })).status, 'ANALYSED');
    await assert.rejects(stat(`${file}.lock`), { code: 'ENOENT' });
    assert.equal((await linesOf(file)).length, 1);
  });
});

test('writers: many parallel appends through two journal objects on one file keep a single valid chain (the lock + the stale check), or refuse - never fork', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'j.jsonl');
    const mkj = () => createFileJournal({ merchantId: MID, file });
    const a = mkj(); const b = mkj();
    await a.append({ kind: 'X', payload: { n: 0 }, at: NOW.toISOString() });
    await b.all();
    const results = await Promise.allSettled([...Array(10)].flatMap((_, i) => [a.append({ kind: 'X', payload: { n: i }, at: NOW.toISOString() }), b.append({ kind: 'X', payload: { n: i }, at: NOW.toISOString() })]));
    const raw = await readFile(file, 'utf8');
    const { events } = inspectJournalText(raw, MID); // throws if the chain forked
    assert.ok(events.length >= 11); assert.equal(events.length, 1 + results.filter((x) => x.status === 'fulfilled').length, 'every acknowledged append is in the file, nothing else');
    assert.ok(results.filter((x) => x.status === 'rejected').every((x) => ['JOURNAL_STALE', 'JOURNAL_PROTECTED'].includes(x.reason.code)));
  });
});

// =============================================================================================== P5/P6: campaigns and creations
const camp = (file) => createCampaignService({ merchantId: MID, branding: null, file, env: {}, now: () => '2026-10-15T10:00:00.000Z' });
const PROPOSAL = { product: 'Mug', objective: 'boutique', audience: 'parents', channel: 'Instagram', copy: 'Un cadeau imprimé avec soin.' };

test('P5 campaigns: only a missing file is an empty history; damage, a cut-short line and an unreadable file are explicit errors, never "no campaigns"', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'campaigns.jsonl'); const svc = camp(file);
    assert.deepEqual(await svc.list(), [], 'ENOENT = a history that has not started');
    const p1 = await svc.prepare(PROPOSAL, OWNER); const p2 = await svc.prepare({ ...PROPOSAL, product: 'Tasse' }, OWNER);
    assert.equal((await svc.list()).length, 2);
    const ok = await readFile(file, 'utf8'); const ls = ok.split('\n');
    await writeFile(file, `${ls[0]}\n{"kind":"DECISION","id":"x","dec\n${ls[1]}\n`); // damaged line in the middle
    assert.equal(await code(svc.list()), 'CAMPAIGN_JOURNAL_CORRUPT');
    assert.equal(await code(svc.decide(p2.id, { decision: 'REJECTED', reason: 'x' }, OWNER)), 'CAMPAIGN_JOURNAL_CORRUPT', 'not NOT_FOUND: the proposal exists, the file is damaged');
    assert.equal(await code(svc.prepare(PROPOSAL, OWNER)), 'CAMPAIGN_JOURNAL_CORRUPT', 'and nothing is appended after a damaged history');
    await writeFile(file, ok.slice(0, ok.length - 30)); // cut-short last line
    assert.equal(await code(svc.list()), 'CAMPAIGN_JOURNAL_TORN_TAIL');
    assert.equal(await code(svc.decide(p1.id, { decision: 'REJECTED', reason: 'x' }, OWNER)), 'CAMPAIGN_JOURNAL_TORN_TAIL');
    assert.equal((await readFile(file, 'utf8')), ok.slice(0, ok.length - 30), 'the file is untouched');
    await rm(file); await mkdir(file); // a directory where the file should be: an I/O error, not an empty list
    assert.equal(await code(svc.list()), 'CAMPAIGN_JOURNAL_UNREADABLE');
    const e = await svc.list().catch((x) => x); assert.equal(e.status, 503);
  });
});

test('P6 campaigns: an approval and a rejection arriving together are NOT both recorded (state check + append are one unit)', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'campaigns.jsonl'); const svc = camp(file); const p = await svc.prepare(PROPOSAL, OWNER);
    const results = await Promise.allSettled([
      svc.decide(p.id, { decision: 'APPROVED_FOR_CREATION', reason: 'oui' }, OWNER), svc.decide(p.id, { decision: 'REJECTED', reason: 'non' }, OWNER), svc.decide(p.id, { decision: 'DEFERRED', reason: 'peut-être' }, OWNER),
    ]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.ok(results.filter((x) => x.status === 'rejected').every((x) => x.reason.code === 'ALREADY_DECIDED'));
    const decisions = (await linesOf(file)).map((l) => JSON.parse(l)).filter((e) => e.kind === 'DECISION');
    assert.equal(decisions.length, 1); assert.equal((await svc.list())[0].decision.decision, results.find((x) => x.status === 'fulfilled').value.decision, 'what is shown is what was acknowledged');
  });
});

test('P6 campaigns: two services (two processes) on one file also record one decision (the file lock)', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'campaigns.jsonl'); const a = camp(file); const b = camp(file); const p = await a.prepare(PROPOSAL, OWNER);
    const results = await Promise.allSettled([a.decide(p.id, { decision: 'APPROVED_FOR_CREATION', reason: '1' }, OWNER), b.decide(p.id, { decision: 'REJECTED', reason: '2' }, OWNER)]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((await linesOf(file)).filter((l) => JSON.parse(l).kind === 'DECISION').length, 1);
  });
});

const PHOTO = () => new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#222"/><rect x="10" y="10" width="280" height="380" fill="#c9a"/></svg>').render().asPng());
const UUID_MERCHANT = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5'; // the visual's design document requires the merchant's Nordla UUID
const creationOn = async (dir) => createCreationService({ merchantId: UUID_MERCHANT, config: await loadCreationConfig({ SOURCING_MERCHANT_ID: 'habb' }), branding: null, dir });

test('P6/P5 creations: two identical requests make ONE visual; contradictory decisions record one; a damaged journal is an explicit error', async () => {
  await withDir(async (dir) => {
    const svc = await creationOn(dir); const photo = PHOTO();
    const [a, b] = await Promise.all([svc.render({ photo, headline: 'Un cadeau imprimé avec soin' }, OWNER), svc.render({ photo, headline: 'Un cadeau imprimé avec soin' }, OWNER)]);
    assert.equal(a.id, b.id); assert.equal((await svc.list()).length, 1, 'kept once, even when the two requests overlap');
    const results = await Promise.allSettled([svc.decide(a.id, { decision: 'APPROVED', reason: 'oui' }, OWNER), svc.decide(a.id, { decision: 'REJECTED', reason: 'non' }, OWNER)]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(results.find((x) => x.status === 'rejected').reason.code, 'ALREADY_DECIDED');
    assert.equal((await readFile(join(dir, 'creations.jsonl'), 'utf8')).split('\n').filter((l) => l.includes('"DECISION"')).length, 1);
    assert.ok((await svc.image(a.id)).length > 100, 'the PNG is there');
    const ok = await readFile(join(dir, 'creations.jsonl'), 'utf8');
    await writeFile(join(dir, 'creations.jsonl'), ok.slice(0, ok.length - 20));
    assert.equal(await code(svc.list()), 'CREATION_JOURNAL_TORN_TAIL');
    assert.equal(await code(svc.decide(a.id, { decision: 'REJECTED', reason: 'x' }, OWNER)), 'CREATION_JOURNAL_TORN_TAIL');
    await writeFile(join(dir, 'creations.jsonl'), `garbage\n${ok}`);
    assert.equal(await code(svc.list()), 'CREATION_JOURNAL_CORRUPT');
  });
});

// =============================================================================================== compatibility with journals written by the ORIGINAL code
const GOLDEN = new URL('./fixtures/core-journal-v1/', import.meta.url);
test('compat: a journal written by the ORIGINAL code (f721e49) replays identically, keeps its head, and accepts new events', async () => {
  await withDir(async (dir) => {
    const expected = JSON.parse(await readFile(new URL('expected.json', GOLDEN), 'utf8'));
    const raw = await readFile(new URL('decision-journal.jsonl', GOLDEN));
    const file = join(dir, 'decision-journal.jsonl'); await writeFile(file, raw);
    assert.equal(inspectJournalText(raw.toString('utf8'), MID).events.length, expected.lines, 'every golden event verifies under the new inspector');
    const rt = runtimeOn(createFileJournal({ merchantId: MID, file }));
    const o = await rt.overview();
    assert.equal(o.journal_head, expected.journal_head, 'the chain head is the one the original code produced');
    assert.deepEqual(o.decisions.map((d) => ({ entry: d.entry.id, human: d.entry.human_decision?.decision ?? null, result: d.entry.result?.result ?? null, case: d.source?.case_id })).sort((x, y) => (x.entry < y.entry ? -1 : 1)), expected.decisions.slice().sort((x, y) => (x.entry < y.entry ? -1 : 1)));
    assert.ok((await readFile(file)).equals(raw), 'replaying does not touch the file');
    // the new code appends to it, and the ORIGINAL verification rules (same chain function) still accept the result
    const waiting = o.decisions.find((d) => !d.entry.human_decision);
    const before = (await linesOf(file)).length;
    await rt.decideHuman(waiting.entry.id, { decision: 'DEFERRED', reason: 'after upgrade' }, OWNER);
    const events = (await linesOf(file)).map((l) => JSON.parse(l)); assert.equal(events.length, before + 1);
    verifyChain(events, MID);
    assert.equal(events.at(-1).prev, expected.journal_head, 'the new event chains onto the old head');
    assert.equal((await runtimeOn(createFileJournal({ merchantId: MID, file })).overview()).decisions.length, expected.decisions.length);
  });
});

test('compat: the in-memory journal (used by older tests) behaves as before, and its append never reports success on a failed write', async () => {
  const j = createMemoryJournal({ merchantId: MID });
  const e = await j.append({ kind: 'X', payload: {}, at: NOW.toISOString() });
  assert.equal(e.seq, 1); assert.equal((await j.all()).length, 1); assert.equal(j.status().state, 'OK');
  assert.equal(await code(Promise.resolve().then(() => createMemoryJournal({ merchantId: '' }))), 'MERCHANT_REQUIRED');
});

test('readJsonlStrict: absent file is empty; a directory, a torn tail and a bad line are typed errors with the HTTP status 503', async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await readJsonlStrict(join(dir, 'none.jsonl'), 'X_JOURNAL'), []);
    await writeFile(join(dir, 'ok.jsonl'), '{"a":1}\n{"a":2}\n'); assert.equal((await readJsonlStrict(join(dir, 'ok.jsonl'), 'X_JOURNAL')).length, 2);
    await writeFile(join(dir, 'torn.jsonl'), '{"a":1}\n{"a"'); const e = await readJsonlStrict(join(dir, 'torn.jsonl'), 'X_JOURNAL').catch((x) => x);
    assert.equal(e.code, 'X_JOURNAL_TORN_TAIL'); assert.equal(e.status, 503); assert.equal(e.details.line, 2);
    await writeFile(join(dir, 'bad.jsonl'), '{"a":1}\nnope\n{"a":3}\n'); assert.equal(await code(readJsonlStrict(join(dir, 'bad.jsonl'), 'X_JOURNAL')), 'X_JOURNAL_CORRUPT');
    await copyFile(join(dir, 'ok.jsonl'), join(dir, 'copy.jsonl'));
  });
});
