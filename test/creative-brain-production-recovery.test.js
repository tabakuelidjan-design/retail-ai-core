import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { DIMENSIONS, normalizeCritique } from '../src/creative-critic/index.js';
import {
  assertExecutable, CAPABILITY, CONCEPT_DIMENSION, CONCEPT_DIMENSIONS, composeScene, createConceptCritic, creativeQualityState, diagnoseRecovery, isSupported, normalizeArtDirection,
  normalizeCompositionPlan, normalizeConceptCritique, normalizeConceptSet, notMeasurableConceptCritique, planProduction, resolveTools, TOOL_REGISTRY,
} from '../src/creative-brain/index.js';
import { artDirectionAnswer, compositionAnswer, CONCEPTS } from './creative-brain-world.js';

// PRODUCTION STRATEGIST, TOOL REGISTRY, RECOVERY, CONCEPT CRITIC, CREATIVE-QUALITY STATE (`// PR-N` markers).

const SHA = 'a'.repeat(64);
const ctx = { candidate_ref: 'cand-1', candidate_sha256: SHA };
const code = (fn, c) => assert.throws(fn, (e) => e.code === c, c);
const concept = normalizeConceptSet(CONCEPTS)[0];
const art = (over) => normalizeArtDirection(artDirectionAnswer(over), { concept });
const production = (over = {}, rec = null) => {
  const artDirection = art(over);
  return planProduction({ artDirection, scene: composeScene({ artDirection, productAssetRef: 'p' }), composition: normalizeCompositionPlan(compositionAnswer()), recovery: rec });
};
const caps = (p) => p.required.map((r) => r.capability);

const critique14 = (outcomes = {}) => normalizeCritique({
  dimensions: DIMENSIONS.map((dimension) => {
    const outcome = outcomes[dimension] ?? 'PASS';
    return { dimension, outcome, evidence: 'Concrete visible evidence for this judgment.', ...(outcome === 'FAIL' || outcome === 'REVIEW_REQUIRED' ? { revision_hint: 'Make the point clearer in plain words.' } : {}) };
  }),
}, ctx);
const conceptCritique = (outcomes = {}) => normalizeConceptCritique({
  dimensions: CONCEPT_DIMENSIONS.map((dimension) => {
    const outcome = outcomes[dimension] ?? 'PASS';
    return { dimension, outcome, evidence: 'Concrete visible evidence for this judgment.', ...(outcome === 'FAIL' || outcome === 'REVIEW_REQUIRED' ? { revision_hint: 'Give the idea more presence in plain words.' } : {}) };
  }),
}, ctx);

test('PR-1 the strategist always requires the protected-product capabilities and chooses scene generation from the art direction', () => {
  const p = production();
  for (const c of ['LOCAL_SEGMENTATION', 'PRODUCT_CUTOUT', 'DETERMINISTIC_PRODUCT_COMPOSITE', 'DETERMINISTIC_TEXT']) assert.ok(caps(p).includes(c), c);
  assert.ok(caps(p).includes('RICH_SCENE_GENERATION') && !caps(p).includes('ENVIRONMENT_GENERATION'));
  assert.ok(caps(p).includes('SHADOW_CONTACT_INTEGRATION'));
  assert.ok(p.required.every((r) => r.reason.length > 20));
  assert.equal(p.executable, true);
  assert.deepEqual(p.unsupported, []);
  // a plain scene: no narrative, no secondary, shallow depth -> the simple environment capability
  const plain = production({ narrative_elements: [], permitted_secondary_elements: [], depth_model: 'FLAT_FIELD' });
  assert.ok(caps(plain).includes('ENVIRONMENT_GENERATION') && !caps(plain).includes('RICH_SCENE_GENERATION'));
  // an adjacent product needs no contact shadow
  assert.ok(!caps(production({ product_relationship: 'ADJACENT_TO_SCENE' })).includes('SHADOW_CONTACT_INTEGRATION'));
  // the id follows the content
  assert.equal(production().production_plan_id, p.production_plan_id);
  assert.notEqual(plain.production_plan_id, p.production_plan_id);
  assert.ok(Object.isFrozen(p));
});

