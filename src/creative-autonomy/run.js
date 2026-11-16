// THE AUTONOMOUS ROUTE. Input from the owner: a Shopify product snapshot, a commercial objective, the tenant's brand (creative profile), a format, the product photo.
// Nordla then, WITHOUT a human writing a concept, a headline or a position:
//   1 BRIEF       builds the Brain brief from verified facts only                         (deterministic)
//   2 EXAMINE     measures the photo and cuts the product out, or says why it cannot       (local engine)
//   3 OBSERVE     what the frame may rest on                                               (deterministic, existing Brain)
//   4 FRAME       frames the creative problem                                              (language model, existing Brain)
//   5 IDEATE      invents 3 distinct concepts                                              (language model, existing Brain + distinctness guard)
//   6 ART_DIRECT  an art direction per concept                                             (language model, existing Brain)
//   7 STAGE       the mise en scène per concept, in a closed vocabulary + tenant rules      (language model, new contract)
//   8 RENDER      the set in Blender from the STAGE (no product pixels involved)            (local engine)
//   9 COMPOSE     the real photo placed untouched + bounded light layers + text             (local engine) -> fidelity proof + technical checks
//  10 CRITIC      concept strength on the rendered image                                   (vision model, existing Brain)
//  11 REFINE      at most 2 rounds: deterministic fixes within allowed limits, or a STAGE re-ask with the critic's hints
//  12 REVIEW      a package for the owner; every proposal is PROPOSED, never approved, never published
// A stage whose engine is not connected STOPS the run with PROVIDER_NOT_CONNECTED. Nothing is ever simulated in place of a missing engine.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessBrief } from '../creative-brain/brief-assessment.js';
import { observeBrief, createProblemFramer } from '../creative-brain/problem-frame.js';
import { createConceptDirector } from '../creative-brain/concept.js';
import { createArtDirector, artSpecVisible } from '../creative-brain/art-direction.js';
import { verifiedReferencesOf } from './verified-references.js';
import { createConceptCritic, creativeQualityState } from '../creative-brain/concept-critic.js';
import { runFinalReview, finalVerdictOf } from './final-review.js';
import { createConceptSelector } from '../creative-brain/concept-selection.js';
import { buildAutonomousBrief } from './brief.js';
import { buildHeadlineInstruction, createStageDirector, headlineProblem, ownerHeadlineProblem, measureHeadline, normalizeStage, parseHeadlineCandidates, pickHeadline } from './stage-contract.js';
import { assertConceptsBrandRules, assertArtDirectionGuard, assertStageGuard, commercialBriefNote, benefitSourceOf, verifiedTextOf } from './brand-guard.js';
import { resolveBrandProfile, artDirectionHintFor } from './brand-profile.js';
import { sceneVocabularyHint } from './product-free-screen.js';
import { litSideOfRgba } from './packshot-light.js';
import { buildReviewPack } from './review-pack.js';
import { buildProductSheet } from './product-sheet.js';
import { assertElementsDoNotNameProduct } from './product-visible-request.js';
import { productFactsForArtDirector } from '../creative-brain/art-direction.js';
import { decodePng } from '../creative-intelligence/png-pixels.js';
import { BRAIN_ERROR } from '../creative-brain/validation.js';
import { collectArtViolations, repairRequest } from './art-violations.js';
import { collectConceptViolations, assertConceptsRoute, routeNotesForSelection } from './concept-violations.js';
import { ROUTE_ENVIRONMENT_FIRST, ROUTE_PRODUCT_VISIBLE, PRODUCT_VISIBLE_FRAME_HINT, ENVIRONMENT_FIRST_FEASIBILITY_QUESTION } from './route-executability.js';
import { photoCameraHeight, cameraFollowsPhoto } from './photo-perspective.js';
import { assertFrameLeavesSetOpen, collectFrameViolations } from './frame-intent.js';
import { ENVIRONMENT_FIRST_FRAME_HINT } from './route-executability.js';
import { CRITERION, OUTCOME } from '../creative-brain/concept-selection.js';
import { collectStageViolations } from './stage-violations.js';
import { assertHeadlineGuard } from './brand-guard.js';
import { buildResumeManifest } from './run-resume.js';
import { planPatches, applyPatches, parseReply, patchInstruction } from './repair-patch.js';
import { PROVIDER_STATE, WHAT_IS_NEEDED } from './providers.js';
import { runAdSinglePass } from './ad-single-pass.js';
import { AD_ROUTE_ID, runAdDecisions, runAdRecomposition, decisionRecordsOf, productFactsForAd, verifiedFactsOf, placementOptionsOf } from './ad-route.js';
import { B0_NEGATIVE } from './full-power-b0.js';

const run$ = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '../../scripts/creative-autonomy');

export const RUN_STATUS = Object.freeze({
  PROPOSALS_READY_FOR_OWNER: 'PROPOSALS_READY_FOR_OWNER',
  STOPPED_PROVIDER_NOT_CONNECTED: 'STOPPED_PROVIDER_NOT_CONNECTED',
  STOPPED_BRIEF_INCOMPLETE: 'STOPPED_BRIEF_INCOMPLETE',
  CONCEPTS_ONLY_ASSET_NOT_USABLE: 'CONCEPTS_ONLY_ASSET_NOT_USABLE',
  IDEATION_ONLY_NOT_A_VISUAL: 'IDEATION_ONLY_NOT_A_VISUAL',
  STOPPED_NO_CONCEPT_SELECTED: 'STOPPED_NO_CONCEPT_SELECTED',
  STOPPED_ERROR: 'STOPPED_ERROR',
});
export const KIND = Object.freeze({ DETERMINISTIC: 'DETERMINISTIC', LLM: 'LLM', VISION: 'VISION', LOCAL_ENGINE: 'LOCAL_ENGINE' });
export const MAX_REFINE_ROUNDS = 2;
/** The decor-first route's bar: a concept is SELECTed only if it MEETS these (the historical pair, plus composition and perceived value). */
export const ROUTE_STRONG_CRITERIA = Object.freeze([CRITERION.CONCEPT_STRENGTH, CRITERION.DISTINCTIVENESS, CRITERION.COMPOSITION_STRENGTH, CRITERION.PERCEIVED_VALUE]);
/** What SELECT advised for every concept that did not meet the bar: the non-MEETS criteria with their refinement (at most 4 per concept, like the Brain's own refinement list), kept so that the NEXT round starts from it. */
export function resumeAdviceOf(selection, concepts = []) {
  const byId = new Map((concepts ?? []).map((c) => [c.concept_id, c]));
  return (selection?.evaluations ?? []).map((e) => ({ concept_id: e.concept_id, central_idea: byId.get(e.concept_id)?.central_idea ?? null,
    advice: e.criteria.filter((c) => c.outcome !== OUTCOME.MEETS && (c.refinement || c.outcome === OUTCOME.FAILS)).map((c) => ({ criterion: c.criterion, outcome: c.outcome, refinement: c.refinement ?? null, evidence: c.evidence ?? null })).slice(0, 4) }))
    .filter((x) => x.advice.length);
}
/** SELECT's refinement advice for ONE concept, given to its art director as directions to apply (it used to be dropped between SELECT and ART_DIRECT). null when there is none. */
export function selectorAdviceHint(selection, conceptId) {
  const e = (selection?.evaluations ?? []).find((x) => x.concept_id === conceptId);
  const lines = (e?.criteria ?? []).filter((c) => c.outcome !== OUTCOME.MEETS && c.refinement).map((c) => `- ${c.criterion}: ${c.refinement}`).slice(0, 4);
  return lines.length ? ["The selector's refinement advice for THIS concept (apply it in the art direction, within what the route can build):", ...lines].join(String.fromCharCode(10)) : null;
}
/** Every local cut-back of a decision (a text longer than its limit, a list longer than its limit), with what was removed: a cut can remove something essential, so it is reported BEFORE generation (the request report and the trace). */
export function lengthCutsOf(meta, prefix) {
  return (meta?.repairs ?? []).filter((r) => r.kind === 'LENGTH_FIT' || r.kind === 'LIST_FIT').map((r) => ({ field: String(r.path).replace(/^[A-Z_]+[.]/, `${prefix}.`), kind: r.kind, from: r.from, to: r.to, removed: r.dropped ?? null }));
}
export const MAX_CONCEPT_FALLBACKS = 1; // after the selected concept, at most ONE more eligible concept is prepared (text calls only; no image is bought before the preparation succeeds)

/**
 * BOUNDED CONTRACT REPAIR. When a model answer is well-formed JSON but refused by a contract rule (a text too long, a forbidden word, a missing key...), Nordla
 * may ask the SAME stage ONCE more, telling the model exactly which field broke which rule. The repair is a paid call, so it exists only when the owner's
 * authorised plan says so: maxRepairCalls (default 0 = no repair, the run stops as before). Never on a provider failure (no retry policy), never twice for
 * the same stage call, and every repair goes through the same port, SpendGuard, call cap and journal as any other call. The refused answer stays in the trace.
 */
/** The Brain stages that can spend a repair of the shared pool (and therefore have one reserved). */
export const REPAIR_STAGES = Object.freeze(['FRAME', 'IDEATE', 'SELECT', 'ART_DIRECT', 'STAGE']);
export const REPAIRABLE = Object.freeze(new Set([BRAIN_ERROR.NOT_DISTINCT, BRAIN_ERROR.TEXT_INVALID, BRAIN_ERROR.MISSING_KEY, BRAIN_ERROR.UNKNOWN_KEY, BRAIN_ERROR.ENUM_INVALID, BRAIN_ERROR.LIST_INVALID, BRAIN_ERROR.NUMERIC_VALUE, BRAIN_ERROR.FORBIDDEN_CONTENT, BRAIN_ERROR.RULE_VIOLATION,
  // a repair REJECTED because it deleted or added items (real run 2026-11-05: the first repair dropped a prop): nothing was applied, the planned SECOND repair is told exactly that. Still bounded by the repair cap and judged by the same contract.
  'REPAIR_ARRAY_LENGTH_CHANGED']));
