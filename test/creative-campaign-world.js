// A synthetic world for the campaign tests: a Creative Brain behind scripted fake ports, a scripted asset director, requests for carousels. No network, no provider, no cost.

import { createCreativeBrain, normalizeConceptSet } from '../src/creative-brain/index.js';
import { createDecisionLedger } from '../src/creative-runtime/ledger.js';
import {
  createAssetDirector, createCampaignPlanner, createMemoryCheckpointStore,
} from '../src/creative-campaign/index.js';
import { createContentFormatPlanner } from '../src/creative-planning/index.js';
import { buildBrief } from './runtime-world.js';
import {
  artDirectionAnswer, CONCEPTS, evaluationsAnswer, frameAnswer, OTHER_CONCEPTS,
} from './creative-brain-world.js';
import { fact, longText } from './creative-planning-world.js';

const STAGES = [['problem framer', 'frame'], ['concept director', 'ideate'], ['concept selector', 'select'], ['art director', 'art_direct'], ['asset director', 'asset']];

/** A scripted port for the shared stages and the asset director: queues per stage, every call recorded. `answers[stage]` is a list (consumed in order) or a function (call index -> answer). */
export function campaignPort(answers) {
  const calls = []; const used = {};
  const complete = async (instruction) => {
    const stage = STAGES.find(([needle]) => instruction.system.includes(`Nordla ${needle}`))?.[1];
    calls.push({ stage, instruction });
    const source = answers[stage];
    const index = used[stage] ?? 0; used[stage] = index + 1;
    const next = typeof source === 'function' ? source(index, instruction) : source?.[index];
    if (next === undefined || next === null) throw Object.assign(new Error(`no scripted answer for ${stage}`), { code: 'NO_SCRIPT' });
    if (next instanceof Error) throw next;
    return { text: typeof next === 'string' ? next : JSON.stringify(next), model: 'fake-model', request_id: `req-${stage}-${index + 1}` };
  };
  return { complete, calls, count: (stage) => calls.filter((c) => c.stage === stage).length };
}

const ASSET_TEXTS = [
  ['A workbench seen from above, tools laid out in order', 'The product is introduced at the edge of the frame.'],
  ['A hand-lettered ledger open beside a small brass scale', 'The product sits at the right of a calm band.'],
  ['Afternoon light crossing a stack of finished orders', 'A tight view on the printed surface of the product.'],
  ['A row of pegs holding sample swatches on a plain wall', 'The product is held off-centre against the wall.'],
  ['A window ledge with a single plant in soft morning light', 'The product leans on the ledge in the lower third.'],
  ['A folded paper bag and a ribbon on a wooden counter', 'The product is shown whole, centred, with room around it.'],
  ['A quiet corridor with a lit doorway at its end', 'The product is placed in the foreground of the corridor.'],
  ['An open drawer of labelled envelopes', 'The product rests beside the drawer.'],
  ['A calendar page turned to a blank day', 'The product is seen close, its edge cropped by the frame.'],
  ['A table set for one in the evening', 'The product is the only object on the table.'],
];
/** The imagery brief of the k-th asset: different for every asset, no figure, no substitute for the product. */
export const assetAnswer = (k) => ({ imagery_brief: ASSET_TEXTS[k % ASSET_TEXTS.length][0], composition_note: ASSET_TEXTS[k % ASSET_TEXTS.length][1], rationale: `Asset ${'abcdefghij'[k % 10]} plays its own part.` });

/** The full set of scripted answers for one campaign (a frame, a round of concepts, a selection, an art direction, and a brief per asset). */
export async function fullScript({ audience = null, assets = 10 } = {}) {
  const ids = normalizeConceptSet(CONCEPTS);
  return {
    frame: [frameAnswer(audience ? { audience } : {})],
    ideate: [{ concepts: CONCEPTS }],
    select: [evaluationsAnswer(ids, [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }])],
    art_direct: [artDirectionAnswer()],
    asset: Array.from({ length: assets }, (_, k) => assetAnswer(k)),
  };
}

export { OTHER_CONCEPTS };

export function makeCampaign({
  script, store = createMemoryCheckpointStore(), ledger = createDecisionLedger(), withDirector = true, ceilingEur, copyPorts = {},
} = {}) {
  const port = campaignPort(script);
  const brain = createCreativeBrain({ complete: port.complete, ledger });
  const contentPlanner = createContentFormatPlanner({ ledger, ...copyPorts });
  const planner = createCampaignPlanner({
    brain, contentPlanner, assetDirector: withDirector ? createAssetDirector({ complete: port.complete }) : null, ledger, store, ...(ceilingEur ? { ceilingEur } : {}),
  });
  return {
    planner, port, store, ledger, brain,
  };
}

export const campaignBrief = () => buildBrief();
export const campaignRequest = (over = {}) => ({
  request_ref: 'campaign:test', locale: 'fr-BE', channel: 'SOCIAL_FEED', requested_format: 'CAROUSEL', audience: 'Parents qui offrent un souvenir', objective: 'Faire connaître l’atelier',
  copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: longText(300, 5) }], ...over,
});
export const proofFact = () => fact({ fact_ref: 'fact://proof', kind: 'PRODUCT_CLAIM', statement: 'Chaque coque est contrôlée à la main avant de partir.' });
