import test from 'node:test';
import assert from 'node:assert/strict';

import { createDecisionLedger } from '../src/creative-runtime/ledger.js';
import { createCopyAdapter, createCopyWriter, stripSpace } from '../src/creative-planning/index.js';
import {
  auditDiversity, createAssetDirector, createCampaignBudget, createMemoryCheckpointStore, DENSITY_CLASS, dependentsOf, DEV_CAMPAIGN_CEILING_EUR, NODE,
} from '../src/creative-campaign/index.js';
import {
  assetAnswer, campaignBrief, campaignPort, campaignRequest, fullScript, makeCampaign, proofFact,
} from './creative-campaign-world.js';
import { longText, scriptedCopyPort } from './creative-planning-world.js';

// THE CAMPAIGN PLANNER (`// CC-N` markers): one objective, one shared frame, concept and art direction, N individually purposeful assets, a continuity contract, a diversity report, a bounded budget, and a
// working state that resumes and invalidates by dependency. No provider: every model is a scripted fake.

const plan = async (over = {}, deps = {}) => {
  const world = makeCampaign({ script: await fullScript(deps.script ?? {}), ...deps });
  const result = await world.planner.plan({ brief: campaignBrief(), request: campaignRequest(over), options: deps.options ?? {} });
  return { ...world, result };
};
const textsOf = (assets) => assets.flatMap((a) => a.copy.map((s) => s.text));

test('CC-1 a 5-slide carousel from one brief: five purposeful assets sharing one idea', async () => {
  const { result, port } = await plan({ requested_asset_count: 5, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: longText(120, 4) }] });
  assert.equal(result.status, 'PLANNED'); assert.equal(result.campaign_plan.lanes[0].format_kind, 'CAROUSEL');
  assert.equal(result.asset_plans.length, 5); assert.equal(result.campaign_plan.asset_plan_ids.length, 5);
  assert.equal(result.campaign_plan.executable, false);
  assert.ok(result.asset_plans.every((a) => a.execution.status === 'PLANNED_NOT_EXECUTABLE' && a.execution.reasons.includes('MULTI_ASSET_PRODUCTION_NOT_AVAILABLE')));
  assert.equal(port.count('asset'), 5);
});

test('CC-2 a 7-slide carousel from a long (about 300 words) brief, without TEXT_DOES_NOT_FIT', async () => {
  const text = longText(300, 5);
  const { result } = await plan({ requested_asset_count: 7, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text }] });
  assert.equal(result.status, 'PLANNED'); assert.equal(result.asset_plans.length, 7);
  assert.ok(!JSON.stringify(result).includes('TEXT_DOES_NOT_FIT'));
  assert.ok(result.asset_plans.every((a, i) => i === 0 || a.copy.length > 0), 'every slide after the hook carries copy');
  assert.equal(result.content_plans[0].caption, null, 'all the text is on the slides');
  assert.equal(stripSpace(textsOf(result.asset_plans).join('')), stripSpace(text), 'the locked copy recombines exactly to the source');
});

test('CC-3 one shared frame, concept and art direction: every asset carries the same ids, and the shared stages run once', async () => {
  const { result, port } = await plan({ requested_asset_count: 6 });
  const c = result.campaign_plan;
  for (const a of result.asset_plans) {
    assert.equal(a.shared.concept_id, c.concept_id); assert.equal(a.shared.art_direction_id, c.art_direction_id); assert.equal(a.shared.frame_id, c.frame_id); assert.equal(a.shared.continuity_id, c.continuity_id);
  }
  assert.deepEqual(['frame', 'ideate', 'select', 'art_direct'].map((s) => port.count(s)), [1, 1, 1, 1]);
  assert.equal(result.shared.concept.concept_id, c.concept_id); assert.match(c.campaign_id, /^cmp_/);
});