// A refusal of the CONTRACT (a rule broken, a repair that broke the repair contract, a repair budget spent), as opposed to a provider failure, a spend/call cap or a media-safety error.
const isContractRefusal = (error) => REPAIRABLE.has(error?.code) || /^REPAIR_/.test(String(error?.code ?? '')) || error?.code === BRAIN_ERROR.MALFORMED;
// A forbidden-content refusal carries the exact words found (error.detail.words): the repair must name them, or the model has no way to know which word to drop.
const refusedWords = (error) => (Array.isArray(error.detail?.words) && error.detail.words.length ? ` The refused word(s) in that field: ${error.detail.words.map((w) => `"${String(w).slice(0, 40)}"`).join(', ')}. Rewrite the field without them or any synonym: describe only what is seen, never a phone, a device or the product.` : '');
export const repairHint = (error, scoped = false, violations = null, concept = null) => `Your previous answer was REFUSED by Nordla's contract: ${error.code} at ${error.field ?? 'unknown field'}: ${String(error.message).slice(0, 240)}.${violations?.length ? repairRequest(violations, concept) : refusedWords(error)}${scoped ? patchInstruction(violations?.length ? violations.map((v) => v.field) : [error.field]) : ' Return the whole answer again with this field corrected. Keep everything else that was valid.'}`;

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// SCOPED REPAIR. A repair may only change the field the contract refused. The model's new answer contributes ONLY that field (by its path); everything else is
// the previous answer, already checked. So a repair can never replace a valid structure elsewhere (first real trial, 2026-11-01: a repair turned a valid
// PLINTH/BENEATH into a refused BLOCK/BENEATH). The changes the model made outside the field are recorded, never applied. When the refusal names no precise
// field (a whole-answer rule), the whole new answer is used, as before.
const ENVELOPES = new Set(['stage', 'art_direction', 'frame', 'answer', 'selection', 'concept_critique']);
/** 'stage.props[0].reason' -> ['props', 0, 'reason'] (the leading envelope name is not a key of the answer). */
export function fieldPath(field, original) {
  if (typeof field !== 'string' || !field) return [];
  const tokens = [];
  for (const part of field.split('.')) { const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part); if (!m) return []; if (m[1]) tokens.push(m[1]); for (const i of m[2].matchAll(/\[(\d+)\]/g)) tokens.push(Number(i[1])); }
  if (tokens.length && typeof tokens[0] === 'string' && (ENVELOPES.has(tokens[0]) && !(original && Object.hasOwn(original, tokens[0])))) tokens.shift();
  return tokens;
}
const getAt = (o, path) => path.reduce((x, k) => (x == null ? undefined : x[k]), o);
function setAt(o, path, value) {
  let x = o;
  for (let i = 0; i < path.length - 1; i += 1) { if (x[path[i]] == null || typeof x[path[i]] !== 'object') return false; x = x[path[i]]; }
  const last = path[path.length - 1];
  if (value === undefined) { if (Array.isArray(x)) return false; delete x[last]; } else x[last] = value;
  return true;
}
function diffPaths(a, b, prefix = '', out = []) {
  if (out.length >= 25) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], Array.isArray(a) ? `${prefix}[${k}]` : (prefix ? `${prefix}.${k}` : k), out);
    return out;
  }
  out.push(prefix || '(whole answer)');
  return out;
}
/** True when every field names a precise place of the previous answer whose container exists (the repair can then be a patch). */
function addressable(originalText, field) {
  let original; try { original = JSON.parse(originalText); } catch { return false; }
  if (!original || typeof original !== 'object') return false;
  return [].concat(field).every((f) => { const p = fieldPath(f, original); const parent = getAt(original, p.slice(0, -1)); return p.length > 0 && parent !== null && typeof parent === 'object' && (!Array.isArray(parent) || p.at(-1) < parent.length); });
}
/** The repaired answer actually normalised: the previous answer with ONLY the refused fields replaced, through validated patches (see repair-patch.js). A reply that breaks the repair contract is REJECTED, never half-applied. */
export function scopedMerge(originalText, repairText, field) {
  let original; try { original = JSON.parse(originalText); } catch { return { text: repairText, applied: false, scope: null, discarded: [], reason: 'UNPARSEABLE' }; }
  const reply = parseReply(repairText);
  if (!reply.ok) return { text: repairText, applied: false, scope: null, discarded: [], reason: 'UNPARSEABLE' };
  const fields = Array.isArray(field) ? field : [field];
  const paths = fields.map((f) => fieldPath(f, original));
  if (!paths.length || paths.some((p) => !p.length) || !original || typeof original !== 'object') return { text: repairText, applied: false, scope: 'WHOLE_ANSWER', discarded: [], reason: 'NO_PRECISE_FIELD' };
  const plan = planPatches({ original, reply: reply.value, required: fields.map((f, i) => ({ field: f, path: paths[i] })), resolve: (f) => fieldPath(f, original) });
  if (!plan.ok) return { text: repairText, applied: false, scope: fields.join(', '), discarded: [], reason: 'REPAIR_REJECTED', rejected: plan.reject };
  const merged = applyPatches(original, plan.patches);
  return { text: JSON.stringify(merged), applied: true, scope: fields.join(', '), form: plan.form, patches: plan.patches.length, discarded: plan.form === 'PATCHES' ? [] : diffPaths(merged, reply.value) };
}

/** Default local engines: real processes, zero cost. Tests may replace them. */
const EXAM_FILES = ['examen.json', 'produit_rgba.png'];
export function localEngines({ python = process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), blenderPython = process.env.NORDLA_BLENDER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), renderScale = 0.5, samples = 32 } = {}) {
  const py = async (bin, args) => (await run$(bin, args, { maxBuffer: 1 << 24, timeout: 900_000 })).stdout;
  // The examination is deterministic (same bytes -> byte-identical examen.json, cut-out and report; verified): a revision or a second creation
  // of the SAME photo reuses it instead of re-examining (one Python start and ~0.8 s). Keyed by the photo's SHA-256, never by its path.
  const examined = new Map(); // sha256 -> { dir, result }
  return {
    name: { examine: 'examine_product.py', render: 'render_stage.py (Blender Cycles)', compose: 'compose_stage.py' },
    binding: Object.freeze({ transmits_source_media: false, source_sha256: null }), // local only: nothing leaves the machine
    async examine({ photoPath, outDir }) {
      const key = createHash('sha256').update(readFileSync(photoPath)).digest('hex');
      const hit = examined.get(key);
      if (hit && EXAM_FILES.every((f) => existsSync(join(hit.dir, f)))) {
        mkdirSync(outDir, { recursive: true });
        for (const f of EXAM_FILES) copyFileSync(join(hit.dir, f), join(outDir, f));
        return structuredClone(hit.result);
      }
      const out = await py(python, [join(SCRIPTS, 'examine_product.py'), photoPath, outDir]);
      const result = JSON.parse(out.trim().split('\n').pop());
      examined.set(key, { dir: outDir, result: structuredClone(result) });
      return result;
    },
    async render({ stagePath, examPath, rgbaPath, canvas, outPath }) {
      const w = Math.round(canvas.width * renderScale); const h = Math.round(canvas.height * renderScale);
      const out = await py(blenderPython, [join(SCRIPTS, 'render_stage.py'), '--', stagePath, examPath, rgbaPath, String(w), String(h), String(samples), outPath]);
      const line = out.split('\n').find((l) => l.startsWith('RENDER_INFO '));
      if (!line) throw Object.assign(new Error('the scene engine produced no render'), { code: 'RENDER_FAILED' });
      return JSON.parse(line.slice('RENDER_INFO '.length));
    },
    async readability({ noTitlePath, rgbaPath, examPath, box }) {
      const out = await py(python, [join(SCRIPTS, 'readability_on_result.py'), noTitlePath, rgbaPath, examPath, ...box.map(String)]);
      return JSON.parse(out.trim().split('\n').pop());
    },
    async compose({ stagePath, setPath, rgbaPath, examPath, factsPath, outPath }) {
      const out = await py(python, [join(SCRIPTS, 'compose_stage.py'), stagePath, setPath, rgbaPath, examPath, factsPath, outPath]);
      return JSON.parse(out.trim().split('\n').pop());
    },
  };
}

// ---- the deterministic refinements Nordla may make on its own: text placement and framing only (never the product, never the headline, never the concept)
const OPPOSITE_COLUMN = { LEFT_THIRD: 'RIGHT_COLUMN', RIGHT_THIRD: 'LEFT_COLUMN', CENTER: 'TOP_LEFT' };
const CLOSER = { WIDE: 'MEDIUM', MEDIUM: 'CLOSE', CLOSE: 'CLOSE' };
const WIDER = { CLOSE: 'MEDIUM', MEDIUM: 'WIDE', WIDE: 'WIDE' };
export function deterministicFix(stage, defects) {
  const change = {};
  if (defects.some((d) => d === 'HEADLINE_OVERLAPS_PRODUCT' || d === 'INFO_OVERLAPS_PRODUCT' || d === 'TEXT_OUTSIDE_MARGINS')) {
    const target = OPPOSITE_COLUMN[stage.camera.product_position];
    if (target !== stage.text_placement) change.text_placement = target;
    else if (stage.camera.product_position === 'CENTER') change.camera = { ...stage.camera, product_position: 'LEFT_THIRD' };
  }
  if (defects.includes('PRODUCT_TOO_SMALL') && CLOSER[stage.camera.framing] !== stage.camera.framing) change.camera = { ...(change.camera ?? stage.camera), framing: CLOSER[stage.camera.framing] };
  if (defects.includes('PRODUCT_CROPPED_BY_FRAME') && WIDER[stage.camera.framing] !== stage.camera.framing) change.camera = { ...(change.camera ?? stage.camera), framing: WIDER[stage.camera.framing] };
  return Object.keys(change).length ? change : null;
}
const NEEDS_BRAIN = new Set(['LOW_TEXT_CONTRAST']);
const stripIds = ({ stage_id, concept_id, ...rest }) => rest; // eslint-disable-line no-unused-vars

