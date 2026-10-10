import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import * as C from '../src/creative-critic/index.js';
import { AGREEMENT, compareWithOwner, assertOwnerReview } from '../src/creative-critic/owner-review.js';
import { createQwenVisionPort, deriveCandidateAuthorization } from '../src/marketing-creative/alibaba/index.js';
import { SpendGuard } from '../src/marketing-creative/alibaba/budget.js';

// C3 with fakes only: no network, no provider, no cost. A "VLM" here is a function returning text.

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const PNG2 = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9]);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const brief = { public_facts: { product: 'a product' }, brand_principles: { tone: 'restrained' }, verified_elsewhere: ['claims', 'price'] };
const answer = (over = {}) => ({
  dimensions: C.DIMENSIONS.map((dimension) => {
    const o = over[dimension] ?? { outcome: 'PASS', evidence: 'The image shows this clearly.' };
    return { dimension, ...o };
  }),
});
const vlmReturning = (obj) => ({ invoke: async () => ({ text: typeof obj === 'string' ? obj : JSON.stringify(obj), model: 'fake-model', request_id: 'r1', cost_eur: 0.01 }) });
const ctx = { candidate_ref: 'cand:1', candidate_sha256: sha(PNG) };
const fail = (dimension, hint = 'Give the supporting text a calmer treatment.') => ({ [dimension]: { outcome: 'FAIL', evidence: 'The element visibly competes with the main one.', revision_hint: hint } });
const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);

test('C3 valid output is normalized into a closed, frozen object', () => {
  const critique = C.normalizeCritique(answer(), ctx);
  assert.equal(critique.dimensions.length, 14);
  assert.deepEqual(critique.dimensions.map((d) => d.dimension), [...C.DIMENSIONS]);
  assert.ok(Object.isFrozen(critique) && Object.isFrozen(critique.dimensions[0]));
  assert.match(critique.critique_id, /^ccq_[0-9a-f]{32}$/);
  assert.equal(critique.candidate_sha256, ctx.candidate_sha256);
});

test('C3 an unknown dimension is refused, a repeated one too', () => {
  const a = answer(); a.dimensions.push({ dimension: 'COOLNESS', outcome: 'PASS', evidence: 'It looks cool and good.' });
  a.dimensions.shift();
  throwsCode(() => C.normalizeCritique(a, ctx), C.CRITIQUE_ERROR.UNKNOWN_DIMENSION);
  const b = answer(); b.dimensions[1].dimension = b.dimensions[0].dimension;
  throwsCode(() => C.normalizeCritique(b, ctx), C.CRITIQUE_ERROR.DUPLICATE_DIMENSION);
});

test('C3 numeric beauty scores are refused in every form', () => {
  const withNumber = answer(); withNumber.dimensions[0].score = 8;
  throwsCode(() => C.normalizeCritique(withNumber, ctx), C.CRITIQUE_ERROR.FORBIDDEN_KEY);
  const numeric = answer(); numeric.dimensions[0].evidence = 7;
  throwsCode(() => C.normalizeCritique(numeric, ctx), C.CRITIQUE_ERROR.NUMERIC_VALUE);
  const top = { ...answer(), overall_score: 82 };
  throwsCode(() => C.normalizeCritique(top, ctx), C.CRITIQUE_ERROR.FORBIDDEN_KEY);
  for (const evidence of ['I would rate this 8/10 overall.', 'score: 7 for the layout here', 'It is rated 4 out of 5 by me.']) {
    const a = answer({ PRODUCT_PROMINENCE: { outcome: 'PASS', evidence } });
    throwsCode(() => C.normalizeCritique(a, ctx), C.CRITIQUE_ERROR.NUMERIC_SCORE_IN_TEXT);
  }
  const bool = answer(); bool.dimensions[0].outcome = true;
  throwsCode(() => C.normalizeCritique(bool, ctx), C.CRITIQUE_ERROR.NUMERIC_VALUE);
});

