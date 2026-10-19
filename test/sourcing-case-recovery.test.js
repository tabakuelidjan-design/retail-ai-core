// CASE RECOVERY. Old supplier cases come back onto a phone (new tunnel address = empty phone) from the server list or from an exported JSON, only on the owner's choice,
// without overwriting anything, and without losing a conversation, a confirmation, a correction, a rejection or a history entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createFileStore } from '../src/sourcing/store/file-store.js';
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { auditCase } from '../src/sourcing/core/case-facts.js';
import { validateCase, parseImportText, buildExport, planRecovery, applyRecovery, digest, describe as describeCase, photoKeysFor, EXPORT_FORMAT } from '../src/sourcing/core/recovery.js';
import { loadUi } from './sourcing-ui-load.js';
import { fileURLToPath } from 'node:url';

const { recoverySection } = await loadUi('recover.js');
const TOKEN = 'unit-test-token-0123456789-abcdef';
const SONNY = 'prix 12$, MOQ 60, puissance 10000mAp. variante 4 couleur blanc, blue, rouge et noir. puissance 45W. nom de Modele AB521';
const T0 = new Date('2026-10-20T08:00:00Z'); const at = (m) => new Date(T0.getTime() + m * 60000);
const copy = (x) => JSON.parse(JSON.stringify(x));

/** A case with everything the owner can do in the field: a supplier conversation, a confirmation, a correction, a rejection, a note. */
function sonny(id = 'sonny') {
  let c = newCase({ id, name: 'batterie externe', now: T0 }); c = dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Sonny' } }, at(0));
  c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'Sonny', lang: 'auto' }, at(1)); const conv = c.conversations.at(-1);
  c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: conv.id, speaker: 'supplier', lang: 'auto', text: SONNY }, at(2));
  c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: c.candidates.find((x) => x.key === 'quote.moq').id }, at(3));
  c = dispatch(c, { type: 'CANDIDATE_CORRECT', id: c.candidates.find((x) => x.key === 'spec.capacity').id, value: { amount: 10000, unit: 'mAh' } }, at(4));
  c = dispatch(c, { type: 'CANDIDATE_REJECT', id: c.candidates.find((x) => x.key === 'quote.unitPrice').id }, at(5));
  return c;
}

async function start() {
  const dir = await mkdtemp(join(tmpdir(), 'nordla-rec-')); const store = createFileStore(dir);
  const app = createSourcingApp({ token: TOKEN, store, workspace: null, merchantProfile: null, uiDir: fileURLToPath(new URL('../src/sourcing/ui/', import.meta.url)), coreDir: fileURLToPath(new URL('../src/sourcing/core/', import.meta.url)) });
  const server = http.createServer(app.handler); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body } = {}) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-sourcing-token': TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const file = (id) => readFile(join(dir, `${id}.json`), 'utf8');
  return { call, store, dir, file, close: async () => { await new Promise((r) => { server.close(r); server.closeAllConnections?.(); }); await rm(dir, { recursive: true, force: true }); } };
}
/** What a phone does on "Récupérer" for one server case: GET, validate, plan. */
async function fetchFromServer(s, id) { const g = await s.call(`/api/cases/${id}`); assert.equal(g.status, 200); const v = validateCase(g.body); assert.ok(v.ok, v.error); return v.case; }

test('1. the server lists its cases with the existing GET routes; a stored case comes back whole', async () => {
  const s = await start(); try {
    const c = sonny(); const put = await s.call(`/api/cases/${c.id}`, { method: 'PUT', body: c }); assert.equal(put.status, 200);
    const list = await s.call('/api/cases'); assert.equal(list.status, 200); assert.deepEqual(list.body.cases.map((x) => x.id), ['sonny']); assert.equal(list.body.cases[0].name, 'batterie externe'); assert.equal(list.body.cases[0].supplier, 'Sonny');
    assert.deepEqual(await readdir(s.dir), ['sonny.json'], 'one JSON file per case on disk');
    const back = await fetchFromServer(s, 'sonny'); assert.deepEqual({ ...back, rev: 0 }, { ...c, rev: 0 }, 'every field, conversation and history entry is identical');
  } finally { await s.close(); }
});