test('CC-4 every asset plan is individually purposeful: its own id, role, look, imagery and copy', async () => {
  const { result } = await plan({ requested_asset_count: 7 });
  const a = result.asset_plans;
  assert.equal(new Set(a.map((x) => x.asset_plan_id)).size, 7);
  assert.equal(new Set(a.map((x) => x.imagery_brief)).size, 7, 'a different imagery brief for each');
  assert.ok(new Set(a.map((x) => x.narrative_role)).size >= 3);
  for (let i = 1; i < a.length; i += 1) assert.notEqual(`${a[i].composition_intent}/${a[i].imagery_intent}`, `${a[i - 1].composition_intent}/${a[i - 1].imagery_intent}`, `asset ${i} does not repeat the look of asset ${i - 1}`);
  assert.equal(a[0].narrative_role, 'HOOK'); assert.equal(a[0].density.density_class, 'LOW');
  assert.ok(a.every((x) => x.imagery_brief_source === 'MODEL' && x.imagery_brief && !/[0-9]/.test(x.imagery_brief)));
  assert.ok(Object.isFrozen(result.campaign_plan) && Object.isFrozen(a[0]));
});

test('CC-5 the diversity report prevents a repeated template, and detects one when it exists', async () => {
  const { result } = await plan({ requested_asset_count: 9 });
  const d = result.campaign_plan.lanes[0].diversity;
  assert.equal(d.passed, true); assert.ok(d.distinct_pairs >= 5); assert.ok(d.max_consecutive_same_pair <= 1);
  const same = Array.from({ length: 5 }, (_, i) => ({
    narrative_role: 'PROGRESSION', composition_intent: 'SPLIT_PANEL', imagery_intent: 'PRODUCT_DETAIL', density: { density_class: 'HIGH' }, copy: [{ text: `Text ${i}` }],
  }));
  const bad = auditDiversity(same);
  assert.equal(bad.passed, false); assert.deepEqual(bad.rules.filter((r) => !r.passed).map((r) => r.id).sort(), ['NOT_ONE_TEMPLATE_REPEATED', 'NO_TWO_NEIGHBOURS_SHARE_A_LOOK', 'ROLES_ARE_VARIED']);
  assert.equal(auditDiversity([{ ...same[0], copy: [{ text: 'x' }] }, { ...same[1], composition_intent: 'CLOSE_CROP', copy: [{ text: 'x' }] }]).rules.find((r) => r.id === 'NO_COPY_IS_REPEATED_ON_TWO_ASSETS').passed, false);
  // a person who forces the same role on ten assets is told that the look repeats
  const hints = Array.from({ length: 10 }, (_, index) => ({ index, narrative_role: 'PROGRESSION' }));
  const forced = await plan({ requested_asset_count: 10 }, { options: { asset_hints: hints } });
  assert.ok(forced.result.questions.some((q) => q.code === 'CAMPAIGN_LOOKS_REPEATED' && q.blocking === false));
});

test('CC-6 density classes reason about the slide, not only the characters: a hook says little, a text-led slide says a lot, nothing is truncated', async () => {
  const text = longText(300, 5);
  const { result } = await plan({ requested_asset_count: 7, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text }] });
  const classes = result.asset_plans.map((a) => a.density.density_class);
  assert.equal(classes[0], DENSITY_CLASS.LOW);
  assert.ok(classes.slice(1).every((c) => c === 'HIGH' || c === 'TEXT_LED' || c === 'MEDIUM'));
  assert.equal(stripSpace(textsOf(result.asset_plans).join('')), stripSpace(text), 'nothing was cut');
  const light = await plan({ requested_asset_count: 9, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: longText(300, 5) }] });
  const spread = light.result.asset_plans.map((a) => a.density.chars);
  assert.ok(Math.max(...spread.slice(1)) < 1.6 * Math.min(...spread.slice(1)), 'the text is spread evenly, not piled on the first slides');
  const hookRoles = result.asset_plans.filter((a) => a.narrative_role === 'HOOK');
  assert.ok(hookRoles.every((a) => a.density.density_class === 'LOW'), 'a hook is light');
  // a smaller density class is preferred when it holds all the text on the slides, a heavier one only when needed
  const few = await plan({ requested_asset_count: 4, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: longText(60, 3) }] });
  assert.equal(few.result.content_plans[0].caption, null); assert.equal(few.result.campaign_plan.lanes[0].slide_density, 'MEDIUM');
  const heavy = await plan({ requested_asset_count: 6, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: longText(300, 5) }] });
  assert.ok(['HIGH', 'TEXT_LED'].includes(heavy.result.campaign_plan.lanes[0].slide_density));
});

