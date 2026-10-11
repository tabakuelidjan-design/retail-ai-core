import test from 'node:test';
import assert from 'node:assert/strict';

import { createDecisionLedger } from '../src/creative-runtime/ledger.js';
import {
  buildCompositionInstruction, createCreativeBrain, normalizeCompositionPlan, normalizeConceptSet, RELATION_PROBLEMS,
} from '../src/creative-brain/index.js';
import {
  artDirectionAnswer, brief as makeBrief, compositionAnswer, CONCEPTS, evaluationsAnswer, frameAnswer, scriptedPort,
} from './creative-brain-world.js';

// THE COMPOSITION CONTRACT AGAINST A LIVE ANSWER (`// CC-N` markers). Regression of the fourth live attempt: the planner answered hero_relationship PRODUCT_RECEDES_INTO_SCENE with visual_weight.PRODUCT DOMINANT
// (its own rationale spoke of "the product grounded in the scene", an art-direction relationship it confused with the composition value). The contract was right to refuse the contradiction; the
// instruction did not state the rule that was broken. The structure below is that answer's, the words are the test world's.

const FAILED = {
  hero_relationship: 'PRODUCT_RECEDES_INTO_SCENE',
  product_anchor: { horizontal: 'END', vertical: 'MIDDLE' },
  text_adjacency: 'BESIDE',
  alignment_family: 'START',
  visual_weight: { HEADLINE: 'STRONG', SUBHEADLINE: 'BALANCED', PRICE: 'QUIET', PRODUCT: 'DOMINANT' },
  grouping: [['HEADLINE', 'SUBHEADLINE'], ['PRICE']],
  overlap_permission: 'NONE',
  negative_space_reservation: [{ region: 'TOP', extent: 'MEDIUM' }, { region: 'START', extent: 'SMALL' }, { region: 'SURROUNDING', extent: 'LARGE' }],
  narrative_flow: ['HEADLINE', 'SUBHEADLINE', 'PRODUCT', 'PRICE'],
  rationale: 'The headline opens the story on the start edge, leading the eye across negative space to the product grounded in the scene at the end, where the quiet price closes.',
};
const problemOf = (answer) => { try { normalizeCompositionPlan(answer); return null; } catch (e) { return e.detail?.problem ?? e.code; } };

test('CC-1 the failed answer is refused for exactly one contradiction, and each single correction makes it valid: nothing is coerced', () => {
  assert.equal(problemOf(FAILED), 'A_RECEDING_PRODUCT_IS_NOT_STRONG');
  // the same plan with the product weight the hero relation needs, or with the hero relation the weight needs, is valid: the contract is strict about the contradiction, not about the rest
  assert.equal(problemOf({ ...FAILED, visual_weight: { ...FAILED.visual_weight, PRODUCT: 'BALANCED' } }), null);
  assert.equal(problemOf({ ...FAILED, visual_weight: { ...FAILED.visual_weight, PRODUCT: 'QUIET' } }), null);
  assert.equal(problemOf({ ...FAILED, hero_relationship: 'PRODUCT_DOMINATES' }), null);
  assert.equal(problemOf({ ...FAILED, hero_relationship: 'HEADLINE_LEADS_PRODUCT_ANSWERS', visual_weight: { ...FAILED.visual_weight, PRODUCT: 'STRONG' } }), null);
  assert.ok(RELATION_PROBLEMS.includes('A_RECEDING_PRODUCT_IS_NOT_STRONG'));
  assert.equal(RELATION_PROBLEMS.length, 7);
});

test('CC-2 the contract is checked against an independent oracle over every combination of the relations it constrains', () => {
  const HERO = ['PRODUCT_DOMINATES', 'PRODUCT_AND_HEADLINE_SHARE', 'HEADLINE_LEADS_PRODUCT_ANSWERS', 'PRODUCT_RECEDES_INTO_SCENE'];
  const W = ['QUIET', 'BALANCED', 'STRONG', 'DOMINANT'];
  const ADJ = ['BESIDE', 'ABOVE', 'BELOW', 'STAGGERED'];
  const rank = (w) => W.indexOf(w);
  const oracle = ({ hero, p, h, adj, horizontal, vertical }) => {
    if (hero === 'PRODUCT_DOMINATES' && p !== 'DOMINANT') return false;
    if (hero === 'PRODUCT_AND_HEADLINE_SHARE' && !(p === 'STRONG' && h === 'STRONG')) return false;
    if (hero === 'HEADLINE_LEADS_PRODUCT_ANSWERS' && !(rank(h) >= rank('STRONG') && rank(p) <= rank('STRONG'))) return false;
    if (hero === 'PRODUCT_RECEDES_INTO_SCENE' && rank(p) > rank('BALANCED')) return false;
    if ((adj === 'BESIDE' || adj === 'STAGGERED') && horizontal === 'CENTER') return false;
    if (adj === 'ABOVE' && vertical === 'UPPER') return false;
    if (adj === 'BELOW' && vertical === 'LOWER') return false;
    return true;
  };
  let valid = 0; let refused = 0;
  for (const hero of HERO) for (const p of W) for (const h of W) for (const adj of ADJ) for (const horizontal of ['START', 'CENTER', 'END']) for (const vertical of ['UPPER', 'MIDDLE', 'LOWER']) {
    const answer = { ...FAILED, hero_relationship: hero, text_adjacency: adj, product_anchor: { horizontal, vertical }, visual_weight: { ...FAILED.visual_weight, PRODUCT: p, HEADLINE: h } };
    const expected = oracle({ hero, p, h, adj, horizontal, vertical });
    assert.equal(problemOf(answer) === null, expected, JSON.stringify({ hero, p, h, adj, horizontal, vertical }));
    if (expected) valid += 1; else refused += 1;
  }
  assert.ok(valid > 100 && refused > 100, `${valid} valid, ${refused} refused`);
});

