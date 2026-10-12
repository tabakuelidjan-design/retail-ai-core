import test from 'node:test';
import assert from 'node:assert/strict';

import { stripSpace } from '../src/creative-planning/index.js';
import { createMemoryCheckpointStore } from '../src/creative-campaign/index.js';
import {
  campaignBrief, campaignRequest, fullScript, makeCampaign, proofFact,
} from './creative-campaign-world.js';
import { longText } from './creative-planning-world.js';

// SYNTHETIC END-TO-END CAMPAIGNS (`// CE-N` markers): from a user request to a campaign plan, through the content planner, the Creative Brain stages, the asset director and the budget, with scripted fakes only.

const run = async (request, deps = {}) => {
  const world = makeCampaign({ script: await fullScript({ assets: 12 }), ...deps });
  const out = await world.planner.plan({ brief: campaignBrief(), request, options: deps.options ?? {} });
  return { world, out };
};
const wordsOf = (out) => stripSpace([...out.asset_plans.flatMap((a) => a.copy.map((s) => s.text)), out.content_plans[0].caption?.text ?? ''].join(''));

test('CE-1 "five different images" become a series: five assets, one idea, five looks', async () => {
  const { out } = await run(campaignRequest({ requested_format: undefined, requested_asset_count: 5, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: longText(100, 4) }] }));
  assert.equal(out.status, 'PLANNED'); assert.equal(out.campaign_plan.lanes[0].format_kind, 'MULTI_VISUAL_SERIES');
  assert.equal(out.asset_plans.length, 5); assert.equal(new Set(out.asset_plans.map((a) => a.imagery_brief)).size, 5);
  assert.ok(out.asset_plans.every((a) => a.shared.concept_id === out.campaign_plan.concept_id));
});

test('CE-2 a story channel with a sectioned text becomes a story sequence of 9:16 frames', async () => {
  const text = longText(150, 4);
  const { out } = await run(campaignRequest({ channel: 'STORY', requested_format: undefined, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text }] }));
  assert.equal(out.status, 'PLANNED'); assert.equal(out.campaign_plan.lanes[0].format_kind, 'STORY_SEQUENCE');
  assert.ok(out.content_plans[0].assets.every((a) => a.aspect_ratio === '9:16')); assert.equal(out.content_plans[0].caption, null);
  assert.equal(wordsOf(out), stripSpace(text));
});

test('CE-3 a text the format decides alone (sectioned, long, nothing requested) is planned as a carousel with a hook and a verbatim body', async () => {
  const text = longText(300, 5);
  const { out } = await run(campaignRequest({ requested_format: undefined, copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text }] }));
  assert.equal(out.status, 'PLANNED'); assert.equal(out.campaign_plan.lanes[0].format_kind, 'CAROUSEL');
  assert.equal(out.asset_plans[0].narrative_role, 'HOOK'); assert.equal(wordsOf(out), stripSpace(text));
  assert.ok(out.asset_plans.length >= 4 && out.asset_plans.length <= 10);
});

test('CE-4 a sale: hook, details, proof, offer — each with its own look, the price on the offer, a verified proof cited', async () => {
  const text = longText(120, 4);
  const { out } = await run(campaignRequest({
    requested_asset_count: 7, facts: [proofFact()],
    copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text }, { copy_ref: 'copy://price', mode: 'COPY_LOCKED', role: 'PRICE', carrier: 'CLAIM', text: '25 €' }, { copy_ref: 'copy://cta', mode: 'COPY_LOCKED', role: 'CTA', text: 'Venez nous voir' }],
  }));
  const roles = out.asset_plans.map((a) => a.narrative_role);
  assert.equal(roles[0], 'HOOK'); assert.equal(roles.at(-1), 'OFFER'); assert.ok(roles.includes('PROOF'));
  assert.deepEqual(out.asset_plans.at(-1).copy.map((c) => c.role).sort(), ['CTA', 'PRICE']);
  assert.deepEqual(out.asset_plans.find((a) => a.narrative_role === 'PROOF').evidence_fact_refs, ['fact://proof']);
  assert.equal(out.campaign_plan.lanes[0].diversity.passed, true);
});

test('CE-5 the whole campaign state survives a serialization round trip: a stop and a resume on a fresh process', async () => {
  const store = createMemoryCheckpointStore();
  const request = campaignRequest({ requested_asset_count: 6 });
  const first = await run(request, { store });
  const persisted = JSON.stringify(store.peek());
  const fresh = createMemoryCheckpointStore(JSON.parse(persisted));
  const world = makeCampaign({ script: { frame: [], ideate: [], select: [], art_direct: [], asset: [] }, store: fresh });
  const resumed = await world.planner.plan({ brief: campaignBrief(), request });
  assert.equal(world.port.calls.length, 0); assert.deepEqual(resumed.executed, []);
  assert.equal(resumed.campaign_plan.campaign_id, first.out.campaign_plan.campaign_id);
  assert.deepEqual(resumed.asset_plans.map((a) => a.asset_plan_id), first.out.asset_plans.map((a) => a.asset_plan_id));
});

test('CE-6 an interruption at every node leaves a store from which the same campaign is finished with only the missing work', async () => {
  const request = campaignRequest({ requested_asset_count: 5 });
  const clean = (await run(request)).out;
  const nodes = ['frame', 'ideate', 'select', 'art_direct'];
  for (const stage of nodes) {
    const store = createMemoryCheckpointStore();
    const script = await fullScript();
    script[stage] = [new Error('interrupted')];
    const broken = makeCampaign({ script, store });
    await assert.rejects(broken.planner.plan({ brief: campaignBrief(), request }));
    const before = Object.keys(store.peek().nodes);
    const world = makeCampaign({ script: await fullScript(), store });
    const finished = await world.planner.plan({ brief: campaignBrief(), request });
    assert.equal(finished.campaign_plan.campaign_id, clean.campaign_plan.campaign_id, `after ${stage}`);
    assert.deepEqual(finished.reused.filter((r) => !r.startsWith('ASSET')), before.filter((b) => !b.startsWith('ASSET')), `after ${stage}: everything stored was reused`);
    assert.equal(world.port.count(stage), stage === 'select' || stage === 'ideate' ? 1 : 1, `after ${stage}: the interrupted stage is asked again`);
  }
});

test('CE-7 a campaign never asks the Brain to compose a slide: it plans, it does not produce', async () => {
  const { world, out } = await run(campaignRequest({ requested_asset_count: 5 }));
  assert.deepEqual([...new Set(world.port.calls.map((c) => c.stage))].sort(), ['art_direct', 'asset', 'frame', 'ideate', 'select']);
  assert.equal(out.campaign_plan.executable, false); assert.ok(out.asset_plans.every((a) => a.execution.status === 'PLANNED_NOT_EXECUTABLE'));
});
