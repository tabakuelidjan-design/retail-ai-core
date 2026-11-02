// THE AUTONOMOUS ROUTE. Input from the owner: a Shopify product snapshot, a commercial objective, HABB's brand rules, a format, the product photo.
// Nordla then, WITHOUT a human writing a concept, a headline or a position:
//   1 BRIEF       builds the Brain brief from verified facts only                         (deterministic)
//   2 EXAMINE     measures the photo and cuts the product out, or says why it cannot       (local engine)
//   3 OBSERVE     what the frame may rest on                                               (deterministic, existing Brain)
//   4 FRAME       frames the creative problem                                              (language model, existing Brain)
//   5 IDEATE      invents 3 distinct concepts                                              (language model, existing Brain + distinctness guard)
//   6 ART_DIRECT  an art direction per concept                                             (language model, existing Brain)
//   7 STAGE       the mise en scène per concept, in a closed vocabulary + HABB rules        (language model, new contract)
//   8 RENDER      the set in Blender from the STAGE (no product pixels involved)            (local engine)
//   9 COMPOSE     the real photo placed untouched + bounded light layers + text             (local engine) -> fidelity proof + technical checks
//  10 CRITIC      concept strength on the rendered image                                   (vision model, existing Brain)
//  11 REFINE      at most 2 rounds: deterministic fixes within allowed limits, or a STAGE re-ask with the critic's hints
//  12 REVIEW      a package for the owner; every proposal is PROPOSED, never approved, never published
// A stage whose engine is not connected STOPS the run with PROVIDER_NOT_CONNECTED. Nothing is ever simulated in place of a missing engine.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessBrief } from '../creative-brain/brief-assessment.js';
import { observeBrief, createProblemFramer } from '../creative-brain/problem-frame.js';
import { createConceptDirector } from '../creative-brain/concept.js';
import { createArtDirector } from '../creative-brain/art-direction.js';
import { createConceptCritic } from '../creative-brain/concept-critic.js';
import { createConceptSelector } from '../creative-brain/concept-selection.js';
import { buildAutonomousBrief } from './brief.js';
import { createStageDirector, normalizeStage, HABB_ART_DIRECTION_HINT } from './stage-contract.js';
import { assertConceptsHabbRules, assertArtDirectionGuard, assertStageGuard, commercialBriefNote } from './habb-guard.js';
import { BRAIN_ERROR } from '../creative-brain/validation.js';
import { PROVIDER_STATE, WHAT_IS_NEEDED } from './providers.js';

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

/**
 * BOUNDED CONTRACT REPAIR. When a model answer is well-formed JSON but refused by a contract rule (a text too long, a forbidden word, a missing key...), Nordla
 * may ask the SAME stage ONCE more, telling the model exactly which field broke which rule. The repair is a paid call, so it exists only when the owner's
 * authorised plan says so: maxRepairCalls (default 0 = no repair, the run stops as before). Never on a provider failure (no retry policy), never twice for
 * the same stage call, and every repair goes through the same port, SpendGuard, call cap and journal as any other call. The refused answer stays in the trace.
 */
export const REPAIRABLE = Object.freeze(new Set([BRAIN_ERROR.NOT_DISTINCT, BRAIN_ERROR.TEXT_INVALID, BRAIN_ERROR.MISSING_KEY, BRAIN_ERROR.UNKNOWN_KEY, BRAIN_ERROR.ENUM_INVALID, BRAIN_ERROR.LIST_INVALID, BRAIN_ERROR.NUMERIC_VALUE, BRAIN_ERROR.FORBIDDEN_CONTENT, BRAIN_ERROR.RULE_VIOLATION]));
export const repairHint = (error, scoped = false) => `Your previous answer was REFUSED by Nordla's contract: ${error.code} at ${error.field ?? 'unknown field'}: ${String(error.message).slice(0, 240)}. Return the whole answer again with this field corrected.${scoped ? ` ONLY ${error.field} will be taken from your new answer: every other field is kept exactly as in your previous answer, and any change elsewhere is discarded. Fix ${error.field} itself; do not move the problem to another field.` : ' Keep everything else that was valid.'}`;

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
/** The repaired answer actually normalised: the previous answer with ONLY the refused field taken from the new one. */
export function scopedMerge(originalText, repairText, field) {
  let original; let repair;
  try { original = JSON.parse(originalText); repair = JSON.parse(repairText); } catch { return { text: repairText, applied: false, scope: null, discarded: [], reason: 'UNPARSEABLE' }; }
  const path = fieldPath(field, original);
  if (!path.length || !original || typeof original !== 'object') return { text: repairText, applied: false, scope: 'WHOLE_ANSWER', discarded: [], reason: 'NO_PRECISE_FIELD' };
  const merged = structuredClone(original);
  if (!setAt(merged, path, structuredClone(getAt(repair, path)))) return { text: repairText, applied: false, scope: 'WHOLE_ANSWER', discarded: [], reason: 'FIELD_NOT_ADDRESSABLE' };
  return { text: JSON.stringify(merged), applied: true, scope: field, discarded: diffPaths(merged, repair) };
}