const flagged = (d) => d.outcome === 'FAIL' || d.outcome === 'REVIEW_REQUIRED';
// THE INDEPENDENT JUDGE (no new agent): seven axes, each from the evidence that can actually support it. Deterministic measures judge what is
// measurable; the concept critic judges what it saw ON THE RENDERED IMAGE (its evidence is kept); an axis nothing measured is NOT_MEASURABLE,
// never a pass. A technically correct image is never called premium: premium_quality_implied is always false (only the owner approves).
const axis = (verdict, source, evidence = null) => ({ verdict, source, evidence });
const fromDims = (dims, names) => {
  const ds = (dims ?? []).filter((d) => names.includes(d.dimension));
  if (!ds.length || ds.some((d) => d.outcome === 'NOT_MEASURABLE') || ds.some((d) => !String(d.evidence ?? '').trim())) return axis('NOT_MEASURABLE', ds.length ? 'concept critic (rendered image)' : 'none', null);
  const v = ds.some((d) => d.outcome === 'FAIL') ? 'FAIL' : ds.some((d) => d.outcome === 'REVIEW_REQUIRED') ? 'REVIEW_REQUIRED' : 'PASS';
  return axis(v, 'concept critic (rendered image)', ds.map((d) => `${d.dimension}: ${d.evidence}`).join(' | '));
};
export function judgeProposal({ technical, critique }) {
  const dims = critique?.dimensions ?? null;
  return Object.freeze({
    technical_correctness: axis(technical.defects.length ? 'FAIL' : 'PASS', 'deterministic checks (composition, text, frame)', technical.defects.length ? technical.defects.join(', ') : null),
    product_fidelity: axis(technical.product_fidelity.pass ? 'PASS' : 'FAIL', 'deterministic pixel proof against the source photo', `max level difference ${technical.product_fidelity.max_level_difference_after_removing_layers ?? '?'}`),
    creative_originality: fromDims(dims, ['DISTINCTIVENESS', 'WOW_FACTOR']),
    storytelling_coherence: fromDims(dims, ['CONCEPT_STRENGTH', 'NARRATIVE_COHESION']),
    premium_artistic_execution: fromDims(dims, ['EDITORIAL_SOPHISTICATION']),
    brand_relevance: axis('NOT_MEASURABLE', 'none', 'no brand-relevance judgment on the rendered image is connected in this route'),
    commercial_effectiveness: axis('NOT_MEASURABLE', 'none', 'judged by the owner and, later, by measured results; SELECT judged the concept, not the image'),
    premium_quality_implied: false,
  });
}
function creativeQuality(critique, technical = null) {
  const canonical = technical ? creativeQualityState({ critique: null, conceptCritique: critique ?? null,
    deterministic: { preflight: technical.defects.length ? 'FAIL' : 'PASS', fidelity: technical.product_fidelity.pass ? 'PASS' : 'FAIL', guardian: 'PASS' } }) : null;
  const extra = { ...(canonical ? { canonical, execution_critique: 'NOT_CONNECTED' } : {}) };
  if (!critique) return { state: 'NOT_MEASURED', reason: 'critique visuel non connecté', dimensions: [], ...extra };
  const dims = critique.dimensions;
  if (dims.every((d) => d.outcome === 'NOT_MEASURABLE')) return { state: 'NOT_MEASURED', reason: dims[0]?.evidence ?? null, dimensions: dims, ...extra };
  if (dims.some(flagged)) return { state: 'CREATIVELY_INSUFFICIENT', dimensions: dims, ...extra };
  // a critique that could not judge every dimension proves nothing about the others: not measured, never "sufficient"
  if (dims.some((d) => d.outcome === 'NOT_MEASURABLE')) return { state: 'NOT_MEASURED', reason: 'PARTIALLY_MEASURED', dimensions: dims, ...extra };
  return { state: 'CREATIVELY_SUFFICIENT_AWAITING_OWNER', dimensions: dims, ...extra };
}
function technicalQuality(report) {
  const fid = report.fidelity;
  // A missing or unmeasurable fidelity sample must never be treated as success.
  // The visible RGB pixels (not only a reversible relight layer) decide fidelity in scene mode.
  // Fail closed: a report without per-pixel counters or without an explicit scene_mode proves nothing.
  const measurable = Number.isInteger(fid.checked_pixels) && Number.isInteger(fid.minimum_checked_pixels)
    && fid.checked_pixels >= fid.minimum_checked_pixels;
  const visibleColorPass = fid.scene_mode === true
    ? Number.isFinite(fid.max_visible_level_difference) && fid.max_visible_level_difference <= 2
    : fid.scene_mode === false;
  const fidelityPass = Number.isFinite(fid.max_level_difference_after_removing_layers)
    && fid.max_level_difference_after_removing_layers <= 2 && measurable && visibleColorPass;
  return {
    state: fidelityPass && !report.technical.defects.length ? 'PASS' : 'FAIL',
    product_fidelity: { pass: fidelityPass, ...fid },
    defects: report.technical.defects, text_contrast_ratio: report.technical.text_contrast_ratio, product_height_share: report.technical.product_height_share,
  };
}

/**
 * @param {object} o
 *   input:   { product, variantTitle?, readAt, objective, audience?, occasion?, brand, format, photoPath, photoMeta: { media_type, width_px, height_px, origin, rights_class }, merchant? }
 *   ports:   { text: complete|null, vision: vlm|null, state: { text, vision }, model?: { text, vision }, budget? }
 *   engines: localEngines()
 *   workdir: where every intermediate file is kept (the run is fully inspectable)
 */
