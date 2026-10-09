import test from 'node:test';
import assert from 'node:assert/strict';

import * as CI from '../src/creative-intelligence/index.js';
import {
  ASSET_PRODUCT, CLAIM_PRICE, FONT, LATER, assetDims, backgroundLayer, checkOf, clone, code, demoDocument, demoLayers, documentParts, fonts, isDeepFrozen,
  logoLayer, preflightContext, productLayer, textLayer,
} from './creative-intelligence-fixtures.js';

// `// N text` markers are rows of the coverage matrix (docs/architecture/creative-intelligence-v1.md).

// ------------------------------------------------------------------ DesignDocument (56-80)

test('DesignDocument: a closed, content-addressed, versioned scene graph', () => {
  const doc = demoDocument();
  // 56 a valid document is built and deep-frozen
  assert.ok(isDeepFrozen(doc));
  assert.equal(doc.layers.length, 7);
  // 57 document_id is derived from the content
  assert.match(doc.document_id, /^cdd_[0-9a-f]{32}$/);
  assert.equal(demoDocument().document_id, doc.document_id);
  assert.notEqual(demoDocument({ created_at: LATER }).document_id, doc.document_id);
  // 58 a forged document_id is refused
  assert.equal(code(() => CI.normalizeDesignDocument({ ...clone(doc), document_id: 'cdd_forged' })), CI.CI_ERROR.ID_MISMATCH);
  assert.equal(CI.normalizeDesignDocument(clone(doc)).document_id, doc.document_id);
  // 59 an unknown top-level key is refused
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ renderer: 'x' }))), CI.CI_ERROR.UNKNOWN_KEY);
  // 60 an unknown layer key is refused
  const withExtra = demoLayers();
  withExtra[3].shadow_css = 'drop-shadow(0 0 4px #000)';
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ layers: withExtra }))), CI.CI_ERROR.UNKNOWN_KEY);
  // 61 layers are stored in canonical order (z_index, then id)
  const shuffled = demoLayers().reverse();
  const canon = CI.buildDesignDocument(documentParts({ layers: shuffled }));
  assert.deepEqual(canon.layers.map((l) => l.z_index), [...canon.layers.map((l) => l.z_index)].sort((a, b) => a - b));
  assert.equal(canon.document_id, doc.document_id);
  // 62 a URL cannot be a layer source
  const urlSource = demoLayers();
  urlSource[2] = logoLayer({ source_ref: 'https://cdn.example.com/logo.png' });
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ layers: urlSource }))), CI.CI_ERROR.INVALID_REFERENCE);
  // 63 a URL cannot be a document reference
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ brief_ref: 'https://brief.example.com/1' }))), CI.CI_ERROR.INVALID_REFERENCE);
  // 64 raw media (a data URI) cannot be canonical truth
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ asset_refs: ['data:image/png;base64,iVBORw0KGgo='] }))), CI.CI_ERROR.INVALID_REFERENCE);
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ asset_refs: ['blob:abc'] }))), CI.CI_ERROR.INVALID_REFERENCE);
  // 65 a provider secret or a provider parameter has no place in the document
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ api_key: 'k' }))), CI.CI_ERROR.UNKNOWN_KEY);
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ provenance: { ...documentParts().provenance, model: 'm' } }))), CI.CI_ERROR.UNKNOWN_KEY);
  // 66 version is a positive integer
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ version: 0 }))), CI.CI_ERROR.DOCUMENT_INVALID);
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ version: 1.5 }))), CI.CI_ERROR.DOCUMENT_INVALID);
  // 67 a revision bumps the version and chains to its parent
  const revised = CI.reviseDesignDocument(doc, { layers: clone(doc.layers), created_at: LATER });
  assert.equal(revised.version, 2);
  assert.equal(revised.provenance.parent_document_ref, doc.document_id);
  assert.notEqual(revised.document_id, doc.document_id);
  // 68 an ADAPT / REFINE / REUSE document names its parent
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ provenance: { ...documentParts().provenance, derivation: 'ADAPT' } }))), CI.CI_ERROR.DOCUMENT_INVALID);
  // 69 a locked layer cannot be modified by a revision
  const locked = CI.buildDesignDocument(documentParts({ layers: [backgroundLayer({ locked: true }), productLayer(), logoLayer(), ...demoLayers().slice(3)] }));
  const edited = clone(locked.layers).map((l) => (l.id === 'bg' ? { ...l, fill: '#000000' } : l));
  assert.equal(code(() => CI.reviseDesignDocument(locked, { layers: edited, created_at: LATER })), CI.CI_ERROR.LAYER_LOCKED);
  // 70 a locked layer cannot be removed by a revision
  assert.equal(code(() => CI.reviseDesignDocument(locked, { layers: clone(locked.layers).filter((l) => l.id !== 'bg'), created_at: LATER })), CI.CI_ERROR.LAYER_LOCKED);
  assert.equal(CI.reviseDesignDocument(locked, { layers: clone(locked.layers), created_at: LATER }).version, 2);
  // 71 a duplicate layer id is structurally accepted and reported by the preflight (not thrown mid-iteration)
  const dup = CI.buildDesignDocument(documentParts({ layers: [...demoLayers(), textLayer('headline', 'CAPTION', 'Encore un', { z_index: 30 })] }));
  assert.equal(checkOf(CI.runCreativePreflight(dup, preflightContext()), 'DUPLICATE_LAYER_ID').status, 'FAIL');
  // 72 the layer count is bounded
  const many = Array.from({ length: CI.MAX_LAYERS + 1 }, (_, i) => backgroundLayer({ id: `bg${i}`, z_index: i }));
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ layers: many }))), CI.CI_ERROR.DOCUMENT_INVALID);
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ layers: [] }))), CI.CI_ERROR.DOCUMENT_INVALID);
  // 73 the canvas is validated and its colour is normalized to #RRGGBB
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ canvas: { width: 10, height: 10, background_color: '#FFF' } }))), CI.CI_ERROR.CANVAS_INVALID);
  assert.equal(CI.buildDesignDocument(documentParts({ canvas: { width: 1080, height: 1350, background_color: '#fbf' } })).canvas.background_color, '#FFBBFF');
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ canvas: { width: 1080, height: 1350, background_color: 'red' } }))), CI.CI_ERROR.COLOR_INVALID);
  // 74 a document-level constraint names its subject
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ constraints: [{ kind: 'WITHIN_SAFE_ZONE' }] }))), CI.CI_ERROR.CONSTRAINT_INVALID);
  assert.ok(CI.buildDesignDocument(documentParts({ constraints: [{ kind: 'WITHIN_SAFE_ZONE', subject: 'price' }] })));
  // 75 constraint kinds are closed and their parameters are checked
  assert.equal(code(() => CI.normalizeConstraint({ kind: 'MAKE_IT_POP' }, 'c')), CI.CI_ERROR.CONSTRAINT_INVALID);
  assert.equal(code(() => CI.normalizeConstraint({ kind: 'NO_OVERLAP' }, 'c')), CI.CI_ERROR.CONSTRAINT_INVALID);
  assert.equal(code(() => CI.normalizeConstraint({ kind: 'MIN_MARGIN' }, 'c')), CI.CI_ERROR.CONSTRAINT_INVALID);
  assert.equal(code(() => CI.normalizeConstraint({ kind: 'WITHIN_SAFE_ZONE', target: 'x' }, 'c')), CI.CI_ERROR.CONSTRAINT_INVALID);
  // 76 effects are closed and bounded
  const fx = (effects) => { const l = demoLayers(); l[2] = logoLayer({ effects }); return documentParts({ layers: l }); };
  assert.equal(code(() => CI.buildDesignDocument(fx([{ kind: 'GLOW' }]))), CI.CI_ERROR.EFFECT_INVALID);
  assert.equal(code(() => CI.buildDesignDocument(fx([{ kind: 'SHADOW', dx: 0, dy: 900, blur: 4, color: '#000', opacity: 0.2 }]))), CI.CI_ERROR.EFFECT_INVALID);
  assert.ok(CI.buildDesignDocument(fx([{ kind: 'SHADOW', dx: 0, dy: 6, blur: 12, color: '#000', opacity: 0.2 }])));
  // 77 geometry is finite and has a positive size
  for (const geometry of [{ x: NaN, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 10, height: -3 }, { x: Infinity, y: 0, width: 1, height: 1 }]) {
    const l = demoLayers(); l[2] = logoLayer({ geometry });
    assert.equal(code(() => CI.buildDesignDocument(documentParts({ layers: l }))), CI.CI_ERROR.GEOMETRY_INVALID);
  }
  // 78 a group lists its members
  const group = (members) => ({ id: 'grp', type: 'GROUP', z_index: 5, geometry: { x: 0, y: 0, width: 10, height: 10, rotation_deg: 0 }, visibility: 'VISIBLE', locked: false, source_ref: null, constraints: [], effects: [], provenance: { origin: 'ENGINE', producer_ref: null, evidence_refs: [] }, members });
  assert.equal(code(() => CI.normalizeLayer(group([]))), CI.CI_ERROR.LAYER_INVALID);
  assert.deepEqual(CI.normalizeLayer(group(['b', 'a', 'a'])).members, ['a', 'b']);
  // 79 the provenance names this contract version
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ provenance: { ...documentParts().provenance, schema_version: 'other.v9' } }))), CI.CI_ERROR.DOCUMENT_INVALID);
  // 80 normalizing a normalized document returns the same document
  assert.equal(CI.normalizeDesignDocument(doc).document_id, doc.document_id);
  assert.deepEqual(clone(CI.normalizeDesignDocument(clone(doc))), clone(doc));
});

