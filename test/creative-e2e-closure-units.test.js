import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyCandidate } from '../src/creative-refine/index.js';
import {
  CATEGORY, DISPOSITION, E2E_STATE, categoryOfProduct, checkProductCopyConsistency, claimsOfBrief, dispositionOfClaims, executionOf, layeredRunOf,
} from '../src/creative-e2e/index.js';
import { createRunContext } from '../src/creative-e2e/index.js';
import { createDecisionLedger } from '../src/creative-runtime/ledger.js';

// The pure decisions of the closure, fast (`// CU-N` markers): claim disposition, product/copy consistency, candidate classes, the status model, the budget refusal that the run reports.

const plan = (slots, caption = null) => [{ assets: [{ index: 0, asset_role: 'SINGLE', slots }], caption }];
const claim = (ref, wording, role = 'PRICE') => ({ ref, role, wording });
const disp = (brief, contentPlans, policy = {}) => dispositionOfClaims({ brief, contentPlans, policy });

test('Claim disposition: where the exact wording is, what is declared, and what stops the run', () => {
  const price = { claims: [claim('c1', '25,00 €')] };
  // CU-1 on an asset, in its slot role; in a caption; nowhere
  const onAsset = disp(price, plan([{ role: 'PRICE', text: '25,00 €' }])); assert.deepEqual(onAsset.dispositions[0], { ref: 'c1', kind: 'CLAIM', role: 'PRICE', wording: '25,00 €', disposition: 'VISUAL_COPY', reason: 'THE_EXACT_WORDING_IS_ON_AN_ASSET', declared: null, placed_on: [{ asset_index: 0, slot_role: 'PRICE' }], exact: true });
  assert.deepEqual(onAsset.blocks, []);
  const inCaption = disp(price, plan([{ role: 'BODY', text: 'x' }], [{ text: 'à 25,00 € seulement' }])).dispositions[0]; assert.equal(inCaption.disposition, DISPOSITION.CAPTION); assert.equal(inCaption.reason, 'THE_EXACT_WORDING_IS_IN_THE_CAPTION'); assert.equal(inCaption.exact, true);
  for (const caption of ['à 25,00 € seulement', ['à 25,00 € seulement'].join(), { text: 'à 25,00 € seulement' }]) assert.equal(disp(price, plan([{ role: 'BODY', text: 'x' }], caption)).dispositions[0].disposition, DISPOSITION.CAPTION);
  const nowhere = disp(price, plan([{ role: 'BODY', text: 'x' }])).dispositions[0]; assert.deepEqual([nowhere.disposition, nowhere.reason, nowhere.exact, nowhere.placed_on], ['NOT_USED', 'NOT_IN_THE_REQUEST_COPY_AND_NOT_FORCED_ONTO_THE_VISUAL', null, []]);
  // CU-2 the declared intent
  assert.equal(disp(price, plan([{ role: 'BODY', text: 'x' }]), { c1: 'METADATA_ONLY' }).dispositions[0].disposition, 'METADATA_ONLY');
  const declaredNot = disp(price, plan([{ role: 'BODY', text: 'x' }]), { c1: 'NOT_USED' }); assert.equal(declaredNot.dispositions[0].reason, 'DECLARED_NOT_USED_BY_THE_OPERATOR'); assert.deepEqual(declaredNot.blocks, []);
  for (const declared of ['VISUAL_COPY', 'CAPTION']) { const out = disp(price, plan([{ role: 'BODY', text: 'x' }]), { c1: declared }); assert.deepEqual(out.blocks.map((b) => [b.code, b.declared]), [['CLAIM_NOT_PLACED', declared]]); assert.equal(out.dispositions[0].disposition, 'NOT_USED'); assert.equal(out.dispositions[0].reason, `DECLARED_${declared}_BUT_THE_WORDING_IS_NOT_IN_THE_PLAN`); }
  assert.deepEqual(disp(price, plan([{ role: 'BODY', text: 'x' }]), { c1: 'EVERYWHERE' }).blocks.map((b) => b.code), ['CLAIM_POLICY_INVALID']); assert.deepEqual(disp(price, plan([{ role: 'BODY', text: 'x' }]), { c1: 'EVERYWHERE' }).dispositions, []);
  // CU-3 the wording is exact up to spaces only: a no-break space is the same wording, another amount form is an ALTERED price, a different amount is simply a different text
  assert.equal(disp(price, plan([{ role: 'BODY', text: '25,00 €' }])).dispositions[0].disposition, 'VISUAL_COPY'); assert.equal(disp(price, plan([{ role: 'BODY', text: '25,00 € ' }])).dispositions[0].disposition, 'VISUAL_COPY');
  for (const altered of ['Seulement 25 €', 'Seulement 25,00€', 'Seulement 25.00 €', 'Seulement 25 euros']) assert.deepEqual(disp(price, plan([{ role: 'BODY', text: altered }])).blocks.map((b) => b.code), altered === 'Seulement 25 euros' ? [] : ['CLAIM_ALTERED'], altered);
  assert.deepEqual(disp(price, plan([{ role: 'BODY', text: 'Seulement 30 €' }])).blocks, []); assert.deepEqual(disp(price, plan([{ role: 'BODY', text: 'prix 2,5 €' }])).blocks, []);
  assert.deepEqual(disp(price, plan([{ role: 'BODY', text: 'Seulement 25 €' }], [{ text: 'à 25,00 € seulement' }])).blocks, [], 'the exact form is in the caption: nothing is altered');
  assert.deepEqual(disp({ claims: [claim('m', '20 000 mAh', 'SUBHEADLINE')] }, plan([{ role: 'BODY', text: '20000 mAh' }])).blocks.map((b) => b.code), ['CLAIM_ALTERED']);
  // CU-4 every claim and approved copy of the brief is accounted for, none is dropped
  const brief = { claims: [claim('a', 'un'), claim('b', 'deux')], approved_copy: [{ ref: 'h', role: 'HEADLINE', content: 'trois' }, { ref: 'n' }] };
  assert.deepEqual(claimsOfBrief(brief).map((c) => [c.ref, c.kind, c.wording]), [['a', 'CLAIM', 'un'], ['b', 'CLAIM', 'deux'], ['h', 'APPROVED_COPY', 'trois']]);
  assert.equal(disp(brief, plan([{ role: 'HEADLINE', text: 'trois' }])).dispositions.length, 3); assert.deepEqual(claimsOfBrief({}), []);
  assert.deepEqual(disp({ claims: [claim('p', 'x')] }, []).dispositions.map((d) => d.disposition), ['NOT_USED']);
});

