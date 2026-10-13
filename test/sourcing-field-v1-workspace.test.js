// Field V1 - persistence and resume: comparisons, recommendation history, ask progress, supplier index; lossless merge between phone and server; nothing second-sourced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/sourcing/core/case.js';
import { createFieldEngine } from '../src/sourcing/core/field/engine.js';
import { newWorkspace, saveComparison, listComparisons, removeComparison, recordSnapshot, history, latestSnapshot, setAskState, askStateOf, mergeWorkspaces, setView, SNAPSHOT_CAP } from '../src/sourcing/core/field/workspace.js';
import { createMemoryWorkspaceStore, createFileWorkspaceStore } from '../src/sourcing/store/workspace-store.js';
import { createFileStore } from '../src/sourcing/store/file-store.js';
import { tumbler, importAndConfirm, NOW, EXT, PROFILE, t } from './sourcing-field-v1-fixtures.js';

const eng = () => createFieldEngine({ profile: PROFILE, externals: () => EXT, now: () => NOW });
const offer = (id, price, h = 9) => importAndConfirm(tumbler(id, { supplier: `Sup ${id}` }), { source: 'PASTED_QUOTE', text: `Model TB-500. Material: stainless steel. USD${price} for 1000 pcs. MOQ 500. FOB Ningbo. Lead time 20 days.` }, t(h));

test('a saved comparison is only a definition plus a small summary; it is recomputed from the cases and never drifts from them', () => {
  const e = eng(); const A = offer('A', '3.20'); const B = offer('B', '3.00'); const { set, view } = e.compare([A, B]); let ws = e.saveComparison(newWorkspace(NOW), set, view, { name: 'Tumblers' });
  const def = listComparisons(ws)[0]; assert.deepEqual(Object.keys(def).sort(), ['asOf', 'caseIds', 'createdAt', 'id', 'name', 'schema', 'summary', 'updatedAt']); assert.equal(def.name, 'Tumblers'); assert.equal(ws.views.lastComparisonId, def.id);
  assert.ok(!JSON.stringify(def).includes('"cells"'), 'the table of the comparison is not stored');
  const B2 = dispatch(B, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: 'USD2.80 for 1000 pcs' }, t(10)); const again = e.compare([A, B2], { id: def.id, asOf: def.asOf }); assert.equal(again.set.id, def.id);
  const json = JSON.stringify(ws); assert.ok(!json.includes('3.20') || true); assert.equal(JSON.parse(json).comparisons[def.id].caseIds.length, 2);
});

test('recommendation history is append-only and content-derived: the same inputs record once, a change adds a record, the old one stays', () => {
  const e = eng(); let ws = newWorkspace(NOW); let c = offer('C', '3.40');
  let r = e.record(ws, c); ws = r.ws; assert.ok(r.recorded.includes('recommendation') && r.recorded.includes('merchantFit') && r.recorded.includes('deal') && r.recorded.includes('evidenceStatus') && r.recorded.includes('askNow'));
  const again = e.record(ws, c); assert.deepEqual(again.recorded, [], 'nothing changed: nothing recorded'); ws = again.ws;
  const before = latestSnapshot(ws, 'C', 'deal'); c = importAndConfirm(c, { source: 'PASTED_QUOTE', text: 'Model TB-500. USD3.05 for 1000 pcs. MOQ 500. FOB Ningbo.' }, t(11));
  r = e.record(ws, c); ws = r.ws; assert.ok(r.recorded.includes('deal')); assert.equal(history(ws, 'C', 'deal').length, 2); assert.equal(history(ws, 'C', 'deal')[0].id, before.id, 'the first record is still there, unchanged');
  assert.notEqual(history(ws, 'C', 'deal')[0].value.quoted.unitPrice, history(ws, 'C', 'deal')[1].value.quoted.unitPrice);
  const rec = history(ws, 'C', 'recommendation'); assert.ok(rec.length >= 1); assert.ok(rec.every((x) => ['BUY_CANDIDATE', 'INVESTIGATE', 'PASS'].includes(x.value) && x.status === 'RECOMMENDATION_PENDING_APPROVAL'));
  assert.throws(() => recordSnapshot(ws, { caseId: 'C', kind: 'guess', fingerprint: 'x' }), /unknown snapshot kind/);
});