test('2. ADDRESS CHANGE: a new tunnel address is an empty phone; the owner lists, ticks, recovers: nothing is lost', async () => {
  const s = await start(); try {
    const c = sonny(); await s.call(`/api/cases/${c.id}`, { method: 'PUT', body: c });
    let phone = {}; // new origin: empty storage
    const incoming = await fetchFromServer(s, 'sonny');
    assert.deepEqual(planRecovery(phone, [incoming]).map((p) => p.status), ['NEW']);
    const out = applyRecovery(phone, incoming, { source: 'server' }); phone = out.cases; assert.equal(out.action, 'ADDED');
    const got = phone.sonny; const { recoveredFrom, ...rest } = got; assert.deepEqual(rest, incoming, 'the recovered case is the server case, field for field');
    assert.ok(JSON.stringify(got.conversations).includes(SONNY), 'the original supplier text is still there, word for word');
    const d = describeCase(got); assert.equal(d.conversations, 1); assert.ok(d.corrections >= 1 && d.rejected >= 1 && d.ledger >= 1);
    assert.deepEqual(auditCase(got), auditCase(c), 'the fact audit (confirmed, corrected, rejected) is unchanged');
    assert.deepEqual(assess(got, { now: at(60), externals: {} }).verdict, assess(c, { now: at(60), externals: {} }).verdict);
  } finally { await s.close(); }
});

test('3. nothing is recovered unless chosen: listing changes nothing; only the ticked ids are fetched', async () => {
  const s = await start(); try {
    for (const id of ['a1', 'b2', 'c3']) await s.call(`/api/cases/${id}`, { method: 'PUT', body: sonny(id) });
    const phone = {}; const before = copy(phone);
    const list = (await s.call('/api/cases')).body.cases; assert.equal(list.length, 3); assert.deepEqual(phone, before, 'listing alone adds nothing');
    const ticked = ['b2']; let p = phone; for (const id of ticked) p = applyRecovery(p, await fetchFromServer(s, id)).cases;
    assert.deepEqual(Object.keys(p), ['b2']);
  } finally { await s.close(); }
});

test('4. a case already on the phone is NEVER overwritten: compare, then keep both or skip', async () => {
  const s = await start(); try {
    const server = sonny(); await s.call('/api/cases/sonny', { method: 'PUT', body: server });
    // the phone worked on the same case offline after the last sync: it has an extra turn the server does not have
    let mine = dispatch(server, { type: 'NOTE', text: 'appel du soir: livraison 20 jours' }, at(90));
    const phone = { sonny: mine }; const frozen = copy(phone);
    const incoming = await fetchFromServer(s, 'sonny');
    const [plan] = planRecovery(phone, [incoming]); assert.equal(plan.status, 'DIFFERENT'); assert.equal(plan.relation, 'LOCAL_AHEAD'); assert.ok(plan.local.events > plan.incoming.events, 'the comparison shows both sides');
    const skip = applyRecovery(phone, incoming, { choice: 'skip' }); assert.equal(skip.action, 'SKIPPED'); assert.deepEqual(skip.cases, frozen, 'skip changes nothing');
    const both = applyRecovery(phone, incoming, { choice: 'keep-both', now: at(100) }); assert.equal(both.action, 'KEPT_BOTH');
    assert.deepEqual(both.cases.sonny, frozen.sonny, 'my copy is byte-for-byte what it was'); assert.notEqual(both.id, 'sonny');
    const kept = both.cases[both.id]; assert.match(kept.id, /^[A-Za-z0-9_-]{1,80}$/); assert.equal(kept.rev, 0, 'it will be created on the server, never replace the existing one'); assert.match(kept.identity.workingName, /copie récupérée/);
    assert.deepEqual(kept.events, incoming.events); assert.deepEqual(kept.candidates, incoming.candidates); assert.deepEqual(kept.ledger, incoming.ledger);
    assert.deepEqual(phone, frozen, 'the input map is not mutated');
  } finally { await s.close(); }
});

