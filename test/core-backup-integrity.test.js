// Backup and restore of the Core's data with INTEGRITY checks (mandate 2026-10-15, point 4): the decision journal inside an archive is verified (hash chain, order, merchant)
// when the archive is made, when it is verified and before anything is restored; a backup taken during an append is cut back in the COPY only; a backup holding an
// inconsistent journal is never declared restorable. Real services, real encrypted archives, synthetic data, nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { backup, restore, verify, journalReport } from '../tools/sourcing-backup.mjs';
import { createFileStore } from '../src/sourcing/store/file-store.js';
import { createFilePhotoStore } from '../src/sourcing/store/photo-store.js';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { createCoreRuntime } from '../src/core-pilot/runtime.js';
import { createFileJournal, inspectJournalText } from '../src/core-pilot/journal.js';
import { validateCoreConfig } from '../src/core-pilot/config.js';
import { createBrandingService, loadBrandProposal } from '../src/core-pilot/branding.js';
import { createCampaignService } from '../src/core-pilot/campaign.js';
import { createCreationService, loadCreationConfig } from '../src/core-pilot/creation.js';
import { NOW, LIVE_CLEAN, ident, traits, importer, commercial } from './sourcing-fixtures.js';

const M = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5';
const ENV = { SOURCING_MERCHANT_ID: 'habb', SOURCING_BACKUP_PASSPHRASE: 'core integrity drill passphrase' };
const OWNER = { role: 'OWNER', userId: '00000001-2222-4222-8222-000000000001' };
const CONFIG = validateCoreConfig({ schema: 1, merchantId: 'test', currency: 'EUR', gates: { materialityThreshold: 0, maxPrioritySubjects: 10, cooldownDays: 14, aggravationFactor: 1.5 }, testSmall: { budget: null }, ownerRules: [] });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const PHOTO_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////8=';
const mk = (events, id) => { let c = newCase({ id, name: 'x', now: NOW }); for (const e of events) c = dispatch(c, e, NOW); return c; };
const goCase = (id, qty = 1000) => mk([...ident({ name: 'Bamboo kitchen organiser', category: 'household_general' }), ...traits({}), ...importer, { type: 'SUPPLIER', supplier: { name: 'Yiwu Greenline' } }, ...commercial({ unitPrice: 4.2, qty })], id);
const withRoot = async (fn) => { const root = await mkdtemp(join(tmpdir(), 'core-bk-')); try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); } };
const treeHashes = async (root, dir = root, out = {}) => { for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) await treeHashes(root, p, out); else if (!e.name.endsWith('.lock')) out[relative(root, p).split(sep).join('/')] = sha(await readFile(p)); } return out; };
const journalFile = (dir) => join(dir, 'core', 'decision-journal.jsonl');
const runtimeOn = (dir) => createCoreRuntime({ merchantId: 'merchant-test', config: CONFIG, journal: createFileJournal({ merchantId: 'merchant-test', file: journalFile(dir) }), now: () => NOW });
const code = async (p) => { try { await p; return 'OK'; } catch (e) { return e.code ?? e.name; } };

