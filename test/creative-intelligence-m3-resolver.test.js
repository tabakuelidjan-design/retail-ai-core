import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import * as CI from '../src/creative-intelligence/index.js';
import {
  ASSET_LOGO, ASSET_PRODUCT, CLAIM_PRICE, IDS, LATER, NOW, PAYLOAD, PRODUCT, acode, assetDims, backgroundLayer, candidateFor, clone, code, demoDocument, documentParts, fonts,
  intakeInput, isDeepFrozen, resolveAllMedia, resolutionFor, solved, textLayer,
} from './creative-intelligence-fixtures.js';
import { M1, M2, buildM3World, posterFormat, tenant } from './creative-intelligence-m3-world.js';
import { registerEvidence } from '../src/creative-intelligence/readiness.js';

// Evidence as the package's own verifications issue it. The REAL verifications are exercised in creative-pre-c2-foundation.test.js; here the
// readiness AGGREGATION is tested, so the evidence is registered directly.
const evidenceFor = (dependency) => registerEvidence(Object.freeze({
  dependency, status: 'VERIFIED', verified_by: 'test', evidence_ref: `probe://${dependency.toLowerCase()}/test`, details: Object.freeze({}),
}));

// `// N text` markers are rows of the coverage matrix (docs/architecture/creative-intelligence-v1.md). Rows 256+ belong to the final
// architect audit: real Marketing M3 compatibility, the resource resolver boundary, canonical ref vs payload, no style defaults, pre-C2.

const AT = '2026-10-09T10:30:00Z';
const WORLD = buildM3World();
const intakeOf = (over = {}) => CI.buildIntakeFromHandoff({
  handoff: WORLD.handoff, deliverable_ref: WORLD.imageSpec.deliverable_id, resolved_format: posterFormat(), created_at: AT, ...over,
});
const union = (...lists) => [...new Set(lists.flat())].sort();
const srcDir = new URL('../src/creative-intelligence/', import.meta.url);
const sources = async () => {
  const out = {};
  for (const file of await readdir(srcDir)) out[file] = await readFile(new URL(file, srcDir), 'utf8');
  return out;
};

// ------------------------------------------------------------------ real M3 -> C1 (256-278)