test('Product / copy consistency: the obvious contradictions, both ways, and what it does not judge', () => {
  const brief = (product, extra = {}) => ({ public_facts: { product }, claims: [], approved_copy: [], ...extra });
  const req = (...texts) => ({ copy: texts.map((text, i) => ({ copy_ref: `c${i}`, text })) });
  // CU-5 the category of the declared product; two names make it unknown; an explicit category wins
  assert.equal(categoryOfProduct(brief('Coque personnalisée pour téléphone')), CATEGORY.PHONE_CASE); assert.equal(categoryOfProduct(brief('Batterie externe 20000 mAh')), CATEGORY.POWER_BANK);
  assert.equal(categoryOfProduct(brief('Gourde isotherme')), CATEGORY.WATER_BOTTLE); assert.equal(categoryOfProduct(brief('Boîte cadeau')), CATEGORY.GIFT_BOX); assert.equal(categoryOfProduct(brief('Cadre photo')), CATEGORY.PHOTO_FRAME);
  assert.equal(categoryOfProduct(brief('Coque et gourde')), null); assert.equal(categoryOfProduct(brief('Produit tech')), null); assert.equal(categoryOfProduct({}), null); assert.equal(categoryOfProduct(brief('Produit', { product_category: 'GIFT_BOX' })), CATEGORY.GIFT_BOX); assert.equal(categoryOfProduct(brief('Coque', { product_category: 'NOPE' })), CATEGORY.PHONE_CASE);
  // CU-6 a conflict names the source, the category the copy speaks of and the evidence; nothing is rewritten
  const bank = checkProductCopyConsistency({ brief: brief('Batterie externe 20000 mAh'), request: req('Votre photo sur votre coque.', 'Une belle journée') });
  assert.deepEqual([bank.status, bank.product_category, bank.findings.length], ['CONFLICT', 'POWER_BANK', 1]); assert.deepEqual(bank.findings[0], { code: 'PRODUCT_COPY_CONFLICT', source: 'request.copy:c0', product_category: 'POWER_BANK', copy_says: 'PHONE_CASE', evidence: 'votre coque' });
  for (const [product, text, says] of [['Coque personnalisée', 'Autonomie 20 000 mAh', 'POWER_BANK'], ['Coque personnalisée', 'Rechargez en 30 minutes', 'POWER_BANK'], ['Batterie externe', 'Protège ton téléphone', 'PHONE_CASE'], ['Batterie externe', 'Votre iPhone adore', 'PHONE_CASE'], ['Coque personnalisée', 'Cette gourde isotherme', 'WATER_BOTTLE'], ['Gourde', 'Notre boîte cadeau', 'GIFT_BOX'], ['Gourde', 'Votre cadre photo', 'PHOTO_FRAME']]) {
    const r = checkProductCopyConsistency({ brief: brief(product), request: req(text) }); assert.equal(r.status, 'CONFLICT', `${product} / ${text}`); assert.ok(r.findings.some((f) => f.copy_says === says), `${product} / ${text}`);
  }
  // CU-7 the claims and the approved copy of the brief are read as well
  assert.equal(checkProductCopyConsistency({ brief: brief('Coque', { claims: [claim('x', '20 000 mAh', 'SUBHEADLINE')] }), request: req('ok') }).findings[0].source, 'brief.claims:x');
  assert.equal(checkProductCopyConsistency({ brief: brief('Coque', { approved_copy: [{ ref: 'h', content: 'Une power bank' }] }), request: req('ok') }).findings[0].source, 'brief.approved_copy:h');
  // CU-8 consistent copy, cross-sell, the product's own words, an undeclared product, no copy at all
  for (const text of ['Votre photo sur votre coque.', 'Protège ton téléphone', 'HABB propose aussi des gourdes personnalisées.', 'Les boîtes cadeaux et les cadres photo', '']) assert.equal(checkProductCopyConsistency({ brief: brief('Coque personnalisée pour téléphone'), request: req(text) }).status, 'CONSISTENT', text);
  assert.deepEqual(checkProductCopyConsistency({ brief: brief('Produit tech'), request: req('Votre coque') }), { status: 'CATEGORY_NOT_DECLARED', product_category: null, findings: [] });
  assert.equal(checkProductCopyConsistency({ brief: brief('Coque'), request: {} }).status, 'CONSISTENT'); assert.equal(checkProductCopyConsistency({ brief: brief('Coque'), request: { copy: [{ copy_ref: 'k', content: 'une power bank' }] } }).status, 'CONFLICT');
});

