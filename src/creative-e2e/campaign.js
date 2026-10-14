import { createHash } from 'node:crypto';

import { createDecisionLedger } from '../creative-runtime/index.js';
import { E2E_STATE } from './constants.js';
import { runCreativeEndToEnd } from './e2e.js';
import { computeProductSegmentation } from './segmentation-stage.js';

// THE CAMPAIGN. A multi-asset request (a carousel, a series) produced as ONE campaign over the existing end-to-end entry point; nothing is re-implemented here.
//   one campaign id (the planner's), one campaign budget (the sum of the assets can never pass it), one ledger, ONE concept and ONE art direction (the planner's store is shared by the assets, so the Brain is asked once),
//   the generated layers shared (the layer store), the product segmented once (a paid segmentation provider is asked once), and for each asset its own asset id, its own run id, its own operation chain and its own result.
// The caller never passes stores around: the campaign result carries one `resume_state` that restores everything. One asset that cannot be produced does not stop the others unless the cause is the same for all of them
// (the budget, a provider that is not connected).

const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const round = (v) => Math.round(v * 1e6) / 1e6;
const PRODUCED = new Set([E2E_STATE.READY, E2E_STATE.NEEDS_OWNER_REVIEW]);
const SEVERITY = [E2E_STATE.TECHNICAL_FAIL, E2E_STATE.BUDGET_EXCEEDED, E2E_STATE.PROVIDER_NOT_CONNECTED, E2E_STATE.BLOCKED]; // the state of a campaign that did not produce every asset: the most severe asset state
const SHARED_CAUSE = new Set([E2E_STATE.BUDGET_EXCEEDED, E2E_STATE.PROVIDER_NOT_CONNECTED]);

/**
 * @param {object} input the inputs of runCreativeEndToEnd, except run_id (campaign_run_id: the id of the campaign run, from which the id of each asset's run is derived) and ceiling_eur (the campaign ceiling),
 *  asset_ceiling_eur   optional ceiling of any one asset (default: what remains of the campaign)
 *  resume              the `resume_state` of a previous campaign result
 */
