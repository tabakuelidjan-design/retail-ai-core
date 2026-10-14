import test from 'node:test';
import assert from 'node:assert/strict';

import { E2E_STATE, runCreativeCampaign } from '../src/creative-e2e/index.js';
import { createDecisionLedger } from '../src/creative-runtime/ledger.js';

// The decisions of the campaign over a SCRIPTED one-asset run (`// CC-N` markers): fast, no image. The real runs are in creative-e2e-closure.test.js.

const AT = '2026-10-14T10:00:00.000Z';
const base = { campaign_run_id: 'camp-cc-1', at: AT, request: {}, brief: {}, fonts: {}, ports: {}, guardian: null };
const shaOf = (s) => s.padEnd(64, '0');
// a scripted asset run: `plan` gives, per asset index, { state, spent, count, ... }
const scripted = (plan, seen = []) => async (input) => {
  const index = input.options.scene_index; const p = typeof plan === 'function' ? plan(index, input) : plan[index];
  seen.push({ index, run_id: input.run_id, ceiling: input.ceiling_eur, planner_ceiling: input.options.planner_ceiling_eur, resume: input.resume });
  const state = p.state ?? E2E_STATE.NEEDS_OWNER_REVIEW; const spent = p.spent ?? 0.1;
  return {
    state, run_id: input.run_id, asset_id: `ast-${index}`, campaign_id: 'cmp_x', asset_count: 'count' in p ? p.count : 3, warnings: p.warnings ?? [], block: p.block ?? null, failure: p.failure ?? null,
    budget: { ceiling_eur: input.ceiling_eur, spent_eur: spent }, operation_ids: p.ops ?? [`${input.run_id}:BRAIN_TEXT:0001`],
    product_identity: { pinned_sha256: p.identity ?? shaOf('id') }, final: state === E2E_STATE.READY || state === E2E_STATE.NEEDS_OWNER_REVIEW ? { png_sha256: `png${index}` } : null,
    resume_state: { run_state: { r: input.run_id }, campaign_store: { nodes: { CONCEPT: { id: p.concept ?? 'cnc_1' }, ART_DIRECTION: { id: p.art ?? 'art_1' } }, mark: `store-after-${index}` }, layer_store: { mark: `layers-after-${index}` }, refine_memory: { m: index } },
  };
};
const run = (plan, over = {}, seen) => runCreativeCampaign({ ...base, ceiling_eur: 1, deps: { run: scripted(plan, seen) }, ...over });

