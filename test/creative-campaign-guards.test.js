import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createContentFormatPlanner, createCopyAdapter, normalizeRequest, partitionPieces, sentenceAtoms,
} from '../src/creative-planning/index.js';
import {
  chooseProductionEnvelope, createMemoryCheckpointStore, DENSITY_CLASS, estimateCampaignCost, ROLE_MAX_DENSITY,
} from '../src/creative-campaign/index.js';
import {
  campaignBrief, campaignRequest, fullScript, makeCampaign, proofFact,
} from './creative-campaign-world.js';
import { fact, longText, scriptedCopyPort } from './creative-planning-world.js';

// GUARDS (`// GD-N` markers): the invalidation, the evidence, the cost and the distribution each have a test that fails if the rule is removed.

test('GD-1 the concept is recomputed when the frame inputs change even if the frame answer is identical', async () => {
  const store = createMemoryCheckpointStore();
  const first = makeCampaign({ script: await fullScript(), store });
  await first.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 5 }) });
  const second = makeCampaign({ script: await fullScript(), store });
  const out = await second.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 5, audience: 'Des étudiants' }) });
  assert.ok(out.executed.includes('FRAME') && out.executed.includes('CONCEPT') && out.executed.includes('ART_DIRECTION'), 'the same words from the framer do not make the concept independent of the audience');
  assert.equal(out.executed.filter((e) => e.startsWith('ASSET_PLAN')).length, 5);
});

test('GD-2 changing the words of one slide recomputes that slide, not the frame, the concept, the art direction or the other slides', async () => {
  const store = createMemoryCheckpointStore();
  const text = longText(300, 5);
  const first = makeCampaign({ script: await fullScript(), store });
  const run1 = await first.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 7, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text }] }) });
  const changed = text.replace('Phrase numéro 17 : notre atelier', 'Phrase numéro 17 : notre studio  ').replace('studio  ', 'studiox');
  assert.notEqual(changed, text);
  const second = makeCampaign({ script: { frame: [], ideate: [], select: [], art_direct: [], asset: Array.from({ length: 7 }, (_, k) => ({ imagery_brief: `Another view ${'abcdefg'[k]} of the workshop table`, composition_note: 'Centred in the frame', rationale: 'ok' })) }, store });
  const run2 = await second.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 7, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: changed }] }) });
  assert.equal(run2.status, 'PLANNED');
  assert.ok(!run2.executed.some((e) => ['FRAME', 'CONCEPT', 'ART_DIRECTION'].includes(e)), 'the shared stages are reused');
  const redone = run2.executed.filter((e) => e.startsWith('ASSET_PLAN'));
  assert.ok(redone.length >= 1 && redone.length < 7, `only the slides whose words changed were redone: ${redone}`);
  assert.equal(second.port.count('asset'), redone.length);
  const sameIds = run2.asset_plans.filter((a) => !redone.includes(`ASSET_PLAN:L0:${a.index}`)).map((a) => a.asset_plan_id);
  assert.deepEqual(sameIds, run1.asset_plans.filter((a) => !redone.includes(`ASSET_PLAN:L0:${a.index}`)).map((a) => a.asset_plan_id));
});

test('GD-3 connecting the asset director to a campaign that had none recomputes the assets', async () => {
  const store = createMemoryCheckpointStore();
  const without = makeCampaign({ script: await fullScript(), store, withDirector: false });
  const run1 = await without.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 5 }) });
  assert.ok(run1.asset_plans.every((a) => a.imagery_brief_source === 'INTENT_ONLY'));
  const withDirector = makeCampaign({ script: await fullScript(), store });
  const run2 = await withDirector.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 5 }) });
  assert.equal(run2.executed.filter((e) => e.startsWith('ASSET_PLAN')).length, 5); assert.ok(run2.asset_plans.every((a) => a.imagery_brief_source === 'MODEL'));
  assert.deepEqual(run2.executed.filter((e) => !e.startsWith('ASSET_PLAN')), [], 'nothing else was redone');
});