test('CC-7 adaptable copy changes only under policy; locked copy never does', async () => {
  const long = 'Un titre très long qui dépasse largement l’espace prévu pour un titre sur une image, parce qu’il raconte presque toute l’histoire de l’atelier.';
  const adapt = scriptedCopyPort('adapt', [{ text: 'L’histoire de l’atelier en un titre', rationale: 'Shortened.' }]);
  const body = longText(120, 4);
  const adaptable = await plan({ requested_asset_count: 5, copy: [{ copy_ref: 'copy://head', mode: 'COPY_ADAPTABLE', role: 'HEADLINE', text: long }, { copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: body }] }, { copyPorts: { copyAdapter: createCopyAdapter({ complete: adapt.complete }) } });
  assert.equal(adapt.calls.length, 1);
  const pieces = adaptable.result.content_plans[0].assets.flatMap((a) => a.slots.flatMap((s) => s.pieces));
  assert.ok(pieces.filter((p) => p.unit_ref === 'copy://head').every((p) => p.origin === 'ADAPTED'));
  assert.ok(pieces.filter((p) => p.unit_ref === 'copy://body').every((p) => p.origin === 'LOCKED'));
  assert.equal(stripSpace(pieces.filter((p) => p.unit_ref === 'copy://body').map((p) => p.text).join('')), stripSpace(body));
  const refused = scriptedCopyPort('adapt', [{ text: 'Titre à 30 €', rationale: 'x' }]);
  const kept = await plan({ requested_asset_count: 5, copy: [{ copy_ref: 'copy://head', mode: 'COPY_ADAPTABLE', role: 'HEADLINE', text: `${long} 25 €` }, { copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: body }] }, { copyPorts: { copyAdapter: createCopyAdapter({ complete: refused.complete }) } });
  assert.ok(kept.result.content_plans[0].events.some((e) => e.kind === 'ADAPTATION_REFUSED'), 'a refused adaptation leaves the text as written');
});

test('CC-8 generated copy comes from verified facts only', async () => {
  const good = scriptedCopyPort('write', [{ text: 'Coques personnalisées, prêtes en cinq minutes', uses_fact_refs: ['fact://descr'], rationale: 'From the fact.' }]);
  const gen = [{ copy_ref: 'copy://gen', mode: 'COPY_GENERATABLE', purpose: 'HEADLINE' }, { copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: longText(100, 3) }];
  const ok = await plan({ requested_asset_count: 5, copy: gen, facts: [(await import('./creative-planning-world.js')).fact()] }, { copyPorts: { copyWriter: createCopyWriter({ complete: good.complete }) } });
  assert.equal(ok.result.status, 'PLANNED');
  const generated = ok.result.content_plans[0].assets.flatMap((a) => a.slots.flatMap((s) => s.pieces)).filter((p) => p.origin === 'GENERATED');
  assert.equal(generated.length, 1);
  const invented = scriptedCopyPort('write', [{ text: 'La meilleure coque à 19 €', uses_fact_refs: ['fact://descr'], rationale: 'x' }]);
  const bad = await plan({ requested_asset_count: 5, copy: gen, facts: [(await import('./creative-planning-world.js')).fact()] }, { copyPorts: { copyWriter: createCopyWriter({ complete: invented.complete }) } });
  assert.ok(bad.result.content_plans[0].events.some((e) => e.kind === 'GENERATION_FAILED'));
  assert.ok(bad.result.asset_plans.some((a) => a.execution.reasons.includes('COPY_NOT_YET_GENERATED')), 'a failed generation is pending, never invented');
});