test('CC-3 the COMPOSE instruction states every relation rule the contract enforces, with its meaning, and the confusion that caused the failure', () => {
  const { system, user } = buildCompositionInstruction({ frame: { f: 1 }, concept: { c: 1 }, artDirection: { a: 1 }, approvedRoles: ['HEADLINE', 'PRICE'] });
  for (const label of ['hero_relationship PRODUCT_DOMINATES', 'hero_relationship PRODUCT_AND_HEADLINE_SHARE', 'hero_relationship HEADLINE_LEADS_PRODUCT_ANSWERS', 'hero_relationship PRODUCT_RECEDES_INTO_SCENE', 'text_adjacency BESIDE or STAGGERED', 'text_adjacency ABOVE', 'text_adjacency BELOW']) {
    assert.ok(system.includes(`- ${label}:`), label);
  }
  assert.match(system, /PRODUCT_RECEDES_INTO_SCENE: the scene and the words carry the image and the product sits quietly within it/);
  assert.match(system, /Needs: visual_weight\.PRODUCT is BALANCED or QUIET/);
  assert.match(system, /NOT the same thing as the product being grounded in the scene, which is an art-direction relationship/);
  assert.match(system, /Before you answer, check your plan against EVERY rule that applies/);
  assert.deepEqual(Object.keys(JSON.parse(user)), ['problem_frame', 'concept', 'art_direction']);
});

const PICKS = [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }];
const script = (compose) => scriptedPort({
  frame: [frameAnswer()], ideate: [{ concepts: CONCEPTS }], select: [evaluationsAnswer(normalizeConceptSet(CONCEPTS), PICKS)], art_direct: [artDirectionAnswer({ narrative_elements: [] })], compose: [compose],
});

test('CC-4 a contradictory plan stops COMPOSE with ONE composition call, and the stopped plan still shows what it had produced', async () => {
  const port = script(FAILED);
  const ledger = createDecisionLedger();
  const brain = createCreativeBrain({ complete: port.complete, ledger, bounds: { concept_rounds: 2, concepts_per_round: 3 } });
  const error = await brain.plan({ brief: makeBrief() }).catch((e) => e);
  assert.equal(error.brain_stage, 'COMPOSE');
  assert.equal(error.detail.problem, 'A_RECEDING_PRODUCT_IS_NOT_STRONG');
  assert.equal(error.evidence.raw_answer, JSON.stringify(FAILED));
  // no automatic second composition: the bounded policy has no composition retry
  assert.equal(port.calls.filter((c) => c.stage === 'compose').length, 1);
  const progress = brain.progress();
  assert.match(progress.problem_frame.frame_id, /^cpf_/);
  assert.equal(progress.rounds.length, 1);
  assert.equal(progress.rounds[0].selection.outcome, 'SELECT');
  assert.equal(progress.concept.concept_id, progress.rounds[0].selection.concept_id);
  assert.match(progress.art_direction.art_direction_id, /^art_/);
  assert.equal(progress.composition, undefined);
});

test('CC-5 a near-miss key of the composition answer is repaired and recorded; the contradiction is still refused', async () => {
  const typo = { ...compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontl: 'CENTER', vertical: 'UPPER' } }) };
  typo.alignment_famly = typo.alignment_family; delete typo.alignment_family;
  const port = script(typo);
  const ledger = createDecisionLedger();
  const out = await createCreativeBrain({ complete: port.complete, ledger, bounds: { concept_rounds: 2, concepts_per_round: 3 } }).plan({ brief: makeBrief() });
  assert.equal(out.status, 'PLANNED');
  assert.deepEqual(ledger.of('COMPOSITION_PLAN')[0].outcome.key_repairs, [{ path: 'COMPOSE', from: 'alignment_famly', to: 'alignment_family' }, { path: 'COMPOSE.product_anchor', from: 'horizontl', to: 'horizontal' }]);
  // a repaired answer that contradicts itself is refused all the same
  const bad = { ...FAILED }; bad.text_adjacncy = bad.text_adjacency; delete bad.text_adjacency;
  const e = await createCreativeBrain({ complete: script(bad).complete }).plan({ brief: makeBrief() }).catch((x) => x);
  assert.equal(e.detail.problem, 'A_RECEDING_PRODUCT_IS_NOT_STRONG');
  assert.deepEqual(e.evidence.key_repairs, [{ path: 'COMPOSE', from: 'text_adjacncy', to: 'text_adjacency' }]);
});

test('CC-6 a plan that stops AFTER composition keeps the composition in the record of what it had produced', async () => {
  // a valid plan that drops an approved text (no PRICE): refused by the coherence check, after the composition exists
  const dropsPrice = compositionAnswer({
    text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' }, narrative_flow: ['HEADLINE', 'SUBHEADLINE', 'PRODUCT'], visual_weight: { HEADLINE: 'STRONG', SUBHEADLINE: 'BALANCED', PRODUCT: 'STRONG' }, grouping: [['HEADLINE', 'SUBHEADLINE']],
  });
  const brain = createCreativeBrain({ complete: script(dropsPrice).complete });
  const error = await brain.plan({ brief: makeBrief() }).catch((e) => e);
  assert.equal(error.brain_stage, 'PLAN_COHERENCE');
  assert.equal(error.detail.problem, 'COMPOSITION_DROPS_OR_INVENTS_A_TEXT_ROLE');
  assert.match(brain.progress().composition.composition_id, /^cmp_/);
});