test('PR-2 multi-reference and selective editing are never needed here, and say why', () => {
  const p = production();
  const notNeeded = Object.fromEntries(p.not_needed.map((n) => [n.capability, n.reason]));
  assert.match(notNeeded.MULTI_REFERENCE_COMPOSITION, /product pixels to a provider/);
  assert.match(notNeeded.SELECTIVE_EDITING, /nothing in the scene needs an edit/);
  assert.ok(!caps(p).includes('MULTI_REFERENCE_COMPOSITION') && !caps(p).includes('SELECTIVE_EDITING'));
  assert.equal(p.required.length + p.not_needed.length, Object.keys(CAPABILITY).length);
});

test('PR-3 a REFINE needs local refinement, which is unsupported today: an explicit degradation, never hidden and never blocking', () => {
  const p = production({}, { action: 'REFINE' });
  assert.ok(caps(p).includes('LOCAL_REFINEMENT'));
  assert.equal(p.unsupported.length, 1);
  assert.deepEqual({ capability: p.unsupported[0].capability, degradation: p.unsupported[0].degradation }, { capability: 'LOCAL_REFINEMENT', degradation: 'REGENERATE_THE_SCENE_ONLY_WITH_THE_SAME_CONCEPT_AND_COMPOSITION' });
  assert.deepEqual(p.degradations, ['REGENERATE_THE_SCENE_ONLY_WITH_THE_SAME_CONCEPT_AND_COMPOSITION']);
  assert.equal(p.executable, true);
  assert.equal(assertExecutable(p), p);
  assert.ok(!caps(production({}, { action: 'RECOMPOSE' })).includes('LOCAL_REFINEMENT'));
});

test('PR-4 a plan that needs a capability no tool provides is refused with the capability named', () => {
  const p = production();
  const blocked = { ...p, executable: false, unsupported: [{ capability: 'SELECTIVE_EDITING', reason: 'x', degradation: 'NONE_AVAILABLE' }] };
  const e = (() => { try { assertExecutable(blocked); } catch (x) { return x; } return null; })();
  assert.equal(e?.code, 'BRAIN_RULE_VIOLATION');
  assert.deepEqual(e.detail.capabilities, ['SELECTIVE_EDITING']);
});

test('PR-4b a required capability that no tool provides and that has no degradation makes the plan not executable and is named', () => {
  const artDirection = art(); const scene = composeScene({ artDirection, productAssetRef: 'p' });
  const registry = { ...TOOL_REGISTRY, LOCAL_SEGMENTATION: { ...TOOL_REGISTRY.LOCAL_SEGMENTATION, status: 'UNSUPPORTED', tool: null } };
  const p = planProduction({ artDirection, scene, composition: normalizeCompositionPlan(compositionAnswer()), registry });
  assert.equal(p.executable, false);
  assert.deepEqual(p.unsupported.map((u) => [u.capability, u.degradation]), [['LOCAL_SEGMENTATION', 'NONE_AVAILABLE']]);
  assert.deepEqual(p.degradations, []);
  const e = (() => { try { assertExecutable(p); } catch (x) { return x; } return null; })();
  assert.deepEqual(e?.detail?.capabilities, ['LOCAL_SEGMENTATION']);
});

