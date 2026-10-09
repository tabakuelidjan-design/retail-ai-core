import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import * as CI from '../src/creative-intelligence/index.js';
import {
  ASSET_LOGO, ASSET_PHOTO, ASSET_PRODUCT, BRIEF, CLAIM_PRICE, FONT, FONT_AR, FONT_AR_EXACT, IDS, LATER, NOW, assetDims, backgroundLayer, candidateFor, checkOf, clone, code,
  demoDocument, demoLayers, documentParts, fonts, intakeInput, isDeepFrozen, outputContext, preflightContext, resolveAllMedia, solved, textLayer,
} from './creative-intelligence-fixtures.js';

// `// N text` markers are rows of the coverage matrix (docs/architecture/creative-intelligence-v1.md).

const base = () => solved().document;
/** A revision of the solved demo document with a defect: `edit(layers)` returns the new layers (or mutates them). */
function defect(edit, extra = {}) {
  const layers = clone(base().layers);
  const next = edit(layers) ?? layers;
  return CI.reviseDesignDocument(base(), { layers: next, created_at: LATER, ...extra });
}
const setLayer = (id, patch) => (layers) => layers.map((l) => (l.id === id ? { ...l, ...patch } : l));
const run = (document, over) => CI.runCreativePreflight(document, preflightContext(over));
const status = (report, name) => checkOf(report, name).status;
const long = 'Un objet personnalisé avec vos plus belles photos de vacances en famille et entre amis';

// ------------------------------------------------------------------ preflight (166-190)

test('Preflight: the clean demo passes every deterministic gate', () => {
  const report = run(base());
  assert.equal(report.status, 'PASS');
  for (const c of report.checks) assert.equal(c.status, 'PASS', c.code);
});

test('Preflight text gates: overflow, minimum size', () => {
  // 166 a text that does not fit fails, and the remediation is the layer's own overflow policy
  const overflow = defect(setLayer('headline', { content: long, font_size: 120, min_font_size: 40, max_lines: 2, overflow_policy: 'RELAYOUT_REQUIRED' }));
  const report = run(overflow);
  assert.equal(status(report, 'TEXT_OVERFLOW'), 'FAIL');
  assert.deepEqual(checkOf(report, 'TEXT_OVERFLOW').remediation, { headline: 'RELAYOUT_REQUIRED' });
  assert.deepEqual(checkOf(report, 'TEXT_OVERFLOW').layer_refs, ['headline']);
  // 167 an overflow cannot silently pass, whatever its policy
  for (const policy of ['FAIL', 'REWRITE_REQUIRED', 'RELAYOUT_REQUIRED']) {
    const r = run(defect(setLayer('headline', { content: long, font_size: 120, min_font_size: 40, max_lines: 2, overflow_policy: policy })));
    assert.equal(r.status, 'FAIL', policy);
    assert.equal(checkOf(r, 'TEXT_OVERFLOW').remediation.headline, policy);
  }
  // 168 a text rendered below its minimum size fails
  const small = run(defect(setLayer('subheadline', { font_size: 10, min_font_size: 24 })));
  assert.equal(status(small, 'TEXT_BELOW_MIN_SIZE'), 'FAIL');
  assert.deepEqual(checkOf(small, 'TEXT_BELOW_MIN_SIZE').layer_refs, ['subheadline']);
});

test('Preflight geometry gates: bounds, safe zones, forbidden zones, collisions', () => {
  // 169 a layer outside the canvas fails - a background may bleed
  const out = run(defect(setLayer('logo', { geometry: { x: 1000, y: 100, width: 150, height: 50, rotation_deg: 0 } })));
  assert.equal(status(out, 'LAYER_OUT_OF_BOUNDS'), 'FAIL');
  const bleed = run(defect(setLayer('bg', { geometry: { x: -50, y: -50, width: 1180, height: 1450, rotation_deg: 0 } })));
  assert.equal(status(bleed, 'LAYER_OUT_OF_BOUNDS'), 'PASS');
  // 170 content outside every safe zone fails
  const unsafe = run(defect(setLayer('logo', { geometry: { x: 0, y: 0, width: 150, height: 50, rotation_deg: 0 } })));
  assert.equal(status(unsafe, 'SAFE_ZONE_VIOLATION'), 'FAIL');
  assert.deepEqual(checkOf(unsafe, 'SAFE_ZONE_VIOLATION').layer_refs, ['logo']);
  // 171 critical content over a forbidden zone fails
  const zone = { zone_id: 'platform-ui', x: 0, y: 990, width: 1080, height: 140 };
  const forbidden = run(defect((l) => l, { output_context: outputContext({ forbidden_zones: [zone] }) }));
  assert.equal(status(forbidden, 'FORBIDDEN_ZONE_OVERLAP'), 'FAIL');
  assert.ok(checkOf(forbidden, 'FORBIDDEN_ZONE_OVERLAP').layer_refs.includes('price'));
  // 172 a product overlapping a text fails
  const product = base().layers.find((l) => l.id === 'product').geometry;
  const collision = run(defect(setLayer('headline', { geometry: { ...product, rotation_deg: 0 } })));
  assert.equal(status(collision, 'PRODUCT_TEXT_COLLISION'), 'FAIL');
  assert.deepEqual(checkOf(collision, 'PRODUCT_TEXT_COLLISION').layer_refs, ['headline', 'product']);
});