test('The campaign produces every planned asset, one run id and one operation chain each, and says what is shared', async () => {
  const seen = []; const c = await run([{ spent: 0.2 }, { spent: 0.1 }, { spent: 0.05 }], {}, seen);
  // CC-1 every asset, in order, with its own derived run id; the campaign id is the planner's; the count comes from the first run
  assert.deepEqual(seen.map((s) => [s.index, s.run_id]), [[0, 'camp-cc-1-a0'], [1, 'camp-cc-1-a1'], [2, 'camp-cc-1-a2']]); assert.equal(c.asset_count, 3); assert.equal(c.produced_assets, 3); assert.equal(c.campaign_id, 'cmp_x');
  assert.equal(c.state, E2E_STATE.NEEDS_OWNER_REVIEW); assert.deepEqual(c.assets.map((a) => [a.asset_index, a.run_id, a.asset_id, a.state, a.not_run]), [[0, 'camp-cc-1-a0', 'ast-0', 'NEEDS_OWNER_REVIEW', null], [1, 'camp-cc-1-a1', 'ast-1', 'NEEDS_OWNER_REVIEW', null], [2, 'camp-cc-1-a2', 'ast-2', 'NEEDS_OWNER_REVIEW', null]]);
  // CC-2 the stores are carried from one asset to the next WITHOUT the caller; the campaign ceiling goes to the planner, the remainder of the campaign to each asset
  assert.equal(seen[0].resume.campaign_store, null); assert.equal(seen[1].resume.campaign_store.mark, 'store-after-0'); assert.equal(seen[2].resume.campaign_store.mark, 'store-after-1'); assert.equal(seen[2].resume.layer_store.mark, 'layers-after-1');
  assert.deepEqual(seen.map((s) => s.planner_ceiling), [1, 1, 1]); assert.deepEqual(seen.map((s) => s.ceiling), [1, 0.8, 0.7]);
  // CC-3 the budget is the sum of the assets, the operation chains are one per asset
  assert.deepEqual(c.budget, { ceiling_eur: 1, spent_eur: 0.35, remaining_eur: 0.65, per_asset_eur: [0.2, 0.1, 0.05], within_ceiling: true });
  assert.deepEqual(Object.keys(c.operation_ids), ['camp-cc-1-a0', 'camp-cc-1-a1', 'camp-cc-1-a2']); assert.equal(c.fallback_to_generated_product, false); assert.equal(c.owner_approval, 'PENDING');
  assert.deepEqual(c.shared, { product_identity_sha256: shaOf('id'), concept_id: 'cnc_1', art_direction_id: 'art_1', coherent: true });
  assert.equal(c.resume_state.schema, 'campaign-resume@1'); assert.equal(c.resume_state.campaign_run_id, 'camp-cc-1'); assert.equal(c.resume_state.campaign_store.mark, 'store-after-2'); assert.equal(c.resume_state.assets.length, 3);
  // CC-4 READY only when every asset is READY and the campaign is coherent
  assert.equal((await run((i) => ({ state: E2E_STATE.READY }))).state, E2E_STATE.READY);
  assert.equal((await run((i) => ({ state: i === 1 ? E2E_STATE.NEEDS_OWNER_REVIEW : E2E_STATE.READY }))).state, E2E_STATE.NEEDS_OWNER_REVIEW);
});

test('The campaign budget is above the assets: an asset is not started when the campaign has nothing left', async () => {
  // CC-5 the money is gone after asset 1: asset 2 is NOT STARTED (no run, no operation), the state is BUDGET_EXCEEDED, the ceiling holds
  const seen = []; const c = await run([{ spent: 0.5 }, { spent: 0.5 }, { spent: 0.5 }], { ceiling_eur: 1 }, seen);
  assert.equal(seen.length, 2); assert.equal(c.state, E2E_STATE.BUDGET_EXCEEDED); assert.equal(c.produced_assets, 2); assert.deepEqual(c.assets.map((a) => a.state), ['NEEDS_OWNER_REVIEW', 'NEEDS_OWNER_REVIEW', 'BUDGET_EXCEEDED']);
  assert.equal(c.assets[2].result, null); assert.equal(c.assets[2].not_run, 'THE_CAMPAIGN_BUDGET_IS_SPENT'); assert.equal(c.budget.spent_eur, 1); assert.equal(c.budget.within_ceiling, true); assert.ok(!('camp-cc-1-a2' in c.operation_ids));
  // CC-6 the asset ceiling caps one asset, the campaign remainder caps the rest
  const seen2 = []; await run([{ spent: 0.1 }, { spent: 0.1 }, { spent: 0.1 }], { ceiling_eur: 1, asset_ceiling_eur: 0.15 }, seen2); assert.deepEqual(seen2.map((s) => s.ceiling), [0.15, 0.15, 0.15]);
  const seen3 = []; await run([{ spent: 0.5 }, { spent: 0.3 }, { spent: 0.1 }], { ceiling_eur: 1, asset_ceiling_eur: 0.6 }, seen3); assert.deepEqual(seen3.map((s) => s.ceiling), [0.6, 0.5, 0.2]);
  // CC-7 a campaign that spends everything on one asset: the others are not started
  const seen4 = []; const all = await run([{ spent: 1 }, { spent: 1 }, { spent: 1 }], { ceiling_eur: 1 }, seen4); assert.equal(seen4.length, 1); assert.deepEqual(all.assets.map((a) => a.state), ['NEEDS_OWNER_REVIEW', 'BUDGET_EXCEEDED', 'BUDGET_EXCEEDED']);
});