export async function runAutonomous({ input, ports, engines = localEngines(), workdir, now = () => Date.now(), mode = 'FULL', maxRepairCalls = 0, reservedRepairs = {}, repairsPerStage = {}, maxHeadlineCalls = 0, produce = 'ALL', adPath = null }) {
  const profile = resolveBrandProfile(input?.brand); // the ACTIVE tenant's creative rules (GENERIC when it has none): never another merchant's
  if (!Number.isInteger(maxRepairCalls) || maxRepairCalls < 0) throw new TypeError('maxRepairCalls must be a non-negative integer');
  // repairsPerStage: { STAGE: 2 } lets the plan allow a SECOND repair for a named stage (default 1 for every stage); both come from the shared pool and reservedRepairs should cover them
  if (!repairsPerStage || typeof repairsPerStage !== 'object' || Array.isArray(repairsPerStage) || Object.entries(repairsPerStage).some(([k, v]) => !REPAIR_STAGES.includes(k) || !Number.isInteger(v) || v < 1 || v > 2)) throw new TypeError('repairsPerStage must name known stages with 1 or 2');
  // maxHeadlineCalls: dedicated headline calls (tiny, own cap, own allowance, NOT the shared repair pool) used only when the headline and all its alternatives break the hard rules; 0 = none
  if (!Number.isInteger(maxHeadlineCalls) || maxHeadlineCalls < 0) throw new TypeError('maxHeadlineCalls must be a non-negative integer');
  // reservedRepairs: { STAGE: 1 } keeps that many repairs of the shared pool (maxRepairCalls) for ONE stage: no other stage, and no protocol re-ask of another stage, can take them; the stage can always use them.
  // In the last two real runs IDEATE and ART_DIRECT spent the whole pool and the stage had none left.
  if (!reservedRepairs || typeof reservedRepairs !== 'object' || Array.isArray(reservedRepairs) || Object.entries(reservedRepairs).some(([k, v]) => !REPAIR_STAGES.includes(k) || !Number.isInteger(v) || v < 0)
    || Object.values(reservedRepairs).reduce((n, v) => n + v, 0) > maxRepairCalls) throw new TypeError(`reservedRepairs must name known stages (${REPAIR_STAGES.join(', ')}) with non-negative integers that fit in maxRepairCalls`);
  // produce: 'ALL' = every concept is art-directed, staged and rendered (the original route); 'SELECTED' = only the concept Nordla's own SELECT stage chose
  // (premium path: one paid scene for the concept Nordla judged best, never simply the first of the list)
  if (!['ALL', 'SELECTED'].includes(produce)) throw new TypeError('produce must be ALL or SELECTED');
  // a scene engine (scene-engine.js) renders a PAID scene once; a refinement may only move the text, which needs no new scene
  const sceneMode = Boolean(engines.sceneMode);
  // AD ROUTE (explicit, opt-in per run: input.route === 'AD_V1'): Nordla's own proposals and composition replace FRAME / IDEATE / SELECT / ART_DIRECT / STAGE; the rest (request, generation, restoration, compositor, review) is this pipeline's, unchanged
  const adRoute = input?.route === AD_ROUTE_ID;
  if (adRoute && !(engines.productVisible && engines.prepare && engines.kit)) throw Object.assign(new TypeError('AD_ROUTE_REQUIRES_THE_PRODUCT_VISIBLE_SCENE_ENGINE'), { code: 'AD_ROUTE_REQUIRES_THE_PRODUCT_VISIBLE_SCENE_ENGINE' });
  const sceneProductless = Boolean(engines.productless); // the environment is built WITHOUT the product: its words are screened at ART_DIRECT (C1)
  const photoCam = photoCameraHeight(profile, input?.product?.id); // the perspective of the product's photograph, from the owner-validated appearance sheet (null when it states none)
  const visibleRoute = !sceneProductless && engines.productVisible ? ROUTE_PRODUCT_VISIBLE : null; // the generator SEES the product: told to FRAME and IDEATE through the brief, frame and composition checked (no decor-first executability rule)
  const route = sceneProductless ? ROUTE_ENVIRONMENT_FIRST : null; // the decor-first route: told to FRAME, IDEATE, SELECT and ART_DIRECT, checked on every concept (route-executability.js)
  let repairsUsed = 0; let headlineCalls = 0; const repairsByStage = {};
  const baseStage = (name) => String(name ?? '').replace(/-cnc_.*/, '').replace(/_REPAIR$/, '');
  // a repair of `stage` may be spent only if, after it, the repairs still reserved for the OTHER stages remain available
  const reservedForOthers = (stage) => Object.entries(reservedRepairs).reduce((n, [st, k]) => (st === stage ? n : n + Math.max(0, k - (repairsByStage[st] ?? 0))), 0);
  const mayRepair = (stage) => maxRepairCalls - repairsUsed > reservedForOthers(stage);
  const spendRepair = (stage) => { repairsUsed += 1; repairsByStage[stage] = (repairsByStage[stage] ?? 0) + 1; };
  const ideationOnly = mode === 'IDEATION_ONLY';
  mkdirSync(workdir, { recursive: true });
  const trace = [];
  const humanInterventions = [
    // The client never approves/confirms a source product image before creative work.
    // Product-source validation belongs to the internal media pipeline; approval is only after creation.
    { when: 'avant le passage', who: 'opérateur', what: 'a défini le produit, l\'objectif commercial et le format', creative: false },
  ];
  let textCost = 0; let lastModel = null; let lastCost = 0; let currentStep = null; let brainCall = 0; let repairNote = null; let callsInStep = 0; let lastReplyText = null; let repairScope = null; let lastMerge = null; let briefNote = null;
  // the merchant's commercial brief, repeated to the stages that do not see the public facts (set once the brief exists)
  const BRIEF_STAGES = new Set(['IDEATE', 'SELECT', 'ART_DIRECT', 'IDEATE_REPAIR', 'SELECT_REPAIR', 'ART_DIRECT_REPAIR']);
  const brainDir = join(workdir, 'brain-calls');
  const metered = ports.text ? async (original) => {
    // during an authorised repair, the exact violation is appended to the stage's own instruction (works for every Brain stage, no Brain module changed)
    const stepName = String(currentStep ?? '').replace(/-cnc_.*/, '');
    const notes = [BRIEF_STAGES.has(stepName) ? briefNote : null, repairNote].filter(Boolean);
    const instruction = notes.length ? { ...original, system: `${original.system}\n${notes.join('\n')}` } : original;
    // a SECOND call inside one stage call is the Brain's own protocol re-ask (invalid JSON): it is a repair too, and it spends the SAME budget, refused before sending
    callsInStep += 1;
    if (callsInStep > 1) {
      if (!mayRepair(baseStage(currentStep))) throw Object.assign(new Error(`repair budget exhausted (${repairsUsed}/${maxRepairCalls}, ${reservedForOthers(baseStage(currentStep))} reserved for other stages): the protocol re-ask was not sent`), { code: 'REPAIR_BUDGET_EXHAUSTED' });
      spendRepair(baseStage(currentStep));
    }
    brainCall += 1; mkdirSync(brainDir, { recursive: true });
    const tag = `${String(brainCall).padStart(2, '0')}-${currentStep ?? 'STAGE'}`;
    writeFileSync(join(brainDir, `${tag}.request.json`), JSON.stringify({ system: instruction.system, user: instruction.user }, null, 1));
    let reply;
    try { reply = await ports.text(instruction); } catch (error) { writeFileSync(join(brainDir, `${tag}.error.json`), JSON.stringify({ code: error.code ?? null, message: String(error.message).slice(0, 300) })); throw error; }
    writeFileSync(join(brainDir, `${tag}.response.txt`), String(reply.text ?? ''));
    writeFileSync(join(brainDir, `${tag}.meta.json`), JSON.stringify({ model: reply.model ?? null, request_id: reply.request_id ?? null, cost_eur: reply.cost_eur ?? null }));
    lastModel = reply.model ?? null; lastCost = reply.cost_eur ?? 0; textCost += lastCost;
    if (repairScope) {
      const m = scopedMerge(repairScope.originalText, String(reply.text ?? ''), repairScope.field);
      lastMerge = { scope: m.scope, applied: m.applied, form: m.form ?? null, patches: m.patches ?? null, discarded_outside_scope: m.discarded, reason: m.reason ?? null, rejected: m.rejected ?? null };
      if (m.rejected) throw Object.assign(new Error(`the repair was REJECTED, nothing applied: ${m.rejected.code} ${JSON.stringify(m.rejected.detail).slice(0, 200)}`), { code: m.rejected.code, field: m.rejected.detail?.field ?? null, detail: m.rejected.detail });
      if (m.applied) { writeFileSync(join(brainDir, `${tag}.merged.txt`), m.text); lastReplyText = m.text; return { ...reply, text: m.text }; }
    }
    lastReplyText = String(reply.text ?? '');
    return reply;
  } : null;

  async function step(rec, fn) {
    const t0 = now(); lastCost = 0; lastModel = null; callsInStep = 0; currentStep = rec.concept_id ? `${rec.step}-${rec.concept_id}` : rec.step;
    const entry = { n: trace.length + 1, ...rec, model: null, cost_eur: 0, ms: 0, outcome: null, detail: null };
    trace.push(entry);
    try {
      const { outcome, detail, value } = await fn();
      Object.assign(entry, { outcome, detail, model: lastModel ?? rec.model ?? null, cost_eur: lastCost, ms: now() - t0 });
      return value;
    } catch (error) {
      Object.assign(entry, { outcome: 'ERROR', detail: { code: error.code ?? null, message: String(error.message).slice(0, 300), field: error.field ?? null, ...(error.evidence ? { evidence: error.evidence } : {}) }, ms: now() - t0 });
      throw error;
    }
  }
  /** One stage call; if its answer breaks a contract rule and the plan allows a repair, ONE more call of the same stage with the exact violation. */
  async function repairable(rec, call, collect = null, rescue = null) {
    try { return await step(rec, call); } catch (error) {
      // a rescue (the dedicated headline call) gets the first chance, with its OWN allowance: it never spends the shared repair pool; undefined = not rescued, the usual repair applies
      if (rescue && REPAIRABLE.has(error?.code)) { const rescued = await rescue(error); if (rescued !== undefined) return rescued; }
      if (!REPAIRABLE.has(error?.code) || !mayRepair(baseStage(rec.step))) throw error;
      const repairCap = Math.max(1, repairsPerStage[baseStage(rec.step)] ?? 1); // the plan may allow ONE MORE repair of this stage (default 1: unchanged)
      const firstText = lastReplyText; let refused = error; let broke = null;
      for (let attempt = 1; attempt <= repairCap; attempt += 1) {
      if (attempt > 1 && (!REPAIRABLE.has(refused?.code) || !mayRepair(baseStage(rec.step)))) throw refused;
      spendRepair(baseStage(rec.step));
      const originalText = attempt === 1 ? lastReplyText : firstText; // a rejected repair applied NOTHING: the second one starts again from the first answer
      const error = refused;
      // the validators stop at the FIRST refusal: every violation of the answer (all rules) is collected now, so this ONE repair can fix them all
      let violations = collect && originalText ? collect(originalText) : [];
      if (collect && error.field && !broke?.field && !violations.some((v) => v.field === error.field || v.field.startsWith(`${error.field}.`) || v.field.startsWith(`${error.field}[`))) violations = [...violations, { field: error.field, issues: [{ rule: error.code, message: String(error.message).slice(0, 240) }] }];
      // the second repair is also told what the FIRST repair broke (the rule its new text refused), so it cannot repeat it
      if (broke?.field) { const issue = { rule: broke.rule, message: String(broke.message).slice(0, 240) }; const at = violations.find((v) => v.field === broke.field); if (at) { if (!at.issues.some((x) => x.rule === issue.rule)) at.issues.push(issue); } else violations = [...violations, { field: broke.field, issues: [issue] }]; }
      violations = violations.length ? violations : null;
      const repairFields = violations ? violations.map((v) => v.field) : error.field;
      const scoped = Boolean(originalText) && addressable(originalText, repairFields);
      repairNote = repairHint(error, scoped, scoped ? violations : null, collect?.concept ?? null);
      repairScope = scoped ? { originalText, field: repairFields } : null; lastMerge = null;
      const repairRec = { ...rec, step: `${rec.step}_REPAIR`, repair_of: { code: error.code, field: error.field ?? null }, repair_scope: scoped ? [].concat(repairFields).join(', ') : 'WHOLE_ANSWER', repairs_used: repairsUsed, repairs_allowed: maxRepairCalls };
      try {
        return await step(repairRec, call);
      } catch (e) {
        // the Brain wraps whatever its port throws into BRAIN_PORT_FAILED: a rejected repair is reported under its own, exact code
        const r = lastMerge?.rejected;
        const thrown = r ? Object.assign(new Error(`the repair was REJECTED and nothing was applied: ${r.code} ${JSON.stringify(r.detail).slice(0, 200)}`), { code: r.code, field: r.detail?.field ?? null, detail: r.detail }) : e;
        // a repair that was merged but whose NEW text breaks another rule (the real case of 2026-11-05) throws that rule's error itself; either way the second repair is told exactly what broke
        if (attempt < repairCap && REPAIRABLE.has(thrown?.code)) { refused = thrown; broke = { field: thrown.field ?? r?.detail?.field ?? null, rule: thrown.detail?.problem ?? r?.detail?.problem ?? thrown.code, message: thrown.message }; continue; }
        throw thrown;
      } finally {
        const entry = trace.at(-1); if (entry && entry.step === repairRec.step) { entry.repair_merge = lastMerge; if (lastMerge?.rejected) Object.assign(entry, { outcome: 'REPAIR_REJECTED', detail: { code: lastMerge.rejected.code, message: 'the repair was REJECTED, nothing applied', field: lastMerge.rejected.detail?.field ?? null, ...lastMerge.rejected.detail } }); }
        repairNote = null; repairScope = null;
      }
      }
    }
  }
  const notConnected = (rec, port) => {
    trace.push({ n: trace.length + 1, ...rec, provider: PROVIDER_STATE.NOT_CONNECTED, model: null, cost_eur: 0, ms: 0, outcome: 'PROVIDER_NOT_CONNECTED', detail: { needed: WHAT_IS_NEEDED[port] } });
  };
  const finish = (status, extra = {}) => {
    const result = {
      status, trace, human_interventions: humanInterventions,
      engines: { text: ports.state?.text ?? PROVIDER_STATE.NOT_CONNECTED, vision: ports.state?.vision ?? PROVIDER_STATE.NOT_CONNECTED, local: PROVIDER_STATE.REAL },
      cost_eur: { text_and_vision: Math.round(textCost * 10000) / 10000, local: 0, budget: ports.budget?.snapshot?.() ?? null },
      published: false, spent_without_authorisation: false, repairs: { used: repairsUsed, allowed: maxRepairCalls, ...(Object.keys(reservedRepairs).length ? { reserved: { ...reservedRepairs } } : {}) }, headline_calls: { used: headlineCalls, allowed: maxHeadlineCalls }, ...extra,
    };
    // THE WORK IS KEPT and the step to resume is said: written next to the trace, whatever the end of the run
    result.resume = buildResumeManifest(result, workdir);
    writeFileSync(join(workdir, 'reprise.json'), JSON.stringify(result.resume, null, 1));
    writeFileSync(join(workdir, 'trace.json'), JSON.stringify(result, null, 1));
    return result;
  };

  const textProvider = ports.state?.text ?? (ports.text ? PROVIDER_STATE.REAL : PROVIDER_STATE.NOT_CONNECTED);
  const visionProvider = ports.state?.vision ?? (ports.vision ? PROVIDER_STATE.REAL : PROVIDER_STATE.NOT_CONNECTED);

  // 1 BRIEF
  // IDEATION_ONLY: no photograph at all; the brief says so, and no image can be examined, rendered or sent
  const photoBytes = ideationOnly ? Buffer.alloc(0) : readFileSync(input.photoPath);
  if (ideationOnly) input = { ...input, photoMeta: { media_type: 'none', width_px: null, height_px: null, origin: 'NOT_PROVIDED_IDEATION_ONLY', rights_class: 'UNKNOWN' } };
  const { brief, facts } = await step({ step: 'BRIEF', component: 'buildAutonomousBrief + assessBrief', module: 'src/creative-autonomy/brief.js, src/creative-brain/brief-assessment.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE }, async () => {
    const built = buildAutonomousBrief({ ...input, route: route ?? visibleRoute, photo: { bytes: photoBytes, ...input.photoMeta } });
    const assessment = assessBrief({ brief: built.brief });
    return { outcome: assessment.status, detail: { issues: assessment.issues, unknowns: assessment.unknowns, claims: built.brief.claims.map((c) => `${c.role}: ${c.wording}`), personalisation_offered: built.facts.personalisation_offered }, value: { ...built, assessment } };
  }).then((v) => v);
  briefNote = commercialBriefNote(brief.public_facts);
  // the advice SELECT gave in a previous round that stopped (resume_advice of its trace): IDEATE starts from it, nothing is forgotten
  if (briefNote && Array.isArray(input.resumeAdvice) && input.resumeAdvice.length) briefNote += [String.fromCharCode(10) + 'ADVICE OF THE PREVIOUS ROUND (from the selector; do not return the same ideas, answer this advice):', ...input.resumeAdvice.flatMap((a) => a.advice.map((x) => `- ${x.criterion} (${x.outcome}): ${x.refinement ?? x.evidence ?? ''}`)).slice(0, 12)].join(String.fromCharCode(10));
  // wordings the owner has NOT confirmed (a contradicting or unverified fact of the product sheet): they never appear in an announcement
  const guardFacts = Object.freeze({ ...facts, held_wordings: [...(input.heldWordings ?? [])] });
  const factsPath = join(workdir, 'faits.json');
  writeFileSync(factsPath, JSON.stringify({ product_title: facts.product_title, variant: facts.variant, price: facts.price, features: input.ownerCopy?.features ?? facts.features ?? [], merchant: input.merchant ?? profile.merchant_display ?? null, ...(adRoute && profile.brand_logo ? { brand_logo: profile.brand_logo } : {}), personalisation_offered: facts.personalisation_offered, source: facts.source }, null, 1));
  if (trace.at(-1).outcome !== 'PROCEED') return finish(RUN_STATUS.STOPPED_BRIEF_INCOMPLETE);

  // 2 EXAMINE
  const examDir = join(workdir, 'examen');
  mkdirSync(examDir, { recursive: true });
  const exam = ideationOnly ? { status: 'NOT_EXAMINED_IDEATION_ONLY' } : await step({ step: 'EXAMINE', component: 'examine_product', module: 'scripts/creative-autonomy/examine_product.py', kind: KIND.LOCAL_ENGINE, provider: PROVIDER_STATE.REAL }, async () => {
    const r = await engines.examine({ photoPath: input.photoPath, outDir: examDir });
    return { outcome: r.status, detail: r, value: r };
  });
  const assetUsable = exam.status === 'CUT_OUT';
  // the side the REAL packshot is lit from (measured on the cut-out, free): the stage's key light must agree with it. null = lit evenly, or nothing to measure (a test double, a missing file)
  const packshotLitSide = (() => { if (!assetUsable) return null; try { return litSideOfRgba(decodePng(readFileSync(join(examDir, 'produit_rgba.png')))).side; } catch { return null; } })();
  // Invalid assets are an internal catalog/media problem, not a confirmation request to a customer.
  // The calling integration may select another verified media asset and retry with a new plan.
  if (!assetUsable && !ideationOnly) humanInterventions.push({ when: 'diagnostic interne', who: 'système médias', what: `source média inexploitable : ${(exam.reasons ?? [exam.status]).join(', ')} ; vérifier une autre image du même produit`, creative: false });

  // 3 OBSERVE
  const observation = await step({ step: 'OBSERVE', component: 'observeBrief', module: 'src/creative-brain/problem-frame.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE }, async () => {
    const o = observeBrief({ brief });
    return { outcome: 'OBSERVED', detail: { product_ref: o.product_ref, approved_text_roles: o.approved_text_roles, format: o.format }, value: o };
  });

  // 4 FRAME — the first decision that needs a language model
  const frameRec = { step: 'FRAME', component: 'createProblemFramer', module: 'src/creative-brain/problem-frame.js', kind: KIND.LLM };
  if (!metered) { notConnected(frameRec, 'text'); return finish(RUN_STATUS.STOPPED_PROVIDER_NOT_CONNECTED, { mode, stopped_at: 'FRAME', asset_usable: assetUsable, exam }); }
  // what the run has REALLY obtained so far: kept for the owner's report even when a later stage stops the run (nothing is completed or invented)
  const progress = { frame: null, concepts: null, selection: null, art_directions: {}, stages: {}, proposals: [] };
  try {
    let frame; let concepts; let selection; let adPre = null;
    if (adRoute) {
      if (!assetUsable) throw Object.assign(new Error('AD_ROUTE_NEEDS_A_USABLE_PHOTO'), { code: 'AD_ROUTE_NEEDS_A_USABLE_PHOTO' });
      const adExam = JSON.parse(readFileSync(join(examDir, 'examen.json'), 'utf8'));
      const adSheet = buildProductSheet({ definition: engines.productVisible.definition, snapshots: engines.productVisible.snapshots, exam: adExam });
      const adRefs = verifiedReferencesOf([observation?.public_facts?.product, verifiedTextOf(facts), ...(Array.isArray(facts?.features) ? facts.features.filter((f) => typeof f === 'string') : [])].filter(Boolean).join(' . '));
      const rgbaPath = join(examDir, 'produit_rgba.png'); const examenPath = join(examDir, 'examen.json');
      const placementOptions = placementOptionsOf({ python: process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), scriptsDir: SCRIPTS, rgbaPath, examenPath });
      const sceneProhibitions = B0_NEGATIVE.split(',').map((t) => t.trim()).filter(Boolean);
      // RESUME (a revision of the scene only): the decisions of the earlier run are reused word for word, no text call is made; only the image is produced again
      const adProductFacts = productFactsForAd({ sheet: adSheet, exam: adExam, variant: input.variantTitle ?? null, references: adRefs });
      let dec;
      if (input.adResume?.decisions) {
        const prev = JSON.parse(readFileSync(input.adResume.decisions, 'utf8'));
        trace.push({ n: trace.length + 1, step: 'AD_RESUMED', component: 'decisions of the earlier run, reused as they are', module: 'src/creative-autonomy/ad-route.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE, model: null, cost_eur: 0, ms: 0, outcome: 'DECISIONS_REUSED', detail: { chosen_concept_id: prev.chosen_concept_id } });
        dec = { understanding: prev.understanding, develop: prev.develop, comparison: prev.comparison, blind: prev.blind_ids, chosen_proposal: prev.chosen_proposal, composition: prev.composition, concepts: prev.concepts, selection: prev.selection, chosen_concept_id: prev.chosen_concept_id, history: prev.history };
        // a revision of the SCENE: the retained proposal is kept, only the composition is made again, told what the owner asked to change
        if (input.adResume.note) { const rec = await runAdRecomposition({ complete: metered, step, brief, productFacts: adProductFacts, verifiedFacts: verifiedFactsOf(adSheet), placementOptions, sceneProhibitions, kit: engines.kit, facts: guardFacts, profile, sheet: adSheet, previous: prev, note: input.adResume.note, provider: textProvider }); dec = { ...dec, composition: rec.value, history: { ...dec.history, recomposition: rec.history } }; }
      } else dec = adPath?.mode === 'SINGLE' ? await runAdSinglePass({ complete: metered, step, brief, productFacts: adProductFacts, verifiedFacts: verifiedFactsOf(adSheet), placementOptions, sceneProhibitions, kit: engines.kit, facts: guardFacts, profile, sheet: adSheet, provider: textProvider, ceilingEur: adPath.ceilingEur ?? null })
        : await runAdDecisions({ complete: metered, step, brief, productFacts: adProductFacts, verifiedFacts: verifiedFactsOf(adSheet), placementOptions, sceneProhibitions, kit: engines.kit, facts: guardFacts, profile, sheet: adSheet, provider: textProvider });
      const records = decisionRecordsOf(dec.composition, { litSide: packshotLitSide, sceneProhibitions });
      adPre = { ...records, composition: dec.composition };
      frame = Object.freeze({ source: AD_ROUTE_ID, understanding: dec.understanding });
      concepts = dec.concepts; selection = dec.selection;
      writeFileSync(join(workdir, 'ad_decisions.json'), JSON.stringify({ route: AD_ROUTE_ID, understanding: dec.understanding, develop: dec.develop, comparison: dec.comparison, blind_ids: dec.blind, chosen_concept_id: dec.chosen_concept_id, chosen_proposal: dec.chosen_proposal, composition: dec.composition, concepts: dec.concepts, selection: dec.selection, history: dec.history }, null, 1));
      // the advertisement is a headline and the name of the product, not a technical sheet: the features line of the compositor is dropped (as in the validated trials)
      writeFileSync(factsPath, JSON.stringify({ ...JSON.parse(readFileSync(factsPath, 'utf8')), features: [] }, null, 1));
    }
    if (!adRoute) frame = await repairable({ ...frameRec, provider: textProvider }, async () => {
      const { frame: f } = await createProblemFramer({ complete: metered, hints: route ? [ENVIRONMENT_FIRST_FRAME_HINT] : visibleRoute ? [PRODUCT_VISIBLE_FRAME_HINT] : [] }).frame({ observation });
      assertFrameLeavesSetOpen(f, route ?? visibleRoute, { verifiedText: benefitSourceOf(facts) }); // the frame states the intention and the constraints of the photograph; the set is the concepts' to decide
      return { outcome: 'FRAMED', detail: f, value: f };
    }, (text) => collectFrameViolations(text, { route: route ?? visibleRoute, verifiedText: benefitSourceOf(facts) }));
    progress.frame = frame;

    // 5 IDEATE
    // IDEATE: the Brain's distinctness guard, then the tenant's brand guard on every concept (forbidden decor, invented capabilities) as early as the idea
    if (!adRoute) concepts = await repairable({ step: 'IDEATE', component: 'createConceptDirector (3, distinctness guard) + brand guard', module: 'src/creative-brain/concept.js, src/creative-autonomy/brand-guard.js', kind: KIND.LLM, provider: textProvider }, async () => {
      const { concepts: c } = await createConceptDirector({ complete: metered, count: { min: 3, max: 3 } }).ideate({ frame });
      assertConceptsBrandRules(c, facts, profile);
      assertConceptsRoute(c, route ?? visibleRoute); // the decor-first route: an idea that needs a cable moved or a device drawn is refused here, with ALL the other defects collected for the one repair
      return { outcome: 'THREE_DISTINCT_CONCEPTS', detail: c.map((x) => ({ concept_id: x.concept_id, central_idea: x.central_idea, visual_metaphor: x.visual_metaphor })), value: c };
    }, (text) => collectConceptViolations(text, { facts, profile, route: route ?? visibleRoute }));
    progress.concepts = concepts;

    // 5b SELECT: Nordla's own judgment of its concepts, criterion by criterion, in words (existing Brain stage). Recorded for the owner; it does not filter the concepts here.
    if (!adRoute) selection = await repairable({ step: 'SELECT', component: 'createConceptSelector (10 criteria, words only)', module: 'src/creative-brain/concept-selection.js', kind: KIND.LLM, provider: textProvider }, async () => {
      const { selection: sel, evaluations } = await createConceptSelector({ complete: metered }).select({ frame, concepts, ...(route ? { feasibility: ENVIRONMENT_FIRST_FEASIBILITY_QUESTION, routeNotes: routeNotesForSelection(concepts, route), strongCriteria: ROUTE_STRONG_CRITERIA } : {}) });
      return { outcome: sel.outcome ?? 'EVALUATED', detail: { selection: sel, evaluations }, value: { selection: sel, evaluations } };
    });
    progress.selection = selection;

    // PRODUCT VISIBLE (lot B, opt-in by the engine): the art director knows the generator will SEE the real product; the product sheet gives it the measured facts and the nouns a scene element may not use
    const pvSheet = engines.productVisible && assetUsable
      ? buildProductSheet({ definition: engines.productVisible.definition, snapshots: engines.productVisible.snapshots, exam: JSON.parse(readFileSync(join(examDir, 'examen.json'), 'utf8')) }) : null;
    // the product's VERIFIED references (model number, verified characteristics) are the only figures its art direction may carry (explicit treatment, never a silent pass): taken from the verified facts, shown to the art director
    const pvRefs = pvSheet ? verifiedReferencesOf([observation?.public_facts?.product, verifiedTextOf(facts), ...(Array.isArray(facts?.features) ? facts.features.filter((f) => typeof f === 'string') : [])].filter(Boolean).join(' . ')) : []; // the verified product text the framer was given (title, variant, description, features)
    const pvFacts = pvSheet ? { ...productFactsForArtDirector(pvSheet.measured), verified_references: pvRefs.map((r) => r.display) } : null;
    const artSpec = pvSheet ? artSpecVisible(pvRefs.map((r) => r.key)) : undefined;
    const artDirector = createArtDirector({ complete: metered, ...(pvSheet ? { mode: 'PRODUCT_VISIBLE', verifiedFigures: pvRefs.map((r) => r.key) } : {}) });
    const stageDirector = createStageDirector({ complete: metered, profile });
    const critic = ports.vision ? createConceptCritic({ vlm: ports.vision }) : null;
    const proposals = progress.proposals;

    let toProduce = concepts;
    let prepError = null; const fellBackFrom = [];
    if (produce === 'SELECTED') {
      const chosenId = selection?.selection?.concept_id ?? null;
      // the winner first, then (at most MAX_CONCEPT_FALLBACKS) the next eligible concept of the SAME decision group, in Nordla's own order: used only if the winner cannot be art-directed or staged
      // under the contract BEFORE any image is bought. A concept below the bar is never in this list.
      // SELECT's verdict is APPLIED in the decor-first route: a round whose best decision is not SELECT (every concept still to refine) produces nothing, and the advice of SELECT is kept (resume_advice)
      const verdictStops = Boolean(route) && selection?.selection?.outcome !== 'SELECT';
      const order = verdictStops ? [] : (selection?.selection?.order ?? (chosenId ? [chosenId] : [])).slice(0, 1 + MAX_CONCEPT_FALLBACKS);
      toProduce = order.map((id) => concepts.find((c) => c.concept_id === id)).filter(Boolean);
      trace.push({ n: trace.length + 1, step: 'PRODUCE', component: 'concept chosen by SELECT', module: 'src/creative-autonomy/run.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE, model: null, cost_eur: 0, ms: 0,
        outcome: toProduce.length ? 'SELECTED_CONCEPT_ONLY' : 'NO_CONCEPT_SELECTED', detail: { selection_outcome: selection?.selection?.outcome ?? null, concept_id: chosenId, reasons: selection?.selection?.reasons ?? null, tie_break: selection?.selection?.tie_break ?? null, fallback_order: toProduce.slice(1).map((c) => c.concept_id), not_produced: concepts.filter((c) => c.concept_id !== chosenId).map((c) => c.concept_id) } });
      if (!toProduce.length) {
        // honest stop BEFORE any paid image: Nordla's own judgment found no concept to produce; nothing is picked in its place
        return finish(RUN_STATUS.STOPPED_NO_CONCEPT_SELECTED, { mode, ...progress, frame, concepts, selection, proposals, asset_usable: assetUsable, exam, brain_calls_dir: metered ? brainDir : null, ...(route ? { resume_advice: resumeAdviceOf(selection, concepts), selection_verdict_applied: verdictStops } : {}) });
      }
    }
    // HEADLINE RESCUE (STAGE only). The model's headline and alternatives all broke the hard rules: ONE dedicated tiny call at a time (at most maxHeadlineCalls) tells it what Nordla measured and
    // asks for short candidates; Nordla picks the first that passes EVERY headline rule (never cutting or rewriting copy) and puts it into the model's OWN stage answer, then validates the whole
    // stage again locally, rule by rule. Anything else (no valid headline, another violation) returns undefined and the usual shared repair applies. A provider failure or a call cap still stops the run.
    const headlineRescue = ({ concept, art, cid }) => async (error) => {
      if (headlineCalls >= maxHeadlineCalls || !ports.text || error?.field !== 'stage.headline' || !lastReplyText) return undefined; // the allowance is for the whole RUN (a fallback concept shares it)
      const refusedText = lastReplyText; let original;
      try { original = JSON.parse(refusedText); } catch { return undefined; }
      if (!original || typeof original !== 'object' || Array.isArray(original)) return undefined;
      const ctx = { personalisation_offered: Boolean(facts.personalisation_offered), profile, headlineCheck: (h) => assertHeadlineGuard(h, guardFacts, profile) };
      const measured = (texts) => texts.filter((t) => typeof t === 'string').map((t) => ({ text: t, ...measureHeadline(t), problem: headlineProblem(t, ctx) }));
      let rejected = measured([original.headline, ...(Array.isArray(original.headline_alternatives) ? original.headline_alternatives.slice(0, 3) : [])]);
      let picked = null;
      try {
        while (headlineCalls < maxHeadlineCalls && !picked) {
          headlineCalls += 1; const attempt = headlineCalls;
          picked = await step({ step: 'HEADLINE_REPAIR', attempt, concept_id: cid, component: 'dedicated headline call (the measured lengths are fed back)', module: 'src/creative-autonomy/stage-contract.js', kind: KIND.LLM, provider: textProvider }, async () => {
            const reply = await metered(buildHeadlineInstruction({ concept, facts, profile, rejected }));
            const candidates = parseHeadlineCandidates(reply.text); const pick = pickHeadline(candidates, ctx);
            rejected = [...rejected, ...pick.rejected.map(({ text, characters, words, problem }) => ({ text, characters, words, problem }))].slice(-8);
            return { outcome: pick.headline ? 'HEADLINE_FOUND' : 'NO_VALID_HEADLINE', detail: { candidates: measured(candidates), chosen_index: pick.chosen_index }, value: pick.headline ? pick : null };
          });
        }
      } finally { lastReplyText = refusedText; }
      if (!picked) return undefined;
      const { headline_alternatives: dropped, ...rest } = original; // eslint-disable-line no-unused-vars
      const local = createStageDirector({ complete: async () => ({ text: JSON.stringify({ ...rest, headline: picked.headline }), model: null, request_id: null, cost_eur: 0 }), profile });
      try {
        return await step({ step: 'STAGE_HEADLINE_APPLIED', concept_id: cid, component: 'the refused STAGE answer with the headline chosen from the dedicated call; the whole stage is validated again, locally', module: 'src/creative-autonomy/stage-contract.js, src/creative-autonomy/brand-guard.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE }, async () => {
          const { stage: s } = await local.stage({ frame, concept, artDirection: art, facts, headlineCheck: ctx.headlineCheck });
          assertStageGuard(s, facts, profile, { art });
          return { outcome: 'STAGED', detail: { ...s, headline_selection: { chosen_index: picked.chosen_index, from: 'HEADLINE_REPAIR' } }, value: s };
        });
      } catch { return undefined; } finally { lastReplyText = refusedText; }
    };
    for (const concept of toProduce) {
      if (produce === 'SELECTED' && proposals.length) break; // one image set is produced; the next concept was only a fallback for a failed preparation
      const cid = concept.concept_id;
      const dir = join(workdir, cid); mkdirSync(dir, { recursive: true });
      let art; let stage; let artCuts = []; let stageCuts = [];
      try {
      // ART_DIRECT gets the tenant's hard rules from its first call, and its answer is checked against them (the Brain's contract does not know the tenant)
      if (adPre) art = adPre.art; else art = await repairable({ step: 'ART_DIRECT', concept_id: cid, component: 'createArtDirector + brand guard', module: 'src/creative-brain/art-direction.js, src/creative-autonomy/brand-guard.js', kind: KIND.LLM, provider: textProvider }, async () => {
        const { art_direction: a, meta: artMeta } = await artDirector.direct({ frame, concept, hints: [artDirectionHintFor(profile), sceneProductless ? sceneVocabularyHint() : null, selectorAdviceHint(selection, cid)].filter(Boolean), ...(pvFacts ? { productFacts: pvFacts } : {}) });
        artCuts = lengthCutsOf(artMeta, 'art_direction');
        assertArtDirectionGuard(a, facts, profile, { productless: sceneProductless, productVisible: Boolean(pvSheet) });
        if (pvSheet) assertElementsDoNotNameProduct(a, pvSheet);
        return { outcome: 'DIRECTED', detail: a, value: a };
      }, Object.assign((text) => collectArtViolations(text, { concept, facts, profile, productless: sceneProductless, productVisible: Boolean(pvSheet), ...(artSpec ? { spec: artSpec } : {}) }), { concept }));
      progress.art_directions[cid] = art;
      if (adPre) stage = adPre.stage; else stage = await repairable({ step: 'STAGE', concept_id: cid, component: 'createStageDirector + brand guard', module: 'src/creative-autonomy/stage-contract.js, src/creative-autonomy/brand-guard.js', kind: KIND.LLM, provider: textProvider }, async () => {
        const { stage: s, meta } = await stageDirector.stage({ frame, concept, artDirection: art, facts, headlineCheck: (h) => assertHeadlineGuard(h, guardFacts, profile), packshotCameraHeight: photoCam, packshotLitSide });
        stageCuts = lengthCutsOf(meta, 'stage');
        assertStageGuard(s, facts, profile, { art });
        // what NORDLA corrected deterministically before validation (e.g. a BLOCK beneath the product made a PLINTH) is part of the record, never silent
        const normalizations = (meta?.repairs ?? []).filter((x) => x.kind === 'SUPPORT_AS_PLINTH');
        return { outcome: 'STAGED', detail: { ...s, ...(meta?.headline_selection ? { headline_selection: meta.headline_selection } : {}), ...(normalizations.length ? { nordla_normalizations: normalizations } : {}) }, value: s };
      }, Object.assign((text) => collectStageViolations(text, { concept, facts: { ...facts, personalisation_offered: Boolean(facts.personalisation_offered) }, profile, packshotLitSide, art }), { concept }), headlineRescue({ concept, art, cid }));
      { const f = cameraFollowsPhoto(stage, photoCam); stage = f.stage; if (f.normalization) trace.push({ n: trace.length + 1, step: 'STAGE_NORMALIZED', concept_id: cid, component: 'cameraFollowsPhoto', module: 'src/creative-autonomy/photo-perspective.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE, model: null, cost_eur: 0, ms: 0, outcome: 'CAMERA_FOLLOWS_PHOTO', detail: f.normalization }); }
      progress.stages[cid] = stage;
      } catch (error) {
        // FALLBACK, before any image: a concept whose art direction or stage the contract refuses (after the one authorised repair) does not end production while another ELIGIBLE concept exists.
        // Only contract refusals fall back; a provider failure, a spend/call cap or any safety error still stops the run, and every guard applies unchanged to the next concept.
        const next = toProduce[toProduce.indexOf(concept) + 1];
        if (produce !== 'SELECTED' || !next || !isContractRefusal(error)) throw error;
        prepError = error; fellBackFrom.push({ concept_id: cid, code: error.code ?? null, field: error.field ?? null });
        trace.push({ n: trace.length + 1, step: 'FALLBACK', concept_id: cid, component: 'next eligible concept after a contract refusal (before any image)', module: 'src/creative-autonomy/run.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE, model: null, cost_eur: 0, ms: 0,
          outcome: 'NEXT_ELIGIBLE_CONCEPT', detail: { failed_concept: cid, code: error.code ?? null, field: error.field ?? null, message: String(error.message).slice(0, 200), next_concept: next.concept_id } });
        continue;
      }

      const grammarGap = { art_direction_elements: (art.narrative_elements ?? []).map((e) => e.element), wanted_but_not_available: stage.wanted_but_not_available ?? [] };
      if (ideationOnly) { proposals.push({ concept, art_direction: art, stage, grammar_gap: grammarGap, image: null, technical_quality: { state: 'NOT_RENDERED', reason: 'IDEATION_ONLY' }, creative_quality: { state: 'NOT_MEASURED', reason: 'essai d\'idéation sans image' }, status: 'IDEATION_ONLY_NOT_A_VISUAL' }); continue; }
      if (!assetUsable) { proposals.push({ concept, art_direction: art, stage, grammar_gap: grammarGap, image: null, technical_quality: { state: 'NOT_RENDERED', reason: exam.status }, creative_quality: { state: 'NOT_MEASURED', reason: 'aucune image' }, status: 'CONCEPT_ONLY' }); continue; }

      let round = 0; let report; let imagePath; let critique = null; let renderInfo = null; const history = [];
      for (;;) {
        const tag = `r${round}`;
        // the merchant's own headline (administrator-typed) replaces the model's, after it passed the brand rules; it is recorded as such
        if (input.ownerCopy?.headline) {
          const why = ownerHeadlineProblem(input.ownerCopy.headline, { personalisation_offered: Boolean(facts.personalisation_offered), profile });
          if (why) throw Object.assign(new Error(`the headline typed by the merchant is refused by the brand rules: ${why}`), { code: 'OWNER_HEADLINE_REFUSED', problem: why });
          stage = Object.freeze({ ...stage, headline: input.ownerCopy.headline.normalize('NFC').trim(), headline_source: 'OWNER_APPROVED' });
        }
        const stagePath = join(dir, `stage_${tag}.json`); writeFileSync(stagePath, JSON.stringify(stage, null, 1));
        const setPath = join(dir, `decor_${tag}.png`); imagePath = join(dir, `proposition_${tag}.png`);
        renderInfo = await step({ step: 'RENDER', concept_id: cid, round, component: engines.name?.render ?? 'render',
          module: engines.name?.renderProvider ? 'src/creative-autonomy/scene-engine.js' : 'scripts/creative-autonomy/render_stage.py',
          kind: engines.name?.renderProvider ? 'GENERATIVE_IMAGE' : KIND.LOCAL_ENGINE,
          provider: engines.name?.renderProvider ?? PROVIDER_STATE.REAL }, async () => {
          const info = await engines.render({ stage, concept, artDirection: art, composition: adPre?.composition, ...(adPre ? { adContext: { concepts, selection }, ...(input.adResume?.seed ? { seed: input.adResume.seed } : {}) } : {}), stagePath,
            examPath: join(examDir, 'examen.json'), rgbaPath: join(examDir, 'produit_rgba.png'),
            canvas: brief.format.canvas, outPath: setPath, cuts: [...artCuts, ...stageCuts] });
          return { outcome: 'RENDERED', detail: { resolution: info.resolution, foreground_props: info.foreground_props,
            blender_capabilities_used: info.blender_capabilities_used ?? null,
            render_backend: info.render_backend ?? 'BLENDER', model: info.model ?? null,
            request_id: info.request_id ?? null, image_sha256: info.image_sha256 ?? null,
            image_cost_eur: info.image_cost_eur ?? null, source_photo_transmitted: info.source_photo_transmitted ?? null,
            ...(info.product_visible ? { product_visible: info.product_visible } : {}),
            ...(info.variants ? { chosen_variant: info.chosen_variant, reused_scene: info.reused_scene, variants: info.variants.map((v) => ({ variant: v.variant, pass: v.pass, rejections: v.rejections, warnings: v.warnings, ...(v.support_check ? { support_check: v.support_check } : {}) })) } : {}) },
            value: info };
        });
        report = await step({ step: 'COMPOSE+CHECK', concept_id: cid, round, component: engines.name?.compose ?? 'compose', module: 'scripts/creative-autonomy/compose_stage.py', kind: KIND.LOCAL_ENGINE, provider: PROVIDER_STATE.REAL }, async () => {
          const r = await engines.compose({ stagePath, setPath, rgbaPath: join(examDir, 'produit_rgba.png'), examPath: join(examDir, 'examen.json'), factsPath, outPath: imagePath });
          return { outcome: r.technical.defects.length ? 'DEFECTS' : 'CLEAN', detail: { defects: r.technical.defects, fidelity_max_levels: r.fidelity.max_level_difference_after_removing_layers }, value: r };
        });
        if (!adRoute) { // the AD route has its own final review (below, once, after the montage): ONE vision call instead of two
        const criticRec = { step: 'CRITIC', concept_id: cid, round, component: 'createConceptCritic', module: 'src/creative-brain/concept-critic.js', kind: KIND.VISION };
        // THE CRITIC IS AN OPINION, NEVER A GATE: by now the image is composed and its fidelity proven. A critic that cannot be built or called (clearance refused, spend cap, port, contract) is recorded as
        // NOT_MEASURABLE and the finished image goes to the owner flagged "creative quality not measured": it must not destroy an image already paid for. Nothing is sent when the clearance is refused.
        let activeCritic = null; let png = null;
        const candidateRef = `render://${cid}/${tag}`;
        try {
          // a static critic (tests) or one built per image from the owner's clearance of the source photo (real lane)
          png = (critic || ports.visionFor) ? readFileSync(imagePath) : null;
          const perImage = !critic && ports.visionFor ? ports.visionFor({ ref: candidateRef, bytes: png }) : null;
          activeCritic = critic ?? (perImage ? createConceptCritic({ vlm: perImage }) : null);
        } catch (error) { trace.push({ n: trace.length + 1, ...criticRec, provider: visionProvider, model: null, cost_eur: 0, ms: 0, outcome: 'NOT_MEASURABLE', detail: { critic_unavailable: { code: error.code ?? null, message: String(error.message).slice(0, 240) } } }); critique = null; }
        if (activeCritic) {
          try {
            critique = await step({ ...criticRec, provider: visionProvider }, async () => {
              const { critique: c, provenance } = await activeCritic.critique({ candidate: { ref: candidateRef, png_bytes: png }, brief: { public_facts: brief.public_facts } });
              if (provenance.failure || provenance.rejected) return { outcome: 'NOT_MEASURABLE', detail: provenance, value: c };
              lastCost = provenance.cost_eur ?? 0; lastModel = provenance.model ?? null; textCost += lastCost;
              return { outcome: c.dimensions.some(flagged) ? 'REVISION_ASKED' : 'NO_REVISION_ASKED', detail: c.dimensions, value: c };
            });
          } catch (error) { const e = trace.at(-1); if (e?.step === 'CRITIC') e.outcome = 'NOT_MEASURABLE'; critique = null; }
        } else if (round === 0 && !trace.some((t) => t.step === 'CRITIC' && t.concept_id === cid && t.round === round)) notConnected(criticRec, 'vision');
        }

        if (round >= MAX_REFINE_ROUNDS) break;
        const defects = report.technical.defects;
        let fix = deterministicFix(stage, defects);
        const brainDefects = defects.filter((d) => NEEDS_BRAIN.has(d) || (!fix && d));
        const hints = [...brainDefects.map((d) => `technical defect on the render: ${d}`), ...(critique?.dimensions ?? []).filter((d) => flagged(d) && d.revision_hint).map((d) => `${d.dimension}: ${d.revision_hint}`)];
        if (sceneMode) {
          // the paid scene is fixed: only the text may move (no new image, no re-staging). Anything else is reported to the owner, not acted on.
          const textOnly = fix?.text_placement ? { text_placement: fix.text_placement } : null;
          const notApplied = { defects, hints, framing_change: fix?.camera ?? null };
          if (!textOnly) {
            if (defects.length || hints.length) trace.push({ n: trace.length + 1, step: 'REFINE', concept_id: cid, round: round + 1, component: 'scene mode: the scene is not regenerated', module: 'src/creative-autonomy/run.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE, model: null, cost_eur: 0, ms: 0, outcome: 'REPORTED_TO_OWNER_NOT_APPLIED', detail: notApplied });
            break;
          }
          fix = textOnly;
        }
        if (fix && (!hints.length || sceneMode)) {
          stage = await step({ step: 'REFINE', concept_id: cid, round: round + 1, component: 'deterministicFix (placement du texte, cadrage)', module: 'src/creative-autonomy/run.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE }, async () => {
            const s = normalizeStage({ ...stripIds(stage), ...fix }, { concept, personalisation_offered: facts.personalisation_offered, profile });
            return { outcome: 'FIXED_WITHIN_LIMITS', detail: { defects, change: fix, ...(sceneMode && hints.length ? { reported_to_owner_not_applied: hints } : {}) }, value: s };
          });
        } else if (hints.length) {
          stage = await step({ step: 'REFINE', concept_id: cid, round: round + 1, component: 'createStageDirector (re-ask with hints)', module: 'src/creative-autonomy/stage-contract.js', kind: KIND.LLM, provider: textProvider }, async () => {
            const { stage: s } = await stageDirector.stage({ frame, concept, artDirection: art, facts, hints, packshotLitSide });
            assertStageGuard(s, facts, profile, { art });
            return { outcome: 'RESTAGED', detail: { hints }, value: s };
          });
        } else break;
        history.push({ round, defects });
        round += 1;
      }
      // AD route: a phone-size preview of the finished advertisement (390 px wide), local and free; a failure is recorded, never a stop
      let mobilePreview = null;
      if (adRoute) { try { mobilePreview = join(dir, 'mobile_preview.png'); await run$(process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [join(SCRIPTS, 'mobile_preview.py'), imagePath, mobilePreview, '390'], { timeout: 120_000 }); } catch (error) { mobilePreview = null; trace.push({ n: trace.length + 1, step: 'MOBILE_PREVIEW', component: 'mobile_preview.py', module: 'scripts/creative-autonomy/mobile_preview.py', kind: KIND.LOCAL_ENGINE, provider: PROVIDER_STATE.REAL, model: null, cost_eur: 0, ms: 0, outcome: 'NOT_BUILT', detail: { message: String(error.message).slice(0, 160) } }); } }
      // AD route: THE FINAL REVIEW (final-review.js). Creator looks at its own finished advertisement (after the restoration of the product and the montage of the title and of the official logo) next to the source photograph and the phone preview,
      // and says what in the picture gives the customer a reason to buy. One vision call, an OPINION: a failure is recorded as NOT_MEASURABLE and the advertisement goes to the owner flagged, it never destroys an image already paid for.
      let finalReview = null;
      if (adRoute && report) {
        const reviewRec = { step: 'FINAL_REVIEW', concept_id: cid, round, component: 'runFinalReview (the finished advertisement, the source photograph and the phone preview on one sheet)', module: 'src/creative-autonomy/final-review.js', kind: KIND.VISION };
        const measured = { defects: report.technical?.defects ?? [], fidelity_max_levels: report.fidelity?.max_level_difference_after_removing_layers ?? null, title_contrast: report.technical?.text_contrast_ratio ?? null, logo: report.logo ? { corner: report.logo.corner, contrast: report.logo.ink_contrast_worst_tenth, phone_mark_px: report.logo.phone_mark_px, overlaps: report.logo.conflicts_with } : null };
        let out = null;
        try {
          const sheetPath = join(dir, 'review_sheet.png');
          await run$(process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [join(SCRIPTS, 'review_sheet.py'), input.photoPath, imagePath, mobilePreview ?? '-', sheetPath], { timeout: 120_000 });
          const sheetBytes = readFileSync(sheetPath);
          const vlm = ports.visionFor ? ports.visionFor({ ref: `render://${cid}/review`, bytes: sheetBytes, maxTokens: 900 }) : null;
          if (!vlm) notConnected(reviewRec, 'vision');
          else {
            await step({ ...reviewRec, provider: visionProvider }, async () => {
              out = await runFinalReview({ vlm, sheetBytes, ref: `render://${cid}/review`, brief: { objective: input.objective, audience: input.audience }, headline: report.text_used?.headline_proposed_by_brain ?? stage.headline,
                proposal: { intention: adPre.composition?.intention ?? null, visible_link: adPre.composition?.visible_link ?? null, reason_to_care: adPre.composition?.reason_to_care ?? null }, product: { title: facts.product_title, variant: facts.variant ?? null }, measured });
              if (out.provenance.cost_eur) { lastCost = out.provenance.cost_eur; lastModel = out.provenance.model ?? null; textCost += lastCost; }
              return { outcome: out.review ? out.review.verdict : 'NOT_MEASURABLE', detail: out.review ?? out.provenance, value: out };
            });
          }
        } catch (error) { trace.push({ n: trace.length + 1, ...reviewRec, provider: visionProvider, model: null, cost_eur: 0, ms: 0, outcome: 'NOT_MEASURABLE', detail: { review_unavailable: { code: error.code ?? null, message: String(error.message).slice(0, 240) } } }); out = null; }
        finalReview = { ...finalVerdictOf({ review: out?.review ?? null, measured }), review: out?.review ?? null, provenance: out?.provenance ?? null, measured };
      }
      // C4 manual review pack (optional, never a gate): the composite WITHOUT the title, the support crops, the status of the contact, the step to redo per defect. A failure here is recorded, it never stops the run.
      let review = null;
      try {
        const noTitlePath = `${imagePath}.notitle.png`; const decorPath = imagePath.replace(/proposition_(r\d+)\.png$/, 'decor_$1.png');
        if (report?.placement && existsSync(noTitlePath) && existsSync(`${decorPath}.json`)) {
          const plate = JSON.parse(readFileSync(`${decorPath}.json`, 'utf8'));
          // readability of the product outline on the finished composite (lot B): measured locally, only in PRODUCT_VISIBLE mode; it flags "to check by the owner", it never rejects
          let readability = null;
          if (pvSheet && engines.readability) { try { readability = await engines.readability({ noTitlePath, rgbaPath: join(examDir, 'produit_rgba.png'), examPath: join(examDir, 'examen.json'), box: report.placement.box }); } catch { readability = null; } }
          review = buildReviewPack({ outDir: join(dir, 'revue'), finalPath: imagePath, noTitlePath, decorPath, plate, box: report.placement.box, canvas: report.placement.canvas, stage, concept, facts: report.text_used, readability, supportCheck: renderInfo?.variants?.find((v) => v.variant === renderInfo.chosen_variant)?.support_check ?? null });
        }
      } catch (error) { review = { state: 'REVIEW_PACK_NOT_BUILT', reason: String(error.message).slice(0, 160) }; }
      proposals.push({
        concept, art_direction: art, stage, image: imagePath, rounds: round + 1, ...(adRoute ? { route: AD_ROUTE_ID, mobile_preview: mobilePreview, composition: adPre.composition, caption: adPre.composition?.caption ?? null, final_review: finalReview } : {}), ...(review ? { review } : {}), ...(renderInfo?.product_visible ? { product_visible: renderInfo.product_visible } : {}), blender_capabilities_used: renderInfo?.blender_capabilities_used ?? null,
        grammar_gap: { art_direction_elements: (art.narrative_elements ?? []).map((e) => e.element), wanted_but_not_available: stage.wanted_but_not_available ?? [] },
        technical_quality: technicalQuality(report), creative_quality: creativeQuality(critique, technicalQuality(report)),
        judgement: judgeProposal({ technical: technicalQuality(report), critique }),
        text_for_owner_approval: { headline: stage.headline, facts_lines: report.text_used.facts_lines, ...(guardFacts.held_wordings.length ? { excluded_uncertain: guardFacts.held_wordings } : {}) },
        scene: renderInfo?.render_backend === 'SCENE_AROUND_PRODUCT' ? { model: renderInfo.model, request_id: renderInfo.request_id, chosen_variant: renderInfo.chosen_variant, variants: renderInfo.variants, image_cost_eur: renderInfo.image_cost_eur, images_billed: renderInfo.images_billed, source_photo_transmitted: renderInfo.source_photo_transmitted } : null,
        selected_by_nordla: selection?.selection?.concept_id === cid,
        ...(fellBackFrom.length ? { fallback_from: fellBackFrom } : {}),
        status: 'PROPOSED_FOR_OWNER_VALIDATION',
      });
    }

    if (produce === 'SELECTED' && !proposals.length && prepError) throw prepError; // every eligible concept was refused by the contract: stop with the exact code of the last refusal
    trace.push({ n: trace.length + 1, step: 'REVIEW', component: 'owner review package', module: 'src/creative-autonomy/run.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE, model: null, cost_eur: 0, ms: 0, outcome: 'AWAITING_OWNER', detail: { proposals: proposals.length } });
    humanInterventions.push({ when: 'après le passage', who: 'propriétaire', what: 'valide, refuse ou demande une révision de chaque proposition (titre compris)', creative: true });
    writeFileSync(join(workdir, 'propositions.json'), JSON.stringify(proposals, null, 1));
    const status = ideationOnly ? RUN_STATUS.IDEATION_ONLY_NOT_A_VISUAL : assetUsable ? RUN_STATUS.PROPOSALS_READY_FOR_OWNER : RUN_STATUS.CONCEPTS_ONLY_ASSET_NOT_USABLE;
    return finish(status, { mode, ...progress, frame, concepts, selection, proposals, asset_usable: assetUsable, exam, brain_calls_dir: metered ? brainDir : null });
  } catch (error) {
    const stoppedAt = [...trace].reverse().find((t) => t.outcome === 'ERROR');
    return finish(RUN_STATUS.STOPPED_ERROR, {
      mode, ...progress, stopped_at: stoppedAt ? { step: stoppedAt.step, concept_id: stoppedAt.concept_id ?? null } : null,
      error: { code: error.code ?? null, field: error.field ?? null, message: String(error.message).slice(0, 300), ...(error.detail?.network ? { network: error.detail.network } : {}) },
      asset_usable: assetUsable, exam, brain_calls_dir: brainDir,
    });
  }
}

export const runFileExists = (p) => existsSync(p);