test('Preflight reference gates: assets, fonts, claims, ids, z-order', () => {
  // 173 an asset the document does not declare - or the catalogue does not hold - fails
  const undeclared = run(defect((l) => l, { asset_refs: [ASSET_PRODUCT] }));
  assert.equal(status(undeclared, 'MISSING_ASSET_REF'), 'FAIL');
  assert.ok(checkOf(undeclared, 'MISSING_ASSET_REF').reason_codes.includes('ASSET_NOT_DECLARED'));
  const { [ASSET_LOGO]: _logo, ...withoutLogo } = assetDims();
  const notInCatalogue = run(base(), { assets: withoutLogo });
  assert.equal(status(notInCatalogue, 'MISSING_ASSET_REF'), 'FAIL');
  assert.ok(checkOf(notInCatalogue, 'MISSING_ASSET_REF').reason_codes.includes('ASSET_NOT_IN_CATALOGUE'));
  // 174 an unregistered font fails; no registry at all cannot be measured
  assert.equal(status(run(base(), { fonts: CI.createFontRegistry([]) }), 'MISSING_FONT_REF'), 'FAIL');
  assert.equal(status(CI.runCreativePreflight(base(), {}), 'MISSING_FONT_REF'), 'NOT_MEASURABLE');
  // 175 a claim the document does not declare, or the Brief did not approve, fails; without the approved list it is NOT_MEASURABLE
  assert.equal(status(run(defect((l) => l, { claim_refs: [] })), 'MISSING_CLAIM_REF'), 'FAIL');
  assert.equal(status(run(base(), { approved_claim_refs: ['claim:something-else'] }), 'MISSING_CLAIM_REF'), 'FAIL');
  assert.equal(status(run(base(), { approved_claim_refs: null }), 'MISSING_CLAIM_REF'), 'NOT_MEASURABLE');
  assert.equal(status(run(base()), 'MISSING_CLAIM_REF'), 'PASS');
  // 176 a repeated layer id fails
  const dup = run(defect((l) => [...l, { ...l.find((x) => x.id === 'cta'), z_index: 40 }]));
  assert.equal(status(dup, 'DUPLICATE_LAYER_ID'), 'FAIL');
  assert.deepEqual(checkOf(dup, 'DUPLICATE_LAYER_ID').layer_refs, ['cta']);
  // 177 two visible layers on the same z_index, or a background above the content, fail
  const sameZ = run(defect(setLayer('cta', { z_index: 22 })));
  assert.equal(status(sameZ, 'INVALID_Z_ORDER'), 'FAIL');
  const bgOnTop = run(defect(setLayer('bg', { z_index: 99 })));
  assert.equal(status(bgOnTop, 'INVALID_Z_ORDER'), 'FAIL');
  assert.ok(checkOf(bgOnTop, 'INVALID_Z_ORDER').reason_codes.includes('BACKGROUND_ABOVE_CONTENT'));
});

