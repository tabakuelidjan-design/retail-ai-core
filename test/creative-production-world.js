// A synthetic world for the layered production tests: a planned campaign behind scripted fakes, then the production planner over it. No network, no provider, no cost.

import { createProductionPlanner } from '../src/creative-production/index.js';
import { createMemoryCheckpointStore } from '../src/creative-campaign/index.js';
import { artDirectionAnswer } from './creative-brain-world.js';
import {
  campaignBrief, campaignRequest, fullScript, makeCampaign,
} from './creative-campaign-world.js';
import { fonts } from './runtime-world.js';

export const FONT = fonts.get('font:runtime-fixture-sans');

/** A planned campaign, ready to be produced. `art` overrides fields of the art direction the fake framer returns; `briefOver` / `requestOver` override the brief and the request. */
export async function plannedCampaign({
  assets = 7, art = {}, briefOver = {}, requestOver = {}, store = createMemoryCheckpointStore(), ceilingEur,
} = {}) {
  const script = await fullScript({ assets: 12 });
  if (Object.keys(art).length) script.art_direct = [artDirectionAnswer(art)];
  const world = makeCampaign({ script, store, ceilingEur });
  const brief = { ...campaignBrief(), ...briefOver };
  const request = campaignRequest({ requested_asset_count: assets, ...requestOver });
  const campaign = await world.planner.plan({ brief, request });
  return {
    world, campaign, brief, request, store,
  };
}

export async function produced(options = {}, {
  font = null, store, bytes = null, ledger = null, policy, unitCosts, productionBrief = null,
} = {}) {
  const base = await plannedCampaign(options);
  const planner = createProductionPlanner({
    store: store ?? base.store, font, ledger, ...(policy ? { policy } : {}), ...(unitCosts ? { unitCosts } : {}),
  });
  const result = await planner.plan({
    campaignResult: base.campaign, brief: productionBrief ?? base.brief, request: base.request, bytes,
  });
  return { ...base, planner, result };
}