test('GD-4 proof is claimed only from a verified product claim, and only the proof asset cites it', async () => {
  const world = makeCampaign({ script: await fullScript() });
  const descriptive = await world.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 8, facts: [fact()] }) });
  assert.ok(!descriptive.asset_plans.some((a) => a.narrative_role === 'PROOF'), 'a descriptive fact is not proof');
  const other = makeCampaign({ script: await fullScript({ assets: 10 }) });
  const proven = await other.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 8, facts: [proofFact()] }) });
  assert.ok(proven.asset_plans.filter((a) => a.narrative_role !== 'PROOF').every((a) => a.evidence_fact_refs.length === 0));
  assert.deepEqual(proven.asset_plans.find((a) => a.narrative_role === 'PROOF').evidence_fact_refs, ['fact://proof']);
  const unverified = makeCampaign({ script: await fullScript({ assets: 10 }) });
  const estimate = await unverified.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 8, facts: [{ ...proofFact(), status: 'ESTIMATE' }] }) });
  assert.ok(!estimate.asset_plans.some((a) => a.narrative_role === 'PROOF'), 'an estimate is not proof');
});

test('GD-5 one checkpoint per node: the number of saves is the number of nodes computed', async () => {
  const world = makeCampaign({ script: await fullScript() });
  const out = await world.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 5 }) });
  assert.equal(world.store.saves(), out.executed.length); assert.equal(out.saves, out.executed.length);
  assert.equal(world.ledger.of('CAMPAIGN_CHECKPOINT').length, out.executed.length);
});

test('GD-6 the worst-case estimate is exact: shared stages, the stages of each asset, the images of the shape, the vision calls', () => {
  const feed = { canvas: { width: 1080, height: 1350 } }; const small = { canvas: { width: 800, height: 800 } };
  const a = estimateCampaignCost({ assets: [feed, feed, feed], environmentCandidates: 1 });
  assert.equal(a.shared_eur, 0.3); assert.deepEqual(a.per_asset_eur, [0.179, 0.179, 0.179]); assert.equal(a.total_eur, 0.837);
  assert.deepEqual(estimateCampaignCost({ assets: [feed], environmentCandidates: 3 }).per_asset_eur, [0.317]);
  assert.deepEqual(estimateCampaignCost({ assets: [small], environmentCandidates: 1 }).per_asset_eur, [0.144], 'a smaller canvas is a cheaper image');
  assert.equal(estimateCampaignCost({ assets: [], environmentCandidates: 1 }).total_eur, 0.3);
  const fitting = chooseProductionEnvelope({ assets: [feed, feed, feed], ceilingEur: 2 });
  assert.equal(fitting.environment_candidates_per_asset, 3); assert.equal(fitting.estimate.total_eur, 1.251);
  assert.equal(chooseProductionEnvelope({ assets: Array(7).fill(feed), ceilingEur: 2 }).environment_candidates_per_asset, 1);
  assert.equal(chooseProductionEnvelope({ assets: Array(7).fill(feed), ceilingEur: 2.1 }).environment_candidates_per_asset, 2);
});

test('GD-7 a hook says little by design, and the role limits are policy that is pinned', () => {
  assert.equal(ROLE_MAX_DENSITY.HOOK, DENSITY_CLASS.LOW); assert.equal(ROLE_MAX_DENSITY.CTA, DENSITY_CLASS.LOW); assert.equal(ROLE_MAX_DENSITY.OFFER, DENSITY_CLASS.MEDIUM);
  assert.equal(ROLE_MAX_DENSITY.PROGRESSION, DENSITY_CLASS.TEXT_LED);
});

test('GD-8 the shared art direction is asked exactly as it is for a single image: no revision hints', async () => {
  const world = makeCampaign({ script: await fullScript() });
  await world.planner.plan({ brief: campaignBrief(), request: campaignRequest({ requested_asset_count: 5 }) });
  const art = world.port.calls.find((c) => c.stage === 'art_direct').instruction;
  assert.ok(!art.system.includes('REVISION') && !art.user.includes('hint'));
});