test('C3 provider, model, prompt and key fields cannot enter the canonical critique', () => {
  for (const key of ['model', 'provider', 'prompt', 'api_key', 'request_id', 'usage', 'seed']) {
    const a = answer(); a.dimensions[0][key] = 'x';
    throwsCode(() => C.normalizeCritique(a, ctx), C.CRITIQUE_ERROR.FORBIDDEN_KEY);
  }
  const critique = C.normalizeCritique(answer(), ctx);
  assert.doesNotMatch(JSON.stringify(critique), /fake-model|alibaba|qwen|api[_-]?key|prompt/i);
});

test('C3 the critic cannot approve publication: approval fields are refused and the production status stays awaiting the owner', () => {
  for (const key of ['approved', 'publish', 'ship', 'owner_approved']) {
    const a = answer(); a.dimensions[0][key] = 'yes';
    throwsCode(() => C.normalizeCritique(a, ctx), C.CRITIQUE_ERROR.FORBIDDEN_KEY);
  }
  const critique = C.normalizeCritique(answer(), ctx);
  const verdict = C.finalizeVerdict({ critique, deterministic: { preflight: 'PASS', fidelity: 'PASS', guardian: 'PASS' } });
  assert.equal(verdict.creative_status, 'CREATIVE_PASS');
  assert.equal(verdict.production_status, 'AWAITING_OWNER_APPROVAL');
  assert.equal(verdict.owner_approval, 'PENDING');
  assert.notEqual(verdict.production_status, 'OWNER_APPROVED');
});

test('C3 the critic never overrides a deterministic FAIL', () => {
  const critique = C.normalizeCritique(answer(), ctx); // every dimension PASS
  for (const gate of ['preflight', 'fidelity', 'guardian']) {
    const v = C.finalizeVerdict({ critique, deterministic: { preflight: 'PASS', fidelity: 'PASS', guardian: 'PASS', [gate]: 'FAIL' } });
    assert.equal(v.technically_eligible, false);
    assert.equal(v.production_status, 'BLOCKED_BY_A_DETERMINISTIC_GATE');
    assert.deepEqual(v.deterministic_blockers, [{ gate: gate === 'guardian' ? 'brand_guardian' : gate, outcome: 'FAIL' }]);
  }
  // a gate that was not evaluated is not a pass
  const v = C.finalizeVerdict({ critique, deterministic: { preflight: 'PASS', fidelity: 'PASS' } });
  assert.equal(v.technically_eligible, false);
  assert.deepEqual(v.deterministic_blockers, [{ gate: 'brand_guardian', outcome: 'NOT_EVALUATED' }]);
});

test('C3 the creative status is computed by Nordla: FAIL > REVIEW_REQUIRED > NOT_MEASURABLE > PASS, and an inconsistent overall PASS is flagged', () => {
  const g = { preflight: 'PASS', fidelity: 'PASS', guardian: 'PASS' };
  const status = (over) => C.finalizeVerdict({ critique: C.normalizeCritique(answer(over), ctx), deterministic: g });
  assert.equal(status({}).creative_status, 'CREATIVE_PASS');
  assert.equal(status({ AI_ARTIFACTS: { outcome: 'NOT_MEASURABLE' } }).creative_status, 'NOT_MEASURABLE');
  assert.equal(status({ AI_ARTIFACTS: { outcome: 'NOT_MEASURABLE' }, VISUAL_HIERARCHY: { outcome: 'REVIEW_REQUIRED', evidence: 'The focal point is arguable.', revision_hint: 'Make one focal point clearer.' } }).creative_status, 'REVIEW_REQUIRED');
  const failing = status(fail('VISUAL_HIERARCHY'));
  assert.equal(failing.creative_status, 'CREATIVE_FAIL');
  assert.deepEqual(failing.blockers, ['VISUAL_HIERARCHY']);
  assert.equal(failing.inconsistent_overall, true); // OVERALL_SHIPPABILITY says PASS while another dimension FAILs
});