test('PR-5 the registry is the only place that names a provider, and the supported status is honest', () => {
  assert.deepEqual(Object.keys(TOOL_REGISTRY).sort(), Object.keys(CAPABILITY).sort());
  for (const c of ['LOCAL_SEGMENTATION', 'PRODUCT_CUTOUT', 'ENVIRONMENT_GENERATION', 'RICH_SCENE_GENERATION', 'DETERMINISTIC_TEXT', 'DETERMINISTIC_PRODUCT_COMPOSITE', 'SHADOW_CONTACT_INTEGRATION']) assert.equal(isSupported(c), true, c);
  for (const c of ['MULTI_REFERENCE_COMPOSITION', 'SELECTIVE_EDITING', 'LOCAL_REFINEMENT']) { assert.equal(isSupported(c), false, c); assert.equal(TOOL_REGISTRY[c].tool, null); }
  assert.equal(TOOL_REGISTRY.RICH_SCENE_GENERATION.executor, 'PROVIDER');
  assert.equal(TOOL_REGISTRY.PRODUCT_CUTOUT.executor, 'LOCAL');
  assert.deepEqual(resolveTools(production()).map((t) => t.capability), caps(production()));
  // no other module of the Creative Brain names a provider, a model or a vendor
  const dir = new URL('../src/creative-brain/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'tool-registry.js')) {
    const text = readFileSync(new URL(file, dir), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(text, /\b(qwen|alibaba|openai|krea|recraft|gemini|dashscope|midjourney)\b/i, file);
  }
});

test('PR-6 the concept critique has six separate dimensions, four outcomes, evidence, semantic hints and no score', () => {
  const c = conceptCritique({ WOW_FACTOR: 'FAIL', DISTINCTIVENESS: 'REVIEW_REQUIRED' });
  assert.deepEqual(c.dimensions.map((d) => d.dimension), ['CONCEPT_STRENGTH', 'NARRATIVE_COHESION', 'EMOTIONAL_RESONANCE', 'EDITORIAL_SOPHISTICATION', 'DISTINCTIVENESS', 'WOW_FACTOR']);
  assert.match(c.critique_id, /^ccc_/);
  assert.equal(c.schema_version, 'concept-critique@1');
  const miss = normalizeConceptCritique({ dimensions: [{ dimension: 'WOW_FACTOR', outcome: 'PASS', evidence: 'A memorable moment is visible.' }] }, ctx);
  assert.equal(miss.dimensions.filter((d) => d.outcome === 'NOT_MEASURABLE').length, 5);
  const bad = (d) => normalizeConceptCritique({ dimensions: [d] }, ctx);
  const ok = { dimension: 'WOW_FACTOR', outcome: 'FAIL', evidence: 'Nothing memorable is visible.', revision_hint: 'Give the idea more presence in plain words.' };
  code(() => bad({ ...ok, dimension: 'BEAUTY' }), 'BRAIN_ENUM_INVALID');
  code(() => bad({ ...ok, outcome: 'GREAT' }), 'BRAIN_ENUM_INVALID');
  code(() => bad({ ...ok, score: 'x' }), 'BRAIN_UNKNOWN_KEY');
  code(() => bad({ ...ok, evidence: 'Rated 8 out of 10 for impact.' }), 'BRAIN_NUMERIC_VALUE');
  code(() => bad({ ...ok, evidence: 'It deserves a score: 9 here.' }), 'BRAIN_NUMERIC_VALUE');
  code(() => bad({ ...ok, evidence: 'ok' }), 'BRAIN_TEXT_INVALID');
  code(() => bad({ ...ok, outcome: 'PASS' }), 'BRAIN_RULE_VIOLATION'); // a hint only for a flagged dimension
  assert.throws(() => bad({ ...ok, revision_hint: 'Move it to x 40, y 90 at 14px' }));
  code(() => normalizeConceptCritique({ dimensions: [ok, ok] }, ctx), 'BRAIN_RULE_VIOLATION');
  code(() => normalizeConceptCritique({ dimensions: [], extra: 'x' }, ctx), 'BRAIN_UNKNOWN_KEY');
  code(() => normalizeConceptCritique({ dimensions: [] }, { candidate_ref: 'c', candidate_sha256: 'bad' }), 'BRAIN_MALFORMED');
  assert.ok(notMeasurableConceptCritique(ctx, 'there is nothing').dimensions.every((d) => d.outcome === 'NOT_MEASURABLE'));
});

test('PR-7 the concept critic is blind to owner review and fails to NOT_MEASURABLE, never to a pass', async () => {
  const png = new Uint8Array(32).fill(7);
  const answer = { dimensions: CONCEPT_DIMENSIONS.map((dimension) => ({ dimension, outcome: 'PASS', evidence: 'Concrete visible evidence here.' })) };
  const seen = [];
  const vlm = { invoke: async (req) => { seen.push(req); return { text: JSON.stringify(answer), model: 'fake', request_id: 'r1' }; } };
  const r = await createConceptCritic({ vlm }).critique({ candidate: { ref: 'cand-1', png_bytes: png }, brief: { public_facts: { f: 'x' } } });
  assert.ok(r.critique.dimensions.every((d) => d.outcome === 'PASS'));
  assert.equal(r.provenance.request_id, 'r1');
  assert.equal(seen[0].images[0].media_type, 'image/png');
  assert.match(seen[0].system, /Never give a score, a rating/);
  assert.match(seen[0].system, /you give an opinion, a person decides/);
  assert.doesNotMatch(seen[0].user + seen[0].system, /OWNER_REJECTED|owner review|NOT_SHIPPABLE/);
  for (const dimension of CONCEPT_DIMENSIONS) assert.ok(seen[0].user.includes(`- ${dimension}:`));
  // no image: no call
  let called = 0;
  const empty = await createConceptCritic({ vlm: { invoke: async () => { called += 1; return { text: '{}' }; } } }).critique({ candidate: { ref: 'c', png_bytes: new Uint8Array(2) } });
  assert.equal(called, 0);
  assert.ok(empty.critique.dimensions.every((d) => d.outcome === 'NOT_MEASURABLE'));
  // provider failure, and a non-conforming answer
  const boom = await createConceptCritic({ vlm: { invoke: async () => { throw Object.assign(new Error('x'), { code: 'Throttling', status: 429, requestId: 'rq' }); } } }).critique({ candidate: { ref: 'c', png_bytes: png } });
  assert.ok(boom.critique.dimensions.every((d) => d.outcome === 'NOT_MEASURABLE'));
  assert.equal(boom.provenance.failure.status, 429);
  const junk = await createConceptCritic({ vlm: { invoke: async () => ({ text: '{"dimensions":[{"dimension":"WOW_FACTOR","outcome":"PASS","evidence":"Rated 9 out of 10 here."}]}' }) } }).critique({ candidate: { ref: 'c', png_bytes: png } });
  assert.ok(junk.critique.dimensions.every((d) => d.outcome === 'NOT_MEASURABLE'));
  assert.equal(junk.provenance.rejected.code, 'BRAIN_NUMERIC_VALUE');
  assert.throws(() => createConceptCritic({}), TypeError);
});

test('PR-8 recovery is a fixed function of the critic evidence: REFINE, RECOMPOSE or RECONCEPT', () => {
  const diagnose = (c14, cc, history = [], id = 'cnc_1') => diagnoseRecovery({ critique: critique14(c14), conceptCritique: conceptCritique(cc), history, concept_id: id });
  assert.equal(diagnose({}, {}).action, 'NONE');
  const refine = diagnose({ PRICE_INTEGRATION: 'FAIL' }, {});
  assert.equal(refine.action, 'REFINE');
  assert.deepEqual(refine.redo, ['SCENE', 'PRODUCTION']);
  assert.ok(refine.reuse.includes('CONCEPT') && refine.reuse.includes('COMPOSITION_PLAN'));
  assert.deepEqual(refine.reasons, [{ dimension: 'PRICE_INTEGRATION', outcome: 'FAIL', group: 'EXECUTION' }]);
  assert.equal(diagnose({ BRAND_EXPRESSION: 'REVIEW_REQUIRED' }, {}).action, 'REFINE');
  const recompose = diagnose({ VISUAL_HIERARCHY: 'FAIL' }, {});
  assert.equal(recompose.action, 'RECOMPOSE');
  assert.ok(recompose.reuse.includes('ART_DIRECTION') && recompose.redo.includes('COMPOSITION_PLAN'));
  assert.equal(diagnose({ COMPOSITION_BALANCE: 'REVIEW_REQUIRED', TEMPLATE_LIKE_APPEARANCE: 'REVIEW_REQUIRED' }, {}).action, 'RECOMPOSE'); // two structural flags
  assert.equal(diagnose({ COMPOSITION_BALANCE: 'REVIEW_REQUIRED' }, {}).action, 'REFINE'); // one soft structural flag only polishes
  // a decisive concept failure is a new concept, whatever the execution looks like
  for (const d of ['CONCEPT_STRENGTH', 'DISTINCTIVENESS', 'NARRATIVE_COHESION']) {
    const r = diagnose({}, { [d]: 'FAIL' });
    assert.equal(r.action, 'RECONCEPT', d);
    assert.deepEqual(r.reuse, ['PROBLEM_FRAME']);
    assert.ok(r.redo.includes('CONCEPTS') && r.redo.includes('CONCEPT_SELECTION'));
  }
  assert.equal(diagnose({}, { WOW_FACTOR: 'FAIL' }).action, 'REFINE'); // a non-decisive concept failure alone is refined
  assert.equal(diagnose({ PRICE_INTEGRATION: 'FAIL' }, { WOW_FACTOR: 'REVIEW_REQUIRED', EMOTIONAL_RESONANCE: 'REVIEW_REQUIRED', EDITORIAL_SOPHISTICATION: 'REVIEW_REQUIRED' }).action, 'RECONCEPT'); // three concept flags
  assert.equal(diagnose({ AI_ARTIFACTS: 'NOT_MEASURABLE' }, {}).action, 'NONE'); // not measurable is not a flag
});

test('PR-9 a weak concept is never endlessly polished', () => {
  const polish = [{ concept_id: 'cnc_1', action: 'REFINE' }, { concept_id: 'cnc_1', action: 'RECOMPOSE' }];
  const r = diagnoseRecovery({ critique: critique14({ PRICE_INTEGRATION: 'FAIL' }), conceptCritique: conceptCritique({}), history: polish, concept_id: 'cnc_1' });
  assert.equal(r.action, 'RECONCEPT');
  assert.equal(r.exhausted, true);
  // polishing a different concept, or having already re-conceived, does not count against this one
  assert.equal(diagnoseRecovery({ critique: critique14({ PRICE_INTEGRATION: 'FAIL' }), conceptCritique: conceptCritique({}), history: polish, concept_id: 'cnc_2' }).action, 'REFINE');
  assert.equal(diagnoseRecovery({ critique: critique14({ PRICE_INTEGRATION: 'FAIL' }), conceptCritique: conceptCritique({}), history: [{ concept_id: 'cnc_1', action: 'RECONCEPT' }, { concept_id: 'cnc_1', action: 'REFINE' }], concept_id: 'cnc_1' }).action, 'REFINE');
  // one polish is allowed
  assert.equal(diagnoseRecovery({ critique: critique14({ PRICE_INTEGRATION: 'FAIL' }), conceptCritique: conceptCritique({}), history: polish.slice(0, 1), concept_id: 'cnc_1' }).action, 'REFINE');
  // nothing flagged: nothing to recover, however long the history
  assert.equal(diagnoseRecovery({ critique: critique14({}), conceptCritique: conceptCritique({}), history: polish, concept_id: 'cnc_1' }).action, 'NONE');
  assert.ok(Object.isFrozen(r));
});

test('PR-10 green gates never imply premium quality: TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT is stated', () => {
  const green = { preflight: 'PASS', fidelity: 'PASS', guardian: 'PASS' };
  const state = (c14, cc, det = green) => creativeQualityState({ critique: critique14(c14), conceptCritique: conceptCritique(cc), deterministic: det });
  // the canonical case: clean execution, weak concept
  const weak = state({}, { CONCEPT_STRENGTH: 'FAIL', WOW_FACTOR: 'FAIL' });
  assert.equal(weak.state, 'TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT');
  assert.equal(weak.diagnosis, 'EXECUTION_IS_CLEAN_BUT_THE_CONCEPT_IS_WEAK');
  assert.equal(weak.weak_concept, true);
  assert.equal(weak.execution_clean, true);
  // everything passes: still only awaiting the owner, never approved, never premium-implied
  const best = state({}, {});
  assert.equal(best.state, 'CREATIVELY_SUFFICIENT_AWAITING_OWNER');
  assert.equal(best.premium_quality_implied, false);
  assert.equal(best.owner_approval, 'PENDING');
  assert.equal(weak.premium_quality_implied, false);
  // a deterministic gate that did not pass dominates
  for (const gate of ['preflight', 'fidelity', 'guardian']) assert.equal(state({}, {}, { ...green, [gate]: 'FAIL' }).state, 'NOT_TECHNICALLY_VALID', gate);
  assert.equal(state({}, {}, {}).state, 'NOT_TECHNICALLY_VALID'); // gates not run are not green
  // a clean-looking critique with an execution FAIL is insufficient but not a concept diagnosis
  const exec = state({ PRICE_INTEGRATION: 'FAIL' }, {});
  assert.equal(exec.state, 'TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT');
  assert.equal(exec.execution_clean, false);
  assert.equal(exec.diagnosis, null);
  // a review-required dimension is not a pass
  assert.equal(state({}, { WOW_FACTOR: 'REVIEW_REQUIRED' }).state, 'TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT');
  assert.equal(state({ AI_ARTIFACTS: 'REVIEW_REQUIRED' }, {}).state, 'TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT');
  // a missing or unmeasurable critique is NOT_MEASURABLE, never sufficient
  assert.equal(creativeQualityState({ critique: critique14({}), conceptCritique: notMeasurableConceptCritique(ctx, 'none'), deterministic: green }).state, 'NOT_MEASURABLE');
  assert.equal(creativeQualityState({ critique: null, conceptCritique: null, deterministic: green }).state, 'NOT_MEASURABLE');
  void CONCEPT_DIMENSION;
});
