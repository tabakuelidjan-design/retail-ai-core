// What the D production line can do today, what needs an AI provider (none is connected, none is chosen), and what does not exist.
// Provider-needing capabilities are NOT re-implemented here: they go through the ports that already exist (Creative layered runtime `ports.layers`, Creative Brain model port,
// provider-connections vault). Connecting one needs the owner's authorisation, a key and a budget (see docs/chantier-d/ETAT-REEL.md).

export const CAPABILITY_STATUS = Object.freeze({ AVAILABLE_NOW: 'AVAILABLE_NOW', PROVIDER_REQUIRED: 'PROVIDER_REQUIRED', NOT_IMPLEMENTED: 'NOT_IMPLEMENTED', NEEDS_HUMAN_INPUT: 'NEEDS_HUMAN_INPUT' });
const S = CAPABILITY_STATUS;

export const CAPABILITIES = Object.freeze([
  { id: 'TYPOGRAPHIC_COMPOSITION', status: S.AVAILABLE_NOW, via: 'src/studio-compose/compose.js + templates/habb.js', note: 'locked copy, Playfair Display + Montserrat, HABB palette, measured safe zones and contrast' },
  { id: 'REAL_PRODUCT_PLACEMENT', status: S.AVAILABLE_NOW, via: 'compose.js (image layer, contain)', note: 'whole product, no crop, no distortion, no overlap, pixels compared after drawing; the source must be a PNG with rights recorded' },
  { id: 'JPEG_EXPORT_FOR_INSTAGRAM', status: S.AVAILABLE_NOW, via: 'src/studio-compose/jpeg.js', note: 'baseline JPEG, deterministic; E requires JPEG for automatic Instagram images' },
  { id: 'DELIVERY_TO_SOCIAL_PUBLISHING', status: S.AVAILABLE_NOW, via: 'src/asset-library/social-proposal.js', note: 'social-post-proposal.v1 + asset package; proposals only, the owner approves in E' },
  { id: 'FIGURE_EXACT_TEXT_AND_PRICE_CHECK', status: S.AVAILABLE_NOW, via: 'compose.js COPY_EXACT + social-proposal.js claim mirror', note: 'a price other than the confirmed coque price is refused' },
  { id: 'MODIFY_ONE_ELEMENT_WITHOUT_REBUILD', status: S.AVAILABLE_NOW, via: 'spec layers are independent; a new version is a new asset (E voids any approval)', note: 'change one layer of the spec, recompose: the other layers are byte-identical' },
  { id: 'PHOTOGRAPH_OF_THE_SHOP_OR_FINISHED_OBJECTS', status: S.NEEDS_HUMAN_INPUT, via: 'owner', note: 'no HABB-taken photograph exists on disk; shooting list in the editorial plan' },
  { id: 'VIDEO_REEL', status: S.NEEDS_HUMAN_INPUT, via: 'owner footage', note: 'scripts and shot plans only; no video is generated or edited here' },
  { id: 'SCENE_OR_BACKGROUND_GENERATION', status: S.PROVIDER_REQUIRED, via: 'Creative layered runtime ports.layers', note: 'no provider connected; no provider chosen' },
  { id: 'CREATIVE_BRAIN_CONCEPTING', status: S.PROVIDER_REQUIRED, via: 'Creative Brain model port', note: 'concept / art direction by a model; the benchmark attempts were stopped by the owner' },
  { id: 'SEGMENTATION_OF_PHOTOGRAPHS', status: S.PROVIDER_REQUIRED, via: 'Creative segmentation port', note: 'local segmenter only handles plain-ground opaque photographs' },
  { id: 'VISION_CRITIC', status: S.PROVIDER_REQUIRED, via: 'Creative critic port', note: 'no visual critic: a person is the only judge of aesthetics' },
  { id: 'MASKED_EDIT_OR_RELIGHT', status: S.NOT_IMPLEMENTED, via: '-', note: 'refused rather than approximated' },
  { id: 'AUTOMATIC_PUBLICATION', status: S.NOT_IMPLEMENTED, via: 'chantier E', note: 'not D\'s role; E is MANUAL / SIMULATION until the owner connects accounts' },
]);

export const capabilitySummary = () => {
  const out = {};
  for (const c of CAPABILITIES) out[c.status] = [...(out[c.status] ?? []), c.id];
  return out;
};
