// Field V1 - local performance instrumentation. NOT a brittle wall-clock test: each operation is measured many times, p50 / p95 are reported (and heap growth where practical), and the budget is a
// generous ceiling (about 10x what a laptop measures) that only a real regression - an accidental O(n^2), a recompute of everything - would break. Correctness first: every measured call also checks its result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/sourcing/core/case.js';
import { createFieldEngine } from '../src/sourcing/core/field/engine.js';
import { newWorkspace } from '../src/sourcing/core/field/workspace.js';
import { createMemoryWorkspaceStore } from '../src/sourcing/store/workspace-store.js';
import { runChinaDay, OFFERS } from './sourcing-field-v1-china-day.js';
import { tumbler, importAndConfirm, NOW, EXT, PROFILE, t } from './sourcing-field-v1-fixtures.js';

const pct = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const bench = (fn, n = 40, warm = 5) => { for (let i = 0; i < warm; i += 1) fn(i); const xs = []; for (let i = 0; i < n; i += 1) { const t0 = performance.now(); fn(i); xs.push(performance.now() - t0); } return { p50: pct(xs, 50), p95: pct(xs, 95), n }; };
const rows = []; const record = (name, r, budgetMs) => { rows.push({ name, p50: +r.p50.toFixed(2), p95: +r.p95.toFixed(2), budget: budgetMs }); assert.ok(r.p95 <= budgetMs, `${name}: p95 ${r.p95.toFixed(1)} ms is over the ${budgetMs} ms budget`); };
const day = runChinaDay(); const C = day.cases; const IDS = ['A', 'B', 'C', 'D', 'E'];
const mk = () => createFieldEngine({ profile: PROFILE, externals: () => EXT, now: () => NOW });
test.after(() => { console.log('\nFIELD V1 PERFORMANCE (ms, Node on this machine; a phone is slower: budgets are ceilings, not targets)'); console.table(rows); });

test('open a case (all derived views, cold) and again (warm)', () => {
  record('open case, cold (every derived node)', bench((i) => { const e = mk(); const v = e.caseView(C[IDS[i % 5]]); assert.ok(v.truthCard && v.deal && v.merchantFit); }), 400);
  const e = mk(); e.caseView(C.B); record('open case, warm (nothing changed)', bench(() => { const v = e.caseView(C.B); assert.equal(v.recomputed.length, 0); }, 200), 40);
});
test('supplier truth card', () => { const e = mk(); e.caseView(C.D); record('truth card, cold (new engine)', bench((i) => { const f = mk(); assert.equal(f.caseView(C.D, null, ['truthCard']).truthCard.type, 'SupplierTruthCard'); }), 300); });
test('create a 2-case and a 5-case comparison', () => {
  record('compare 2 cases (cold)', bench(() => { const e = mk(); assert.equal(e.compare([C.A, C.B]).set.candidates.length, 2); }, 25), 600);
  record('compare 5 cases (cold)', bench(() => { const e = mk(); assert.equal(e.compare(IDS.map((id) => C[id])).set.candidates.length, 5); }, 25), 1500);
  const e = mk(); e.compare(IDS.map((id) => C[id])); record('compare 5 cases (warm engine)', bench(() => { e.compare(IDS.map((id) => C[id])); }, 40), 600);
});
test('save and reload a comparison (workspace store round trip)', async () => {
  const e = mk(); const cmp = e.compare(IDS.map((id) => C[id])); const store = createMemoryWorkspaceStore(); const xs = []; const ys = [];
  for (let i = 0; i < 30; i += 1) { let ws = newWorkspace(NOW); ws = e.saveComparison(ws, cmp.set, cmp.view, { name: `n${i}` }); const t0 = performance.now(); await store.save(ws); xs.push(performance.now() - t0); const t1 = performance.now(); const back = await store.get(); const def = Object.values(back.comparisons)[0]; const again = e.compare(def.caseIds.map((id) => C[id]), { id: def.id, asOf: def.asOf }); ys.push(performance.now() - t1); assert.equal(again.set.id, cmp.set.id); }
  record('save comparison', { p50: pct(xs, 50), p95: pct(xs, 95) }, 120); record('reload comparison (read + rebuild)', { p50: pct(ys, 50), p95: pct(ys, 95) }, 600);
});
test('recompute after ONE changed fact', () => {
  const e = mk(); IDS.forEach((id) => e.caseView(C[id])); let state = C.B; const xs = [];
  for (let i = 0; i < 40; i += 1) { state = dispatch(state, { type: 'SALE', sale: { ...state.sale, sellingPriceGross: 19 + i / 10 } }, t(15, i)); const t0 = performance.now(); const v = e.caseView(state); xs.push(performance.now() - t0); assert.ok(v.recomputed.includes('deal') && !v.recomputed.includes('askNow')); }
  record('recompute one changed fact (dependent nodes only)', { p50: pct(xs, 50), p95: pct(xs, 95) }, 150);
  const last = e.caseView(dispatch(state, { type: 'SALE', sale: { ...state.sale, sellingPriceGross: 31 } }, t(16))); assert.ok(last.recomputed.length < 10 && last.reused.length >= 1, 'structurally incremental: some nodes are reused (timing is not compared: it would be brittle)');
});
test('import a long supplier transcript', () => {
  for (const [lines, budget] of [[300, 600], [1500, 3000]]) { const text = Array.from({ length: lines }, (_, i) => `[10:${String(i % 60).padStart(2, '0')}] ${i % 2 ? 'Me' : 'Supplier'}: ${i % 2 ? 'ok thanks' : `msg ${i}: ${i % 40 === 0 ? 'MOQ 300 pcs, USD3.10 for 1000 pcs, FOB Ningbo' : 'we will check and come back'}`}`).join('\n');
    record(`import transcript, ${lines} lines`, bench(() => { const c = dispatch(tumbler('X'), { type: 'OFFER_IMPORT', source: 'CHAT', text }, NOW); assert.equal(c.conversations.at(-1).items.length, lines); }, 6, 1), budget); }
});
test('memory: repeated recompute does not grow the heap without bound', () => {
  const e = mk(); let state = C.B; if (globalThis.gc) globalThis.gc(); const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 400; i += 1) { state = dispatch(state, { type: 'SALE', sale: { ...state.sale, sellingPriceGross: 19 + (i % 50) / 10 } }, t(15, i % 59)); e.caseView(state); }
  if (globalThis.gc) globalThis.gc(); const grown = (process.memoryUsage().heapUsed - h0) / 1e6; rows.push({ name: 'heap growth after 400 recomputes (MB)', p50: +grown.toFixed(1), p95: '', budget: 150 }); assert.ok(grown < 150, `heap grew ${grown.toFixed(0)} MB`);
  assert.ok(e.cache.history('B', 'deal').length <= 5, 'the history is bounded');
});
