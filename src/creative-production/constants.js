// CREATIVE PRODUCTION (Phase 3): layered scene production as SPECIFICATION. Closed vocabularies and declared policies of the stage that turns an asset plan into the layers a scene is made of, the requests that would
// produce them, the deterministic compositing that puts them together, the cost of it, and the gate that says whether anything may be sent to a provider. Nothing here calls a provider.
// Nothing here knows a merchant. Figures are DECLARED policy (sizes of generated layers, the share of the product a foreground may cover) or unit costs to recalibrate.

export const SCHEMA = Object.freeze({
  scene: 'scene-production@1', identity: 'product-identity@1', production: 'campaign-production@1', gate: 'provider-gate@1', layer: 'scene-layer@1',
});

/** What a layer is. The order of the bands is the z-order: plate under props under the product under foreground props under text. */
export const LAYER_KIND = Object.freeze({
  PLATE: 'PLATE', PROP_BACKGROUND: 'PROP_BACKGROUND', PROP_MIDGROUND: 'PROP_MIDGROUND', PRODUCT: 'PRODUCT', PROP_FOREGROUND: 'PROP_FOREGROUND', TEXT: 'TEXT',
});
export const LAYER_Z = Object.freeze({
  [LAYER_KIND.PLATE]: 0, [LAYER_KIND.PROP_BACKGROUND]: 10, [LAYER_KIND.PROP_MIDGROUND]: 20, [LAYER_KIND.PRODUCT]: 30, [LAYER_KIND.PROP_FOREGROUND]: 40, [LAYER_KIND.TEXT]: 50,
});
/** Where the pixels of a layer come from. A PRODUCT layer is ALWAYS the real asset; a generated layer is never allowed to be the product. */
export const LAYER_SOURCE = Object.freeze({ REAL_ASSET: 'REAL_ASSET', GENERATED: 'GENERATED', DETERMINISTIC_TEXT: 'DETERMINISTIC_TEXT' });

export const PRODUCT_STATUS = Object.freeze({ VERIFIED: 'VERIFIED', AMBIGUOUS: 'AMBIGUOUS', MISSING: 'MISSING', UNSUPPORTED: 'UNSUPPORTED' });
export const PRODUCT_REASON = Object.freeze({
  NO_PRODUCT_REFERENCE: 'NO_PRODUCT_REFERENCE',
  NO_PRODUCT_ASSET: 'NO_PRODUCT_ASSET',
  PRODUCT_NOT_DESCRIBED: 'PRODUCT_NOT_DESCRIBED',
  ASSET_NOT_PINNED: 'ASSET_NOT_PINNED',
  ASSET_BYTES_DO_NOT_MATCH_THE_PINNED_HASH: 'ASSET_BYTES_DO_NOT_MATCH_THE_PINNED_HASH',
  PRODUCT_DESCRIPTION_MATCHES_SEVERAL_FAMILIES: 'PRODUCT_DESCRIPTION_MATCHES_SEVERAL_FAMILIES',
  CAMPAIGN_NAMES_ANOTHER_PRODUCT: 'CAMPAIGN_NAMES_ANOTHER_PRODUCT',
  NO_OUTLINE_FOR_LOCAL_SEGMENTATION: 'NO_OUTLINE_FOR_LOCAL_SEGMENTATION',
});

/** The state of the production of an asset. INTENT_ONLY is the explicit state of an asset whose scene cannot honestly be specified; it is never filled with a plausible replacement. */
export const PRODUCTION_STATUS = Object.freeze({ SPECIFIED: 'SPECIFIED', BLOCKED: 'BLOCKED', INTENT_ONLY: 'INTENT_ONLY' });
export const BLOCK = Object.freeze({
  PRODUCT_IDENTITY_NOT_VERIFIED: 'PRODUCT_IDENTITY_NOT_VERIFIED',
  ART_DIRECTION_HOLDS_A_SUBSTITUTE: 'ART_DIRECTION_HOLDS_A_SUBSTITUTE',
  LOCKED_COPY_DOES_NOT_FIT_THE_COMPOSITION: 'LOCKED_COPY_DOES_NOT_FIT_THE_COMPOSITION',
  LOCKED_COPY_NOT_RECOVERABLE: 'LOCKED_COPY_NOT_RECOVERABLE',
  PRODUCTION_BLOCKED_BY_BUDGET: 'PRODUCTION_BLOCKED_BY_BUDGET',
  PROVENANCE_BROKEN: 'PROVENANCE_BROKEN',
  UNSUPPORTED_CLAIM_IN_A_LAYER: 'UNSUPPORTED_CLAIM_IN_A_LAYER',
});

/** The capabilities a scene needs that are produced, with the tool class that realizes them. The candidates are declared in capability-router.js. */
export const PRODUCTION_CAPABILITY = Object.freeze({
  ENVIRONMENT_PLATE_GENERATION: 'ENVIRONMENT_PLATE_GENERATION',
  PROP_ON_PLAIN_GROUND_GENERATION: 'PROP_ON_PLAIN_GROUND_GENERATION',
  PROP_CUTOUT: 'PROP_CUTOUT',
  LOCAL_SEGMENTATION: 'LOCAL_SEGMENTATION',
  PRODUCT_CUTOUT: 'PRODUCT_CUTOUT',
  DETERMINISTIC_COMPOSITE: 'DETERMINISTIC_COMPOSITE',
  DETERMINISTIC_TEXT: 'DETERMINISTIC_TEXT',
});