test('5. an identical case on the phone is recognised: nothing is added, whatever the revision', () => {
  const c = sonny(); const phone = { sonny: { ...c, rev: 4 } };
  const [p] = planRecovery(phone, [{ ...c, rev: 9 }]); assert.equal(p.status, 'ALREADY_HERE');
  assert.equal(applyRecovery(phone, { ...c, rev: 9 }, { choice: 'keep-both' }).action, 'ALREADY_HERE');
});

test('6. REPEATED IMPORT: the same case or file twice (or ten times) never creates a duplicate', () => {
  const c = sonny(); let phone = {};
  for (let i = 0; i < 3; i++) phone = applyRecovery(phone, c, { source: 'file' }).cases;
  assert.deepEqual(Object.keys(phone), ['sonny'], 'a new case imported three times is one case');
  // a different local copy: keep both once, importing again offers nothing new
  const other = { sonny: dispatch(c, { type: 'NOTE', text: 'x' }, at(50)) }; let p = other;
  p = applyRecovery(p, c, { choice: 'keep-both', now: at(60) }).cases; const n = Object.keys(p).length; assert.equal(n, 2);
  for (let i = 0; i < 3; i++) { const out = applyRecovery(p, c, { choice: 'keep-both', now: at(61 + i) }); assert.equal(out.action, 'ALREADY_KEPT'); p = out.cases; }
  assert.equal(Object.keys(p).length, 2, 'still two cases');
  assert.deepEqual(p.sonny, other.sonny);
});

test('7. REVISION CONFLICTS: a recovered case can only be saved with its own revision; a stale save is refused and the server file stays as it was', async () => {
  const s = await start(); try {
    const c = sonny(); const first = (await s.call('/api/cases/sonny', { method: 'PUT', body: c })).body; assert.equal(first.rev, 1);
    const phone = applyRecovery({}, await fetchFromServer(s, 'sonny')).cases; assert.equal(phone.sonny.rev, 1);
    // another device moves the server on
    const moved = (await s.call('/api/cases/sonny', { method: 'PUT', body: dispatch(first, { type: 'NOTE', text: 'autre appareil' }, at(70)) })).body; assert.equal(moved.rev, 2);
    const onDisk = await s.file('sonny');
    // the phone (still at rev 1) edits and tries to save: refused, server copy returned, file untouched
    const stale = await s.call('/api/cases/sonny', { method: 'PUT', body: dispatch(phone.sonny, { type: 'NOTE', text: 'depuis le téléphone' }, at(80)) });
    assert.equal(stale.status, 409); assert.equal(stale.body.server.rev, 2); assert.equal(await s.file('sonny'), onDisk, 'the server file is byte-identical: nothing was overwritten');
    // a file exported before the case ever reached the server (rev 0) against a server case with the same id: also refused
    const clash = await s.call('/api/cases/sonny', { method: 'PUT', body: { ...c, rev: 0 } }); assert.equal(clash.status, 409); assert.equal(await s.file('sonny'), onDisk);
    // a keep-both copy has a NEW id and rev 0: it creates its own file, the original is untouched
    const both = applyRecovery(phone, moved, { choice: 'keep-both', now: at(120) }); const created = await s.call(`/api/cases/${both.id}`, { method: 'PUT', body: both.cases[both.id] }); assert.equal(created.status, 200);
    assert.equal(await s.file('sonny'), onDisk);
  } finally { await s.close(); }
});