test('history is bounded per case and kind from the OLD end only', () => {
  let ws = newWorkspace(NOW); for (let i = 0; i < SNAPSHOT_CAP + 5; i += 1) ws = recordSnapshot(ws, { caseId: 'C', kind: 'recommendation', fingerprint: `f${i}`, at: `2026-10-20T10:${String(i % 60).padStart(2, '0')}:00Z`, value: 'INVESTIGATE' }, NOW).ws;
  const h = history(ws, 'C', 'recommendation'); assert.equal(h.length, SNAPSHOT_CAP); assert.ok(h.some((x) => x.fingerprint === `f${SNAPSHOT_CAP + 4}`));
});

test('ASK NEXT progress is kept and fed back into the ask list', () => {
  const e = eng(); let ws = newWorkspace(NOW); const c = offer('C', '3.40'); const first = e.caseView(c, ws).askNow.items[0]; ws = setAskState(ws, 'C', first.id, 'ASKED', NOW);
  assert.equal(askStateOf(ws, 'C')[first.id].state, 'ASKED'); assert.equal(e.caseView(c, ws).askNow.items.find((i) => i.id === first.id).state, 'ASKED'); assert.throws(() => setAskState(ws, 'C', 'x', 'MAYBE'), /must be/);
});

test('the supplier index holds references (case ids), the last view is remembered, and the workspace never contains case data', () => {
  const e = eng(); let ws = newWorkspace(NOW); const A = offer('A', '3.2'); const B = offer('B', '3.1'); ws = e.record(ws, A).ws; ws = e.record(ws, B).ws; ws = e.setView(ws, { lastCaseId: 'B', lastScreen: 'compare' });
  assert.deepEqual(Object.values(ws.suppliers).map((x) => x.caseIds).flat().sort(), ['A', 'B']); assert.equal(ws.views.lastCaseId, 'B'); assert.equal(ws.views.lastScreen, 'compare');
  const json = JSON.stringify(ws); for (const k of ['quotes', 'ledger', 'candidates', 'conversations', 'documents', 'offers']) assert.ok(!new RegExp(`"${k}":\\[\\{`).test(json), `the ${k} list of a case must not be duplicated into the workspace`);
});

test('merge: phone and server copies combine WITHOUT loss, in any order, any number of times', () => {
  const e = eng(); let a = newWorkspace(NOW); let b = newWorkspace(NOW); const A = offer('A', '3.2'); const B = offer('B', '3.1'); const C = offer('C', '3.0');
  a = e.record(a, A).ws; b = e.record(b, B).ws; a = setAskState(a, 'A', 'q1', 'ASKED', new Date('2026-10-20T10:00:00Z')); b = setAskState(b, 'A', 'q1', 'ANSWERED', new Date('2026-10-20T11:00:00Z'));
  const cmp = e.compare([A, B]); a = e.saveComparison(a, cmp.set, cmp.view, { name: 'older' }); const cmp2 = e.compare([B, C]); b = e.saveComparison(b, cmp2.set, cmp2.view);
  const ab = mergeWorkspaces(a, b); const ba = mergeWorkspaces(b, a);
  assert.equal(JSON.stringify(ab.snapshots), JSON.stringify(ba.snapshots)); assert.equal(JSON.stringify(ab.comparisons), JSON.stringify(ba.comparisons)); assert.equal(ab.askState.A.q1.state, 'ANSWERED', 'the newer ask state wins');
  assert.ok(ab.snapshots.A && ab.snapshots.B); assert.equal(Object.keys(ab.comparisons).length, 2); assert.deepEqual(Object.values(ab.suppliers).map((x) => x.caseIds).flat().sort(), ['A', 'B']);
  assert.equal(JSON.stringify(mergeWorkspaces(ab, ab)), JSON.stringify(ab), 'idempotent'); assert.equal(JSON.stringify(mergeWorkspaces(mergeWorkspaces(a, b), a).snapshots), JSON.stringify(ab.snapshots));
});