test('C3 missing visual evidence is NOT_MEASURABLE and the model is not called', async () => {
  let called = 0;
  const critic = C.createCreativeCritic({ vlm: { invoke: async () => { called += 1; return { text: '{}' }; } } });
  const { critique, provenance } = await critic.critique({ candidate: { ref: 'c', png_bytes: new Uint8Array() }, brief });
  assert.equal(called, 0);
  assert.equal(provenance.called, false);
  assert.ok(critique.dimensions.every((d) => d.outcome === 'NOT_MEASURABLE'));
  assert.equal(C.finalizeVerdict({ critique, deterministic: { preflight: 'PASS', fidelity: 'PASS', guardian: 'PASS' } }).creative_status, 'NOT_MEASURABLE');
});

test('C3 a judged dimension with no evidence is refused; an unanswered dimension is NOT_MEASURABLE, never a guessed pass', () => {
  const noEvidence = answer({ PRODUCT_PROMINENCE: { outcome: 'PASS', evidence: '' } });
  throwsCode(() => C.normalizeCritique(noEvidence, ctx), C.CRITIQUE_ERROR.EVIDENCE_MISSING);
  const partial = { dimensions: [{ dimension: 'PRODUCT_PROMINENCE', outcome: 'PASS', evidence: 'The product is the largest element.' }] };
  const critique = C.normalizeCritique(partial, ctx);
  assert.equal(critique.dimensions.filter((d) => d.outcome === 'NOT_MEASURABLE').length, 13);
});

test('C3 provider failure and malformed or non-conforming output become NOT_MEASURABLE with classified provenance (no repair, no pass)', async () => {
  const boom = C.createCreativeCritic({ vlm: { invoke: async () => { throw Object.assign(new Error('x'), { code: 'Throttling', status: 429, requestId: 'rq' }); } } });
  const r1 = await boom.critique({ candidate: { ref: 'c', png_bytes: PNG }, brief });
  assert.ok(r1.critique.dimensions.every((d) => d.outcome === 'NOT_MEASURABLE'));
  assert.deepEqual(r1.provenance.failure, { code: 'Throttling', status: 429, request_id: 'rq' });
  for (const text of ['not json at all', '{"dimensions": "nope"}', JSON.stringify({ ...answer(), score: 9 }), JSON.stringify(answer({ PRODUCT_PROMINENCE: { outcome: 'GREAT', evidence: 'Looks great to me.' } }))]) {
    const r = await C.createCreativeCritic({ vlm: vlmReturning(text) }).critique({ candidate: { ref: 'c', png_bytes: PNG }, brief });
    assert.ok(r.critique.dimensions.every((d) => d.outcome === 'NOT_MEASURABLE'), text);
    assert.ok(r.provenance.rejected?.code || r.provenance.rejected === undefined);
  }
  const fenced = await C.createCreativeCritic({ vlm: vlmReturning(`\`\`\`json\n${JSON.stringify(answer())}\n\`\`\``) }).critique({ candidate: { ref: 'c', png_bytes: PNG }, brief });
  assert.ok(fenced.critique.dimensions.every((d) => d.outcome === 'PASS'));
});

test('C3 the critic is blind: its instruction holds the brief and the dimensions, never a review or an expected answer, and no provider or model', async () => {
  let seen;
  const critic = C.createCreativeCritic({ vlm: { invoke: async (input) => { seen = input; return { text: JSON.stringify(answer()) }; } } });
  await critic.critique({ candidate: { ref: 'c', png_bytes: PNG }, brief });
  assert.equal(seen.images.length, 1);
  assert.equal(seen.images[0].media_type, 'image/png');
  const wire = `${seen.system}\n${seen.user}`;
  for (const d of C.DIMENSIONS) assert.ok(wire.includes(d));
  assert.doesNotMatch(wire, /owner|reject|qwen|alibaba|HABB|title plate|price block|disproportion/i);
});