test('A cause shared by every asset stops the rest once; an asset that fails alone does not', async () => {
  // CC-8 shared causes: the budget and a provider that is not connected
  for (const state of [E2E_STATE.BUDGET_EXCEEDED, E2E_STATE.PROVIDER_NOT_CONNECTED]) {
    const seen = []; const c = await run([{ state, spent: 0, failure: { code: 'X' } }, {}, {}], {}, seen);
    assert.equal(seen.length, 1, state); assert.equal(c.state, state); assert.equal(c.produced_assets, 0); assert.deepEqual(c.assets.map((a) => a.state), [state, state, state]); assert.match(c.assets[1].not_run, /THE_SAME_CAUSE_STOPS_EVERY_ASSET/); assert.equal(c.assets[1].result, null);
  }
  // CC-9 an asset that is BLOCKED or fails technically alone: the others are produced, and the campaign says what it is (the most severe asset state)
  const seen = []; const mixed = await run((i) => (i === 1 ? { state: E2E_STATE.BLOCKED, block: { code: 'MATTE_INVALID' } } : {}), {}, seen);
  assert.equal(seen.length, 3); assert.equal(mixed.produced_assets, 2); assert.equal(mixed.state, E2E_STATE.BLOCKED); assert.deepEqual(mixed.assets.map((a) => a.state), ['NEEDS_OWNER_REVIEW', 'BLOCKED', 'NEEDS_OWNER_REVIEW']);
  assert.equal((await run((i) => (i === 0 ? {} : i === 1 ? { state: E2E_STATE.BLOCKED } : { state: E2E_STATE.TECHNICAL_FAIL }))).state, E2E_STATE.TECHNICAL_FAIL, 'a technical failure outranks a block');
  assert.equal((await run((i) => (i === 2 ? { state: E2E_STATE.BLOCKED } : { state: E2E_STATE.BUDGET_EXCEEDED, spent: 0.1 }), { ceiling_eur: 5 })).state, E2E_STATE.BUDGET_EXCEEDED);
  // CC-10 nothing planned: ONE result, no other asset invented
  const seen2 = []; const none = await run(() => ({ state: E2E_STATE.BLOCKED, count: null, block: { code: 'PRODUCT_COPY_CONFLICT' } }), {}, seen2); assert.equal(seen2.length, 1); assert.equal(none.state, E2E_STATE.BLOCKED); assert.equal(none.assets.length, 1); assert.equal(none.asset_count, null); assert.equal(none.campaign_id, 'cmp_x');
});

