// The candidate manifest for Brand Guardian, built from the actual DesignDocument and the actual Creative Fidelity gate result (never from a guess):
// structured FACTS only (refs, colours, family names, text fragments, claim refs, a gate status), no media. Fidelity is evaluated BEFORE this is built and is only
// consumed here: Guardian never recomputes product fidelity, and there is no circular evaluation.
//
// Colours are the DECLARED colours of the document (canvas, fills, strokes, text, shadow colours). The pixels of a merchant photograph are not constrained and not
// observed. Coverage is COMPLETE because the document model is the complete inventory of what the creative declares.

import { fidelityGateObservation } from '../branding/candidate-manifest.js';
import { LAYER_TYPE } from './constants.js';

export const MANIFEST_SUBJECTS = Object.freeze({
  colors: 'canvas.colors',
  families: 'text.families',
  fragments: 'text.fragments',
  claims: 'text.claims',
  assets: 'product.asset',
});

const upper = (hex) => hex.toUpperCase();

export function buildCandidateManifest({ document, fonts, fidelityGate, evidenceRefs = [] } = {}) {
  const colors = new Set([document.canvas.background_color]);
  const families = new Set();
  const fragments = [];
  const assets = new Set();
  let carriesProduct = false;
  for (const layer of document.layers) {
    if (layer.visibility === 'HIDDEN') continue;
    if (layer.fill) colors.add(layer.fill);
    if (layer.stroke) colors.add(layer.stroke);
    for (const effect of layer.effects ?? []) if (effect.color) colors.add(effect.color);
    if (layer.type === LAYER_TYPE.TEXT) {
      colors.add(layer.color);
      const font = fonts.get(layer.font_ref);
      if (font) families.add(font.family);
      fragments.push(layer.content);
    }
    if (layer.type === LAYER_TYPE.PRODUCT) { carriesProduct = true; assets.add(layer.asset_ref); }
    if (layer.type === LAYER_TYPE.IMAGE) assets.add(layer.source_ref);
    if (layer.type === LAYER_TYPE.LOGO && layer.source_ref) assets.add(layer.source_ref);
  }
  const complete = (subject, values) => ({
    subject, coverage: 'COMPLETE', values, evidence_refs: evidenceRefs,
  });
  const textFonts = document.layers.filter((l) => l.type === LAYER_TYPE.TEXT && l.visibility !== 'HIDDEN');
  const allFamiliesKnown = textFonts.every((l) => fonts.get(l.font_ref));
  return {
    content_kind: document.output_context.content_kind,
    assets: [complete(MANIFEST_SUBJECTS.assets, [...assets].sort())],
    colors: [complete(MANIFEST_SUBJECTS.colors, [...colors].map(upper).sort())],
    // a family that cannot be resolved is not guessed: the observation is then UNAVAILABLE and the rule cannot be judged
    typography: [allFamiliesKnown
      ? complete(MANIFEST_SUBJECTS.families, [...families].sort())
      : { subject: MANIFEST_SUBJECTS.families, coverage: 'UNAVAILABLE', values: [], evidence_refs: evidenceRefs }],
    text: [complete(MANIFEST_SUBJECTS.fragments, fragments)],
    claims: [complete(MANIFEST_SUBJECTS.claims, [...document.claim_refs].sort())],
    // a candidate without product imagery has no product-fidelity observation at all
    external_gates: carriesProduct && fidelityGate ? [fidelityGateObservation({ gate: fidelityGate, evidenceRefs })] : [],
  };
}