test('Candidate classes and the status model say what each thing is, apart', () => {
  const artifact = { schema: 'layered-artifact@1' };
  // CU-9 classes: no artifact / invalid / delivered / unmeasurable (the artifact checks need a real layered artifact, covered by the closure test; here the cases that do not need one)
  assert.equal(classifyCandidate(null), 'NO_ARTIFACT'); assert.equal(classifyCandidate(undefined), 'NO_ARTIFACT'); assert.equal(classifyCandidate({}), 'NO_ARTIFACT'); assert.equal(classifyCandidate({ status: 'READY_FOR_REVIEW', png_bytes: new Uint8Array(1) }), 'NO_ARTIFACT');
  assert.equal(classifyCandidate({ status: 'READY_FOR_REVIEW', artifact }), 'INVALID'); assert.equal(classifyCandidate({ status: 'BLOCKED', fidelity: { gate: 'NOT_MEASURABLE' }, artifact }), 'INVALID');
  // CU-10 the layered run said as what it means
  const png = new Uint8Array(1);
  assert.deepEqual(layeredRunOf({ status: 'READY_FOR_REVIEW', png_bytes: png, fidelity: { gate: 'PASS' } }), { raw_status: 'READY_FOR_REVIEW', delivery: 'COMPLETE', case_gate: 'PASS' });
  assert.deepEqual(layeredRunOf({ status: 'BLOCKED', png_bytes: png, fidelity: { gate: 'NOT_MEASURABLE' } }), { raw_status: 'BLOCKED', delivery: 'IDENTITY_NOT_MEASURED_BY_THE_CASE_GATE', case_gate: 'NOT_MEASURABLE' });
  assert.equal(layeredRunOf({ status: 'BLOCKED', png_bytes: png, fidelity: { gate: 'PASS' }, reason: 'BRAND_GUARDIAN_NOT_CONFIGURED' }).delivery, 'A_GATE_OF_THE_LAYERED_RUN_FAILED');
  for (const status of ['PREFLIGHT_FAIL', 'FIDELITY_FAIL', 'GUARDIAN_FAIL']) assert.equal(layeredRunOf({ status, png_bytes: png, fidelity: { gate: 'FAIL' } }).delivery, 'A_GATE_OF_THE_LAYERED_RUN_FAILED');
  assert.deepEqual(layeredRunOf({ status: 'BLOCKED', fidelity: { gate: 'NOT_MEASURABLE' } }), { raw_status: 'BLOCKED', delivery: 'NO_IMAGE', case_gate: 'NOT_MEASURABLE' }); assert.deepEqual(layeredRunOf(undefined), { raw_status: null, delivery: 'NO_IMAGE', case_gate: null });
  // CU-11 the execution model: deliverable only for an image in a delivered final state
  const layered = { status: 'READY_FOR_REVIEW', png_bytes: png, fidelity: { gate: 'PASS' } };
  for (const state of [E2E_STATE.READY, E2E_STATE.NEEDS_OWNER_REVIEW]) assert.deepEqual(executionOf({ state, png, planned: true, specified: true, layered }), { planned: true, specified: true, produced: true, deliverable: true, layered_delivery: 'COMPLETE' });
  for (const state of [E2E_STATE.BLOCKED, E2E_STATE.TECHNICAL_FAIL, E2E_STATE.BUDGET_EXCEEDED, E2E_STATE.PROVIDER_NOT_CONNECTED]) assert.equal(executionOf({ state, png, planned: true, specified: true, layered }).deliverable, false, state);
  assert.deepEqual(executionOf({ state: E2E_STATE.BLOCKED, png: null, planned: false, specified: false, layered: null }), { planned: false, specified: false, produced: false, deliverable: false, layered_delivery: 'NO_IMAGE' });
  assert.equal(executionOf({ state: E2E_STATE.NEEDS_OWNER_REVIEW, png: null, planned: true, specified: true, layered: null }).deliverable, false, 'a delivered state without an image delivers nothing');
});

test('The run context remembers the first reservation the ceiling refused, whatever the port made of it', () => {
  // CU-12
  const ctx = createRunContext({ run_id: 'run-cu-1', ceiling_eur: 0.05, ledger: createDecisionLedger(), at: 'x' });
  assert.equal(ctx.budgetRefusal(), null);
  const ok = ctx.budget.reserve('a', 0.05); assert.equal(ctx.budgetRefusal(), null, 'a reservation that fits is not a refusal'); ctx.budget.release(ok);
  const first = ctx.budget.reserve('b', 0.04); assert.throws(() => ctx.budget.reserve('c', 0.02), (e) => e.name === 'RunBudgetError');
  const refusal = ctx.budgetRefusal(); assert.equal(refusal.label, 'c'); assert.equal(refusal.requested_eur, 0.02); assert.equal(refusal.ceiling_eur, 0.05);
  assert.throws(() => ctx.budget.reserve('d', 0.03), (e) => e.name === 'RunBudgetError'); assert.equal(ctx.budgetRefusal().label, 'c', 'the FIRST refusal is the one kept'); ctx.budget.release(first);
  assert.doesNotThrow(() => ctx.budget.reserve('e', 0.05)); // exactly what is left is allowed
});