test('CC-9 a campaign resumes from an intermediate checkpoint: stored nodes are not recomputed', async () => {
  const store = createMemoryCheckpointStore();
  const broken = { ...(await fullScript()), art_direct: [new Error('provider down')] };
  const first = makeCampaign({ script: broken, store });
  await assert.rejects(first.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 5 }) }), /provider down|port failed/i);
  const saved = store.peek();
  assert.deepEqual(Object.keys(saved.nodes).sort(), ['CONCEPT', 'CONTENT_PLAN', 'FRAME']);
  assert.ok(saved.nodes.FRAME.status === 'DONE' && !saved.nodes.ART_DIRECTION);
  const second = makeCampaign({ script: { ...(await fullScript()), frame: [], ideate: [], select: [] }, store });
  const resumed = await second.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 5 }) });
  assert.equal(resumed.status, 'PLANNED');
  assert.deepEqual(resumed.reused, ['CONTENT_PLAN', 'FRAME', 'CONCEPT']);
  assert.equal(second.port.count('frame') + second.port.count('ideate') + second.port.count('select'), 0, 'the stored stages were not asked again');
  assert.equal(second.port.count('art_direct'), 1); assert.equal(second.port.count('asset'), 5);
  // the resumed plan equals the plan of an uninterrupted run
  const clean = await plan({ requested_asset_count: 5 });
  assert.equal(resumed.campaign_plan.campaign_id, clean.result.campaign_plan.campaign_id);
});

test('CC-10 an asset whose brief failed is degraded, the campaign goes on, and only that asset is redone on the next run', async () => {
  const store = createMemoryCheckpointStore();
  const script = await fullScript();
  script.asset = (i) => (i === 2 ? Object.assign(new Error('boom'), { code: 'UPSTREAM' }) : assetAnswer(i));
  const first = makeCampaign({ script, store });
  const run1 = await first.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 5 }) });
  assert.equal(run1.status, 'PLANNED');
  const degraded = run1.asset_plans.filter((a) => a.imagery_brief_source === 'INTENT_ONLY');
  assert.equal(degraded.length, 1); assert.equal(degraded[0].index, 2); assert.equal(degraded[0].imagery_failure_code, 'BRAIN_PORT_FAILED');
  assert.ok(!JSON.stringify(run1).includes('boom'), 'no message of a failure is kept');
  const second = makeCampaign({ script: { ...(await fullScript()), frame: [], ideate: [], select: [], art_direct: [], asset: [assetAnswer(2)] }, store });
  const run2 = await second.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 5 }) });
  assert.deepEqual(run2.executed, ['ASSET_PLAN:L0:2']); assert.equal(second.port.count('asset'), 1);
  assert.ok(run2.asset_plans.every((a) => a.imagery_brief_source === 'MODEL'));
});

test('CC-11 changing one slide-level input recomputes only the work that depends on it', async () => {
  const store = createMemoryCheckpointStore();
  const first = makeCampaign({ script: await fullScript(), store });
  const run1 = await first.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 6 }) });
  const again = makeCampaign({ script: { frame: [], ideate: [], select: [], art_direct: [], asset: [] }, store });
  const noChange = await again.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 6 }) });
  assert.deepEqual(noChange.executed, []); assert.equal(again.port.calls.length, 0); assert.equal(noChange.campaign_plan.campaign_id, run1.campaign_plan.campaign_id);
  const second = makeCampaign({ script: { frame: [], ideate: [], select: [], art_direct: [], asset: [assetAnswer(9)] }, store });
  const changed = await second.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 6 }), options: { asset_hints: [{ index: 3, imagery_hint: 'show the product in a hand' }] } });
  assert.deepEqual(changed.executed, ['ASSET_PLAN:L0:3']); assert.equal(second.port.calls.length, 1);
  assert.deepEqual([...changed.reused].sort(), ['ASSET_PLAN:L0:0', 'ASSET_PLAN:L0:1', 'ASSET_PLAN:L0:2', 'ASSET_PLAN:L0:4', 'ASSET_PLAN:L0:5', 'CONCEPT', 'CONTENT_PLAN', 'FRAME', 'ART_DIRECTION'].sort());
  assert.notEqual(changed.asset_plans[3].asset_plan_id, run1.asset_plans[3].asset_plan_id);
  assert.deepEqual(changed.asset_plans.filter((_, i) => i !== 3).map((a) => a.asset_plan_id), run1.asset_plans.filter((_, i) => i !== 3).map((a) => a.asset_plan_id), 'the other assets are the same objects');
  assert.notEqual(changed.campaign_plan.campaign_id, run1.campaign_plan.campaign_id);
});

