// Interface contracts between the field assistant and the modules it reads (Sourcing engine, Buying / Core levers, Core runtime, router, HTTP).
// If one of those modules changes shape, THIS file fails first and names the contract, instead of an answer silently going wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { BLOCKER, VERDICT } from '../src/sourcing/core/levels.js';
import { sourcingPurchaseFacts } from '../src/core-pilot/sourcing-facts.js';
import { buildSourcingPurchaseSubject, sourcingPurchaseLevers } from '../src/buying/sourcing-purchase.js';
import { createCoreRuntime } from '../src/core-pilot/runtime.js';
import { createMemoryJournal } from '../src/core-pilot/journal.js';
import { validateCoreConfig } from '../src/core-pilot/config.js';
import { routeUtterance, STATUS } from '../src/integration/router.js';
import { MODULE as M } from '../src/integration/constants.js';
import { askNordla } from '../src/core-pilot/ask.js';
import { buildFieldSnapshot, showVerdict } from '../src/core-pilot/field-facts.js';
import { BLOCKER_FR, buildFieldAnswer } from '../src/core-pilot/field-answers.js';
import { FIELD_INTENT } from '../src/core-pilot/field-intents.js';
import { NOW, LIVE_CLEAN, ident, traits, importer, commercial, extraTraits } from './sourcing-fixtures.js';