async function populate(dir) {
  const cases = createFileStore(join(dir, 'cases')); await cases.save(goCase('case-1')); await cases.save(goCase('case-2', 600));
  const photos = createFilePhotoStore(join(dir, 'photos')); await photos.put('case-1', 'photo:case-1.0', PHOTO_URL);
  const rt = runtimeOn(dir);
  const a = await rt.analyseCase(goCase('case-1'), { externals: { safety: LIVE_CLEAN }, actor: OWNER });
  await rt.decideHuman(a.entry.id, { decision: 'APPROVED', reason: 'test de 1000 pièces' }, OWNER);
  await rt.recordResult(a.entry.id, { result: 'NOT_MEASURABLE', notes: 'pas encore vendu' }, OWNER);
  const b = await rt.analyseCase(goCase('case-2', 600), { externals: { safety: LIVE_CLEAN }, actor: OWNER });
  await rt.decideHuman(b.entry.id, { decision: 'DEFERRED', reason: 'attendre' }, OWNER);
  const branding = createBrandingService({ merchantId: M, proposal: await loadBrandProposal(ENV), file: join(dir, 'core', 'brand-approved.json') });
  await branding.approve(OWNER);
  const campaigns = createCampaignService({ merchantId: M, branding, file: join(dir, 'core', 'campaigns.jsonl'), env: {} });
  const camp = await campaigns.prepare({ product: 'Mug', objective: 'boutique', audience: 'parents', channel: 'Instagram', copy: 'Un cadeau imprimé avec soin.' }, OWNER);
  await campaigns.decide(camp.id, { decision: 'DEFERRED', reason: 'plus tard' }, OWNER);
  const creation = createCreationService({ merchantId: M, config: await loadCreationConfig(ENV), branding, dir: join(dir, 'core', 'creations') });
  const photo = new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#222"/><rect x="10" y="10" width="280" height="380" fill="#c9a"/></svg>').render().asPng());
  const visual = await creation.render({ photo, headline: 'Un cadeau imprimé avec soin' }, OWNER);
  await creation.decide(visual.id, { decision: 'APPROVED', reason: 'ok' }, OWNER);
  return { camp, visual };
}
const statesOf = async (dir, visualId) => {
  const rt = runtimeOn(dir); const o = await rt.overview();
  const branding = createBrandingService({ merchantId: M, proposal: await loadBrandProposal(ENV), file: join(dir, 'core', 'brand-approved.json') });
  const campaigns = createCampaignService({ merchantId: M, branding, file: join(dir, 'core', 'campaigns.jsonl'), env: {} });
  const creation = createCreationService({ merchantId: M, config: await loadCreationConfig(ENV), branding, dir: join(dir, 'core', 'creations') });
  const photos = createFilePhotoStore(join(dir, 'photos')); const cases = createFileStore(join(dir, 'cases'));
  const ph = await photos.get('case-1', 'photo:case-1.0');
  return {
    head: o.journal_head, decisions: o.decisions.map((d) => ({ id: d.entry.id, human: d.entry.human_decision, result: d.entry.result, actor_case: d.source?.case_id })),
    branding: (await branding.status()).status, campaigns: await campaigns.list(), creations: await creation.list(), png: sha(await creation.image(visualId)),
    cases: await cases.list(), photo: { sha256: ph.sha256, data: sha(ph.dataUrl) }, case1: await cases.get('case-1'),
  };
};

test('full restore: journal chain, decisions and actors, cases, photos, Branding approval, campaigns, creations and PNG come back with identical hashes and identical rebuilt states', async () => {
  await withRoot(async (root) => {
    const live = join(root, 'live'); const restored = join(root, 'restored');
    const { visual } = await populate(live);
    const before = await statesOf(live, visual.id);
    const hashesBefore = await treeHashes(live);
    const made = await backup(live, join(root, 'backups'), { env: ENV });
    assert.equal(made.restorable, true); assert.deepEqual(made.journals.map((j) => j.status), ['OK']); assert.deepEqual(made.adjustments, []);
    const v = await verify(made.file, { env: ENV });
    assert.equal(v.ok, true); assert.equal(v.journals[0].events, 5, 'the verifier re-checked the chain of the journal inside the archive');
    const r = await restore(made.file, restored, { env: ENV });
    assert.equal(r.journals[0].status, 'OK'); assert.equal(r.journals[0].head, v.journals[0].head);
    assert.deepEqual(await treeHashes(restored), hashesBefore, 'every file comes back byte for byte (the journal, the cases, the photos, the PNG, the approvals)');
    const after = await statesOf(restored, visual.id);
    assert.deepEqual(after, before, 'the states rebuilt from the restored copy equal the live ones');
    assert.ok(before.decisions.some((d) => d.human?.approver?.startsWith?.('user:') || d.human?.approver), 'decisions carry their approver');
    // the restored Core continues the SAME chain
    const rt = runtimeOn(restored); const open = (await rt.overview()).decisions.find((d) => d.entry.human_decision?.decision === 'DEFERRED');
    assert.equal(inspectJournalText(await readFile(journalFile(restored), 'utf8'), 'merchant-test').events.length, 5);
    assert.equal(open.entry.human_decision.decision, 'DEFERRED');
  });
});

test('backup during writes: archives made while the journal is being appended always verify and restore into a Core that starts (a cut-short copy is trimmed in the COPY, recorded, and the live file is never touched)', async () => {
  await withRoot(async (root) => {
    const live = join(root, 'live'); const file = journalFile(live);
    const j = createFileJournal({ merchantId: 'merchant-test', file });
    await j.append({ kind: 'SEED', payload: { n: 0 }, at: NOW.toISOString() });
    let stop = false; let appended = 1;
    const writer = (async () => { while (!stop) { await j.append({ kind: 'SEED', payload: { n: appended }, at: NOW.toISOString() }); appended += 1; await new Promise((r) => setTimeout(r, 1)); } })();
    const archives = [];
    for (let i = 0; i < 8; i += 1) { archives.push(await backup(live, join(root, 'backups'), { env: ENV, now: () => new Date(Date.UTC(2026, 9, 15, 10, 0, i)) })); }
    stop = true; await writer;
    for (const [i, a] of archives.entries()) {
      assert.equal(a.restorable, true, `archive ${i}`); const v = await verify(a.file, { env: ENV }); assert.equal(v.ok, true);
      const target = join(root, `restored-${i}`); const r = await restore(a.file, target, { env: ENV });
      assert.equal(r.journals[0].status, 'OK'); assert.ok(r.journals[0].events >= 1);
      assert.equal(inspectJournalText(await readFile(journalFile(target), 'utf8'), 'merchant-test').events.length, r.journals[0].events);
    }
    assert.equal(inspectJournalText(await readFile(file, 'utf8'), 'merchant-test').events.length, appended, 'the live journal kept every event');
  });
});