test('CC-12 changing the campaign audience recomputes the frame, the concept, the art direction and every asset', async () => {
  const store = createMemoryCheckpointStore();
  const first = makeCampaign({ script: await fullScript(), store });
  const run1 = await first.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 5 }) });
  const second = makeCampaign({ script: await fullScript({ audience: 'Des grands-parents qui veulent offrir un souvenir de leurs petits-enfants.' }), store });
  const run2 = await second.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 5, audience: 'Des grands-parents' }) });
  for (const node of ['FRAME', 'CONCEPT', 'ART_DIRECTION']) assert.ok(run2.executed.includes(node), `${node} was recomputed`);
  assert.equal(run2.executed.filter((e) => e.startsWith('ASSET_PLAN')).length, 5, 'every asset was recomputed');
  assert.deepEqual([second.port.count('frame'), second.port.count('ideate'), second.port.count('select'), second.port.count('art_direct'), second.port.count('asset')], [1, 1, 1, 1, 5]);
  assert.notEqual(run2.campaign_plan.frame_id, run1.campaign_plan.frame_id); assert.notEqual(run2.campaign_plan.campaign_id, run1.campaign_plan.campaign_id);
  assert.deepEqual(dependentsOf(NODE.FRAME), ['ART_DIRECTION', 'ASSET_PLAN', 'CAMPAIGN_PLAN', 'CONCEPT']);
  assert.deepEqual(dependentsOf(NODE.ASSET_PLAN), []);
  assert.deepEqual(dependentsOf(NODE.CONTENT_PLAN), ['ART_DIRECTION', 'ASSET_PLAN', 'CAMPAIGN_PLAN', 'CONCEPT', 'FRAME']);
});

test('CC-13 the legacy single-image flow is untouched: a single asset is not a campaign and asks no model', async () => {
  const world = makeCampaign({ script: await fullScript() });
  const out = await world.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_format: 'SINGLE_IMAGE', copy: [{ copy_ref: 'copy://h', mode: 'COPY_LOCKED', role: 'HEADLINE', text: 'Vos souvenirs. Votre création.' }] }) });
  assert.equal(out.status, 'NOT_A_MULTI_ASSET_PLAN'); assert.equal(world.port.calls.length, 0); assert.equal(out.content_plans[0].format.kind, 'SINGLE_IMAGE');
  assert.equal(out.campaign_plan, undefined);
});

test('CC-14 the campaign budget is bounded: reserved before the cost, never past the ceiling', async () => {
  assert.equal(DEV_CAMPAIGN_CEILING_EUR, 2);
  const ok = await plan({ requested_asset_count: 7 });
  const b = ok.result.campaign_plan.budget;
  assert.equal(b.ceiling_eur, 2); assert.equal(b.within_ceiling, true); assert.ok(b.estimated_worst_case_eur <= 2); assert.ok([1, 2, 3].includes(b.environment_candidates_per_asset));
  assert.equal(b.per_asset_eur.length, 7);
  const tight = await plan({ requested_asset_count: 7 }, { ceilingEur: 0.5 });
  assert.equal(tight.result.status, 'NEEDS_USER_DECISION'); assert.deepEqual(tight.result.questions.filter((q) => q.blocking).map((q) => q.code), ['CAMPAIGN_BUDGET_EXCEEDED']);
  assert.equal(tight.result.campaign_plan.budget.within_ceiling, false); assert.equal(tight.result.campaign_plan.budget.environment_candidates_per_asset, 1, 'the cheapest bounded shape was tried');
  const guard = createCampaignBudget({ ceilingEur: 1 });
  guard.reserve('a', 0.6); guard.reserve('b', 0.4);
  assert.throws(() => guard.reserve('c', 0.01), (e) => e.code === 'CAMPAIGN_BUDGET_EXCEEDED' && e.detail.label === 'c');
  assert.equal(guard.reserved_eur(), 1); assert.equal(guard.remaining_eur(), 0);
  assert.throws(() => createCampaignBudget({ ceilingEur: 0 }), RangeError); assert.throws(() => guard.reserve('x', -1), RangeError);
});