test('C3 revision requests are semantic: closed intents, hints re-checked, never pixel steering', () => {
  const critique = C.normalizeCritique(answer({ ...fail('PRODUCT_PROMINENCE', 'Let the product take clearly more of the frame.'), ...fail('TEXT_HIERARCHY') }), ctx);
  const rev = C.buildRevisionRequest({ critique, iteration: 1 });
  assert.deepEqual(rev.intents.map((i) => i.intent), ['INCREASE_PRODUCT_DOMINANCE', 'CLARIFY_TEXT_HIERARCHY']);
  assert.ok(rev.intents.every((i) => Object.values(C.REVISION_INTENT).includes(i.intent)));
  assert.doesNotMatch(JSON.stringify(rev), /\bx\s*=|\d+\s*px|font-size|#[0-9a-f]{6}/i);
  assert.ok(Object.isFrozen(rev));
  // the pixel-level hint is refused at normalization
  for (const hint of ['Move it to x = 132 on the canvas.', 'Make the title font-size 53 and larger.', 'Make the price 20% smaller than now.', 'Use the colour #c0392b for the plate.', 'Shift it by 40px to the left.']) {
    throwsCode(() => C.normalizeCritique(answer(fail('PRICE_INTEGRATION', hint)), ctx), C.CRITIQUE_ERROR.HINT_NOT_SEMANTIC);
  }
  // and a hint on a PASS dimension is refused
  const bad = answer({ PRODUCT_PROMINENCE: { outcome: 'PASS', evidence: 'The product is clearly the hero.', revision_hint: 'Make it even bigger overall.' } });
  throwsCode(() => C.normalizeCritique(bad, ctx), C.CRITIQUE_ERROR.HINT_NOT_SEMANTIC);
  // nothing asks for a revision on a pass
  assert.equal(C.buildRevisionRequest({ critique: C.normalizeCritique(answer(), ctx), iteration: 1 }), null);
});

test('C3 pairwise: per-dimension preferences with evidence, Nordla derives the overall answer, no score', async () => {
  const pair = (overrides, aEligible = true, bEligible = true) => C.createPairwiseComparer({
    vlm: vlmReturning({ dimensions: C.DIMENSIONS.map((dimension) => ({ dimension, preference: 'NONE', evidence: 'No clear difference between them.', ...(overrides[dimension] ?? {}) })) }),
  }).compare({ a: { ref: 'a', png_bytes: PNG, eligible: aEligible }, b: { ref: 'b', png_bytes: PNG2, eligible: bEligible }, brief });
  const prefer = (p) => ({ preference: p, evidence: 'One is clearly more convincing here.' });
  const favourB = Object.fromEntries(['PRODUCT_PROMINENCE', 'VISUAL_HIERARCHY', 'TEXT_HIERARCHY', 'OVERALL_SHIPPABILITY'].map((d) => [d, prefer('B')]));
  assert.equal((await pair(favourB)).comparison.status, 'PREFER_B');
  assert.equal((await pair({ PRODUCT_PROMINENCE: prefer('A'), VISUAL_HIERARCHY: prefer('A'), TEXT_HIERARCHY: prefer('A') })).comparison.status, 'PREFER_A');
  assert.equal((await pair({ PRODUCT_PROMINENCE: prefer('A') })).comparison.status, 'NO_CLEAR_PREFERENCE'); // margin below the decisive margin
  assert.equal((await pair({ PRODUCT_PROMINENCE: prefer('A'), VISUAL_HIERARCHY: prefer('A'), TEXT_HIERARCHY: prefer('A'), OVERALL_SHIPPABILITY: prefer('B') })).comparison.status, 'NO_CLEAR_PREFERENCE'); // overall contradicts the count
  const notEligible = await pair(favourB, true, false);
  assert.equal(notEligible.comparison.status, 'NOT_MEASURABLE');
  assert.equal(notEligible.provenance.called, false);
  const comparison = (await pair(favourB)).comparison;
  assert.doesNotMatch(JSON.stringify(comparison), /score|rating|winner_score|confidence/i);
  const mostlyUnknown = await pair(Object.fromEntries(C.DIMENSIONS.slice(0, 8).map((d) => [d, { preference: 'NOT_MEASURABLE', evidence: 'Cannot compare.' }])));
  assert.equal(mostlyUnknown.comparison.status, 'NOT_MEASURABLE');
  // a numeric score, a winner key or a missing evidence is refused (no preference is invented)
  const scored = await C.createPairwiseComparer({ vlm: vlmReturning({ dimensions: [{ dimension: 'PRODUCT_PROMINENCE', preference: 'A', evidence: 'A scores 8/10 on this one.' }] }) }).compare({ a: { ref: 'a', png_bytes: PNG, eligible: true }, b: { ref: 'b', png_bytes: PNG2, eligible: true }, brief });
  assert.equal(scored.comparison.status, 'NOT_MEASURABLE');
});

const candidateOf = (ref, bytes, gates = { preflight: 'PASS', fidelity: 'PASS', guardian: 'PASS' }) => ({ ref, png_bytes: bytes, deterministic: gates, provenance: { by: 'test' } });
const failingCritic = () => C.createCreativeCritic({ vlm: vlmReturning(answer(fail('VISUAL_HIERARCHY'))) });

test('C3 the loop is bounded: at most 3 candidates, whatever the caller asks', async () => {
  let produced = 0;
  const run = (maxCandidates) => C.runCreativeLoop({
    critic: failingCritic(), brief, initial: candidateOf('c1', PNG), maxCandidates,
    authorizeRevision: async () => true,
    produce: async ({ iteration }) => { produced += 1; return candidateOf(`c${iteration}`, new Uint8Array([...PNG, iteration])); },
  });
  await assert.rejects(() => run(4), RangeError);
  const result = await run(3);
  assert.equal(result.candidates_produced, 3);
  assert.equal(produced, 2);
  assert.equal(result.stop_reason, 'MAX_CANDIDATES_REACHED');
  assert.equal(result.iterations[2].revision_request, null); // no revision is requested after the last candidate
  assert.equal(C.MAX_CANDIDATES, 3);
});

test('C3 a revision cycle needs an explicit human authorization; without it the loop stops after the first critique', async () => {
  let produced = 0;
  const base = { critic: failingCritic(), brief, initial: candidateOf('c1', PNG), produce: async () => { produced += 1; return candidateOf('c2', PNG2); } };
  for (const authorizeRevision of [undefined, async () => false, async () => 'yes', async () => undefined]) {
    const result = await C.runCreativeLoop({ ...base, authorizeRevision });
    assert.equal(result.stop_reason, 'REVISION_NOT_AUTHORIZED');
    assert.equal(result.candidates_produced, 1);
  }
  assert.equal(produced, 0);
});

test('C3 every iteration records hash, provenance, critique, revision request and the deterministic results; the owner stays external', async () => {
  const result = await C.runCreativeLoop({
    critic: failingCritic(), brief, initial: candidateOf('c1', PNG), maxCandidates: 2, authorizeRevision: async () => true, produce: async () => candidateOf('c2', PNG2),
  });
  const first = result.iterations[0];
  assert.equal(first.candidate_sha256, sha(PNG));
  assert.deepEqual(first.candidate_provenance, { by: 'test' });
  assert.equal(first.critic_provenance.model, 'fake-model');
  assert.equal(first.critique.candidate_sha256, sha(PNG));
  assert.deepEqual(first.deterministic, { preflight: 'PASS', fidelity: 'PASS', guardian: 'PASS' });
  assert.equal(first.revision_request.iteration, 1);
  assert.equal(result.owner_approval, 'PENDING');
  assert.equal(result.production_status, 'AWAITING_OWNER_APPROVAL');
  assert.equal(result.iterations[1].candidate_sha256, sha(PNG2));
});

test('C3 a CREATIVE_PASS stops the loop and still is not an approval; a deterministic FAIL keeps the candidate blocked', async () => {
  const passing = C.createCreativeCritic({ vlm: vlmReturning(answer()) });
  const ok = await C.runCreativeLoop({ critic: passing, brief, initial: candidateOf('c1', PNG) });
  assert.equal(ok.stop_reason, 'CREATIVE_PASS_AWAITING_OWNER');
  assert.equal(ok.owner_approval, 'PENDING');
  const blocked = await C.runCreativeLoop({ critic: passing, brief, initial: candidateOf('c1', PNG, { preflight: 'PASS', fidelity: 'FAIL', guardian: 'PASS' }) });
  assert.equal(blocked.production_status, 'BLOCKED_BY_A_DETERMINISTIC_GATE');
  assert.equal(blocked.iterations[0].verdict.technically_eligible, false);
});

test('C3 a failed production is recorded and ends the loop', async () => {
  const result = await C.runCreativeLoop({ critic: failingCritic(), brief, initial: candidateOf('c1', PNG), authorizeRevision: async () => true, produce: async () => ({ failed: { code: 'PREFLIGHT_FAIL' } }) });
  assert.equal(result.stop_reason, 'PRODUCTION_FAILED');
  assert.equal(result.iterations.at(-1).production_failure.code, 'PREFLIGHT_FAIL');
});

test('C3 owner review is evidence after the fact: comparison per dimension, status copied from the owner record only', () => {
  const critique = C.normalizeCritique(answer({
    ...fail('TEXT_HIERARCHY'), PRICE_INTEGRATION: { outcome: 'REVIEW_REQUIRED', evidence: 'The price block is arguable.', revision_hint: 'Integrate the price more calmly.' },
  }), { candidate_ref: 'c', candidate_sha256: sha(PNG) });
  const owner = {
    kind: 'OWNER_REVIEW', recorded_by: 'owner', status: 'OWNER_REJECTED', candidate_sha256: sha(PNG),
    dimensions: [
      { dimension: 'TEXT_HIERARCHY', owner_view: 'FAIL' }, { dimension: 'PRICE_INTEGRATION', owner_view: 'FAIL' },
      { dimension: 'PRODUCT_PROMINENCE', owner_view: 'FAIL' }, { dimension: 'AI_ARTIFACTS', owner_view: 'NOT_STATED' },
    ],
  };
  const cmp = compareWithOwner({ critique, ownerReview: owner });
  const row = (d) => cmp.rows.find((r) => r.dimension === d).agreement;
  assert.equal(row('TEXT_HIERARCHY'), AGREEMENT.AGREE);
  assert.equal(row('PRICE_INTEGRATION'), AGREEMENT.PARTIAL);
  assert.equal(row('PRODUCT_PROMINENCE'), AGREEMENT.DISAGREE);
  assert.equal(row('AI_ARTIFACTS'), AGREEMENT.NOT_COMPARED);
  assert.equal(cmp.owner_status, 'OWNER_REJECTED');
  assert.throws(() => assertOwnerReview({ ...owner, recorded_by: 'nordla' }), TypeError);
  assert.throws(() => compareWithOwner({ critique, ownerReview: { ...owner, candidate_sha256: sha(PNG2) } }), /same candidate/);
  // the critic and the loop never import the owner review
  assert.equal('compareWithOwner' in C, false);
});

test('C3 vision port: scoped clearance for exact bytes, one call, no secret in the journal or the error, provider stays at adapter level', async () => {
  const authz = {
    kind: 'EXTERNAL_MEDIA_AUTHORIZATION', authorization_id: 'authz://t', purpose_note: 'x',
    asset: { asset_ref: 'asset://src', asset_sha256: 'a'.repeat(64), data_class: 'MERCHANT_PRIVATE_MEDIA', contains_personal_data: false, contains_face: false },
    provider: { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1' }, purpose: 'P', allowed_operations: ['IMAGE_EDIT', 'VISION_CRITIQUE'],
    transmissible: 'THE_SOURCE_ASSET_AND_IMAGES_DERIVED_FROM_IT_FOR_THIS_PURPOSE_ONLY',
    retention: { standard_inference_retention_days_max: 30, zdr_status: 'NOT_CONFIRMED', zdr_claimed: false, zdr_evidence_ref: null, acknowledged: true },
    authorization: { revoked: false }, state: {}, global_policy: { changed_by_this_record: false },
  };
  const config = { apiKey: 'sk-test-1234567890abcdef', workspaceId: 'ws0123456789abcd', region: 'eu-central-1', textModel: 'qwen3.8-max', imageModel: 'qwen-image-3.0-pro', videoModel: 'wan3.0-video', requestTimeoutMs: 1000 };
  const candidateAuthz = deriveCandidateAuthorization({ authorization: authz, source_asset_sha256: 'a'.repeat(64), candidate_ref: 'cand:1', candidate_sha256: sha(PNG) });
  assert.throws(() => deriveCandidateAuthorization({ authorization: { ...authz, transmissible: 'NOTHING' }, source_asset_sha256: 'a'.repeat(64), candidate_ref: 'c', candidate_sha256: sha(PNG) }), /NOT_AUTHORIZED/);
  assert.throws(() => deriveCandidateAuthorization({ authorization: authz, source_asset_sha256: 'b'.repeat(64), candidate_ref: 'c', candidate_sha256: sha(PNG) }), /NOT_AUTHORIZED/);
  const journal = []; const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'req-1', choices: [{ message: { content: JSON.stringify(answer()) } }], usage: { prompt_tokens: 3000, completion_tokens: 800 } }) };
  };
  const make = (over = {}) => createQwenVisionPort({
    config, budget: new SpendGuard({ maxSpendEur: 0.5, maxImages: 0 }), journal: { append: async (e) => journal.push(e) }, authorization: candidateAuthz, purpose: 'P', assetRefFor: () => 'cand:1', fetchImpl, ...over,
  });
  const port = make();
  const reply = await port.invoke({ system: 's', user: 'u', images: [{ label: 'candidate', media_type: 'image/png', bytes: PNG }] });
  assert.equal(reply.request_id, 'req-1');
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].url, /eu-central-1\.maas\.aliyuncs\.com/);
  assert.equal(bodies[0].body.messages[1].content[0].type, 'image_url');
  assert.ok(bodies[0].body.messages[1].content[0].image_url.url.startsWith('data:image/png;base64,'));
  assert.doesNotMatch(JSON.stringify(journal), /sk-test|base64|data:image/);
  await assert.rejects(() => port.invoke({ system: 's', user: 'u', images: [{ label: 'candidate', media_type: 'image/png', bytes: PNG }] }), /at most 1/);
  // other bytes are not cleared
  await assert.rejects(() => make().invoke({ system: 's', user: 'u', images: [{ label: 'candidate', media_type: 'image/png', bytes: PNG2 }] }), /NOT_AUTHORIZED/);
  assert.equal(bodies.length, 1);
  // a provider failure never leaks the key
  const leaky = make({ fetchImpl: async () => { throw new Error('failed with Bearer sk-test-1234567890abcdef'); } });
  await assert.rejects(() => leaky.invoke({ system: 's', user: 'u', images: [{ label: 'candidate', media_type: 'image/png', bytes: PNG }] }), (e) => !/sk-test-1234567890abcdef/.test(e.message));
  assert.doesNotMatch(JSON.stringify(journal), /sk-test-1234567890abcdef/);
});