test('backup of a journal that was cut short mid-append: the COPY is trimmed to the last whole event and the cut is recorded; the live file stays byte-identical; the archive restores', async () => {
  await withRoot(async (root) => {
    const live = join(root, 'live'); await populate(live);
    const f = journalFile(live); const whole = await readFile(f); const torn = Buffer.concat([whole, Buffer.from('{"seq":6,"at":"2026-10-03T12:00:00.000Z","merchant_id":"merchant-test","kind":"HUMAN_DEC')]);
    await writeFile(f, torn);
    const made = await backup(live, join(root, 'backups'), { env: ENV });
    assert.equal(made.restorable, true);
    assert.equal(made.adjustments.length, 1); assert.equal(made.adjustments[0].kind, 'TORN_TAIL_TRIMMED_IN_COPY'); assert.equal(made.adjustments[0].removed_bytes, torn.length - whole.length); assert.equal(made.adjustments[0].events_kept, 5);
    assert.ok((await readFile(f)).equals(torn), 'the live journal was not modified by the backup');
    const restored = join(root, 'restored'); const r = await restore(made.file, restored, { env: ENV });
    assert.equal(r.adjustments[0].kind, 'TORN_TAIL_TRIMMED_IN_COPY'); assert.ok((await readFile(journalFile(restored))).equals(whole), 'the restored journal is exactly the verified events');
    assert.equal((await runtimeOn(restored).overview()).decisions.length, 2);
  });
});

test('a backup holding an INCONSISTENT journal is made (cases and photos stay protected) but never declared restorable: verify says so, restore refuses before writing anything', async () => {
  await withRoot(async (root) => {
    const live = join(root, 'live'); await populate(live);
    const f = journalFile(live); const ok = await readFile(f, 'utf8'); const ls = ok.split('\n'); let tick = 0;
    for (const [name, damaged, diagnostic] of [
      ['middle line damaged', `${ls[0]}\n${ls[1].slice(0, 25)}\n${ls.slice(2).join('\n')}`, 'CORRUPT_MIDDLE'],
      ['edited content', ok.replace('"DEFERRED"', '"APPROVED"'), 'CHAIN_BROKEN'],
      ['first line removed', ls.slice(1).join('\n'), 'SEQUENCE'],
    ]) {
      await writeFile(f, damaged);
      const made = await backup(live, join(root, 'backups'), { env: ENV, now: () => new Date(Date.UTC(2026, 9, 15, 11, 0, tick += 1)) });
      assert.equal(made.restorable, false, name); assert.equal(made.journals[0].status, 'INCONSISTENT'); assert.equal(made.journals[0].diagnostic, diagnostic, name);
      assert.equal(made.files > 3, true, `${name}: the rest of the data directory is still backed up`);
      const v = await verify(made.file, { env: ENV }); assert.equal(v.ok, false, name);
      const target = join(root, `t-${diagnostic}`);
      assert.equal(await code(restore(made.file, target, { env: ENV })), 'RESTORE_JOURNAL_INCONSISTENT', name);
      await assert.rejects(stat(target), { code: 'ENOENT' }, `${name}: nothing was written`);
      // the explicit override exists for an investigation and says what it restored
      const forced = await restore(made.file, target, { env: ENV, allowInconsistentJournal: true });
      assert.equal(forced.journals[0].status, 'INCONSISTENT');
    }
  });
});

test('journalReport: one report per decision journal in the archive, found by name, verified from the bytes', async () => {
  const good = Buffer.from(''); // an empty journal is a journal that has not started: valid
  const r = journalReport([{ path: 'core/decision-journal.jsonl', data: good }, { path: 'cases/a.json', data: Buffer.from('{}') }]);
  assert.deepEqual(r.map((x) => [x.path, x.status, x.events]), [['core/decision-journal.jsonl', 'OK', 0]]);
  const bad = journalReport([{ path: 'x/core/decision-journal.jsonl', data: Buffer.from('not json\nnor this\n') }]);
  assert.equal(bad[0].status, 'INCONSISTENT'); assert.equal(bad[0].diagnostic, 'CORRUPT_MIDDLE');
});