export async function runCreativeCampaign({
  campaign_run_id: campaignRunId, at, ceiling_eur: ceiling = 2, asset_ceiling_eur: assetCeiling = null, request, brief, fonts, font = null, ports = {}, guardian = null, options = {}, resume = null,
  ledger = createDecisionLedger(), deps = {},
}) {
  const fail = (code, detail = {}) => Object.freeze({ schema: 'creative-campaign-result@1', state: E2E_STATE.TECHNICAL_FAIL, campaign_run_id: campaignRunId ?? null, campaign_id: null, assets: [], failure: { code, ...detail }, owner_approval: 'PENDING', fallback_to_generated_product: false });
  if (!/^[A-Za-z0-9_.-]{3,52}$/.test(campaignRunId ?? '')) return fail('CAMPAIGN_RUN_ID_INVALID');
  if (!(Number.isFinite(ceiling) && ceiling >= 0)) return fail('CEILING_INVALID', { ceiling_eur: ceiling });
  if (resume && (resume.schema !== 'campaign-resume@1' || resume.campaign_run_id !== campaignRunId)) return fail('RESUME_STATE_IS_NOT_THIS_CAMPAIGN', { got: resume?.campaign_run_id ?? null });

  const { run: runAsset = runCreativeEndToEnd, ...assetDeps } = deps; // `deps.run` replaces the one-asset run (the tests of the campaign's own decisions inject a scripted one)
  const segmentation = assetDeps.segment ?? computeProductSegmentation;
  const memo = new Map(); // the product is segmented once for the campaign; a paid segmentation provider is asked once
  const segment = async (args) => {
    const key = sha({ asset: args.rgba?.width, h: args.rgba?.height, px: createHash('sha256').update(args.rgba?.pixels ?? '').digest('hex'), mode: args.mode, selection: args.selection ?? null });
    if (!memo.has(key)) memo.set(key, await segmentation(args));
    return memo.get(key);
  };

  let campaignStore = resume?.campaign_store ?? null; let layerStore = resume?.layer_store ?? null;
  const priorAssets = new Map((resume?.assets ?? []).map((a) => [a.asset_index, a]));
  const assets = []; let assetCount = null; let campaignId = null;
  const spentOf = () => round(assets.reduce((t, a) => t + (a.result?.budget?.spent_eur ?? 0), 0));
  const note = (event, outcome) => ledger.record({ decision: 'E2E_RUN_EVENT', decided_by: 'nordla:creative-e2e-run-context@1', rule: 'ONE_CAMPAIGN_ONE_BUDGET_ONE_LEDGER_AN_OPERATION_CHAIN_PER_ASSET', basis: [campaignRunId], outcome: { event, ...outcome } });
  note('CAMPAIGN_STARTED', { ceiling_eur: ceiling, asset_ceiling_eur: assetCeiling });

  let stop = null; // a cause shared by every remaining asset
  for (let i = 0; assetCount === null || i < assetCount; i += 1) {
    const remaining = round(ceiling - spentOf());
    const runId = `${campaignRunId}-a${i}`;
    if (stop) { assets.push({ asset_index: i, run_id: runId, asset_id: null, state: stop.state, result: null, not_run: stop.reason }); continue; }
    if (assetCount !== null && !(remaining > 0)) { // the campaign budget is spent: the asset is not started (no operation, no reservation)
      note('CAMPAIGN_BUDGET_EXHAUSTED', { asset_index: i, remaining_eur: remaining });
      stop = { state: E2E_STATE.BUDGET_EXCEEDED, reason: 'THE_CAMPAIGN_BUDGET_IS_SPENT' };
      assets.push({ asset_index: i, run_id: runId, asset_id: null, state: stop.state, result: null, not_run: stop.reason });
      continue;
    }
    const prior = priorAssets.get(i);
    const result = await runAsset({
      run_id: runId, at, ceiling_eur: assetCeiling === null ? remaining : Math.min(remaining, assetCeiling), request, brief, fonts, font, ports, guardian, ledger,
      options: { ...options, scene_index: i, planner_ceiling_eur: ceiling },
      resume: { run_state: prior?.run_state ?? null, campaign_store: campaignStore, layer_store: layerStore, refine_memory: prior?.refine_memory ?? null },
      deps: { ...assetDeps, segment },
    });
    assets.push({ asset_index: i, run_id: runId, asset_id: result.asset_id, state: result.state, result });
    campaignStore = result.resume_state?.campaign_store ?? campaignStore; layerStore = result.resume_state?.layer_store ?? layerStore;
    campaignId ??= result.campaign_id;
    if (assetCount === null) {
      assetCount = result.asset_count;
      if (assetCount === null) { stop = { state: result.state, reason: 'THE_CAMPAIGN_WAS_NOT_PLANNED' }; break; } // nothing was planned: there is no list of assets to go on with
    }
    if (SHARED_CAUSE.has(result.state)) { stop = { state: result.state, reason: `THE_SAME_CAUSE_STOPS_EVERY_ASSET:${result.failure?.code ?? result.block?.code ?? result.state}` }; }
  }

  const produced = assets.filter((a) => PRODUCED.has(a.state));
  const results = assets.map((a) => a.result).filter(Boolean);
  const identities = [...new Set(results.map((r) => r.product_identity?.pinned_sha256).filter(Boolean))];
  const concepts = [...new Set(results.map((r) => r.resume_state?.campaign_store?.nodes?.CONCEPT?.id).filter(Boolean))];
  const artDirections = [...new Set(results.map((r) => r.resume_state?.campaign_store?.nodes?.ART_DIRECTION?.id).filter(Boolean))];
  const allOps = results.flatMap((r) => r.operation_ids);
  const warnings = [...new Set(results.flatMap((r) => r.warnings))];
  const coherent = identities.length <= 1 && concepts.length <= 1 && artDirections.length <= 1 && new Set(allOps).size === allOps.length;
  if (!coherent) warnings.push('THE_ASSETS_DO_NOT_SHARE_ONE_PRODUCT_CONCEPT_AND_ART_DIRECTION');
  let state;
  if (assets.length && produced.length === assets.length) state = produced.every((a) => a.state === E2E_STATE.READY) && coherent ? E2E_STATE.READY : E2E_STATE.NEEDS_OWNER_REVIEW;
  else state = SEVERITY.find((s) => assets.some((a) => a.state === s)) ?? E2E_STATE.BLOCKED;
  const spent = spentOf();
  note('CAMPAIGN_FINISHED', { state, produced_assets: produced.length, asset_count: assetCount, spent_eur: spent });

  return Object.freeze({
    schema: 'creative-campaign-result@1', state, campaign_run_id: campaignRunId, campaign_id: campaignId, asset_count: assetCount, produced_assets: produced.length,
    assets: assets.map((a) => ({ asset_index: a.asset_index, run_id: a.run_id, asset_id: a.asset_id, state: a.state, not_run: a.not_run ?? null, result: a.result })),
    shared: { product_identity_sha256: identities.length === 1 ? identities[0] : identities, concept_id: concepts.length === 1 ? concepts[0] : concepts, art_direction_id: artDirections.length === 1 ? artDirections[0] : artDirections, coherent },
    budget: { ceiling_eur: ceiling, spent_eur: spent, remaining_eur: round(ceiling - spent), per_asset_eur: assets.map((a) => a.result?.budget?.spent_eur ?? 0), within_ceiling: spent <= ceiling + 1e-9 },
    operation_ids: Object.fromEntries(assets.filter((a) => a.result).map((a) => [a.run_id, a.result.operation_ids])),
    ledger_reference: { campaign_run_id: campaignRunId, entries: ledger.entries().length },
    warnings, owner_approval: 'PENDING', fallback_to_generated_product: false,
    resume_state: { schema: 'campaign-resume@1', campaign_run_id: campaignRunId, campaign_store: campaignStore, layer_store: layerStore, assets: assets.filter((a) => a.result).map((a) => ({ asset_index: a.asset_index, run_state: a.result.resume_state?.run_state ?? null, refine_memory: a.result.resume_state?.refine_memory ?? null })) },
  });
}