test('8. recovering marks nothing as changed: the app code for recovery has no save call and no dirty mark', async () => {
  const src = await readFile(new URL('../src/sourcing/ui/app.js', import.meta.url), 'utf8');
  const a = src.indexOf('// ---- case recovery'); const b = src.indexOf('function openMenu()'); assert.ok(a > 0 && b > a);
  const block = src.slice(a, b);
  assert.doesNotMatch(block, /markDirty|queueSync|sync\(\)|method:\s*'(PUT|POST|DELETE)'/, 'recovery only reads (GET) and stores locally');
  assert.match(block, /api\('\/api\/cases'\)/); assert.match(block, /api\(`\/api\/cases\/\$\{encodeURIComponent\(id\)\}`\)/);
  const sw = await readFile(new URL('../src/sourcing/ui/sw.js', import.meta.url), 'utf8'); assert.match(sw, /nordla-sourcing-terrain-v2-2/, 'the installed phone app refreshes (the shell cache name changes with the UI generation)');
});

test('9. EXPORT / IMPORT of a JSON: a case that never reached the server round-trips whole, with the photos the phone holds', () => {
  const c = sonny('never-synced'); c.identity.photos = ['photo-0']; const blobs = { 'photo:never-synced.0': 'data:image/jpeg;base64,AAAA', 'photo:other.0': 'data:image/jpeg;base64,BBBB' };
  const text = buildExport(c, (k) => blobs[k] ?? null, T0); const raw = JSON.parse(text); assert.equal(raw.format, EXPORT_FORMAT); assert.deepEqual(Object.keys(raw.photos), ['photo:never-synced.0']);
  const p = parseImportText(text); assert.ok(p.ok); assert.deepEqual(p.case, c); assert.deepEqual(p.photos, { 'photo:never-synced.0': 'data:image/jpeg;base64,AAAA' });
  // the file written by earlier versions (the bare case) is still accepted
  const old = parseImportText(JSON.stringify(c)); assert.ok(old.ok); assert.deepEqual(old.case, c); assert.deepEqual(old.photos, {});
  const out = applyRecovery({}, p.case, { source: 'file' }); assert.equal(out.action, 'ADDED'); assert.equal(digest(out.cases['never-synced']), digest(c));
  assert.deepEqual(photoKeysFor(c, 'never-synced'), ['photo:never-synced.0']);
});

test('10. a file that is not a safe, complete case is refused and nothing is stored', () => {
  const c = sonny();
  const bad = { empty: '', notJson: '{oops', array: '[]', noId: JSON.stringify({ ...c, id: undefined }), badId: JSON.stringify({ ...c, id: '../etc/passwd' }), longId: JSON.stringify({ ...c, id: 'a'.repeat(81) }),
    newer: JSON.stringify({ ...c, schema: 99 }), noEvents: JSON.stringify({ ...c, events: undefined }), badCollection: JSON.stringify({ ...c, ledger: 'x' }),
    proto: JSON.stringify(c).replace('{', '{"__proto__":{"admin":true},'), nested: JSON.stringify({ ...c, notes: [{ constructor: { prototype: 1 } }] }), bundleNewer: JSON.stringify({ format: EXPORT_FORMAT, version: 2, case: c }) };
  for (const [name, text] of Object.entries(bad)) assert.equal(parseImportText(text).ok, false, name);
  assert.equal(parseImportText('x'.repeat(65 * 1024 * 1024)).error, 'TOO_BIG');
  assert.equal(parseImportText('x'.repeat(9 * 1024 * 1024)).error, 'NOT_JSON', 'a 9 MB file is no longer refused for its size (the old 8 MB limit lost large cases)');
  assert.equal(({}).admin, undefined, 'no prototype pollution');
  // a photo that belongs to another case, or is not an image, is dropped, not stored under this case
  const p = parseImportText(JSON.stringify({ format: EXPORT_FORMAT, version: 1, case: c, photos: { 'photo:other.0': 'data:image/jpeg;base64,AA', 'photo:sonny.0': 'javascript:alert(1)', 'x': 'data:image/png;base64,AA' } })); assert.ok(p.ok); assert.deepEqual(p.photos, {});
});