test('C3 a REVIEW_REQUIRED dimension also asks for a revision, and a revision request re-checks every hint on its own', () => {
  const critique = C.normalizeCritique(answer({ WHITESPACE_BALANCE: { outcome: 'REVIEW_REQUIRED', evidence: 'The margins are arguable here.', revision_hint: 'Give the elements calmer breathing room.' } }), ctx);
  const rev = C.buildRevisionRequest({ critique, iteration: 1 });
  assert.deepEqual(rev.intents.map((i) => [i.intent, i.outcome]), [['REBALANCE_WHITESPACE', 'REVIEW_REQUIRED']]);
  // a critique object built by hand (not through the trust boundary) cannot smuggle a pixel instruction into a revision request
  const forged = { ...critique, dimensions: critique.dimensions.map((d) => (d.dimension === 'WHITESPACE_BALANCE' ? { ...d, revision_hint: 'Set the margin to 40px on every side.' } : d)) };
  throwsCode(() => C.buildRevisionRequest({ critique: forged, iteration: 1 }), C.CRITIQUE_ERROR.HINT_NOT_SEMANTIC);
});

test('C3 pairwise: a score hidden in the evidence rejects the whole comparison (no preference is kept)', async () => {
  const dims = C.DIMENSIONS.map((dimension) => ({ dimension, preference: 'B', evidence: 'B is clearly more convincing here.' }));
  dims[0].evidence = 'B is better, about 8/10 against 5/10.';
  const r = await C.createPairwiseComparer({ vlm: vlmReturning({ dimensions: dims }) }).compare({ a: { ref: 'a', png_bytes: PNG, eligible: true }, b: { ref: 'b', png_bytes: PNG2, eligible: true }, brief });
  assert.equal(r.comparison.status, 'NOT_MEASURABLE');
  assert.equal(r.provenance.rejected.code, C.CRITIQUE_ERROR.NUMERIC_SCORE_IN_TEXT);
});