test('Preflight contrast and output gates', () => {
  // 178 low contrast fails (WCAG: 4.5 for small text, 3 for large text)
  assert.equal(status(run(defect(setLayer('headline', { color: '#EEEEEE' }))), 'INSUFFICIENT_CONTRAST'), 'FAIL');
  const grey = '#8A8A8A';
  assert.ok(CI.contrastRatio(grey, '#FBF8F3') > 3 && CI.contrastRatio(grey, '#FBF8F3') < 4.5);
  assert.equal(status(run(defect(setLayer('headline', { color: grey }))), 'INSUFFICIENT_CONTRAST'), 'PASS');
  assert.equal(status(run(defect(setLayer('headline', { color: grey, font_size: 20, min_font_size: 10 }))), 'INSUFFICIENT_CONTRAST'), 'FAIL');
  // 179 over an image the backdrop is unknown: NOT_MEASURABLE, never PASS; over a solid shape it is measured
  const overImage = defect((l) => [...l, {
    id: 'photo', type: 'IMAGE', z_index: 5, geometry: { x: 0, y: 150, width: 1080, height: 300, rotation_deg: 0 }, visibility: 'VISIBLE', locked: false, source_ref: ASSET_PHOTO, constraints: [], effects: [], provenance: { origin: 'PROVIDED_ASSET', producer_ref: null, evidence_refs: [] }, fit: 'COVER',
  }], { asset_refs: [ASSET_LOGO, ASSET_PHOTO, ASSET_PRODUCT] });
  const imageReport = run(overImage);
  assert.equal(status(imageReport, 'INSUFFICIENT_CONTRAST'), 'NOT_MEASURABLE');
  assert.ok(checkOf(imageReport, 'INSUFFICIENT_CONTRAST').layer_refs.includes('headline'));
  const band = (fill) => defect((l) => [...l, {
    id: 'band', type: 'SHAPE', z_index: 8, geometry: { x: 0, y: 150, width: 1080, height: 300, rotation_deg: 0 }, visibility: 'VISIBLE', locked: false, source_ref: null, constraints: [], effects: [], provenance: { origin: 'ENGINE', producer_ref: null, evidence_refs: [] }, shape_kind: 'RECT', fill, stroke: null, stroke_width: 0, corner_radius: 0,
  }]);
  assert.equal(status(run(band('#0F2A52')), 'INSUFFICIENT_CONTRAST'), 'FAIL'); // navy text on a navy band
  assert.equal(status(run(band('#FFFFFF')), 'INSUFFICIENT_CONTRAST'), 'PASS');
  // 180 a canvas that differs from the output context fails
  const mismatch = run(defect((l) => l, { canvas: { width: 1000, height: 1350, background_color: '#FBF8F3' } }));
  assert.equal(status(mismatch, 'OUTPUT_DIMENSION_MISMATCH'), 'FAIL');
});