const externals = { safety: LIVE_CLEAN };
const CONFIG = validateCoreConfig({ schema: 1, merchantId: 'test', currency: 'EUR', gates: { materialityThreshold: 0, maxPrioritySubjects: 10, cooldownDays: 14, aggravationFactor: 1.5 }, testSmall: { budget: null }, ownerRules: [] });
const mk = (events, id) => { let c = newCase({ id, name: 'x', now: NOW }); for (const e of events) c = dispatch(c, e, NOW); return c; };
const blocked = mk([...ident({ name: 'USB charger', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({})], 'blocked');
const bare = mk([...ident({ name: 'Mug', category: 'household_general' })], 'bare');

test('contract Sourcing engine -> field facts: every blocker code and verdict has a French wording; no code is shown raw', () => {
  for (const code of Object.values(BLOCKER)) assert.ok(BLOCKER_FR[code], `BLOCKER ${code} has no French label: add it to field-answers.js BLOCKER_FR`);
  // the rule is the engine's: every decision card carries verdictDisplay, and a CONDITIONAL_GO with a hard blocker is never displayed as a go
  for (const c of [blocked, bare]) { const d = assess(c, { now: NOW, externals }).decision; assert.ok(typeof d.verdictDisplay === 'string', 'decision.verdictDisplay missing: the engine contract changed'); if (d.hardBlockers.length) assert.ok(!['GO', 'CONDITIONAL_GO'].includes(d.verdictDisplay)); }
  for (const v of Object.values(VERDICT)) assert.ok(showVerdict(v) !== 'inconnu', v);
  assert.match(showVerdict('CONDITIONAL_GO_BLOCKED'), /blocage dur ouvert : aucune commande possible/);
  assert.equal(showVerdict('GO'), 'GO'); assert.equal(showVerdict(null), 'inconnu');
});

test('contract Sourcing engine -> field facts: assess() still exposes every field the snapshot reads', () => {
  for (const c of [blocked, bare]) {
    const a = assess(c, { now: NOW, externals });
    for (const k of ['verdict', 'canCommitMoney', 'hardBlockers', 'conditionBlockers', 'conditions', 'dimensions', 'nextAction', 'gaps', 'contradictions', 'rulebookReview']) assert.ok(k in a.decision, `decision.${k}`);
    assert.ok(Array.isArray(a.decision.gaps.missingDocs));
    for (const b of a.decision.hardBlockers) assert.ok(b.code && 'detail' in b);
    for (const k of ['status', 'totals', 'criticalUnknown', 'unknownCostComponents', 'isLowerBound']) assert.ok(k in a.landed, `landed.${k}`);
    for (const k of ['landedPerUnitEurMinor', 'landedTotalEurMinor', 'purchaseTotalEurMinor', 'importCostEurMinor', 'estimatedMinor']) assert.ok(k in a.landed.totals, `landed.totals.${k}`);
    for (const k of ['status', 'contributionMinor', 'contributionPct', 'priceBasis']) assert.ok(k in a.economics, `economics.${k}`);
    if (a.economics.status === 'COMPLETE') for (const k of ['contributionIsUpperBound', 'sellingPriceGrossMinor']) assert.ok(k in a.economics, `economics.${k} (complete)`);
    assert.ok('maxUnitPriceMinor' in a.maxPurchasePrice && 'status' in a.maxPurchasePrice);
    assert.ok(Array.isArray(a.freshness) && a.freshness.every((f) => f.name && f.status));
    assert.ok(a.freshness.map((f) => f.name).every((n) => ['regulatory rulebook', 'EU Safety Gate', 'FX rate', 'Amazon observations'].includes(n)), 'a new freshness source needs a French name in field-answers.js');
    assert.ok(Array.isArray(a.evidence.unknown) && Array.isArray(a.documents) && typeof a.dataMode === 'string');
    for (const q of a.questions) for (const k of ['id', 'priority', 'topic', 'why', 'en', 'zh']) assert.ok(k in q, `questions[].${k}`);
  }
});

test('contract Buying / Core levers: the order levers keep their ids and the effect fields the field layer reads', () => {
  const { input, scenarios } = sourcingPurchaseFacts(blocked, { merchantId: 'm', now: NOW, externals });
  for (const k of ['case_id', 'case_version', 'verdict', 'can_commit_money', 'hard_blockers', 'landed_total', 'landed_per_unit', 'landed_is_lower_bound', 'contribution_per_unit', 'contribution_is_upper_bound', 'price_basis', 'quote_qty', 'moq', 'unit_price', 'max_unit_price']) assert.ok(k in input, `sourcingPurchaseFacts input.${k}`);
  assert.ok(Array.isArray(input.hard_blockers) && scenarios.moq && 'landed_total' in scenarios.moq && 'contribution_per_unit' in scenarios.moq);
  const levers = sourcingPurchaseLevers(buildSourcingPurchaseSubject(input), scenarios);
  const ids = levers.map((l) => l.id); assert.deepEqual(ids.sort(), ['buying.ORDER_MOQ', 'buying.ORDER_QUOTED_QTY']);
  for (const l of levers) { assert.equal(typeof l.estimated_cost.amount, 'number'); assert.equal(typeof l.estimated_effects.margin_impact, 'number'); }
  const snap = buildFieldSnapshot(blocked, { merchantId: 'm', now: NOW, externals });
  assert.equal(snap.orderQuoted.qty, input.quote_qty); assert.equal(snap.orderMoq.qty, input.moq);
  assert.equal(snap.orderQuoted.landedTotal, input.landed_total, 'the order effect is the Core lever, not a copy');
});

test('contract Core runtime -> explanation: the journal view keeps the fields the explanation reads, and every elimination reason is translated', async () => {
  const rt = createCoreRuntime({ merchantId: 'm', config: CONFIG, journal: createMemoryJournal({ merchantId: 'm' }), now: () => NOW });
  await rt.analyseCase(blocked, { externals, actor: { userId: 'u', role: 'OWNER' } });
  const ov = await rt.overview(); assert.ok('owner_rules' in ov && Array.isArray(ov.decisions));
  const [v] = await rt.forCase('blocked'); const e = v.entry;
  assert.ok(e.id && e.created_at && Array.isArray(e.facts_used) && e.facts_used.every((f) => f.key && f.source_ref));
  assert.ok(e.recommendation.label && e.recommendation.kind && Array.isArray(e.recommendation.rationale));
  assert.ok(Array.isArray(e.options.eliminated) && e.options.eliminated.every((x) => x.label && x.stage && Array.isArray(x.reasons)));
  assert.ok(Array.isArray(e.rules_applied));
  const snap = buildFieldSnapshot(blocked, { merchantId: 'm', now: NOW, externals });
  const out = buildFieldAnswer(FIELD_INTENT.EXPLAIN_RECOMMENDATION, snap, { entryView: v, ownerRules: ov.owner_rules });
  assert.doesNotMatch(out.answer, /CONDITION_NOT_MET|can_commit_money eq/, 'an untranslated engine reason reached the person: extend REASON_FR');
});

test('contract router: the active-case summary route and the module table the field layer defers to are unchanged', () => {
  const r = routeUtterance('résume ce dossier', { active: { module: M.CHINA_SOURCING, entities: {} }, available: (m) => m === M.CHINA_SOURCING });
  assert.equal(r.status, STATUS.ROUTED); assert.deepEqual(r.route.map((s) => [s.module, s.command]), [[M.CHINA_SOURCING, 'summarize_case']]);
  assert.equal(routeUtterance('pourquoi mes ventes ont baissé', { available: () => false }).status, STATUS.MODULE_NOT_AVAILABLE);
});

test('contract HTTP: the ask result is plain JSON, small, with the stable keys the PWA and http.js pass through untouched', async () => {
  const ctx = { runtime: null, getCase: async () => blocked, externals, actor: {}, now: NOW };
  const KNOWN = new Set(['ANSWERED', 'ASK', 'NOT_UNDERSTOOD', 'MODULE_NOT_CONNECTED', 'CORE_NOT_CONFIGURED', 'ACTION_REFUSED']);
  for (const q of ['résume ce dossier', 'quels sont les risques ?', 'puis-je commander ?', 'quelle est la marge ?', 'passe la commande', 'raconte une blague', 'quelles factures fournisseurs dois-je payer ?', 'quels modules sont connectés ?']) {
    const r = await askNordla({ text: q, caseId: 'blocked' }, ctx);
    assert.ok(KNOWN.has(r.status), `${q}: status ${r.status}`); assert.equal(typeof r.answer, 'string'); assert.ok(Array.isArray(r.sources) && Array.isArray(r.limits));
    const json = JSON.stringify(r); assert.equal(JSON.stringify(JSON.parse(json)), json, 'round-trips through JSON'); assert.ok(json.length < 16 * 1024, `${q}: ${json.length} bytes`);
  }
  const field = await askNordla({ text: 'quelle est la marge ?', caseId: 'blocked' }, ctx);
  assert.deepEqual(Object.keys(field).sort(), ['answer', 'intent', 'limits', 'sections', 'sources', 'status']);
  const withConv = await askNordla({ text: 'quelle est la marge ?', caseId: 'blocked' }, { ...ctx, conversation: null });
  assert.deepEqual(Object.keys(withConv).sort(), ['answer', 'conversation', 'intent', 'limits', 'sections', 'sources', 'status'], 'opt-in only: no conversation key unless the caller asked');
});

test('contract isolation: the field modules import only pure sources - never the runtime, journal, HTTP layer, filesystem, network or process', () => {
  const ALLOWED = new Set(['../sourcing/core/case.js', './sourcing-facts.js', '../buying/sourcing-purchase.js', './field-intents.js', './field-facts.js', './field-answers.js', './field-context.js']);
  for (const f of ['field-intents.js', 'field-facts.js', 'field-answers.js', 'field-context.js']) {
    const src = readFileSync(new URL(`../src/core-pilot/${f}`, import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    for (const i of imports) assert.ok(ALLOWED.has(i), `${f} imports ${i}: the field layer must stay pure (read-only)`);
    const code = src.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//')).join(String.fromCharCode(10));
    assert.doesNotMatch(code, /\b(fetch|XMLHttpRequest|writeFile|appendFile|process\.env|child_process|analyseCase|decideHuman|recordResult)\b|\bcommit\(/, `${f} uses a write or network capability`);
  }
});

test('contract HTTP -> conversation: validateConversation rebuilds a trusted copy and drops everything malformed, oversized or foreign-shaped', async () => {
  const { validateConversation, stepConversation } = await import('../src/core-pilot/field-context.js');
  const ok = stepConversation(null, { merchantId: 'm', caseId: 'c', caseVersion: 'v1', intent: FIELD_INTENT.MARGIN, sources: [{ kind: 'sourcing_case', ref: 'c', version: 'v1' }], now: NOW }).conversation;
  assert.deepEqual(validateConversation(JSON.parse(JSON.stringify(ok))), ok, 'a state produced by the server round-trips unchanged');
  const extra = { ...ok, injected: 'x', turns: [{ ...ok.turns[0], figure: 16.07, secret: 's' }] };
  assert.deepEqual(Object.keys(validateConversation(extra)), ['v', 'merchantId', 'caseId', 'caseVersion', 'turns']); assert.deepEqual(Object.keys(validateConversation(extra).turns[0]), ['intent', 'at', 'sources']);
  for (const bad of [null, undefined, 'x', 42, [], {}, { ...ok, v: 2 }, { ...ok, merchantId: '' }, { ...ok, turns: [] }, { ...ok, turns: Array(11).fill(ok.turns[0]) }, { ...ok, turns: [{ ...ok.turns[0], intent: 'DELETE_EVERYTHING' }] }, { ...ok, caseId: 'c'.repeat(81) }, { ...ok, turns: [{ ...ok.turns[0], sources: Array(11).fill({ kind: 'k', ref: 'r' }) }] }, { ...ok, pad: 'z'.repeat(5000) }]) assert.equal(validateConversation(bad), null, JSON.stringify(bad)?.slice(0, 60));
});