test('Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed', async () => {
  const { handoff, brief, imageSpec } = WORLD;
  const intake = intakeOf();
  // 256 a real CreativeHandoffPackage (real Marketing and Branding builders) becomes a valid, deep-frozen C1 intake
  assert.match(handoff.handoff_id, /^mch_/);
  assert.ok(handoff.brand_interface && handoff.creative_brief);
  assert.match(intake.intake_id, /^cin_/);
  assert.ok(isDeepFrozen(intake));
  // 257 merchant and brand are preserved
  assert.equal(intake.merchant_id, brief.merchant_id);
  assert.equal(intake.brand_id, brief.brand_id);
  assert.equal(intake.merchant_id, M1);
  // 258 the Brief, the deliverable and the brand interface (through the handoff) are pinned by reference
  assert.equal(intake.brief_ref, brief.brief_id);
  assert.equal(intake.deliverable_ref, imageSpec.deliverable_id);
  assert.equal(intake.brand_context_ref, handoff.handoff_id);
  // 259 subject_refs are preserved exactly and stay untyped: a category is not turned into a product
  assert.deepEqual(intake.subject_refs, [...brief.subject_refs].sort());
  assert.deepEqual(intake.subject_refs, ['category://phone-cases']);
  assert.ok(!('product_refs' in intake));
  // 260 source assets: the Brief's and the deliverable's, preserved
  assert.deepEqual(intake.source_asset_refs, union(brief.source_asset_refs, imageSpec.source_asset_refs));
  assert.deepEqual(intake.source_asset_refs, ['asset://product-1', 'asset://product-2']);
  // 261 claims are preserved
  assert.deepEqual(intake.claim_refs, [...brief.claim_refs].sort());
  // 262 the channel is the deliverable's
  assert.equal(intake.output_context.channel, imageSpec.channel);
  // 263 the placement is the deliverable's
  assert.equal(intake.output_context.placement, imageSpec.placement);
  // 264 the locale is the deliverable's (the direction is the platform rule for that language, not a choice)
  assert.equal(intake.output_context.locale, imageSpec.locale);
  assert.equal(intake.output_context.direction, 'LTR');
  // 265 the format reference is preserved; the canvas comes from the RESOLVED format, never from the reference text
  assert.equal(intake.output_context.format_ref, imageSpec.format_ref);
  assert.deepEqual(intake.output_context.canvas, { width: posterFormat().metadata.canvas.width, height: posterFormat().metadata.canvas.height });
  const other = intakeOf({ resolved_format: posterFormat({ metadata: { ...posterFormat().metadata, canvas: { width: 1000, height: 1400, unit: 'px' }, safe_zones: [] } }) });
  assert.deepEqual(other.output_context.canvas, { width: 1000, height: 1400 });
  // the aspect ratio is derived from that canvas - the format states none
  assert.equal(other.output_context.aspect_ratio, '5:7');
  assert.equal(intake.output_context.aspect_ratio, CI.reducedAspectRatio(2000, 2800));
  assert.ok(!('aspect_ratio' in posterFormat().metadata));
  // channel and placement are Marketing deliverable facts: a format cannot state them
  for (const key of ['channel', 'placement', 'aspect_ratio']) assert.equal(code(() => intakeOf({ resolved_format: posterFormat({ metadata: { ...posterFormat().metadata, [key]: 'X' } }) })), CI.CI_ERROR.RESOURCE_INVALID, key);
  // C1 renders in px: another unit is refused, not converted
  assert.equal(code(() => intakeOf({ resolved_format: posterFormat({ metadata: { ...posterFormat().metadata, canvas: { width: 210, height: 297, unit: 'mm' } } }) })), CI.CI_ERROR.CANVAS_INVALID);
  // 266 mandatory content: the Brief's and the deliverable's
  assert.deepEqual(intake.mandatory_content_refs, union(brief.mandatory_content_refs, imageSpec.mandatory_content_refs));
  // 267 prohibited content is preserved
  assert.deepEqual(intake.prohibited_content_refs, [...brief.prohibited_content_refs].sort());
  // 268 the deliverable's requirement refs are preserved
  assert.deepEqual(intake.requirement_refs, [...imageSpec.requirement_refs].sort());
  // 269 policy, consent and promotion refs are preserved
  assert.deepEqual(intake.policy_requirement_refs, [...brief.policy_requirement_refs].sort());
  assert.deepEqual(intake.consent_requirement_refs, [...brief.consent_requirement_refs].sort());
  assert.deepEqual(intake.promotion_rule_refs, [...brief.promotion_rule_refs].sort());
  // 270 the deadline is preserved
  assert.equal(intake.needed_by, imageSpec.needed_by);
  // 271 no business truth of Marketing is copied into Creative
  const keys = new Set();
  const walk = (v) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk(intake);
  for (const forbidden of ['objective', 'audience', 'channels', 'message_intent', 'cta_intent', 'statement', 'finding_ref', 'push_ref', 'decision_ref', 'authorization_ref', 'brief_limitations']) {
    assert.ok(!keys.has(forbidden), forbidden);
  }
  assert.doesNotMatch(JSON.stringify(intake), /Make the unserved demand|Invite people to ask/);
  // 272 the prose of the Brief is never read (accessing it would throw)
  const guardedBrief = {};
  for (const [key, value] of Object.entries(brief)) {
    if (['message_intent', 'cta_intent', 'brief_limitations'].includes(key)) Object.defineProperty(guardedBrief, key, { get() { throw new Error(`prose read: ${key}`); }, enumerable: true });
    else guardedBrief[key] = value;
  }
  const guardedHandoff = { ...handoff, creative_brief: guardedBrief };
  assert.equal(CI.buildIntakeFromHandoff({ handoff: guardedHandoff, deliverable_ref: imageSpec.deliverable_id, resolved_format: posterFormat(), created_at: AT }).intake_id, intake.intake_id);
  // 273 the Marketing objects are not modified
  const before = JSON.stringify(handoff);
  intakeOf();
  assert.equal(JSON.stringify(handoff), before);
  assert.ok(isDeepFrozen(handoff));
  // 274 a TEXT deliverable is refused, never converted into an image
  assert.equal(code(() => CI.buildIntakeFromHandoff({ handoff, deliverable_ref: WORLD.textSpec.deliverable_id, resolved_format: posterFormat({ ref: 'format://caption' }), created_at: AT })), CI.CI_ERROR.CONTENT_KIND_UNSUPPORTED);
  // 275 a resolved format of another reference, kind, status or merchant is refused
  assert.equal(code(() => intakeOf({ resolved_format: posterFormat({ ref: 'format://other' }) })), CI.CI_ERROR.RESOURCE_REF_MISMATCH);
  assert.equal(code(() => intakeOf({ resolved_format: posterFormat({ kind: 'ASSET', merchant_id: M1 }) })), CI.CI_ERROR.RESOURCE_KIND_MISMATCH);
  assert.equal(code(() => intakeOf({ resolved_format: posterFormat({ status: 'REVOKED' }) })), CI.CI_ERROR.RESOURCE_NOT_ACTIVE);
  assert.equal(code(() => intakeOf({ resolved_format: posterFormat({ merchant_id: M2 }) })), CI.CI_ERROR.RESOURCE_CROSS_MERCHANT);
  assert.equal(code(() => intakeOf({ resolved_format: null })), CI.CI_ERROR.RESOURCE_NOT_ACTIVE);
  assert.equal(code(() => intakeOf({ resolved_format: posterFormat({ metadata: { ...posterFormat().metadata, style: 'bold' } }) })), CI.CI_ERROR.RESOURCE_INVALID);
  // 276 a handoff of another scope, an expired one or an unknown deliverable is refused
  assert.equal(code(() => intakeOf({ deliverable_ref: 'mdl_unknown' })), CI.CI_ERROR.HANDOFF_INVALID);
  assert.equal(code(() => intakeOf({ created_at: '2026-10-21T00:00:00Z' })), CI.CI_ERROR.HANDOFF_INVALID);
  assert.equal(code(() => intakeOf({ created_at: '2026-10-01T00:00:00Z' })), CI.CI_ERROR.HANDOFF_INVALID);
  const foreign = { ...clone(handoff), brand_interface: { ...clone(handoff.brand_interface), brand: { ...clone(handoff.brand_interface.brand), brand_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } } };
  assert.equal(code(() => intakeOf({ handoff: foreign })), CI.CI_ERROR.HANDOFF_INVALID);
  assert.equal(code(() => intakeOf({ handoff: { creative_brief: {} } })), CI.CI_ERROR.HANDOFF_INVALID);
  // 277 the same inputs give the same intake
  assert.equal(intakeOf().intake_id, intake.intake_id);
  assert.notEqual(intakeOf({ created_at: '2026-10-09T11:00:00Z' }).intake_id, intake.intake_id);
  // 278 the adapter imports nothing from Marketing: it receives plain data
  const adapter = await readFile(new URL('m3-intake.js', srcDir), 'utf8');
  assert.ok(!adapter.includes("from '../"));
  assert.ok(adapter.includes('Marketing M3 is not modified and not imported'));
});