test('Preflight report: complete, ordered, never an optimistic default, no score', () => {
  const report = run(base());
  // 181 the thirteen mandate checks are always present, in a fixed order
  assert.deepEqual(report.checks.slice(0, 13).map((c) => c.code), [...CI.MANDATE_PREFLIGHT_CHECKS]);
  assert.equal(CI.MANDATE_PREFLIGHT_CHECKS.length, 13);
  assert.equal(new Set(report.checks.map((c) => c.code)).size, report.checks.length);
  // 182 overall precedence: FAIL > REVIEW_REQUIRED > NOT_MEASURABLE > PASS
  const reviewOnly = run(defect(setLayer('product', { geometry: { x: 600, y: 500, width: 400, height: 460, rotation_deg: 0 } })));
  assert.equal(status(reviewOnly, 'PRODUCT_ASPECT_MISMATCH'), 'REVIEW_REQUIRED');
  assert.equal(reviewOnly.status, 'REVIEW_REQUIRED');
  const notMeasurableOnly = run(base(), { approved_claim_refs: null });
  assert.equal(notMeasurableOnly.status, 'NOT_MEASURABLE');
  const both = run(defect(setLayer('product', { geometry: { x: 600, y: 500, width: 400, height: 460, rotation_deg: 0 } })), { approved_claim_refs: ['claim:other'] });
  assert.equal(both.status, 'FAIL');
  // 183 with no context at all nothing is reported as a pass: unknowns stay NOT_MEASURABLE
  const bare = CI.runCreativePreflight(base(), {});
  assert.notEqual(bare.status, 'PASS');
  assert.equal(status(bare, 'TEXT_OVERFLOW'), 'NOT_MEASURABLE');
  assert.equal(status(bare, 'MISSING_CLAIM_REF'), 'NOT_MEASURABLE');
  assert.deepEqual(bare.context_provided, { fonts: false, assets: false, approved_claim_refs: false, approved_texts: false });
  // 184 the report is a pure function of its inputs, derived-id and deep-frozen
  assert.equal(JSON.stringify(run(base())), JSON.stringify(report));
  assert.match(report.report_id, /^cpr_[0-9a-f]{32}$/);
  assert.ok(isDeepFrozen(report));
  // 185 a complex script is NOT_MEASURABLE with an advance-table font and measured with an exact-shaping font
  const arabic = (font) => CI.buildDesignDocument(documentParts({
    output_context: outputContext({ locale: 'ar-SA', direction: 'RTL' }),
    layers: [backgroundLayer(), textLayer('ar', 'HEADLINE', 'مرحبا بكم في متجرنا', { geometry: { x: 100, y: 200, width: 800, height: 200, rotation_deg: 0 }, font_size: 50, extra: { font_ref: font, direction: 'RTL', locale: 'ar-SA' } })],
    asset_refs: [], claim_refs: [],
  }));
  assert.equal(status(run(arabic(FONT_AR)), 'TEXT_OVERFLOW'), 'NOT_MEASURABLE');
  assert.equal(status(run(arabic(FONT_AR_EXACT)), 'TEXT_OVERFLOW'), 'PASS');
  // 186 a script the font does not cover fails
  assert.equal(status(run(arabic(FONT)), 'FONT_SCRIPT_UNSUPPORTED'), 'FAIL');
  // 187 a claim-bearing text that differs from the approved wording fails
  assert.equal(status(run(base(), { approved_texts: { [CLAIM_PRICE]: CI.textDigest('19,90 €') } }), 'TEXT_CONTENT_CHANGED'), 'PASS');
  assert.equal(status(run(base(), { approved_texts: { [CLAIM_PRICE]: CI.textDigest('17,50 €') } }), 'TEXT_CONTENT_CHANGED'), 'FAIL');
  // 188 a violated constraint fails
  const violated = run(defect((l) => l, { constraints: [{ kind: 'ABOVE', subject: 'price', target: 'headline', value: null }] }));
  assert.equal(status(violated, 'CONSTRAINT_VIOLATION'), 'FAIL');
  assert.equal(status(run(defect((l) => l, { constraints: [{ kind: 'BELOW', subject: 'price', target: 'headline', value: null }] })), 'CONSTRAINT_VIOLATION'), 'PASS');
  // 189 two texts (or a logo and a text) that overlap fail
  const headline = base().layers.find((l) => l.id === 'headline').geometry;
  const overlap = run(defect(setLayer('subheadline', { geometry: { ...headline, rotation_deg: 0 } })));
  assert.equal(status(overlap, 'TEXT_LAYER_OVERLAP'), 'FAIL');
  // 190 the report carries no numeric aesthetic score of any kind
  const keys = JSON.stringify(report).match(/"[a-z_]+":/g).map((k) => k.slice(1, -2));
  for (const forbidden of CI.FORBIDDEN_SCORE_KEYS) assert.ok(!keys.includes(forbidden), forbidden);
  assert.ok(report.checks.every((c) => ['PASS', 'REVIEW_REQUIRED', 'FAIL', 'NOT_MEASURABLE'].includes(c.status)));
});

// ------------------------------------------------------------------ candidates and selection (191-205)

const mutateCandidate = (c, patch) => ({ ...clone(c), ...patch });