/** How far a foreground prop may cover the real product. Declared policy: the product identity is never covered. */
export const OVERLAP_POLICY = Object.freeze({ NONE: 'NONE', EDGE_ONLY: 'EDGE_ONLY' });
export const OVERLAP_LIMIT = Object.freeze({ NONE: 0, EDGE_ONLY: 0.08 });

/** Declared policy of the generated layers. Quality is not traded for cost: reuse comes first, a budget that cannot hold the layers blocks. */
export const PRODUCTION_POLICY = Object.freeze({
  candidates_per_generated_layer: 2,
  prop_canvas: Object.freeze({ width: 1024, height: 1024, unit: 'px' }),
  max_props_per_asset: 2,
  max_plates_per_campaign: 3,
  vision_calls_per_asset: 2,
  text_stages_per_asset: 1,
  protocol_repairs_per_asset: 1,
});

/** Where an asset's generated layers may be placed, by composition intent: how many props a composition carries and whether a foreground prop may overlap the product. */
export const COMPOSITION_LAYERING = Object.freeze({
  PRODUCT_CENTERED: { props: 1, foreground: false },
  PRODUCT_OFFSET: { props: 1, foreground: false },
  TEXT_FIRST: { props: 0, foreground: false },
  FULL_BLEED_SCENE: { props: 2, foreground: true },
  SPLIT_PANEL: { props: 1, foreground: false },
  CLOSE_CROP: { props: 0, foreground: false },
  WIDE_ESTABLISHING: { props: 2, foreground: true },
});
/** Where the product and the text go, in words (the solver turns them into geometry later). */
export const PLACEMENT = Object.freeze({
  PRODUCT_CENTERED: { product: 'CENTER', text: 'ABOVE_OR_BELOW' }, PRODUCT_OFFSET: { product: 'OFF_CENTER', text: 'BESIDE' }, TEXT_FIRST: { product: 'SMALL_SECONDARY', text: 'MAIN_FIELD' },
  FULL_BLEED_SCENE: { product: 'IN_THE_SCENE', text: 'CALM_ZONE' }, SPLIT_PANEL: { product: 'ONE_PANEL', text: 'THE_OTHER_PANEL' }, CLOSE_CROP: { product: 'CLOSE', text: 'EDGE_BAND' }, WIDE_ESTABLISHING: { product: 'SMALL_IN_THE_SCENE', text: 'CALM_ZONE' },
});

export const GATE_STATUS = Object.freeze({ NOT_READY: 'NOT_READY', READY_PENDING_OWNER_GO: 'READY_PENDING_OWNER_GO', OPEN_BY_OWNER: 'OPEN_BY_OWNER' });
export const GATE_REASON = Object.freeze({
  PRODUCT_IDENTITY_NOT_VERIFIED: 'PRODUCT_IDENTITY_NOT_VERIFIED',
  PRODUCTION_NOT_SPECIFIED: 'PRODUCTION_NOT_SPECIFIED',
  BUDGET_BLOCKED: 'BUDGET_BLOCKED',
  PIPELINE_NOT_READY: 'PIPELINE_NOT_READY',
  OWNER_GO_PENDING: 'OWNER_GO_PENDING',
  COMPOSITOR_NOT_WIRED_TO_THE_RUNTIME: 'COMPOSITOR_NOT_WIRED_TO_THE_RUNTIME',
});

/** The nodes of the production state (labels carry the content key). */
export const PRODUCTION_NODE = Object.freeze({ PLATE: 'SCENE_PLATE', PROP: 'SCENE_PROP', SCENE: 'SCENE', PRODUCT_IDENTITY: 'PRODUCT_IDENTITY' });
export const PRODUCTION_DEPENDS_ON = Object.freeze({
  [PRODUCTION_NODE.PRODUCT_IDENTITY]: [],
  [PRODUCTION_NODE.PLATE]: ['ART_DIRECTION'],
  [PRODUCTION_NODE.PROP]: ['ART_DIRECTION', PRODUCTION_NODE.PRODUCT_IDENTITY],
  [PRODUCTION_NODE.SCENE]: ['ASSET_PLAN', PRODUCTION_NODE.PLATE, PRODUCTION_NODE.PROP, PRODUCTION_NODE.PRODUCT_IDENTITY],
});

/**
 * Unit costs of the generated layers, in EUR, by capability class (never by provider): the worst-case reservations observed on the Creative Brain benchmark, to be recalibrated from measured production costs.
 * The price of an image depends on the size class of the layer (its longest side). A deterministic layer costs nothing.
 */
export const PRODUCTION_UNIT_COSTS = Object.freeze({
  text_stage_eur: 0.03,
  vision_critic_eur: 0.01,
  image_eur_by_size_class: Object.freeze({ UP_TO_1024: 0.034, ABOVE_1024: 0.069 }),
});