test('11. an older V0 case (no V1 collections) is upgraded additively on import, never rewritten', () => {
  const c = sonny(); const v0 = copy(c); for (const k of ['conversations', 'candidates', 'ledger', 'conflicts', 'documentLedger', 'userQuestions', 'questionLog', 'confirmBatches', 'offers', 'factAudit', 'factObservations']) delete v0[k]; v0.schema = 1;
  const v = validateCase(v0); assert.ok(v.ok); assert.equal(v.case.schema, 2); assert.deepEqual(v.case.offers, []); assert.deepEqual(v.case.quotes, v0.quotes); assert.deepEqual(v.case.events, v0.events);
});

test('12. OFFLINE RESUME: with no server at all, the phone keeps its cases and a file import still works', () => {
  const mine = sonny('field-case'); const phone = { 'field-case': mine };
  // the server cannot be reached: nothing to call, nothing changes; an exported file from another day is imported by choice
  const file = parseImportText(buildExport(sonny('old-trip'), () => null, T0)); assert.ok(file.ok);
  const out = applyRecovery(phone, file.case, { source: 'file' });
  assert.deepEqual(out.cases['field-case'], mine, 'the case in progress is untouched'); assert.deepEqual(Object.keys(out.cases).sort(), ['field-case', 'old-trip']);
});

test('13. the menu section: nothing is ticked by default, the button stays disabled; conflicts offer "Garder les deux" and "Ignorer"', () => {
  const c = sonny(); const list = [{ id: 'sonny', name: 'batterie externe', rev: 2, updatedAt: '2026-10-20T09:00:00.000Z', supplier: 'Sonny' }];
  const html = recoverySection({ list, selected: {}, results: [], pending: [] }, { online: true, hasToken: true, local: {} });
  assert.match(html, /Récupérer mes dossiers/); assert.match(html, /data-act="rec-go" disabled/); assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  assert.match(recoverySection({ list, selected: { sonny: true } }, { online: true, hasToken: true, local: {} }), /data-act="rec-go" >|data-act="rec-go" >Récupérer \(1\)|Récupérer \(1\)/);
  const [plan] = planRecovery({ sonny: dispatch(c, { type: 'NOTE', text: 'n' }, at(9)) }, [c]);
  const pend = recoverySection({ list: [], pending: [{ id: 'sonny', relation: plan.relation, incoming: plan.incoming, local: plan.local }] }, { online: false, hasToken: false, local: {} });
  assert.match(pend, /Garder les deux/); assert.match(pend, /Ignorer/); assert.match(pend, /Rien n’a été remplacé/); assert.match(pend, /Sur ce téléphone/); assert.match(pend, /Importer un fichier exporté/);
  assert.match(pend, /data-act="rec-list" disabled/, 'the server list needs a reachable server');
  assert.match(html, /Les photos sauvegardées sur le serveur reviennent avec le dossier/, 'the honest statement, now that the server keeps the photos');
});

test('14. the sync sends only cases the owner changed: sync() never marks the open case, commit() always marks the edited one', async () => {
  const src = await readFile(new URL('../src/sourcing/ui/app.js', import.meta.url), 'utf8');
  const a = src.indexOf('async function sync()'); const b = src.indexOf('async function checkSafety'); const body = src.slice(a, b);
  assert.doesNotMatch(body.split('for (const id of')[0], /markDirty\(/, 'sync() must not mark the current case before sending');
  assert.match(body, /!dirty\.size\) return/, 'nothing marked = nothing sent');
  assert.match(src, /function commit\(event\) \{[^]*?markDirty\(S\.currentId\);/, 'an explicit change is marked, token or not');
  assert.doesNotMatch(src.slice(src.indexOf('async function ping()'), src.indexOf('function autoSafety')), /!was \|\| dirty\.size/, 'reconnecting alone does not start a sync');
});