test('Creative candidate: facts about the pipeline, never another module\'s verdict', () => {
  const document = base();
  const candidate = candidateFor(document);
  // 191 a candidate holds the document, the reference of its render and its preflight report
  assert.equal(candidate.design_document.document_id, document.document_id);
  assert.equal(candidate.rendered_asset_ref, CI.renderedAssetRefOf(CI.renderDesignDocument({ document, fonts: fonts(), assetResolver: resolveAllMedia })));
  assert.equal(candidate.render_mode, 'RESOLVED');
  assert.equal(candidate.preflight_report.document_ref, document.document_id);
  assert.ok(isDeepFrozen(candidate));
  // 192 the candidate id is derived; a forged one is refused
  assert.match(candidate.candidate_id, /^ccc_[0-9a-f]{32}$/);
  assert.equal(code(() => CI.normalizeCreativeCandidate({ ...clone(candidate), candidate_id: 'ccc_forged' })), CI.CI_ERROR.ID_MISMATCH);
  assert.equal(CI.normalizeCreativeCandidate(clone(candidate)).candidate_id, candidate.candidate_id);
  // 193 a candidate cannot claim a Brand Guardian / Creative Fidelity verdict, nor be marked published
  for (const key of ['brand_approved', 'guardian_status', 'fidelity_status', 'approved', 'published', 'activation']) {
    assert.equal(code(() => CI.normalizeCreativeCandidate(mutateCandidate(candidate, { [key]: true }))), CI.CI_ERROR.CANDIDATE_APPROVAL_CLAIMED, key);
  }
  assert.equal(code(() => CI.normalizeCreativeCandidate(mutateCandidate(candidate, { provenance: { ...candidate.provenance, approved_by: 'x' } }))), CI.CI_ERROR.CANDIDATE_APPROVAL_CLAIMED);
  // 194 a candidate cannot carry a score, a rank or a winner flag
  for (const key of ['score', 'rank', 'winner', 'rating']) {
    assert.equal(code(() => CI.normalizeCreativeCandidate(mutateCandidate(candidate, { [key]: 1 }))), CI.CI_ERROR.CANDIDATE_APPROVAL_CLAIMED, key);
  }
  // 195 the candidate and its document must belong together (merchant, brand, brief, direction)
  assert.equal(code(() => CI.normalizeCreativeCandidate(mutateCandidate(candidate, { merchant_id: IDS.otherMerchant }))), CI.CI_ERROR.CANDIDATE_INVALID);
  assert.equal(code(() => CI.normalizeCreativeCandidate(mutateCandidate(candidate, { brief_ref: 'brief:other' }))), CI.CI_ERROR.CANDIDATE_INVALID);
  assert.equal(code(() => CI.normalizeCreativeCandidate(mutateCandidate(candidate, { direction_ref: 'direction:other' }))), CI.CI_ERROR.CANDIDATE_INVALID);
  // 196 a report (preflight or quality) of another document is refused
  const other = candidateFor(CI.solveLayout({ document: demoDocument(), recipe_id: 'EDITORIAL_SPLIT', fonts: fonts(), assets: assetDims(), created_at: LATER }).document);
  assert.equal(code(() => CI.normalizeCreativeCandidate(mutateCandidate(candidate, { preflight_report: other.preflight_report }))), CI.CI_ERROR.CANDIDATE_REPORT_STALE);
  const foreignQuality = CI.normalizeQualityReport({ document_ref: 'cdd_other', dimensions: {} });
  assert.equal(code(() => CI.normalizeCreativeCandidate(mutateCandidate(candidate, { quality_report: foreignQuality }))), CI.CI_ERROR.CANDIDATE_REPORT_STALE);
  // 197 a preflight report whose id does not follow from its content is refused
  assert.equal(code(() => CI.normalizeCreativeCandidate(mutateCandidate(candidate, { preflight_report: { ...clone(candidate.preflight_report), status: 'PASS', checks: clone(candidate.preflight_report.checks).slice(1) } }))), CI.CI_ERROR.ID_MISMATCH);
});