test('CC-15 FUZZ: whatever the ceiling and the number of assets, an estimate that fits never passes the ceiling, and a campaign that does not fit is a question', async () => {
  const { chooseProductionEnvelope, estimateCampaignCost, reserveEstimate } = await import('../src/creative-campaign/index.js');
  const mulberry = (seed) => () => { let t = (seed += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = mulberry(11);
  for (let n = 0; n < 300; n += 1) {
    const assets = Array.from({ length: 1 + Math.floor(r() * 10) }, () => ({ canvas: r() > 0.5 ? { width: 1080, height: 1350 } : { width: 800, height: 800 } }));
    const ceiling = Math.round((0.1 + r() * 4) * 100) / 100;
    const envelope = chooseProductionEnvelope({ assets, ceilingEur: ceiling });
    const reservation = reserveEstimate(createCampaignBudget({ ceilingEur: ceiling }), envelope.estimate);
    assert.equal(reservation.ok, envelope.fits, `fuzz ${n}`);
    if (envelope.fits) assert.ok(envelope.estimate.total_eur <= ceiling + 1e-9);
    else assert.equal(envelope.environment_candidates_per_asset, 1, 'the cheapest shape was tried before giving up');
    assert.ok(estimateCampaignCost({ assets, environmentCandidates: 1 }).total_eur <= estimateCampaignCost({ assets, environmentCandidates: 3 }).total_eur);
  }
});

test('CC-16 several channels make a campaign: one shared idea, a lane per channel, a video lane that is only planned', async () => {
  const world = makeCampaign({ script: await fullScript() });
  const out = await world.planner.plan({ brief: campaignBrief(), request: campaignRequest({ channel: undefined, channels: ['INSTAGRAM', 'STORE_WINDOW', 'TIKTOK'], requested_format: undefined, requested_asset_count: undefined, copy: [{ copy_ref: 'copy://h', mode: 'COPY_LOCKED', role: 'HEADLINE', text: 'Vos souvenirs. Votre création.' }] }) });
  assert.equal(out.status, 'PLANNED');
  assert.deepEqual(out.campaign_plan.lanes.map((l) => [l.channel, l.format_kind]), [['INSTAGRAM', 'SINGLE_IMAGE'], ['STORE_WINDOW', 'POSTER'], ['TIKTOK', 'SHORT_VIDEO']]);
  assert.deepEqual(out.campaign_plan.lanes[2].asset_plan_ids, []); assert.deepEqual(out.campaign_plan.lanes[2].execution, { status: 'PLANNED_NOT_EXECUTABLE', reasons: ['VIDEO_PRODUCTION_NOT_AVAILABLE'] });
  assert.equal(out.campaign_plan.lanes[2].diversity, null, 'a video lane has no assets to compare');
  assert.equal(out.asset_plans.length, 2); assert.equal(new Set(out.asset_plans.map((a) => a.shared.concept_id)).size, 1);
  assert.equal(world.port.count('frame'), 1); assert.equal(world.port.count('art_direct'), 1);
  assert.deepEqual(out.asset_plans.map((a) => a.aspect_ratio ?? a.canvas.width / a.canvas.height).length, 2);
});

test('CC-17 the continuity contract states what stays and what varies, and forbids the same slide with other words', async () => {
  const { result } = await plan({ requested_asset_count: 5 });
  const c = result.continuity;
  assert.deepEqual(c.must_stay_consistent.map((m) => m.aspect), ['CAMPAIGN_CONCEPT', 'ART_DIRECTION', 'BRAND_CONSTRAINTS', 'PRODUCT_IDENTITY', 'APPROVED_FACTS', 'VISUAL_LANGUAGE']);
  assert.deepEqual(c.should_vary.map((m) => m.aspect), ['SLIDE_ROLE', 'COMPOSITION', 'IMAGERY', 'CROP_SCALE', 'TEXT_HIERARCHY', 'RHYTHM']);
  assert.equal(c.forbidden_pattern, 'SAME_SLIDE_REPEATED_WITH_DIFFERENT_TEXT'); assert.match(c.continuity_id, /^cnt_/);
  assert.deepEqual(c.must_stay_consistent[0].refs, [result.campaign_plan.concept_id]); assert.deepEqual(c.must_stay_consistent[1].refs, [result.campaign_plan.art_direction_id]);
});

test('CC-18 a brief the Brain cannot frame, or text that cannot be placed, is a question and costs no model call', async () => {
  const world = makeCampaign({ script: await fullScript() });
  const noProduct = campaignBrief(); noProduct.public_facts = {};
  const a = await world.planner.plan({ brief: noProduct, request: campaignRequest({ requested_asset_count: 5 }) });
  assert.equal(a.status, 'NEEDS_USER_DECISION'); assert.ok(a.questions.some((q) => q.code === 'BRIEF_NEEDS_CLARIFICATION')); assert.equal(world.port.calls.length, 0);
  const nothing = await world.planner.plan({ brief: campaignBrief(), request: { request_ref: 'r', channel: 'SOCIAL_FEED', requested_format: 'CAROUSEL', copy: [] } });
  assert.equal(nothing.status, 'NEEDS_USER_DECISION'); assert.ok(nothing.questions.some((q) => q.code === 'NOTHING_TO_SAY')); assert.equal(world.port.calls.length, 0);
});

test('CC-19 the proof role needs verified proof; objective and price shape the roles', async () => {
  const withProof = await plan({ requested_asset_count: 8, facts: [proofFact()] });
  assert.ok(withProof.result.asset_plans.some((a) => a.narrative_role === 'PROOF'));
  assert.deepEqual(withProof.result.asset_plans.find((a) => a.narrative_role === 'PROOF').evidence_fact_refs, ['fact://proof']);
  const noProof = await plan({ requested_asset_count: 8 });
  assert.ok(!noProof.result.asset_plans.some((a) => a.narrative_role === 'PROOF'), 'no proof is claimed without a verified fact');
  const sell = await plan({
    requested_asset_count: 6, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: longText(120, 4) }, { copy_ref: 'copy://price', mode: 'COPY_LOCKED', role: 'PRICE', carrier: 'CLAIM', text: '25 €' }, { copy_ref: 'copy://cta', mode: 'COPY_LOCKED', role: 'CTA', text: 'Commandez' }],
  });
  assert.equal(sell.result.campaign_plan.lanes[0].objective_kind, 'SELL'); assert.equal(sell.result.asset_plans.at(-1).narrative_role, 'OFFER'); assert.equal(sell.result.asset_plans[0].narrative_role, 'HOOK');
});