// ------------------------------------------------------------------ text layers (81-100)

const withText = (text) => { const l = demoLayers(); l[3] = text; return () => CI.buildDesignDocument(documentParts({ layers: l })); };
const textRaw = (over = {}) => ({ ...textLayer('headline', 'HEADLINE', 'Votre coque, votre style'), ...over });

test('Text layers: the characters are the approved characters; fact-bearing text always has a claim basis', () => {
  // 81 the content is preserved exactly (NFC-normalized, nothing trimmed or altered)
  const doc = demoDocument();
  assert.equal(doc.layers.find((l) => l.id === 'headline').content, 'Votre coque, votre style');
  assert.equal(CI.normalizeLayer(textRaw({ content: 'Café' })).content, 'Café');
  // 82 claim-bearing text needs a claim reference
  assert.equal(code(withText(textRaw({ text_kind: 'CLAIM_BEARING', claim_ref: null }))), CI.CI_ERROR.CLAIM_BASIS_MISSING);
  // 83 claim-bearing text needs the digest of the approved wording
  assert.equal(code(withText(textRaw({ text_role: 'PRICE', text_kind: 'CLAIM_BEARING', claim_ref: CLAIM_PRICE, approved_digest: null }))), CI.CI_ERROR.TEXT_DIGEST_MISMATCH);
  // 84 a price that changed after approval is refused
  const price = textLayer('price', 'PRICE', '25,00 €', { claim_ref: CLAIM_PRICE });
  assert.ok(CI.normalizeLayer(price));
  assert.equal(code(() => CI.normalizeLayer({ ...price, content: '22,00 €' })), CI.CI_ERROR.TEXT_DIGEST_MISMATCH);
  assert.equal(code(() => CI.normalizeLayer({ ...price, content: '25,00 € ' })), CI.CI_ERROR.TEXT_LAYER_INVALID);
  // 85 non-claim text cannot carry a claim reference or a digest
  assert.equal(code(() => CI.normalizeLayer(textRaw({ claim_ref: CLAIM_PRICE }))), CI.CI_ERROR.TEXT_LAYER_INVALID);
  assert.equal(code(() => CI.normalizeLayer(textRaw({ approved_digest: 'a'.repeat(64) }))), CI.CI_ERROR.TEXT_LAYER_INVALID);
  // 86 non-claim text cannot contain a number
  assert.equal(code(() => CI.normalizeLayer(textRaw({ content: 'Depuis 1987' }))), CI.CI_ERROR.NON_CLAIM_TEXT_FACTUAL);
  assert.equal(code(() => CI.normalizeLayer(textRaw({ content: 'Dès ٢٥ pièces' }))), CI.CI_ERROR.NON_CLAIM_TEXT_FACTUAL);
  // 87 non-claim text cannot contain a currency sign or a percentage
  for (const content of ['Super €', 'Offre %', 'Prix $', 'Prix £']) assert.equal(code(() => CI.normalizeLayer(textRaw({ content }))), CI.CI_ERROR.NON_CLAIM_TEXT_FACTUAL, content);
  // 88 a PRICE text must be claim-bearing
  assert.equal(code(() => CI.normalizeLayer(textRaw({ text_role: 'PRICE', content: 'Pas cher' }))), CI.CI_ERROR.CLAIM_BASIS_MISSING);
  // 89 a LEGAL text must be claim-bearing
  assert.equal(code(() => CI.normalizeLayer(textRaw({ text_role: 'LEGAL', content: 'Conditions en magasin' }))), CI.CI_ERROR.CLAIM_BASIS_MISSING);
  // 90 decorative text cannot carry a claim
  assert.equal(code(() => CI.normalizeLayer(textLayer('d', 'DECORATIVE', 'Joli', { claim_ref: CLAIM_PRICE }))), CI.CI_ERROR.TEXT_LAYER_INVALID);
  // 91 decorative, non-factual text is allowed without any claim
  assert.equal(CI.normalizeLayer(textRaw({ text_role: 'DECORATIVE', content: 'Fait main, avec soin' })).text_kind, 'NON_CLAIM_CREATIVE_TEXT');
  // 92 a text layer must say what it is: there is no free factual path
  const missingKind = textRaw(); delete missingKind.text_kind;
  assert.equal(code(() => CI.normalizeLayer(missingKind)), CI.CI_ERROR.CLAIM_BASIS_MISSING);
  assert.equal(code(() => CI.normalizeLayer(textRaw({ text_kind: 'FREE_TEXT' }))), CI.CI_ERROR.TEXT_LAYER_INVALID);
  // 93 whitespace that could not survive rendering is refused (tab, double space, padding, empty)
  for (const content of ['Deux  espaces', ' début', 'fin ', 'tab\tici', 'ligne \nfin', '   ']) assert.ok(code(() => CI.normalizeLayer(textRaw({ content }))) !== 'NO_ERROR', JSON.stringify(content));
  assert.equal(CI.normalizeLayer(textRaw({ content: 'Une ligne\nUne autre' })).content, 'Une ligne\nUne autre');
  // 94 font sizes are bounded
  assert.equal(code(() => CI.normalizeLayer(textRaw({ font_size: 0 }))), CI.CI_ERROR.TEXT_LAYER_INVALID);
  assert.equal(code(() => CI.normalizeLayer(textRaw({ min_font_size: 99999 }))), CI.CI_ERROR.TEXT_LAYER_INVALID);
  // 95 max_lines is a bounded integer
  assert.equal(code(() => CI.normalizeLayer(textRaw({ max_lines: 0 }))), CI.CI_ERROR.TEXT_LAYER_INVALID);
  assert.equal(code(() => CI.normalizeLayer(textRaw({ max_lines: 2.5 }))), CI.CI_ERROR.TEXT_LAYER_INVALID);
  // 96 the overflow policy is one of FAIL / REWRITE_REQUIRED / RELAYOUT_REQUIRED
  for (const policy of ['FAIL', 'REWRITE_REQUIRED', 'RELAYOUT_REQUIRED']) assert.equal(CI.normalizeLayer(textRaw({ overflow_policy: policy })).overflow_policy, policy);
  assert.equal(code(() => CI.normalizeLayer(textRaw({ overflow_policy: 'SHRINK_SILENTLY' }))), CI.CI_ERROR.TEXT_LAYER_INVALID);
  // 97 alignment is logical (START / CENTER / END), never LEFT / RIGHT
  assert.equal(code(() => CI.normalizeLayer(textRaw({ alignment: 'LEFT' }))), CI.CI_ERROR.TEXT_LAYER_INVALID);
  assert.equal(CI.normalizeLayer(textRaw({ alignment: 'END' })).alignment, 'END');
  // 98 the locale is normalized
  assert.equal(CI.normalizeLayer(textRaw({ locale: 'fr-be' })).locale, 'fr-BE');
  assert.equal(code(() => CI.normalizeLayer(textRaw({ locale: 'not a locale' }))), CI.CI_ERROR.INVALID_FIELD);
  // 99 the direction is LTR or RTL
  assert.equal(CI.normalizeLayer(textRaw({ direction: 'RTL' })).direction, 'RTL');
  assert.equal(code(() => CI.normalizeLayer(textRaw({ direction: 'TTB' }))), CI.CI_ERROR.TEXT_LAYER_INVALID);
  // 100 a text layer has no source reference and no unknown key
  assert.equal(code(() => CI.normalizeLayer(textRaw({ source_ref: 'asset:x' }))), CI.CI_ERROR.TEXT_LAYER_INVALID);
  assert.equal(code(() => CI.normalizeLayer(textRaw({ html: '<b>x</b>' }))), CI.CI_ERROR.UNKNOWN_KEY);
});