test('Selection: hard gates only - no winner, no score, nothing promoted', () => {
  const clean = candidateFor(base());
  const split = candidateFor(CI.solveLayout({ document: demoDocument(), recipe_id: 'EDITORIAL_SPLIT', fonts: fonts(), assets: assetDims(), created_at: LATER }).document);
  const failing = candidateFor(defect(setLayer('headline', { content: long, font_size: 120, min_font_size: 40, max_lines: 2 })));
  const reviewing = candidateFor(defect(setLayer('product', { geometry: { x: 600, y: 500, width: 400, height: 460, rotation_deg: 0 } })));
  const select = (candidates, context = preflightContext()) => CI.selectCandidates({ candidates, context });
  // 198 a candidate whose preflight FAILS cannot be selected
  const rejected = select([failing]);
  assert.equal(rejected.status, 'NO_ELIGIBLE_CANDIDATE');
  assert.deepEqual(rejected.eligible, []);
  assert.ok(rejected.rejected[0].reasons.includes('TEXT_OVERFLOW'));
  // 199 a PASS candidate is exposed
  const exposed = select([clean]);
  assert.equal(exposed.eligible[0].candidate_id, clean.candidate_id);
  assert.equal(exposed.eligible[0].preflight_status, 'PASS');
  // 200 a REVIEW_REQUIRED candidate stays REVIEW_REQUIRED and is flagged for review - it is never promoted to PASS
  const review = select([reviewing]);
  assert.equal(review.eligible[0].preflight_status, 'REVIEW_REQUIRED');
  assert.equal(review.eligible[0].needs_review, true);
  assert.ok(review.eligible[0].open_checks.some((c) => c.code === 'PRODUCT_ASPECT_MISMATCH' && c.status === 'REVIEW_REQUIRED'));
  // 201 a stored report that differs from the one recomputed now is refused (a stored report is never an authority)
  const staleContext = preflightContext({ approved_claim_refs: null });
  assert.equal(code(() => select([clean], staleContext)), CI.CI_ERROR.CANDIDATE_REPORT_STALE);
  // 202 there is no winner, no score and no ranking in the answer
  const mixed = select([clean, split, failing]);
  assert.deepEqual(Object.keys(mixed).sort(), ['eligible', 'human_choice_required', 'ordering', 'rejected', 'status']);
  assert.match(mixed.ordering, /NOT a ranking/);
  assert.doesNotMatch(JSON.stringify(mixed), /"(score|winner|rank|best|rating)"/);
  assert.deepEqual(mixed.eligible.map((e) => e.candidate_id), [...mixed.eligible.map((e) => e.candidate_id)].sort());
  // 203 several eligible candidates require a human choice; a single one does not
  assert.equal(mixed.eligible.length, 2);
  assert.equal(mixed.human_choice_required, true);
  assert.equal(exposed.human_choice_required, false);
  // quality: a fully assessed, all-PASS candidate needs no review
  const passQuality = CI.normalizeQualityReport({ document_ref: base().document_id, reviewer_ref: 'agent:critic', dimensions: Object.fromEntries(CI.QUALITY_DIMENSIONS.map((d) => [d, { status: 'PASS' }])) });
  assert.equal(select([candidateFor(base(), { quality: passQuality })]).eligible[0].needs_review, false);
  assert.equal(exposed.eligible[0].needs_review, true); // never assessed -> not silently fine
  // 204 when nothing is eligible the answer says so
  assert.equal(select([failing]).human_choice_required, false);
  assert.equal(select([failing, candidateFor(defect(setLayer('subheadline', { font_size: 10, min_font_size: 24 })))]).status, 'NO_ELIGIBLE_CANDIDATE');
  // 205 candidates of different merchants / briefs, duplicates and an empty list are refused
  assert.equal(code(() => select([])), CI.CI_ERROR.SELECTION_INVALID);
  assert.equal(code(() => select([clean, clean])), CI.CI_ERROR.SELECTION_INVALID);
  const foreignDoc = CI.buildDesignDocument({ ...clone(documentParts()), brief_ref: 'brief:other', layers: clone(base().layers), version: 2, provenance: { ...clone(documentParts().provenance), derivation: 'REFINE', parent_document_ref: 'cdd_x' } });
  assert.equal(code(() => select([clean, candidateFor(foreignDoc)])), CI.CI_ERROR.SELECTION_INVALID);
});

// ------------------------------------------------------------------ boundaries and non-regression (236-250)

const srcDir = new URL('../src/creative-intelligence/', import.meta.url);
const sources = async () => {
  const out = {};
  for (const file of await readdir(srcDir)) out[file] = await readFile(new URL(file, srcDir), 'utf8');
  return out;
};