test('GD-9 slides are split evenly, cutting where the author did when the evenness is the same', () => {
  const piece = (chars, paragraph_end) => ({ chars, paragraph_end });
  const pieces = [piece(100, false), piece(100, true), piece(100, false), piece(100, true), piece(100, true)];
  const split = partitionPieces(pieces, 3, 300);
  assert.deepEqual(split.map((g) => g.pieces.length), [2, 2, 1], 'among equal splits, the cuts fall at the ends of paragraphs');
  assert.deepEqual(partitionPieces(pieces, 2, 400).map((g) => g.chars), [201, 302]);
  assert.equal(partitionPieces(pieces, 2, 250), null, 'no split keeps every slide within the cap');
  assert.equal(partitionPieces(pieces, 6, 1000), null, 'more slides than pieces is no split');
  assert.equal(partitionPieces(pieces, 0, 1000), null);
  assert.deepEqual(partitionPieces([piece(10, true)], 1, 10).map((g) => g.chars), [10]);
});

test('GD-10 sentences are the unit of distribution, with the end of each paragraph marked, and a sentence longer than a slide is cut', () => {
  const text = 'Un. Deux.\n\nTrois.';
  const atoms = sentenceAtoms(text, 100, 'fr');
  assert.deepEqual(atoms.map((a) => text.slice(a.start, a.end)), ['Un.', 'Deux.', 'Trois.']);
  assert.deepEqual(atoms.map((a) => a.paragraph_end), [false, true, true]);
  const long = `${'mot '.repeat(30)}fin.`;
  const cut = sentenceAtoms(long, 40, 'fr');
  assert.ok(cut.length > 1 && cut.every((a) => long.slice(a.start, a.end).length <= 40));
});

test('GD-11 plans made from one preparation do not touch each other: the same preparation gives the same plan every time', async () => {
  const body = Array(20).fill('Notre atelier de Namur imprime vos photos sur des coques personnalisées avec soin.').join(' ');
  const answer = { text: 'Résumé fidèle de l’atelier de Namur et de ses coques personnalisées.', rationale: 'Condensed.' };
  const port = scriptedCopyPort('adapt', [answer, answer, answer]);
  const planner = createContentFormatPlanner({ copyAdapter: createCopyAdapter({ complete: port.complete }) });
  const prepared = await planner.prepare({
    request_ref: 'r', locale: 'fr-BE', channel: 'STORE_WINDOW', constraints: [{ kind: 'ALL_TEXT_ON_ASSET' }, { kind: 'SINGLE_ASSET_ONLY' }], copy: [{ copy_ref: 'copy://b', mode: 'COPY_ADAPTABLE', text: body }],
  });
  const first = await planner.planPrepared(prepared, { quiet: true });
  assert.ok(first.assets.flatMap((a) => a.slots.flatMap((s) => s.pieces)).some((p) => p.origin === 'ADAPTED'), 'the adaptation was needed and made');
  const second = await planner.planPrepared(prepared, { quiet: true });
  assert.deepEqual(second.assets, first.assets, 'the preparation was not changed by the first plan (only the request ids of the two adaptations differ)');
  assert.deepEqual(second.events.map((e) => e.kind), first.events.map((e) => e.kind));
  assert.equal(port.calls.length, 2);
  const lockedOnly = await planner.planPrepared(prepared, { quiet: true, channels: ['SOCIAL_FEED'], requested: null });
  assert.ok([...lockedOnly.assets.flatMap((a) => a.slots.flatMap((s) => s.pieces)), ...(lockedOnly.caption?.pieces ?? [])].every((p) => p.origin === 'LOCKED' || p.origin === 'ADAPTED'));
});

test('GD-12 the stated density of a slide is validated: only the body classes exist', () => {
  assert.equal(normalizeRequest({ request_ref: 'r', copy: [{ copy_ref: 'c', mode: 'COPY_LOCKED', text: 'x' }], slide_density: 'TEXT_LED' }).slide_density, 'TEXT_LED');
  assert.throws(() => normalizeRequest({ request_ref: 'r', copy: [{ copy_ref: 'c', mode: 'COPY_LOCKED', text: 'x' }], slide_density: 'LOW' }), /slide_density/);
  assert.throws(() => normalizeRequest({ request_ref: 'r', copy: [{ copy_ref: 'c', mode: 'COPY_LOCKED', text: 'x' }], slide_density: 'ENORMOUS' }), /slide_density/);
});