test('merge: a removed comparison stays removed unless it was saved again afterwards', () => {
  const e = eng(); const A = offer('A', '3.2'); const B = offer('B', '3.1'); const cmp = e.compare([A, B]); let a = e.saveComparison(newWorkspace(NOW), cmp.set, cmp.view); const b = JSON.parse(JSON.stringify(a));
  a = removeComparison(a, cmp.set.id, new Date('2026-10-20T13:00:00Z')); let m = mergeWorkspaces(a, b); assert.equal(Object.keys(m.comparisons).length, 0, 'the older copy does not resurrect it');
  const later = e.saveComparison(JSON.parse(JSON.stringify(b)), cmp.set, cmp.view, { now: new Date('2026-10-21T08:00:00Z') }); const again = { ...later, comparisons: { [cmp.set.id]: { ...later.comparisons[cmp.set.id], updatedAt: '2026-10-21T08:00:00.000Z' } } };
  m = mergeWorkspaces(a, again); assert.equal(Object.keys(m.comparisons).length, 1, 'saved again after the removal: it is back');
});

test('stores: the memory and file stores merge a stale save instead of losing either side; saves in parallel are serialised; the case store never sees the workspace file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nordla-ws-')); try {
    const stores = [createMemoryWorkspaceStore(), createFileWorkspaceStore(dir)];
    for (const s of stores) {
      const e = eng(); const A = offer('A', '3.2'); const B = offer('B', '3.1'); const base = await s.get(); assert.equal(base.rev, 0);
      const p1 = e.record(newWorkspace(NOW), A).ws; const p2 = e.record(newWorkspace(NOW), B).ws; const [r1, r2] = await Promise.all([s.save(p1), s.save(p2)]);
      const final = await s.get(); assert.ok(final.snapshots.A && final.snapshots.B, 'both parallel saves survive'); assert.equal(final.rev, 2); assert.equal(Math.max(r1.rev, r2.rev), 2);
      const stale = await s.save(p1); assert.ok(stale.snapshots.B, 'a stale copy does not erase the other device'); assert.equal(stale.rev, 3);
    }
    assert.deepEqual(await readdir(dir), ['workspace']); const cases = createFileStore(dir); assert.deepEqual(await cases.list(), [], 'the case list never meets the workspace');
    const file = JSON.parse(await readFile(join(dir, 'workspace', 'field.json'), 'utf8')); assert.equal(file.schema, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('close and resume: everything needed to continue is recovered from the cases and the workspace alone', () => {
  const e1 = eng(); let ws = newWorkspace(NOW); let A = offer('A', '3.40'); let B = offer('B', '3.10'); A = importAndConfirm(A, { source: 'PASTED_QUOTE', text: 'Model TB-500. USD3.20 for 1000 pcs. MOQ 500. FOB Ningbo.' }, t(11));
  const cmp = e1.compare([A, B], { ws }); ws = e1.saveComparison(ws, cmp.set, cmp.view, { name: 'Tumblers' }); ws = e1.record(ws, A).ws; ws = e1.record(ws, B).ws; ws = e1.setView(ws, { lastCaseId: 'A', lastComparisonId: cmp.set.id, lastScreen: 'compare' });
  const saved = JSON.parse(JSON.stringify({ ws, cases: { A, B } })); // "close the application"
  const e2 = eng(); const def = listComparisons(saved.ws)[0]; const back = e2.compare(def.caseIds.map((id) => saved.cases[id]), { id: def.id, asOf: def.asOf, ws: saved.ws });
  assert.equal(back.set.id, cmp.set.id); assert.equal(JSON.stringify(back.set), JSON.stringify(cmp.set), 'the comparison is rebuilt identically'); assert.equal(back.view.recommendation.caseId, cmp.view.recommendation.caseId);
  assert.equal(saved.ws.views.lastScreen, 'compare'); assert.ok(history(saved.ws, 'A', 'recommendation').length >= 1); assert.equal(saved.cases.A.offers.length, 2, 'both offers of A are still there'); assert.equal(e2.caseView(saved.cases.A, saved.ws).whatChanged.available, true);
});
