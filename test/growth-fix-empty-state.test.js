// "À corriger maintenant" empty state: never "nothing to fix" when nothing could be checked (owner request 2026-11-16).
//   CHECKED  = the engines answered and analysed data: a real zero, said as before
//   NO_DATA  = they answered but had nothing to analyse (empty catalogue, no sold product): "nothing to analyse", not "all clear"
//   PARTIAL  = a source is down: "incomplete check", not "all clear"
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPriorities } from '../src/growth/priorities/priorities.js';
import { buildOverview } from '../src/growth/server/overview.js';
import { growthDom, text, all, hasClass, NOW, storePayload } from './growth-dom.js';

const empty = { products: { rows: [], window: { weeks: 8 } }, content: { rows: [], problems: [], scope: { analysed: 0, catalog: 0, activeOnly: true } } };
const checked = { products: { rows: [{ margin: { tier: 'VERIFIED' }, rule: 'X', units: 3 }], window: { weeks: 8 } }, content: { rows: [{ problems: [] }], problems: [], scope: { analysed: 1, catalog: 1, activeOnly: true } } };

test('FES-1 the priorities say why the fix list is empty: CHECKED, NO_DATA or PARTIAL (a missing or failed source), with the sources that are down', () => {
  assert.equal(buildPriorities({ ...checked, now: NOW }).fixState, 'CHECKED');
  assert.equal(buildPriorities({ ...empty, now: NOW }).fixState, 'NO_DATA');
  const noContent = buildPriorities({ products: checked.products, content: null, now: NOW }); assert.equal(noContent.fixState, 'PARTIAL'); assert.deepEqual(noContent.fixDownSources, ['content']);
  const failed = buildPriorities({ products: { error: 'boom' }, content: checked.content, now: NOW }); assert.equal(failed.fixState, 'PARTIAL'); assert.deepEqual(failed.fixDownSources, ['products']);
  assert.equal(buildPriorities({ now: NOW }).fixState, 'PARTIAL', 'nothing configured at all is not a checked zero');
});

test('FES-2 the overview carries the state (null when nothing could be computed)', () => {
  const ov = (p) => buildOverview({ now: NOW, store: storePayload(), priorities: buildPriorities({ ...p, now: NOW }) });
  assert.equal(ov(checked).fixState, 'CHECKED'); assert.equal(ov(empty).fixState, 'NO_DATA');
  assert.equal(ov({ products: checked.products, content: null }).fixState, 'PARTIAL');
  assert.equal(buildOverview({ now: NOW, store: null, priorities: null }).fixState, null);
});

test('FES-3 the screens: a real zero keeps its honest message, no data and an incomplete check never say "Rien à corriger"', async () => {
  const states = [['CHECKED', buildPriorities({ ...checked, now: NOW }), /Rien à corriger dans les données analysées/], ['NO_DATA', buildPriorities({ ...empty, now: NOW }), /Aucune donnée à analyser pour l’instant/], ['PARTIAL', buildPriorities({ products: checked.products, content: null, now: NOW }), /Vérification incomplète/]];
  for (const [state, pr, expected] of states) {
    const overview = buildOverview({ now: NOW, store: storePayload(), priorities: pr });
    const ov = await growthDom('#/overview', { overview, opportunities: pr }); const marks = all(ov.root, (n) => n.getAttribute?.('data-fix-state'));
    assert.ok(marks.some((n) => n.getAttribute('data-fix-state') === state), `overview ${state}`); assert.match(text(ov.root), expected, `overview ${state}`);
    const op = await growthDom('#/opportunities', { overview, opportunities: pr }); assert.match(text(op.root), expected, `opportunities ${state}`);
    if (state !== 'CHECKED') { assert.doesNotMatch(text(ov.root), /Rien à corriger/, `overview ${state}`); assert.doesNotMatch(text(op.root), /Rien à corriger/, `opportunities ${state}`); }
  }
  void hasClass;
});