test('C3 vision port: an authorization that does not cover VISION_CRITIQUE, this purpose or this region refuses before any request', async () => {
  const authz = {
    kind: 'EXTERNAL_MEDIA_AUTHORIZATION', authorization_id: 'authz://t', purpose_note: 'x',
    asset: { asset_ref: 'cand:1', asset_sha256: sha(PNG), data_class: 'MERCHANT_PRIVATE_MEDIA', contains_personal_data: false, contains_face: false },
    provider: { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1' }, purpose: 'P', allowed_operations: ['IMAGE_EDIT'],
    transmissible: 'THE_SOURCE_ASSET_AND_IMAGES_DERIVED_FROM_IT_FOR_THIS_PURPOSE_ONLY',
    retention: { standard_inference_retention_days_max: 30, zdr_status: 'NOT_CONFIRMED', zdr_claimed: false, zdr_evidence_ref: null, acknowledged: true },
    authorization: { revoked: false }, state: {}, global_policy: { changed_by_this_record: false },
  };
  const config = { apiKey: 'sk-test-1234567890abcdef', workspaceId: 'ws0123456789abcd', region: 'eu-central-1', textModel: 'qwen3.8-max', imageModel: 'qwen-image-3.0-pro', videoModel: 'wan3.0-video', requestTimeoutMs: 1000 };
  let sent = 0;
  const attempt = (authorization, purpose = 'P') => createQwenVisionPort({ config, budget: new SpendGuard({ maxSpendEur: 0.5, maxImages: 0 }), authorization, purpose, assetRefFor: () => 'cand:1', fetchImpl: async () => { sent += 1; return { ok: true, status: 200, text: async () => '{}' }; } })
    .invoke({ system: 's', user: 'u', images: [{ label: 'candidate', media_type: 'image/png', bytes: PNG }] });
  await assert.rejects(() => attempt(authz), /OPERATION_NOT_AUTHORIZED/);
  await assert.rejects(() => attempt({ ...authz, allowed_operations: ['VISION_CRITIQUE'] }, 'OTHER'), /PURPOSE_NOT_AUTHORIZED/);
  await assert.rejects(() => attempt({ ...authz, allowed_operations: ['VISION_CRITIQUE'], authorization: { revoked: true } }), /REVOKED/);
  assert.equal(sent, 0);
});
