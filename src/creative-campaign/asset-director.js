import {
  obj, renderContract, renderRules, text, validateAnswer,
} from '../creative-brain/contract.js';
import { askAndNormalize } from '../creative-brain/model-port.js';
import { substituteWordsIn } from '../creative-brain/substitutes.js';
import { BRAIN_ERROR, fail } from '../creative-brain/validation.js';

// THE ASSET DIRECTOR. A campaign thinks once about its idea and its art direction; each asset then needs its own imagery brief: what THIS asset shows, so that the assets are individually purposeful. One model
// completion per asset, behind a port, under a closed contract. The model receives the shared concept and art direction (it does not propose another idea), the role, the intents and the copy of the asset
// only, so that the brief of an asset depends on nothing else and one asset can be redone alone. The answer holds no figure and never replaces the real product: the product is "the product", placed by
// Nordla; a scene is described around it.

export const ASSET_BRIEF_SPEC = obj({ imagery_brief: text({ max: 300, geometry: true }), composition_note: text({ max: 200, geometry: true }), rationale: text() });

const ALLOWED_PRODUCT_WORDS = ['product', 'produit'];
const refuse = (words) => fail(BRAIN_ERROR.FORBIDDEN_CONTENT, 'the imagery brief speaks of a substitute for the product, a competing hero object or text', 'asset_brief', { problem: 'ASSET_BRIEF_SUBSTITUTES_THE_PRODUCT', words });

export const ASSET_BRIEF_RULES = Object.freeze([
  {
    id: 'ASSET_BRIEF_NEVER_REPLACES_THE_PRODUCT',
    statement: 'the real product is placed by Nordla and is called only "the product": the imagery brief and the composition note never name a phone, a case, a device, a screen, a box, a logo, a label, text or a competing hero object, nor anything that could stand in for the product',
    check: (v) => { const found = [...new Set([...substituteWordsIn(v.imagery_brief), ...substituteWordsIn(v.composition_note)])].filter((w) => !ALLOWED_PRODUCT_WORDS.includes(w)); if (found.length) refuse(found); },
  },
  { id: 'ASSET_BRIEF_SERVES_THE_SHARED_IDEA', statement: 'the imagery brief serves the shared concept and art direction given in the request and does not propose another idea; it differs from the other assets by its role, its composition and its imagery', enforcedBy: 'ADVISORY: judged by the concept and execution critics' },
  { id: 'ASSET_BRIEF_NAMES_NO_FIGURE', statement: 'the imagery brief holds no digit, colour code or unit: sizes and positions belong to the deterministic layout', enforcedBy: 'closed spec (geometry text)' },
]);
export const ASSET_BRIEF_CONTRACT = Object.freeze({ stage: 'ASSET_BRIEF', spec: ASSET_BRIEF_SPEC, rules: ASSET_BRIEF_RULES });

const conceptWords = (c) => ({ central_idea: c.central_idea, visual_metaphor: c.visual_metaphor, story: c.story, emotional_intent: c.emotional_intent });
const artWords = (a) => ({
  atmosphere: a.atmosphere, material_language: a.material_language, lighting_intent: a.lighting_intent, depth_model: a.depth_model, visual_rhythm: a.visual_rhythm, realism: a.realism, emotional_temperature: a.emotional_temperature,
});

/** The instruction for the imagery brief of ONE asset. */
export function buildAssetBriefInstruction({ concept, artDirection, asset }) {
  const system = [
    'You are the Nordla asset director. A campaign of several assets shares one concept and one art direction. You write the imagery brief of ONE asset: what it shows and how it is composed, so that it plays its own part in the sequence.',
    'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):',
    ...renderContract(ASSET_BRIEF_SPEC, 'answer'),
    ...renderRules(ASSET_BRIEF_RULES),
    'You never use JSON numbers. rationale is one concise sentence of why this brief, for the record; it is not a reasoning log.',
  ].join('\n');
  const user = JSON.stringify({
    shared_concept: conceptWords(concept),
    shared_art_direction: artWords(artDirection),
    asset: {
      position: asset.position, of: asset.of, narrative_role: asset.narrative_role, density_class: asset.density_class, composition_intent: asset.composition_intent, imagery_intent: asset.imagery_intent, crop_scale: asset.crop_scale, copy: asset.copy, hint: asset.hint ?? null,
    },
  });
  return { system, user };
}

/** The ASSET_BRIEF stage: one model completion behind the port, then the closed contract and the guard. */
export function createAssetDirector({ complete }) {
  return Object.freeze({
    async brief({ concept, artDirection, asset }) {
      const { value, meta } = await askAndNormalize({
        complete, instruction: buildAssetBriefInstruction({ concept, artDirection, asset }), stage: 'ASSET_BRIEF', spec: ASSET_BRIEF_SPEC, normalize: (raw) => validateAnswer(ASSET_BRIEF_CONTRACT, raw, 'asset_brief'),
      });
      return { imagery_brief: value.imagery_brief, composition_note: value.composition_note, rationale: value.rationale, meta };
    },
  });
}