test('CC-20 the ledger records the campaign decisions with Nordla components, and no copy', async () => {
  const ledger = createDecisionLedger();
  const { result } = await plan({ requested_asset_count: 5 }, { ledger });
  const decisions = new Set(ledger.entries().map((e) => e.decision));
  for (const d of ['CONTENT_ANALYSIS', 'FORMAT_PLAN', 'PROBLEM_FRAME', 'CONCEPT_SELECTION', 'ART_DIRECTION', 'CAMPAIGN_SEQUENCE', 'CONTINUITY_CONTRACT', 'ASSET_PLAN', 'CAMPAIGN_BUDGET', 'CAMPAIGN_CHECKPOINT']) assert.ok(decisions.has(d), d);
  assert.ok(ledger.entries().every((e) => e.decided_by.startsWith('nordla:')));
  assert.equal(ledger.of('ASSET_PLAN').length, 5); assert.equal(ledger.of('FORMAT_PLAN').length, 1, 'exploratory plans are not recorded, the kept one is');
  assert.ok(!JSON.stringify(ledger.entries()).includes('Phrase numéro'));
  assert.equal(result.status, 'PLANNED');
});

test('CC-21 the working state is plain, serializable and deterministic', async () => {
  const a = await plan({ requested_asset_count: 5 });
  const b = await plan({ requested_asset_count: 5 });
  assert.equal(a.result.campaign_plan.campaign_id, b.result.campaign_plan.campaign_id);
  const state = a.store.peek();
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state); assert.equal(state.schema, 'campaign-state@1');
  assert.ok(state.nodes.FRAME.inputs_hash.startsWith('inp_') && state.nodes['ASSET_PLAN:L0:0'].id.startsWith('apl_'));
  assert.equal(state.saves, a.store.saves(), 'one checkpoint per node');
});

test('CC-22 the asset director is optional: without it the assets keep their intents and say so', async () => {
  const { result, port } = await plan({ requested_asset_count: 5 }, { withDirector: false });
  assert.equal(port.count('asset'), 0); assert.ok(result.asset_plans.every((a) => a.imagery_brief === null && a.imagery_brief_source === 'INTENT_ONLY' && a.imagery_failure_code === null));
  assert.equal(result.status, 'PLANNED');
});