/** Default local engines: real processes, zero cost. Tests may replace them. */
export function localEngines({ python = process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), blenderPython = process.env.NORDLA_BLENDER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), renderScale = 0.5, samples = 32 } = {}) {
  const py = async (bin, args) => (await run$(bin, args, { maxBuffer: 1 << 24, timeout: 900_000 })).stdout;
  return {
    name: { examine: 'examine_product.py', render: 'render_stage.py (Blender Cycles)', compose: 'compose_stage.py' },
    async examine({ photoPath, outDir }) {
      const out = await py(python, [join(SCRIPTS, 'examine_product.py'), photoPath, outDir]);
      return JSON.parse(out.trim().split('\n').pop());
    },
    async render({ stagePath, examPath, rgbaPath, canvas, outPath }) {
      const w = Math.round(canvas.width * renderScale); const h = Math.round(canvas.height * renderScale);
      const out = await py(blenderPython, [join(SCRIPTS, 'render_stage.py'), '--', stagePath, examPath, rgbaPath, String(w), String(h), String(samples), outPath]);
      const line = out.split('\n').find((l) => l.startsWith('RENDER_INFO '));
      if (!line) throw Object.assign(new Error('the scene engine produced no render'), { code: 'RENDER_FAILED' });
      return JSON.parse(line.slice('RENDER_INFO '.length));
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
function creativeQuality(critique) {
  if (!critique) return { state: 'NOT_MEASURED', reason: 'critique visuel non connecté', dimensions: [] };
  const dims = critique.dimensions;
  if (dims.every((d) => d.outcome === 'NOT_MEASURABLE')) return { state: 'NOT_MEASURED', reason: dims[0]?.evidence ?? null, dimensions: dims };
  return { state: dims.some(flagged) ? 'CREATIVELY_INSUFFICIENT' : 'CREATIVELY_SUFFICIENT_AWAITING_OWNER', dimensions: dims };
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
export async function runAutonomous({ input, ports, engines = localEngines(), workdir, now = () => Date.now(), mode = 'FULL', maxRepairCalls = 0, produce = 'ALL' }) {
  if (!Number.isInteger(maxRepairCalls) || maxRepairCalls < 0) throw new TypeError('maxRepairCalls must be a non-negative integer');
  // produce: 'ALL' = every concept is art-directed, staged and rendered (the original route); 'SELECTED' = only the concept Nordla's own SELECT stage chose
  // (premium path: one paid scene for the concept Nordla judged best, never simply the first of the list)
  if (!['ALL', 'SELECTED'].includes(produce)) throw new TypeError('produce must be ALL or SELECTED');
  // a scene engine (scene-engine.js) renders a PAID scene once; a refinement may only move the text, which needs no new scene
  const sceneMode = Boolean(engines.sceneMode);
  let repairsUsed = 0;
  const ideationOnly = mode === 'IDEATION_ONLY';
  mkdirSync(workdir, { recursive: true });
  const trace = [];
  const humanInterventions = [
    // The client never approves/confirms a source product image before creative work.
    // Product-source validation belongs to the internal media pipeline; approval is only after creation.
    { when: 'avant le passage', who: 'opérateur', what: 'a défini le produit, l\'objectif commercial et le format', creative: false },
  ];
  let textCost = 0; let lastModel = null; let lastCost = 0; let currentStep = null; let brainCall = 0; let repairNote = null; let callsInStep = 0; let lastReplyText = null; let repairScope = null; let lastMerge = null; let briefNote = null;
  // HABB's commercial brief, repeated to the stages that do not see the public facts (set once the brief exists)
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
      if (repairsUsed >= maxRepairCalls) throw Object.assign(new Error(`repair budget exhausted (${repairsUsed}/${maxRepairCalls}): the protocol re-ask was not sent`), { code: 'REPAIR_BUDGET_EXHAUSTED' });
      repairsUsed += 1;
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
      lastMerge = { scope: m.scope, applied: m.applied, discarded_outside_scope: m.discarded, reason: m.reason ?? null };
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
  async function repairable(rec, call) {
    try { return await step(rec, call); } catch (error) {
      if (!REPAIRABLE.has(error?.code) || repairsUsed >= maxRepairCalls) throw error;
      repairsUsed += 1;
      const originalText = lastReplyText;
      const scoped = Boolean(originalText) && scopedMerge(originalText, originalText, error.field).applied;
      repairNote = repairHint(error, scoped);
      repairScope = scoped ? { originalText, field: error.field } : null; lastMerge = null;
      const repairRec = { ...rec, step: `${rec.step}_REPAIR`, repair_of: { code: error.code, field: error.field ?? null }, repair_scope: scoped ? error.field : 'WHOLE_ANSWER', repairs_used: repairsUsed, repairs_allowed: maxRepairCalls };
      try {
        return await step(repairRec, call);
      } finally {
        const entry = trace.at(-1); if (entry && entry.step === repairRec.step) entry.repair_merge = lastMerge;
        repairNote = null; repairScope = null;
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
      published: false, spent_without_authorisation: false, repairs: { used: repairsUsed, allowed: maxRepairCalls }, ...extra,
    };
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
    const built = buildAutonomousBrief({ ...input, photo: { bytes: photoBytes, ...input.photoMeta } });
    const assessment = assessBrief({ brief: built.brief });
    return { outcome: assessment.status, detail: { issues: assessment.issues, unknowns: assessment.unknowns, claims: built.brief.claims.map((c) => `${c.role}: ${c.wording}`), personalisation_offered: built.facts.personalisation_offered }, value: { ...built, assessment } };
  }).then((v) => v);
  briefNote = commercialBriefNote(brief.public_facts);
  const factsPath = join(workdir, 'faits.json');
  writeFileSync(factsPath, JSON.stringify({ product_title: facts.product_title, variant: facts.variant, price: facts.price, merchant: input.merchant ?? 'HABB, Namur', personalisation_offered: facts.personalisation_offered, source: facts.source }, null, 1));
  if (trace.at(-1).outcome !== 'PROCEED') return finish(RUN_STATUS.STOPPED_BRIEF_INCOMPLETE);

  // 2 EXAMINE
  const examDir = join(workdir, 'examen');
  mkdirSync(examDir, { recursive: true });
  const exam = ideationOnly ? { status: 'NOT_EXAMINED_IDEATION_ONLY' } : await step({ step: 'EXAMINE', component: 'examine_product', module: 'scripts/creative-autonomy/examine_product.py', kind: KIND.LOCAL_ENGINE, provider: PROVIDER_STATE.REAL }, async () => {
    const r = await engines.examine({ photoPath: input.photoPath, outDir: examDir });
    return { outcome: r.status, detail: r, value: r };
  });
  const assetUsable = exam.status === 'CUT_OUT';
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
    const frame = await repairable({ ...frameRec, provider: textProvider }, async () => {
      const { frame: f } = await createProblemFramer({ complete: metered }).frame({ observation });
      return { outcome: 'FRAMED', detail: f, value: f };
    });
    progress.frame = frame;

    // 5 IDEATE
    // IDEATE: the Brain's distinctness guard, then HABB's guard on every concept (forbidden decor, invented capabilities) as early as the idea
    const concepts = await repairable({ step: 'IDEATE', component: 'createConceptDirector (3, distinctness guard) + HABB guard', module: 'src/creative-brain/concept.js, src/creative-autonomy/habb-guard.js', kind: KIND.LLM, provider: textProvider }, async () => {
      const { concepts: c } = await createConceptDirector({ complete: metered, count: { min: 3, max: 3 } }).ideate({ frame });
      assertConceptsHabbRules(c, facts);
      return { outcome: 'THREE_DISTINCT_CONCEPTS', detail: c.map((x) => ({ concept_id: x.concept_id, central_idea: x.central_idea, visual_metaphor: x.visual_metaphor })), value: c };
    });
    progress.concepts = concepts;

    // 5b SELECT: Nordla's own judgment of its concepts, criterion by criterion, in words (existing Brain stage). Recorded for the owner; it does not filter the concepts here.
    const selection = await repairable({ step: 'SELECT', component: 'createConceptSelector (10 criteria, words only)', module: 'src/creative-brain/concept-selection.js', kind: KIND.LLM, provider: textProvider }, async () => {
      const { selection: sel, evaluations } = await createConceptSelector({ complete: metered }).select({ frame, concepts });
      return { outcome: sel.outcome ?? 'EVALUATED', detail: { selection: sel, evaluations }, value: { selection: sel, evaluations } };
    });
    progress.selection = selection;

    const artDirector = createArtDirector({ complete: metered });
    const stageDirector = createStageDirector({ complete: metered });
    const critic = ports.vision ? createConceptCritic({ vlm: ports.vision }) : null;
    const proposals = progress.proposals;

    let toProduce = concepts;
    if (produce === 'SELECTED') {
      const chosenId = selection?.selection?.concept_id ?? null;
      toProduce = concepts.filter((c) => c.concept_id === chosenId);
      trace.push({ n: trace.length + 1, step: 'PRODUCE', component: 'concept chosen by SELECT', module: 'src/creative-autonomy/run.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE, model: null, cost_eur: 0, ms: 0,
        outcome: toProduce.length ? 'SELECTED_CONCEPT_ONLY' : 'NO_CONCEPT_SELECTED', detail: { selection_outcome: selection?.selection?.outcome ?? null, concept_id: chosenId, not_produced: concepts.filter((c) => c.concept_id !== chosenId).map((c) => c.concept_id) } });
      if (!toProduce.length) {
        // honest stop BEFORE any paid image: Nordla's own judgment found no concept to produce; nothing is picked in its place
        return finish(RUN_STATUS.STOPPED_NO_CONCEPT_SELECTED, { mode, ...progress, frame, concepts, selection, proposals, asset_usable: assetUsable, exam, brain_calls_dir: metered ? brainDir : null });
      }
    }
    for (const concept of toProduce) {
      const cid = concept.concept_id;
      const dir = join(workdir, cid); mkdirSync(dir, { recursive: true });
      // ART_DIRECT gets HABB's hard rules from its first call, and its answer is checked against them (the Brain's contract does not know HABB)
      const art = await repairable({ step: 'ART_DIRECT', concept_id: cid, component: 'createArtDirector + HABB guard', module: 'src/creative-brain/art-direction.js, src/creative-autonomy/habb-guard.js', kind: KIND.LLM, provider: textProvider }, async () => {
        const { art_direction: a } = await artDirector.direct({ frame, concept, hints: [HABB_ART_DIRECTION_HINT] });
        assertArtDirectionGuard(a, facts);
        return { outcome: 'DIRECTED', detail: a, value: a };
      });
      progress.art_directions[cid] = art;
      let stage = await repairable({ step: 'STAGE', concept_id: cid, component: 'createStageDirector + HABB guard', module: 'src/creative-autonomy/stage-contract.js, src/creative-autonomy/habb-guard.js', kind: KIND.LLM, provider: textProvider }, async () => {
        const { stage: s } = await stageDirector.stage({ frame, concept, artDirection: art, facts });
        assertStageGuard(s, facts);
        return { outcome: 'STAGED', detail: s, value: s };
      });
      progress.stages[cid] = stage;

      const grammarGap = { art_direction_elements: (art.narrative_elements ?? []).map((e) => e.element), wanted_but_not_available: stage.wanted_but_not_available ?? [] };
      if (ideationOnly) { proposals.push({ concept, art_direction: art, stage, grammar_gap: grammarGap, image: null, technical_quality: { state: 'NOT_RENDERED', reason: 'IDEATION_ONLY' }, creative_quality: { state: 'NOT_MEASURED', reason: 'essai d\'idéation sans image' }, status: 'IDEATION_ONLY_NOT_A_VISUAL' }); continue; }
      if (!assetUsable) { proposals.push({ concept, art_direction: art, stage, grammar_gap: grammarGap, image: null, technical_quality: { state: 'NOT_RENDERED', reason: exam.status }, creative_quality: { state: 'NOT_MEASURED', reason: 'aucune image' }, status: 'CONCEPT_ONLY' }); continue; }

      let round = 0; let report; let imagePath; let critique = null; let renderInfo = null; const history = [];
      for (;;) {
        const tag = `r${round}`;
        const stagePath = join(dir, `stage_${tag}.json`); writeFileSync(stagePath, JSON.stringify(stage, null, 1));
        const setPath = join(dir, `decor_${tag}.png`); imagePath = join(dir, `proposition_${tag}.png`);
        renderInfo = await step({ step: 'RENDER', concept_id: cid, round, component: engines.name?.render ?? 'render',
          module: engines.name?.renderProvider ? 'src/creative-autonomy/scene-engine.js' : 'scripts/creative-autonomy/render_stage.py',
          kind: engines.name?.renderProvider ? 'GENERATIVE_IMAGE' : KIND.LOCAL_ENGINE,
          provider: engines.name?.renderProvider ?? PROVIDER_STATE.REAL }, async () => {
          const info = await engines.render({ stage, concept, artDirection: art, stagePath,
            examPath: join(examDir, 'examen.json'), rgbaPath: join(examDir, 'produit_rgba.png'),
            canvas: brief.format.canvas, outPath: setPath });
          return { outcome: 'RENDERED', detail: { resolution: info.resolution, foreground_props: info.foreground_props,
            blender_capabilities_used: info.blender_capabilities_used ?? null,
            render_backend: info.render_backend ?? 'BLENDER', model: info.model ?? null,
            request_id: info.request_id ?? null, image_sha256: info.image_sha256 ?? null,
            image_cost_eur: info.image_cost_eur ?? null, source_photo_transmitted: info.source_photo_transmitted ?? null,
            ...(info.variants ? { chosen_variant: info.chosen_variant, reused_scene: info.reused_scene, variants: info.variants.map((v) => ({ variant: v.variant, pass: v.pass, rejections: v.rejections, warnings: v.warnings })) } : {}) },
            value: info };
        });
        report = await step({ step: 'COMPOSE+CHECK', concept_id: cid, round, component: engines.name?.compose ?? 'compose', module: 'scripts/creative-autonomy/compose_stage.py', kind: KIND.LOCAL_ENGINE, provider: PROVIDER_STATE.REAL }, async () => {
          const r = await engines.compose({ stagePath, setPath, rgbaPath: join(examDir, 'produit_rgba.png'), examPath: join(examDir, 'examen.json'), factsPath, outPath: imagePath });
          return { outcome: r.technical.defects.length ? 'DEFECTS' : 'CLEAN', detail: { defects: r.technical.defects, fidelity_max_levels: r.fidelity.max_level_difference_after_removing_layers }, value: r };
        });
        const criticRec = { step: 'CRITIC', concept_id: cid, round, component: 'createConceptCritic', module: 'src/creative-brain/concept-critic.js', kind: KIND.VISION };
        // a static critic (tests) or one built per image from the owner's clearance of the source photo (real lane)
        const candidateRef = `render://${cid}/${tag}`;
        const png = (critic || ports.visionFor) ? readFileSync(imagePath) : null;
        const perImage = !critic && ports.visionFor ? ports.visionFor({ ref: candidateRef, bytes: png }) : null;
        const activeCritic = critic ?? (perImage ? createConceptCritic({ vlm: perImage }) : null);
        if (activeCritic) {
          critique = await step({ ...criticRec, provider: visionProvider }, async () => {
            const { critique: c, provenance } = await activeCritic.critique({ candidate: { ref: candidateRef, png_bytes: png }, brief: { public_facts: brief.public_facts } });
            if (provenance.failure || provenance.rejected) return { outcome: 'NOT_MEASURABLE', detail: provenance, value: c };
            lastCost = provenance.cost_eur ?? 0; lastModel = provenance.model ?? null; textCost += lastCost;
            return { outcome: c.dimensions.some(flagged) ? 'REVISION_ASKED' : 'NO_REVISION_ASKED', detail: c.dimensions, value: c };
          });
        } else if (round === 0) notConnected(criticRec, 'vision');

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
            const s = normalizeStage({ ...stripIds(stage), ...fix }, { concept, personalisation_offered: facts.personalisation_offered });
            return { outcome: 'FIXED_WITHIN_LIMITS', detail: { defects, change: fix, ...(sceneMode && hints.length ? { reported_to_owner_not_applied: hints } : {}) }, value: s };
          });
        } else if (hints.length) {
          stage = await step({ step: 'REFINE', concept_id: cid, round: round + 1, component: 'createStageDirector (re-ask with hints)', module: 'src/creative-autonomy/stage-contract.js', kind: KIND.LLM, provider: textProvider }, async () => {
            const { stage: s } = await stageDirector.stage({ frame, concept, artDirection: art, facts, hints });
            assertStageGuard(s, facts);
            return { outcome: 'RESTAGED', detail: { hints }, value: s };
          });
        } else break;
        history.push({ round, defects });
        round += 1;
      }
      proposals.push({
        concept, art_direction: art, stage, image: imagePath, rounds: round + 1, blender_capabilities_used: renderInfo?.blender_capabilities_used ?? null,
        grammar_gap: { art_direction_elements: (art.narrative_elements ?? []).map((e) => e.element), wanted_but_not_available: stage.wanted_but_not_available ?? [] },
        technical_quality: technicalQuality(report), creative_quality: creativeQuality(critique),
        text_for_owner_approval: { headline: stage.headline, facts_lines: report.text_used.facts_lines },
        scene: renderInfo?.render_backend === 'SCENE_AROUND_PRODUCT' ? { model: renderInfo.model, request_id: renderInfo.request_id, chosen_variant: renderInfo.chosen_variant, variants: renderInfo.variants, image_cost_eur: renderInfo.image_cost_eur, images_billed: renderInfo.images_billed, source_photo_transmitted: renderInfo.source_photo_transmitted } : null,
        selected_by_nordla: selection?.selection?.concept_id === cid,
        status: 'PROPOSED_FOR_OWNER_VALIDATION',
      });
    }

    trace.push({ n: trace.length + 1, step: 'REVIEW', component: 'owner review package', module: 'src/creative-autonomy/run.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE, model: null, cost_eur: 0, ms: 0, outcome: 'AWAITING_OWNER', detail: { proposals: proposals.length } });
    humanInterventions.push({ when: 'après le passage', who: 'propriétaire', what: 'valide, refuse ou demande une révision de chaque proposition (titre compris)', creative: true });
    writeFileSync(join(workdir, 'propositions.json'), JSON.stringify(proposals, null, 1));
    const status = ideationOnly ? RUN_STATUS.IDEATION_ONLY_NOT_A_VISUAL : assetUsable ? RUN_STATUS.PROPOSALS_READY_FOR_OWNER : RUN_STATUS.CONCEPTS_ONLY_ASSET_NOT_USABLE;
    return finish(status, { mode, ...progress, frame, concepts, selection, proposals, asset_usable: assetUsable, exam, brain_calls_dir: metered ? brainDir : null });
  } catch (error) {
    const stoppedAt = [...trace].reverse().find((t) => t.outcome === 'ERROR');
    return finish(RUN_STATUS.STOPPED_ERROR, {
      mode, ...progress, stopped_at: stoppedAt ? { step: stoppedAt.step, concept_id: stoppedAt.concept_id ?? null } : null,
      error: { code: error.code ?? null, field: error.field ?? null, message: String(error.message).slice(0, 300) },
      asset_usable: assetUsable, exam, brain_calls_dir: brainDir,
    });
  }
}

export const runFileExists = (p) => existsSync(p);