test('Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others', async () => {
  const src = await sources();
  // 236 the public surface has no publish / schedule / activate / approve function
  const names = Object.keys(CI).filter((n) => !n.startsWith('FORBIDDEN_'));
  assert.deepEqual(names.filter((n) => /publish|schedul|activat|approv|send|submit/i.test(n)), []);
  // 237 no network, clock, randomness or environment access in the source
  for (const [file, text] of Object.entries(src)) {
    assert.doesNotMatch(text, /\bfetch\(|node:http|node:https|node:net|node:dgram|XMLHttpRequest|Date\.now|new Date\(\)|Math\.random|randomUUID|randomBytes|process\.env|performance\.now|setTimeout|setInterval/, file);
  }
  // 238 the only modules imported from outside the directory are shared pure validators and the Branding content-kind constant
  const outside = new Set();
  for (const text of Object.values(src)) for (const m of text.matchAll(/from '(\.\.\/[^']+)'/g)) outside.add(m[1]);
  assert.deepEqual([...outside].sort(), ['../branding/candidate-manifest.js', '../branding/constants.js', '../branding/expression-system.js', '../creative-fidelity/constants.js', '../marketing/m2-validation.js', '../marketing/understand-validation.js', '../resources/index.js']);
  // 239 no merchant-specific logic in the generic domain
  for (const [file, text] of Object.entries(src)) assert.doesNotMatch(text, /habb|shopify|namur|\bcoque/i, file);
  // 240 no platform is hardcoded in the generic domain (channel facts come from explicit contracts)
  for (const [file, text] of Object.entries(src)) assert.doesNotMatch(text, /instagram|tiktok|facebook|pinterest|youtube|linkedin/i, file);
  // 241 a candidate carries no publishing state
  const candidate = candidateFor(base());
  for (const key of ['publish', 'scheduled', 'publication_receipt']) {
    assert.ok(code(() => CI.normalizeCreativeCandidate({ ...clone(candidate), [key]: true })) !== 'NO_ERROR', key);
  }
  // 242 Creative Intelligence cannot mutate Brand Memory: it neither imports it nor lets an agent write to it
  for (const text of Object.values(src)) assert.doesNotMatch(text, /branding\/memory|writeBrandMemory|brand-memory/);
  assert.equal(code(() => CI.normalizeAgentOutput('CREATIVE_ORCHESTRATOR', { ...CI.planCreativeRun(), brand_memory: { tone: 'x' } })), CI.CI_ERROR.AGENT_OUTPUT_INVALID);
  // 243 an agent cannot recompute a Marketing decision (objective, margin, stock, strategy)
  for (const key of ['objective', 'margin', 'stock', 'strategy', 'decision', 'push']) {
    assert.equal(code(() => CI.normalizeAgentOutput('CREATIVE_ORCHESTRATOR', { ...CI.planCreativeRun(), [key]: 'x' })), CI.CI_ERROR.AGENT_OUTPUT_INVALID, key);
  }
  // 244 an agent cannot choose a channel, an audience, a budget or a price
  for (const key of ['channel', 'audience', 'budget', 'price', 'discount', 'schedule']) {
    assert.equal(code(() => CI.normalizeAgentOutput('CREATIVE_ORCHESTRATOR', { ...CI.planCreativeRun(), [key]: 'x' })), CI.CI_ERROR.AGENT_OUTPUT_INVALID, key);
  }
  // 245 a raw URL can never become a canonical asset reference, in any contract
  const url = 'https://cdn.example.com/a.png';
  const attempts = [
    () => CI.normalizeCreativeIntake(intakeInput({ source_asset_refs: [url] })),
    () => CI.buildDesignDocument(documentParts({ asset_refs: [url] })),
    () => CI.normalizeLayer({ ...demoLayers()[2], source_ref: url }),
    () => CI.normalizeLayer({ ...demoLayers()[1], asset_ref: url }),
    () => CI.normalizeCreativeCandidate({ ...clone(candidate), rendered_asset_ref: url }),
    () => CI.normalizeProviderEntry({ provider_id: 'p', capabilities: ['STT'], regions: ['EU'], privacy_class: 'PUBLIC', commercial_rights_ref: url, latency_class: 'BATCH', cost_model_ref: 'c:1' }),
  ];
  attempts.forEach((attempt, i) => assert.equal(code(attempt), CI.CI_ERROR.INVALID_REFERENCE, `attempt ${i}`));
  // 246 normalizers never mutate their input
  const frozenIn = CI.normalizeDesignDocument(base());
  const snapshot = JSON.stringify(frozenIn);
  CI.normalizeDesignDocument(frozenIn);
  CI.runCreativePreflight(frozenIn, preflightContext());
  CI.renderDesignDocument({ document: frozenIn, fonts: fonts() });
  assert.equal(JSON.stringify(frozenIn), snapshot);
  const mutable = clone(documentParts());
  const before = JSON.stringify(mutable);
  CI.buildDesignDocument(mutable);
  assert.equal(JSON.stringify(mutable), before);
  // 247 every produced object is deep-frozen
  for (const object of [base(), candidate, CI.runCreativePreflight(base(), preflightContext()), CI.renderDesignDocument({ document: base(), fonts: fonts() }), CI.planCreativeRun(), CI.notAssessedQualityReport('cdd_x'), solved()]) {
    assert.ok(isDeepFrozen(object));
  }
  // 248 no unaudited dependency: the manifest holds the pdf pair and ONLY the three audited production packages (docs: dependency / license audit)
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@resvg/resvg-js', 'bidi-js', 'harfbuzzjs', 'pdfjs-dist', 'pdfkit']);
  assert.equal(pkg.devDependencies, undefined);
  // 249 error codes are stable, unique and namespaced
  const entries = Object.entries(CI.CI_ERROR);
  assert.equal(new Set(entries.map(([, v]) => v)).size, entries.length);
  for (const [key, value] of entries) assert.equal(value, `CI_${key}`);
  // 250 the public surface exposes the documented entry points
  for (const name of ['normalizeCreativeIntake', 'normalizeOutputContext', 'buildAssetReadinessReport', 'normalizeProductUnderstanding', 'normalizeCreativeDirection', 'buildDesignDocument', 'solveLayout', 'renderDesignDocument', 'runCreativePreflight', 'normalizeCreativeCandidate', 'selectCandidates', 'createProviderRegistry', 'defineCreativeAgent', 'createFontRegistry']) {
    assert.equal(typeof CI[name], 'function', name);
  }
});

// ------------------------------------------------------------------ demo (251-255)

test('Demo: one synthetic still, end to end, with no network and no model', () => {
  const run1 = () => {
    const layout = CI.solveLayout({ document: demoDocument(), recipe_id: 'PRODUCT_HERO', fonts: fonts(), assets: assetDims(), created_at: LATER });
    const rendered = CI.renderDesignDocument({ document: layout.document, fonts: fonts() });
    const candidate = candidateFor(layout.document);
    return { layout, rendered, candidate };
  };
  const { layout, rendered, candidate } = run1();
  // 251 the demo yields a DesignDocument, an SVG, a preflight report and a CreativeCandidate for a 1080 x 1350 PRODUCT_HERO still
  assert.equal(layout.recipe_id, 'PRODUCT_HERO');
  assert.equal(layout.document.canvas.width, 1080);
  assert.equal(layout.document.canvas.height, 1350);
  assert.match(rendered.svg, /^<svg [^>]*width="1080" height="1350"/);
  assert.equal(candidate.preflight_report.status, 'PASS');
  assert.equal(candidate.design_document.document_id, layout.document.document_id);
  // 252 the PNG projection is honest: unsupported in this runtime, never faked
  assert.equal(CI.renderPng(rendered).supported, false);
  // 253 the selection exposes the candidate without ranking it
  const selection = CI.selectCandidates({ candidates: [candidate], context: preflightContext() });
  assert.equal(selection.status, 'CANDIDATES_EXPOSED');
  assert.equal(selection.eligible.length, 1);
  // 254 the price in the SVG and in the document is exactly the approved wording
  assert.ok(rendered.svg.includes('>19,90 €</tspan>'));
  assert.equal(layout.document.layers.find((l) => l.id === 'price').content, '19,90 €');
  assert.equal(layout.document.layers.find((l) => l.id === 'price').approved_digest, CI.textDigest('19,90 €'));
  // 255 two complete runs produce the same bytes and the same ids
  const again = run1();
  assert.equal(again.rendered.digest, rendered.digest);
  assert.equal(again.candidate.candidate_id, candidate.candidate_id);
  assert.equal(CI.CI_VERSION, 'creative-intelligence.v1');
  assert.ok(ASSET_PHOTO && FONT);
});

// ------------------------------------------------------------------ coverage matrix (doc <-> tests)

test('Coverage matrix: the doc maps every behaviour row (1-255 mandate, 256+ architect audit) and every test it names exists', async () => {
  const doc = await readFile(new URL('../docs/architecture/creative-intelligence-v1.md', import.meta.url), 'utf8');
  const matrix = doc.slice(doc.indexOf('<!-- coverage-matrix:start -->'), doc.indexOf('<!-- coverage-matrix:end -->'));
  const rows = [...matrix.matchAll(/^\| (\d+) \| (.+?) \| (.+?) \|$/gm)].map((m) => ({ n: Number(m[1]), ref: m[3] }));
  assert.ok(rows.length >= 325, `at least 325 rows, found ${rows.length}`);
  assert.deepEqual(rows.map((r) => r.n), Array.from({ length: rows.length }, (_, i) => i + 1));
  for (const { n, ref } of rows) {
    const [file, name] = ref.split(' › ');
    const text = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.ok(text.includes(`test('${name}'`), `row ${n} names a test that does not exist: ${ref}`);
    assert.match(text, new RegExp(`^\\s*// ${n} `, 'm'), `row ${n} has no marker in ${file}`);
  }
});