test('The campaign says when its assets do not share one product, concept and art direction, and refuses what is not a campaign run', async () => {
  // CC-11 incoherent: a different product identity / concept / art direction / a repeated operation id
  for (const [name, over] of [['identity', { identity: shaOf('other') }], ['concept', { concept: 'cnc_2' }], ['art', { art: 'art_2' }]]) {
    const c = await run((i) => (i === 1 ? over : {})); assert.equal(c.shared.coherent, false, name); assert.ok(c.warnings.includes('THE_ASSETS_DO_NOT_SHARE_ONE_PRODUCT_CONCEPT_AND_ART_DIRECTION'), name); assert.equal(c.state, E2E_STATE.NEEDS_OWNER_REVIEW);
  }
  const dup = await run(() => ({ ops: ['same:BRAIN_TEXT:0001'] })); assert.equal(dup.shared.coherent, false);
  assert.equal((await run((i) => ({ state: E2E_STATE.READY }), {}, [])).shared.coherent, true);
  assert.equal((await run((i) => (i === 1 ? { state: E2E_STATE.READY, identity: shaOf('other') } : { state: E2E_STATE.READY }))).state, E2E_STATE.NEEDS_OWNER_REVIEW, 'incoherent assets are never READY');
  // CC-12 the door: run id (3 to 52 characters), ceiling, resume of another campaign
  for (const id of [undefined, 'ab', 'a'.repeat(53), 'bad id']) assert.equal((await run([{}], { campaign_run_id: id })).failure.code, 'CAMPAIGN_RUN_ID_INVALID', String(id));
  for (const id of ['abc', 'a'.repeat(52)]) assert.notEqual((await run([{ count: 1 }], { campaign_run_id: id })).failure?.code, 'CAMPAIGN_RUN_ID_INVALID', id);
  for (const ceiling of [-0.01, NaN, Infinity, undefined === 0 ? 0 : 'x']) assert.equal((await run([{}], { ceiling_eur: ceiling })).failure.code, 'CEILING_INVALID', String(ceiling));
  assert.equal((await run([{ count: 1 }], { ceiling_eur: 0 })).failure, undefined, 'a ceiling of zero is a valid ceiling (the run then spends nothing)');
  assert.equal((await run([{}], { resume: { schema: 'campaign-resume@1', campaign_run_id: 'another' } })).failure.code, 'RESUME_STATE_IS_NOT_THIS_CAMPAIGN'); assert.equal((await run([{}], { resume: { schema: 'x', campaign_run_id: 'camp-cc-1' } })).failure.code, 'RESUME_STATE_IS_NOT_THIS_CAMPAIGN');
  // CC-13 resume: each asset gets ITS run state back, the stores come from the saved campaign
  const first = await run([{}, {}, {}]); const seen = [];
  await run([{}, {}, {}], { resume: JSON.parse(JSON.stringify(first.resume_state)) }, seen);
  assert.deepEqual(seen.map((s) => s.resume.run_state), [{ r: 'camp-cc-1-a0' }, { r: 'camp-cc-1-a1' }, { r: 'camp-cc-1-a2' }]); assert.deepEqual(seen.map((s) => s.resume.refine_memory), [{ m: 0 }, { m: 1 }, { m: 2 }]); assert.equal(seen[0].resume.campaign_store.mark, 'store-after-2'); assert.equal(seen[0].resume.layer_store.mark, 'layers-after-2');
  // CC-14 one ledger for the campaign: the campaign events are in the ledger it was given
  const ledger = createDecisionLedger(); await run([{}, {}, {}], { ledger }); const events = ledger.entries().filter((e) => e.outcome?.event?.startsWith?.('CAMPAIGN_')).map((e) => e.outcome.event); assert.deepEqual(events, ['CAMPAIGN_STARTED', 'CAMPAIGN_FINISHED']);
});

test('Campaign defaults, refusal shape, and the product is segmented once (guards from the mutation sweep)', async () => {
  // CC-15 the default ceiling, and a refusal never carries a product
  const seen = []; await runCreativeCampaign({ ...base, deps: { run: scripted([{ count: 1 }], seen) } }); assert.equal(seen[0].planner_ceiling, 2); assert.equal(seen[0].ceiling, 2);
  const refused = await runCreativeCampaign({ ...base, campaign_run_id: 'x', deps: { run: scripted([{}]) } }); assert.deepEqual([refused.state, refused.fallback_to_generated_product, refused.campaign_id, refused.assets], [E2E_STATE.TECHNICAL_FAIL, false, null, []]);
  // CC-16 the segmentation is shared: the same product is segmented once whatever the number of assets, a different product or mode is segmented again
  let calls = 0; const segment = async (a) => { calls += 1; return { calls, mode: a.mode }; };
  const rgba = (n) => ({ width: 2, height: 2, pixels: new Uint8Array([n, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]) });
  const out = []; const run = async (input) => { out.push(await input.deps.segment({ rgba: rgba(1), mode: 'AUTO', selection: null }), await input.deps.segment({ rgba: rgba(1), mode: 'AUTO', selection: null })); out.push(await input.deps.segment({ rgba: rgba(2), mode: 'AUTO', selection: null })); out.push(await input.deps.segment({ rgba: rgba(1), mode: 'PHOTO', selection: null })); return scripted([{}, {}, {}])(input); };
  await runCreativeCampaign({ ...base, ceiling_eur: 5, deps: { run, segment } });
  assert.equal(calls, 3, 'one segmentation per distinct product and mode, whatever the assets'); assert.equal(out[0], out[1]); assert.equal(out[0], out[4]); assert.notEqual(out[2], out[0]); assert.notEqual(out[3], out[0]);
});