// ------------------------------------------------------------------ product layers (101-115)

const pl = (over) => () => CI.normalizeLayer(productLayer(over));

test('Product layers: the real product pixels are placed, never mutated', () => {
  // 101 a valid product layer is normalized
  const layer = CI.normalizeLayer(productLayer());
  assert.equal(layer.preservation_mode, 'COMPOSITE');
  assert.ok(isDeepFrozen(layer));
  // 102 PIXEL_PRESERVE forbids relighting
  assert.equal(code(pl({ preservation_mode: 'PIXEL_PRESERVE', allow_relight: true })), CI.CI_ERROR.PRODUCT_PIXEL_MUTATION);
  // 103 PIXEL_PRESERVE forbids rotation and cropping
  assert.equal(code(pl({ preservation_mode: 'PIXEL_PRESERVE', allow_rotation: true })), CI.CI_ERROR.PRODUCT_PIXEL_MUTATION);
  assert.equal(code(pl({ preservation_mode: 'PIXEL_PRESERVE', allow_crop: true })), CI.CI_ERROR.PRODUCT_PIXEL_MUTATION);
  // 104 COMPOSITE forbids relighting
  assert.equal(code(pl({ allow_relight: true })), CI.CI_ERROR.PRODUCT_PIXEL_MUTATION);
  // 105 a rotated product needs allow_rotation
  const rotated = { x: 0, y: 0, width: 100, height: 100, rotation_deg: 12 };
  assert.equal(code(pl({ geometry: rotated })), CI.CI_ERROR.PRODUCT_PIXEL_MUTATION);
  assert.ok(CI.normalizeLayer(productLayer({ geometry: rotated, allow_rotation: true })));
  // 106 a shadow needs allow_shadow
  const shadow = [{ kind: 'SHADOW', dx: 0, dy: 8, blur: 16, color: '#000000', opacity: 0.2 }];
  assert.equal(code(pl({ allow_shadow: false, effects: shadow })), CI.CI_ERROR.PRODUCT_PIXEL_MUTATION);
  assert.ok(CI.normalizeLayer(productLayer({ effects: shadow })));
  // 107 an opacity change on a product is refused (it would alter how its pixels read)
  assert.equal(code(pl({ effects: [{ kind: 'OPACITY', value: 0.5 }] })), CI.CI_ERROR.PRODUCT_PIXEL_MUTATION);
  // 108 a product is sourced through asset_ref, not source_ref
  assert.equal(code(pl({ asset_ref: undefined })), CI.CI_ERROR.INVALID_REFERENCE);
  assert.equal(code(pl({ source_ref: ASSET_PRODUCT })), CI.CI_ERROR.PRODUCT_LAYER_INVALID);
  // 109 protected regions are fractions inside the asset
  assert.equal(code(pl({ protected_regions: [{ region_id: 'r', x: 0.9, y: 0.9, width: 0.5, height: 0.5 }] })), CI.CI_ERROR.REGION_INVALID);
  // 110 the renderer scales the product uniformly ("meet") and never stretches it
  const svg = CI.renderDesignDocument({ document: demoDocument(), fonts: fonts() }).svg;
  assert.match(svg, /data-type="PRODUCT"[^>]*preserveAspectRatio="xMidYMid meet"/);
  assert.doesNotMatch(svg, /preserveAspectRatio="none"/);
  // 111 CONTROLLED_EDIT and GENERATIVE_REFERENCE layers cannot be rendered by C1
  for (const mode of ['CONTROLLED_EDIT', 'GENERATIVE_REFERENCE']) {
    const l = demoLayers(); l[1] = productLayer({ preservation_mode: mode });
    const d = CI.buildDesignDocument(documentParts({ layers: l }));
    assert.equal(code(() => CI.renderDesignDocument({ document: d, fonts: fonts() })), CI.CI_ERROR.RENDER_INPUT_INVALID, mode);
  }
  // 112 the product pixels are untouched: the only filter ever applied to a product is its cast shadow
  assert.doesNotMatch(svg, /<image[^>]*data-type="PRODUCT"[^>]*(filter=|opacity=|transform=)/);
  const shadowed = demoLayers(); shadowed[1] = productLayer({ effects: shadow });
  const shadowSvg = CI.renderDesignDocument({ document: CI.buildDesignDocument(documentParts({ layers: shadowed })), fonts: fonts() }).svg;
  assert.match(shadowSvg, /<feDropShadow/);
  assert.doesNotMatch(shadowSvg, /feColorMatrix|feBlend|feGaussianBlur|feComposite/);
  // 113 a product asset that the document does not declare is reported by the preflight
  const undeclared = CI.buildDesignDocument(documentParts({ asset_refs: [] }));
  assert.equal(checkOf(CI.runCreativePreflight(undeclared, preflightContext()), 'MISSING_ASSET_REF').status, 'FAIL');
  // 114 a box whose proportions differ from the real asset is flagged for review (the renderer letterboxes, it never stretches)
  const skewed = demoLayers(); skewed[1] = productLayer({ geometry: { x: 100, y: 400, width: 600, height: 300, rotation_deg: 0 } });
  const skewedReport = CI.runCreativePreflight(CI.buildDesignDocument(documentParts({ layers: skewed })), preflightContext());
  assert.equal(checkOf(skewedReport, 'PRODUCT_ASPECT_MISMATCH').status, 'REVIEW_REQUIRED');
  // 115 an asset whose size is unknown cannot be checked: NOT_MEASURABLE, never PASS
  const { [ASSET_PRODUCT]: _omitted, ...withoutProduct } = assetDims();
  const unknownSize = CI.runCreativePreflight(demoDocument(), preflightContext({ assets: withoutProduct }));
  assert.equal(checkOf(unknownSize, 'PRODUCT_ASPECT_MISMATCH').status, 'NOT_MEASURABLE');
  assert.notEqual(unknownSize.status, 'PASS');
});

test('A font reference in a document is an opaque reference, never a URL', () => {
  assert.equal(code(() => CI.normalizeLayer(textRaw({ font_ref: 'https://fonts.example.com/a.woff2' }))), CI.CI_ERROR.INVALID_REFERENCE);
  assert.equal(CI.normalizeLayer(textRaw({ font_ref: FONT })).font_ref, FONT);
});
