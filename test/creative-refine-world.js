// The world of the REFINE tests: the layered world of Phase 3 (a planned and produced campaign, a fake layer port that records every call and answers from scripted local images, the real segmenter,
// typography, gates and compositor), with scripted CANDIDATES: the n-th candidate of a prop or of a plate is a different image, so that a repair visibly replaces ONE layer. No network, no provider, no cost.
import {
  AT, createLayerBudget, createLayerStore, fakeLayerPort, fonts, GUARDIAN_PASS, calmPlate, layeredHarness, layeredWorld, propOnGround,
} from './creative-layered-runtime-world.js';
import { runLayeredCreative } from '../src/creative-runtime/index.js';
import { ANNOTATIONS } from './runtime-world.js';

export {
  AT, createLayerBudget, createLayerStore, fonts, GUARDIAN_PASS, layeredHarness, layeredWorld, propOnGround, calmPlate,
};

export const PROP_COLOURS = ['#7a4b2a', '#2a6b4a', '#4a2a6b', '#6b4a2a'];
export const PLATE_TONES = [['#eef0f2', '#d4d9de'], ['#f2efe9', '#d9d2c4'], ['#e9f0ee', '#c9d9d2']];
/** The same product with a smaller protected artwork, so that a foreground prop may legally cover part of the rim. */
export const SMALL_ART = { ...ANNOTATIONS, artwork_region: { ...ANNOTATIONS.artwork_region, width: ANNOTATIONS.artwork_region.width * 0.75, height: ANNOTATIONS.artwork_region.height * 0.8 } };

/** A layer port whose n-th candidate is a different image (prop colour / plate tone by index), unless a test overrides it. */
export function scriptedPort(over = {}) {
  return fakeLayerPort({
    plate: (size, { candidate_index: n }) => calmPlate(size, PLATE_TONES[(n - 1) % PLATE_TONES.length]),
    prop: ({ candidate_index: n }) => propOnGround({ colour: PROP_COLOURS[(n - 1) % PROP_COLOURS.length] }),
    ...over,
  });
}

const WORLD = await layeredWorld();
export { WORLD };
export const HEADLINE_SCENE = WORLD.result.scenes.findIndex((s) => s.text_layers.some((t) => t.role === 'HEADLINE'));
export const FOREGROUND_SCENE = WORLD.result.scenes.findIndex((s) => s.layers.some((l) => l.kind === 'PROP_FOREGROUND'));

/** A first layered run of one scene, with everything a refine needs: the candidate, the shared store and budget, and the inputs of the call. */
export async function firstRun({ index = HEADLINE_SCENE, port = scriptedPort(), foreground = false, withBudget = true } = {}) {
  const h = layeredHarness({ layerPort: port });
  const store = createLayerStore(); const budget = withBudget ? createLayerBudget({ production: WORLD.result }) : null;
  const run = {
    at: AT, brief: foreground ? { ...WORLD.brief, identity_annotations: SMALL_ART } : WORLD.brief, fonts, agents: h.agents, ports: h.ports, ledger: h.ledger, guardian: GUARDIAN_PASS, production: WORLD.result,
    scene_id: WORLD.result.scenes[index].scene_id, ...(foreground ? { policy: { placement: { foreground_inset: 0.8 } } } : {}),
  };
  const candidate = await runLayeredCreative({ ...run, store, ...(budget ? { budget } : {}) });
  return { candidate, store, budget, run, port, harness: h };
}