// ------------------------------------------------------------------ resource resolver boundary (279-292)

const world = (map) => async (reference) => (reference in map ? map[reference] : null);
const T = tenant();
const res = (reference, kind, over = {}) => ({ ref: reference, kind, merchant_id: M1, version: 1, status: 'ACTIVE', metadata: null, ...over });

test('Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string', async () => {
  const boundary = CI.createResourceBoundary({ resolver: world({ 'asset://a': res('asset://a', 'ASSET') }) });
  // 279 a resolution has exactly: ref, kind, merchant_id, version, status, metadata
  const r = await boundary.resolve('asset://a', T);
  assert.deepEqual(Object.keys(r).sort(), ['kind', 'merchant_id', 'metadata', 'provenance', 'ref', 'status', 'version']);
  assert.ok(isDeepFrozen(r));
  assert.equal(code(() => CI.normalizeResourceResolution({ ...res('asset://a', 'ASSET'), extra: 1 }, { ref: 'asset://a', tenant: T })), CI.CI_ERROR.RESOURCE_INVALID);
  // 287 closed vocabularies: kind and status are enums
  assert.equal(code(() => CI.normalizeResourceResolution(res('asset://a', 'SPACESHIP'), { ref: 'asset://a', tenant: T })), CI.CI_ERROR.RESOURCE_INVALID);
  assert.equal(code(() => CI.normalizeResourceResolution(res('asset://a', 'ASSET', { status: 'MAYBE' }), { ref: 'asset://a', tenant: T })), CI.CI_ERROR.RESOURCE_INVALID);
  // 280 an unknown reference cannot become a PRODUCT by inference - however product-like it looks
  const unknown = CI.createResourceBoundary({ resolver: world({}) });
  assert.equal(await acode(unknown.require('product://ghost-item', 'PRODUCT', T)), CI.CI_ERROR.RESOURCE_NOT_ACTIVE);
  const ghost = await unknown.resolve('product://ghost-item', T);
  assert.equal(ghost.kind, null);
  assert.equal(ghost.status, 'UNRESOLVED');
  // 281 the resolver's kind is authoritative: a product-looking reference that is an ASSET is an ASSET, and vice versa
  const mixed = CI.createResourceBoundary({ resolver: world({ 'product://looks-like-product': res('product://looks-like-product', 'ASSET'), 'asset://looks-like-asset': res('asset://looks-like-asset', 'PRODUCT') }) });
  assert.equal(await acode(mixed.require('product://looks-like-product', 'PRODUCT', T)), CI.CI_ERROR.RESOURCE_KIND_MISMATCH);
  assert.equal((await mixed.require('asset://looks-like-asset', 'PRODUCT', T)).kind, 'PRODUCT');
  assert.equal((await mixed.require('product://looks-like-product', ['ASSET'], T)).kind, 'ASSET');
  // 282 a resource of another merchant is refused; a merchant-less resource is only allowed for platform-level kinds
  const foreign = CI.createResourceBoundary({ resolver: world({ 'asset://f': res('asset://f', 'ASSET', { merchant_id: M2 }), 'asset://nobody': res('asset://nobody', 'ASSET', { merchant_id: null }), 'format://p': res('format://p', 'FORMAT', { merchant_id: null }), 'font://p': res('font://p', 'FONT', { merchant_id: null }) }) });
  assert.equal(await acode(foreign.resolve('asset://f', T)), CI.CI_ERROR.RESOURCE_CROSS_MERCHANT);
  assert.equal(await acode(foreign.resolve('asset://nobody', T)), CI.CI_ERROR.RESOURCE_CROSS_MERCHANT);
  assert.equal((await foreign.resolve('format://p', T)).merchant_id, null);
  assert.equal((await foreign.resolve('font://p', T)).kind, 'FONT');
  // 283 a raw URL is not a resource identity: refused before the resolver is even asked; metadata cannot carry a location either
  let asked = 0;
  const spy = CI.createResourceBoundary({ resolver: () => { asked += 1; return null; } });
  for (const url of ['https://cdn.example.com/a.png', 'data:image/png;base64,AAAA', 'blob:abc', 'file:///etc/passwd', 'cdn.example.com/a.png']) {
    assert.equal(await acode(spy.resolve(url, T)), CI.CI_ERROR.INVALID_REFERENCE, url);
  }
  assert.equal(asked, 0);
  assert.equal(code(() => CI.normalizeResourceResolution(res('asset://a', 'ASSET', { metadata: { preview: 'https://cdn.example.com/a.png' } }), { ref: 'asset://a', tenant: T })), CI.CI_ERROR.RESOURCE_METADATA_LOCATION);
  assert.equal(code(() => CI.normalizeResourceResolution(res('asset://a', 'ASSET', { metadata: { nested: [{ blob: 'data:image/png;base64,AAAA' }] } }), { ref: 'asset://a', tenant: T })), CI.CI_ERROR.RESOURCE_METADATA_LOCATION);
  assert.ok(CI.normalizeResourceResolution(res('asset://a', 'ASSET', { metadata: { width_px: 100 } }), { ref: 'asset://a', tenant: T }));
  // 284 an unresolved resource can never silently become READY
  const asset = { asset_ref: ASSET_PRODUCT, kind: 'PRODUCT', width_px: 2000, height_px: 2500, has_alpha: true, cutout_available: true, rights_class: 'OWNED', privacy_class: 'PUBLIC', released: true };
  const readiness = (resolutions) => CI.buildAssetReadinessReport({ merchant_id: IDS.merchant, brand_id: IDS.brand, assets: [asset], resolutions, target: { width: 1080, height: 1350 }, created_at: NOW });
  assert.equal(readiness([resolutionFor(ASSET_PRODUCT)]).status, 'READY');
  assert.equal(readiness(null).status, 'NOT_MEASURABLE'); // never asked
  assert.equal(readiness([]).status, 'NOT_MEASURABLE'); // asked, no answer
  assert.equal(readiness([resolutionFor(ASSET_PRODUCT, { kind: null, status: 'UNRESOLVED', merchant_id: null })]).status, 'NOT_READY');
  for (const status of ['REVOKED', 'EXPIRED', 'RESTRICTED']) assert.equal(readiness([resolutionFor(ASSET_PRODUCT, { status })]).status, 'NOT_READY', status);
  assert.equal(readiness([resolutionFor(ASSET_PRODUCT, { kind: 'PRODUCT' })]).status, 'NOT_READY'); // the resolver says it is not an asset
  assert.equal(code(() => readiness([resolutionFor(ASSET_PRODUCT, { merchant_id: M2 })])), CI.CI_ERROR.RESOURCE_CROSS_MERCHANT);
  // 285 a failing resolver is a stable refusal and its message is not echoed
  const leaky = ['sk', 'live', '9999999999'].join('_');
  const failing = CI.createResourceBoundary({ resolver: () => { throw new Error(`boom ${leaky}`); } });
  const failure = await failing.resolve('asset://a', T).catch((e) => e);
  assert.equal(failure.code, CI.CI_ERROR.RESOURCE_RESOLVER_FAILED);
  assert.ok(!(failure.message + JSON.stringify(failure.detail)).includes(leaky));
  assert.equal(code(() => CI.createResourceBoundary({})), CI.CI_ERROR.RESOURCE_INVALID);
  // 286 a resolver that answers for another reference is refused
  const wrong = CI.createResourceBoundary({ resolver: () => res('asset://other', 'ASSET') });
  assert.equal(await acode(wrong.resolve('asset://a', T)), CI.CI_ERROR.RESOURCE_REF_MISMATCH);
  // 288 the resolver receives only the merchant (frozen) and the boundary never touches the network
  let seen;
  await CI.createResourceBoundary({ resolver: (reference, tn) => { seen = tn; return null; } }).resolve('asset://a', T);
  assert.deepEqual(seen, { merchantId: M1 });
  assert.ok(Object.isFrozen(seen));
  const text = await readFile(new URL('resource-resolver.js', srcDir), 'utf8');
  assert.doesNotMatch(text, /\bfetch\(|node:http|node:https|node:net|process\.env/);
  // 289 no Creative Intelligence module reads a reference to decide what it names (only the location deny-list of the validator does)
  for (const [file, body] of Object.entries(await sources())) {
    if (file === 'validation.js') continue;
    assert.doesNotMatch(body, /\.startsWith\(|\.split\(['"]:\/\//, file);
  }
  // 290 a subject, an asset and a claim always belong to a merchant; only a font and a format may be platform-level
  assert.deepEqual([...CI.PLATFORM_LEVEL_KINDS].sort(), ['FONT', 'FORMAT']);
  for (const kind of ['PRODUCT', 'CATEGORY', 'COLLECTION', 'SUBJECT_OTHER', 'ASSET', 'CLAIM']) {
    assert.equal(code(() => CI.normalizeResourceResolution(res('x://y', kind, { merchant_id: null }), { ref: 'x://y', tenant: T })), CI.CI_ERROR.RESOURCE_CROSS_MERCHANT, kind);
  }
  // 291 an intake whose every reference resolves ACTIVE and of an expected kind is RESOLVED
  const intake = intakeOf();
  const full = CI.createResourceBoundary({
    resolver: world({
      'category://phone-cases': res('category://phone-cases', 'CATEGORY'),
      'asset://product-1': res('asset://product-1', 'ASSET'),
      'asset://product-2': res('asset://product-2', 'ASSET'),
      'claim://approved-1': res('claim://approved-1', 'CLAIM'),
      'format://poster-a3': res('format://poster-a3', 'FORMAT', { merchant_id: null }),
    }),
  });
  const ok = await CI.resolveIntakeResources({ intake, boundary: full, tenant: T });
  assert.equal(ok.status, 'RESOLVED');
  assert.deepEqual(ok.unresolved_refs, []);
  assert.equal(ok.items.length, 5);
  assert.ok(isDeepFrozen(ok));
  // 292 a reference resolved as the wrong kind, or not at all, leaves the intake UNRESOLVED (reported, never assumed)
  const partial = CI.createResourceBoundary({
    resolver: world({
      'category://phone-cases': res('category://phone-cases', 'CLAIM'),
      'asset://product-1': res('asset://product-1', 'ASSET'),
      'claim://approved-1': res('claim://approved-1', 'CLAIM', { status: 'REVOKED' }),
      'format://poster-a3': res('format://poster-a3', 'FORMAT', { merchant_id: null }),
    }),
  });
  const bad = await CI.resolveIntakeResources({ intake, boundary: partial, tenant: T });
  assert.equal(bad.status, 'UNRESOLVED');
  assert.deepEqual(bad.unresolved_refs.map((u) => `${u.ref}:${u.outcome}`).sort(), ['asset://product-2:NOT_UNRESOLVED', 'category://phone-cases:KIND_MISMATCH', 'claim://approved-1:NOT_REVOKED']);
});

// ------------------------------------------------------------------ canonical reference vs resolved payload (293-298)

test('Canonical ref is not a resolved payload: a trusted resolver may feed one render, never the document', () => {
  const document = solved().document;
  // 293 a DesignDocument stores canonical references in the platform convention
  assert.ok(document.asset_refs.every((r) => r.startsWith('asset://')));
  assert.ok(document.layers.filter((l) => l.type === 'PRODUCT').every((l) => l.asset_ref === ASSET_PRODUCT));
  // 294 a payload or a location is refused in every canonical position
  for (const bad of ['data:image/png;base64,iVBORw0KGgo=', 'data:image/png', 'blob:https://x/abc', 'blob:abc', 'http://cdn.example.com/a.png', 'https://cdn.example.com/a.png', 'file:///tmp/a.png', 'file:relative/a.png']) {
    assert.equal(code(() => CI.buildDesignDocument(documentParts({ asset_refs: [bad] }))), CI.CI_ERROR.INVALID_REFERENCE, bad);
    const layers = clone(demoDocument().layers).map((l) => (l.id === 'logo' ? { ...l, source_ref: bad } : l));
    assert.equal(code(() => CI.buildDesignDocument(documentParts({ layers }))), CI.CI_ERROR.INVALID_REFERENCE, bad);
    const productLayers = clone(demoDocument().layers).map((l) => (l.id === 'product' ? { ...l, asset_ref: bad } : l));
    assert.equal(code(() => CI.buildDesignDocument(documentParts({ layers: productLayers }))), CI.CI_ERROR.INVALID_REFERENCE, bad);
  }
  // 295 the ephemeral payload lives in the SVG projection only: the document, the structure and the text runs never hold it
  const payload = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const before = JSON.stringify(document);
  const rendered = CI.renderDesignDocument({ document, fonts: fonts(), assetResolver: () => payload });
  assert.ok(rendered.svg.includes(payload));
  assert.equal(JSON.stringify(document), before);
  assert.ok(!before.includes('data:'));
  assert.ok(!JSON.stringify(rendered.structure).includes('data:'));
  assert.ok(!JSON.stringify(rendered.text_runs).includes('data:'));
  // 296 the candidate carries a digest reference of the render, never the payload; that reference is itself a valid opaque ref
  const candidateRef = CI.renderedAssetRefOf(rendered);
  assert.match(candidateRef, /^render:[0-9a-f]{64}$/);
  assert.ok(!candidateRef.includes('data:'));
  const withPayload = JSON.stringify({ document, ref: candidateRef });
  assert.ok(!withPayload.includes('base64'));
  // 297 a resolver cannot point an image at a remote location instead of a payload
  assert.equal(code(() => CI.renderDesignDocument({ document, fonts: fonts(), assetResolver: () => 'https://cdn.example.com/a.png' })), CI.CI_ERROR.RENDER_INPUT_INVALID);
  // 298 the same document renders deterministically with the same payload, and the document id never depends on it
  const again = CI.renderDesignDocument({ document, fonts: fonts(), assetResolver: () => payload });
  assert.equal(again.digest, rendered.digest);
  assert.notEqual(CI.renderDesignDocument({ document, fonts: fonts() }).digest, rendered.digest);
  assert.equal(CI.normalizeDesignDocument(document).document_id, document.document_id);
  assert.ok(ASSET_LOGO && assetDims && PRODUCT && LATER);
});

// ------------------------------------------------------------------ no style invented while the brand expression is absent (299-304)

test('No invented style: with no brand expression system, Creative Intelligence carries no style default', async () => {
  const src = await sources();
  // 299 no colour literal anywhere in the C1 source (no default palette, no "premium" colour)
  for (const [file, body] of Object.entries(src)) assert.doesNotMatch(body, /#[0-9A-Fa-f]{3,8}\b/, file);
  // 300 no font family and no style vocabulary table anywhere in the C1 source
  for (const [file, body] of Object.entries(src)) {
    assert.doesNotMatch(body, /\b(helvetica|arial|georgia|times new roman|roboto|garamond|futura|didot|open sans)\b/i, file);
    assert.doesNotMatch(body, /\b(minimalist|cinematic|film grain|bokeh|moodboard|pastel|vintage)\b/i, file);
  }
  // 301 the canvas colour is required, never defaulted
  const parts = documentParts();
  assert.equal(code(() => CI.buildDesignDocument({ ...parts, canvas: { width: 1080, height: 1350 } })), CI.CI_ERROR.COLOR_INVALID);
  // 302 an image fit and a font's generic family are required, never defaulted
  const noFit = { ...clone(demoDocument().layers[2]), type: 'IMAGE', id: 'img' };
  delete noFit.fit;
  assert.equal(code(() => CI.normalizeLayer(noFit)), CI.CI_ERROR.LAYER_INVALID);
  const font = { font_ref: 'font://x', family: 'X Sans', units_per_em: 1000, ascent: 800, descent: 200, default_advance: 500, advances: {}, scripts: ['LATIN'] };
  assert.equal(code(() => CI.normalizeFontMetrics(font)), CI.CI_ERROR.FONT_INVALID);
  assert.ok(CI.normalizeFontMetrics({ ...font, generic: 'sans-serif' }));
  // 303 no recipe is chosen by default: the caller (the creative direction) names it
  assert.equal(code(() => CI.solveLayout({ document: demoDocument(), fonts: fonts(), assets: assetDims(), created_at: LATER })), CI.CI_ERROR.LAYOUT_RECIPE_UNKNOWN);
  assert.equal(code(() => CI.solveLayout({ document: demoDocument(), recipe_id: undefined, fonts: fonts(), created_at: LATER })), CI.CI_ERROR.LAYOUT_RECIPE_UNKNOWN);
  // 304 the expression system is a declared PRE-C2 dependency covering every domain the architect listed
  const dependency = CI.PRE_C2_DEPENDENCIES.find((d) => d.id === 'BRAND_EXPRESSION_SYSTEM');
  assert.equal(dependency.blocking, true);
  for (const domain of ['expression_system', 'photography', 'product_presentation', 'composition', 'layout_principles', 'illustration', 'iconography', 'motion', 'locale_overrides']) {
    assert.ok(dependency.summary.includes(domain), domain);
  }
  assert.match(dependency.summary, /invents none of those values/);
});

// ------------------------------------------------------------------ pre-C2 readiness (305-312)

test('Pre-C2 readiness: C2 stays blocked until every blocking dependency has explicit evidence', () => {
  const blocking = ['RESOURCE_RESOLVER', 'BRAND_EXPRESSION_SYSTEM', 'REAL_FONT_METRICS', 'COMPLEX_SCRIPT_SHAPING', 'ARABIC_BIDI_RTL_VERIFICATION', 'DETERMINISTIC_RASTERIZER', 'REAL_PNG_RENDER_PATH', 'REAL_CAMPAIGN_BENCHMARK'];
  // 305 with no fact, C2 is not allowed and every blocking dependency is open
  const none = CI.assessCreativeC2Readiness();
  assert.equal(none.c2_allowed, false);
  assert.deepEqual([...none.open_blockers].sort(), [...blocking].sort());
  assert.ok(isDeepFrozen(none));
  // 306 the typography / rasterization blockers the architect named are all present and blocking
  for (const id of ['REAL_FONT_METRICS', 'COMPLEX_SCRIPT_SHAPING', 'ARABIC_BIDI_RTL_VERIFICATION', 'DETERMINISTIC_RASTERIZER', 'REAL_PNG_RENDER_PATH']) {
    assert.equal(CI.PRE_C2_DEPENDENCIES.find((d) => d.id === id).blocking, true, id);
  }
  // 307 one closed dependency does not unblock C2
  const one = CI.assessCreativeC2Readiness({ REAL_FONT_METRICS: evidenceFor('REAL_FONT_METRICS') });
  assert.equal(one.c2_allowed, false);
  assert.equal(one.dependencies.find((d) => d.id === 'REAL_FONT_METRICS').status, 'CLOSED');
  assert.equal(one.open_blockers.length, blocking.length - 1);
  // 308 C2 is allowed only when every blocking dependency has explicit evidence; typography is production-ready only when its three evidences exist
  const all = CI.assessCreativeC2Readiness(Object.fromEntries(blocking.map((id) => [id, evidenceFor(id)])));
  assert.equal(all.c2_allowed, true);
  assert.deepEqual(all.open_blockers, []);
  assert.equal(all.typography_production_ready, true);
  assert.equal(one.typography_production_ready, false);
  assert.equal(none.typography_production_ready, false);
  // 309 only issued evidence closes a dependency: a reference, a hand-made object, evidence of another dependency, or an unknown dependency is refused
  assert.equal(code(() => CI.assessCreativeC2Readiness({ REAL_FONT_METRICS: 'evidence://font-metrics-report' })), CI.CI_ERROR.READINESS_INVALID);
  assert.equal(code(() => CI.assessCreativeC2Readiness({ REAL_FONT_METRICS: 'https://example.com/report' })), CI.CI_ERROR.READINESS_INVALID);
  const forged = { dependency: 'REAL_FONT_METRICS', status: 'VERIFIED', evidence_ref: 'probe://real-font-metrics/forged' };
  assert.equal(code(() => CI.assessCreativeC2Readiness({ REAL_FONT_METRICS: forged })), CI.CI_ERROR.READINESS_INVALID);
  assert.equal(code(() => CI.assessCreativeC2Readiness({ REAL_FONT_METRICS: evidenceFor('REAL_PNG_RENDER_PATH') })), CI.CI_ERROR.READINESS_INVALID);
  assert.equal(code(() => CI.assessCreativeC2Readiness({ MAGIC: evidenceFor('REAL_FONT_METRICS') })), CI.CI_ERROR.READINESS_INVALID);
  assert.equal(code(() => CI.assessCreativeC2Readiness('yes')), CI.CI_ERROR.READINESS_INVALID);
  // 310 CJK line breaking is DEFERRED: documented, never claimed, and it does not block C2
  const cjk = none.dependencies.find((d) => d.id === 'CJK_LINE_BREAKING');
  assert.equal(cjk.status, 'DEFERRED');
  assert.equal(cjk.blocking, false);
  assert.ok(!none.open_blockers.includes('CJK_LINE_BREAKING'));
  // 311 no PNG is faked meanwhile: without an injected rasterizer the answer is "unsupported"
  const rendered = CI.renderDesignDocument({ document: solved().document, fonts: fonts() });
  assert.equal(CI.renderPng(rendered).supported, false);
  // 312 ONE resource resolver (with FORMAT capability) is the pre-C2 dependency - there is no separate format resolver
  assert.match(CI.PRE_C2_DEPENDENCIES.find((d) => d.id === 'RESOURCE_RESOLVER').summary, /resolve\(ref, tenant\)/);
  assert.match(CI.PRE_C2_DEPENDENCIES.find((d) => d.id === 'RESOURCE_RESOLVER').summary, /FORMAT capability/);
  assert.ok(!CI.PRE_C2_DEPENDENCIES.some((d) => d.id === 'FORMAT_RESOLVER'));
  assert.ok(CLAIM_PRICE && intakeInput && fonts);
});

// ------------------------------------------------------------------ structural vs resolved render (313-319)

test('Structural render is not a production render: only resolved media may back a render-ready candidate', () => {
  const document = solved().document;
  // 313 an unresolved asset may produce a structural representation (labelled, deterministic, for inspection and tests)
  const structural = CI.renderDesignDocument({ document, fonts: fonts() });
  assert.equal(structural.render_mode, 'STRUCTURAL');
  assert.deepEqual(structural.unresolved_asset_refs, [ASSET_LOGO, ASSET_PRODUCT].sort());
  assert.ok(structural.svg.includes('data-render-mode="STRUCTURAL"'));
  assert.ok(structural.svg.includes(`href="ref:${ASSET_PRODUCT}"`));
  // 314 a partial resolution, a symbolic answer or no answer all stay structural
  const onlyProduct = CI.renderDesignDocument({ document, fonts: fonts(), assetResolver: (r) => (r === ASSET_PRODUCT ? PAYLOAD : null) });
  assert.equal(onlyProduct.render_mode, 'STRUCTURAL');
  assert.deepEqual(onlyProduct.unresolved_asset_refs, [ASSET_LOGO]);
  assert.equal(CI.renderDesignDocument({ document, fonts: fonts(), assetResolver: (r) => `ref:${r}` }).render_mode, 'STRUCTURAL');
  assert.equal(CI.renderDesignDocument({ document, fonts: fonts(), assetResolver: () => null }).unresolved_asset_refs.length, 2);
  // 315 an unresolved render can never become a render-ready candidate, nor a production image
  assert.equal(code(() => CI.renderedAssetRefOf(structural)), CI.CI_ERROR.RENDER_NOT_RESOLVED);
  const ready = candidateFor(document);
  assert.equal(ready.render_mode, 'RESOLVED');
  assert.equal(code(() => CI.normalizeCreativeCandidate({ ...clone(ready), render_mode: 'STRUCTURAL' })), CI.CI_ERROR.RENDER_NOT_RESOLVED);
  const { render_mode: _dropped, ...withoutMode } = clone(ready);
  assert.equal(code(() => CI.normalizeCreativeCandidate(withoutMode)), CI.CI_ERROR.RENDER_NOT_RESOLVED);
  assert.equal(code(() => CI.renderPng(structural, { rasterizer: () => Uint8Array.from([0x89, 0x50, 0, 0, 0, 0, 0, 0, 0]) })), CI.CI_ERROR.RENDER_NOT_RESOLVED);
  // 316 a resolved ephemeral payload can render: every needed media reference resolved, a RESOLVED render and candidate
  const resolved = CI.renderDesignDocument({ document, fonts: fonts(), assetResolver: resolveAllMedia });
  assert.equal(resolved.render_mode, 'RESOLVED');
  assert.deepEqual(resolved.unresolved_asset_refs, []);
  assert.ok(resolved.svg.includes('data-render-mode="RESOLVED"'));
  assert.ok(resolved.svg.includes(PAYLOAD));
  assert.match(CI.renderedAssetRefOf(resolved), /^render:[0-9a-f]{64}$/);
  // 317 the resolved payload never enters the DesignDocument, nor the candidate
  assert.ok(!JSON.stringify(document).includes('base64'));
  assert.ok(!JSON.stringify(ready).includes('base64'));
  assert.equal(CI.normalizeDesignDocument(document).document_id, document.document_id);
  // 318 the same resolved inputs produce the same bytes; another payload changes the bytes, never the document
  assert.equal(CI.renderDesignDocument({ document, fonts: fonts(), assetResolver: resolveAllMedia }).svg, resolved.svg);
  const other = CI.renderDesignDocument({ document, fonts: fonts(), assetResolver: () => 'data:image/png;base64,iVBORw0KGgo=' });
  assert.notEqual(other.digest, resolved.digest);
  assert.equal(other.render_mode, 'RESOLVED');
  // 319 a document with no media to resolve has nothing unresolved (text and shapes only)
  const textOnly = CI.buildDesignDocument(documentParts({ layers: [backgroundLayer(), textLayer('only', 'HEADLINE', 'Rien à résoudre', { geometry: { x: 100, y: 100, width: 800, height: 200, rotation_deg: 0 } })], asset_refs: [], claim_refs: [] }));
  assert.equal(CI.renderDesignDocument({ document: textOnly, fonts: fonts() }).render_mode, 'RESOLVED');
});

// ------------------------------------------------------------------ L3-002 / NDR-D02 and the benchmark (320-325)

test('C1 may close, C2 provider work stays blocked on a real campaign benchmark kept as configuration data', async () => {
  const benchmark = JSON.parse(await readFile(new URL('../benchmarks/creative-intelligence/habb-creative-benchmark-001.json', import.meta.url), 'utf8'));
  // 320 the architect-selected benchmark exists as DATA with exactly the facts and requirements given
  assert.equal(benchmark.kind, 'CONFIGURATION_DATA');
  assert.equal(benchmark.status, 'NOT_RUN');
  assert.equal(benchmark.subject, 'Personalized phone case');
  assert.equal(benchmark.facts_given_by_the_architect.price, '25 €');
  assert.equal(benchmark.facts_given_by_the_architect.promise, '5 minutes');
  assert.equal(benchmark.facts_given_by_the_architect.primary_channel, 'Instagram Feed');
  assert.deepEqual(benchmark.facts_given_by_the_architect.primary_canvas, { width: 1080, height: 1350, unit: 'px' });
  for (const requirement of ['real product asset', 'exact product preservation', 'exact critical text', 'brand expression compliance', 'no generic style fallback', 'deterministic typography', 'preflight PASS', 'Fidelity gate', 'Guardian gate']) {
    assert.ok(benchmark.requirements.includes(requirement), requirement);
  }
  assert.ok(benchmark.requirements.some((r) => r.includes('25 €')) && benchmark.requirements.some((r) => r.includes('5 minutes')));
  // 321 none of it lives in the generic Creative source: no campaign, price, promise or channel
  for (const [file, text] of Object.entries(await sources())) assert.doesNotMatch(text, /25 €|5 minutes|habb|instagram/i, file);
  // 322 with everything else closed, the missing real benchmark alone keeps C2 blocked
  const ids = CI.PRE_C2_DEPENDENCIES.filter((d) => d.blocking && d.id !== 'REAL_CAMPAIGN_BENCHMARK').map((d) => d.id);
  const closed = Object.fromEntries(ids.map((id) => [id, evidenceFor(id)]));
  const almost = CI.assessCreativeC2Readiness(closed);
  assert.equal(almost.c2_allowed, false);
  assert.deepEqual(almost.open_blockers, ['REAL_CAMPAIGN_BENCHMARK']);
  assert.equal(CI.assessCreativeC2Readiness({ ...closed, REAL_CAMPAIGN_BENCHMARK: evidenceFor('REAL_CAMPAIGN_BENCHMARK') }).c2_allowed, true);
  // 323 the benchmark says honestly what is still missing before it can run
  assert.ok(Array.isArray(benchmark.bindings_still_missing)); // every binding is prepared; the benchmark is still NOT_RUN and C2 closed
  assert.ok(!benchmark.bindings_still_missing.some((b) => b.includes('FORMAT'))); // the FORMAT is bound (benchmark owned_records)
  // 324 the architecture document states the decision: C1 may close, C2 provider work is blocked on that benchmark
  const doc = await readFile(new URL('../docs/architecture/creative-intelligence-v1.md', import.meta.url), 'utf8');
  assert.ok(doc.includes('C1 foundation may close.'));
  assert.ok(doc.includes('C2 provider work remains blocked until a real HABB campaign benchmark exists.'));
  assert.ok(doc.includes('HABB CREATIVE BENCHMARK 001'));
  // 325 NDR-D02 / L3-002 carry the explicit clarification (C1 foundation COMPLETE, C2 DEFERRED on the benchmark) and keep the original condition
  const register = await readFile(new URL('../NORDLA-DECISION-REGISTER.md', import.meta.url), 'utf8');
  const deferred = await readFile(new URL('../NORDLA-DEFERRED.md', import.meta.url), 'utf8');
  assert.ok(register.includes('| NDR-D02 | Creative Intelligence implementation beyond current experiments | DECIDED / C1 FOUNDATION COMPLETE · C2 DEFERRED'));
  assert.ok(register.includes('C2 provider bake-off / real provider execution  BLOCKED / DEFERRED until HABB CREATIVE BENCHMARK 001 is runnable and used'));
  assert.ok(register.includes('This does not mean Creative Intelligence is complete'));
  assert.ok(deferred.includes('a real HABB campaign is used as benchmark.')); // the original condition is not deleted
  assert.ok(deferred.includes('| L3-002 | Creative Intelligence |') && deferred.includes('C1 FOUNDATION COMPLETE · C2 NOT IMPLEMENTED'));
  assert.ok(deferred.includes('Creative Intelligence is NOT complete as a whole: only its C1 foundation is.'));
});