test('CC-23 an imagery brief that names the product as something else, or holds a figure, is refused', async () => {
  const bad = [{ imagery_brief: 'A phone on a desk', composition_note: 'Centred', rationale: 'x' }, { imagery_brief: 'The product beside a 40 mm ruler', composition_note: 'Centred', rationale: 'x' }, { imagery_brief: 'Soft light', composition_note: 'A logo on the left', rationale: 'x' }];
  for (const answer of bad) {
    const port = campaignPort({ asset: [answer] });
    await assert.rejects(createAssetDirector({ complete: port.complete }).brief({ concept: (await fullScriptConcept()), artDirection: ART, asset: { position: 1, of: 3, narrative_role: 'HOOK', density_class: 'LOW', composition_intent: 'PRODUCT_CENTERED', imagery_intent: 'PRODUCT_HERO', crop_scale: 'MID', copy: [] } }), (e) => e.code === 'BRAIN_FORBIDDEN_CONTENT' || e.code === 'BRAIN_TEXT_INVALID');
  }
  const good = campaignPort({ asset: [{ imagery_brief: 'The product on a worn counter in soft light', composition_note: 'Centred with room around it', rationale: 'ok' }] });
  const out = await createAssetDirector({ complete: good.complete }).brief({ concept: await fullScriptConcept(), artDirection: ART, asset: { position: 1, of: 3, narrative_role: 'HOOK', density_class: 'LOW', composition_intent: 'PRODUCT_CENTERED', imagery_intent: 'PRODUCT_HERO', crop_scale: 'MID', copy: [] } });
  assert.match(out.imagery_brief, /product/);
});
const ART = { atmosphere: 'A quiet workshop', material_language: 'wood', lighting_intent: 'soft light', depth_model: 'SHALLOW_LAYERS', visual_rhythm: 'MEASURED', realism: 'PHOTOREALISTIC', emotional_temperature: 'WARM' };
async function fullScriptConcept() { const { SAMPLE_CONCEPT } = await import('../src/creative-brain/parity.js'); return SAMPLE_CONCEPT; }

test('CC-24 FUZZ: any number of slides, any length, any density: valid, shared, varied, bounded, verbatim', async () => {
  const mulberry = (seed) => () => { let t = (seed += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = mulberry(2026);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  for (let n = 0; n < 40; n += 1) {
    const words = pick([40, 90, 200, 300, 450]); const paragraphs = pick([2, 4, 6]);
    const count = pick([null, 3, 4, 5, 6, 7, 8, 9, 10]);
    const text = longText(words, paragraphs);
    const world = makeCampaign({ script: await fullScript({ assets: 12 }) });
    const out = await world.planner.plan({ brief: campaignBrief(), request: campaignRequest({ copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text }], ...(count ? { requested_asset_count: count } : {}) }) });
    if (out.status === 'NOT_A_MULTI_ASSET_PLAN') continue;
    assert.ok(['PLANNED', 'NEEDS_USER_DECISION'].includes(out.status), `fuzz ${n}`);
    if (out.status !== 'PLANNED') continue;
    const lane = out.campaign_plan.lanes[0];
    assert.ok(out.asset_plans.length <= 10 && (!count || out.asset_plans.length === count || out.content_plans[0].caption), `fuzz ${n}: count`);
    assert.equal(new Set(out.asset_plans.map((a) => a.shared.concept_id)).size, 1);
    assert.equal(new Set(out.asset_plans.map((a) => a.asset_plan_id)).size, out.asset_plans.length);
    assert.ok(lane.diversity.max_consecutive_same_pair <= 1, `fuzz ${n}: neighbours differ`);
    assert.equal(lane.diversity.passed, true, `fuzz ${n}: ${JSON.stringify(lane.diversity)}`);
    const placed = textsOf(out.asset_plans).join('') + (out.content_plans[0].caption?.text ?? '');
    assert.equal(stripSpace(placed), stripSpace(text), `fuzz ${n}: verbatim`);
    assert.ok(out.campaign_plan.budget.estimated_worst_case_eur <= out.campaign_plan.budget.ceiling_eur || out.status !== 'PLANNED');
  }
});
