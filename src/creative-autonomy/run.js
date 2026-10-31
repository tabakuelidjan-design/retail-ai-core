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
import { buildAutonomousBrief } from './brief.js';
import { createStageDirector, normalizeStage } from './stage-contract.js';
import { PROVIDER_STATE, WHAT_IS_NEEDED } from './providers.js';

const run$ = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '../../scripts/creative-autonomy');

export const RUN_STATUS = Object.freeze({
  PROPOSALS_READY_FOR_OWNER: 'PROPOSALS_READY_FOR_OWNER',
  STOPPED_PROVIDER_NOT_CONNECTED: 'STOPPED_PROVIDER_NOT_CONNECTED',
  STOPPED_BRIEF_INCOMPLETE: 'STOPPED_BRIEF_INCOMPLETE',
  CONCEPTS_ONLY_ASSET_NOT_USABLE: 'CONCEPTS_ONLY_ASSET_NOT_USABLE',
  STOPPED_ERROR: 'STOPPED_ERROR',
});
export const KIND = Object.freeze({ DETERMINISTIC: 'DETERMINISTIC', LLM: 'LLM', VISION: 'VISION', LOCAL_ENGINE: 'LOCAL_ENGINE' });
export const MAX_REFINE_ROUNDS = 2;

/** Default local engines: real processes, zero cost. Tests may replace them. */
export function localEngines({ python = 'python3', blenderPython = process.env.NORDLA_BLENDER_PYTHON || 'python3', renderScale = 0.5, samples = 32 } = {}) {
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
  const fidelityPass = fid.max_level_difference_after_removing_layers <= 2;
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
export async function runAutonomous({ input, ports, engines = localEngines(), workdir, now = () => Date.now() }) {
  mkdirSync(workdir, { recursive: true });
  const trace = [];
  const humanInterventions = [
    { when: 'avant le passage', who: 'propriétaire', what: 'a choisi le produit, l\'objectif commercial, le format et fourni la photo', creative: false },
  ];
  let textCost = 0; let lastModel = null; let lastCost = 0;
  const metered = ports.text ? async (instruction) => {
    const reply = await ports.text(instruction);
    lastModel = reply.model ?? null; lastCost = reply.cost_eur ?? 0; textCost += lastCost; return reply;
  } : null;

  async function step(rec, fn) {
    const t0 = now(); lastCost = 0; lastModel = null;
    const entry = { n: trace.length + 1, ...rec, model: null, cost_eur: 0, ms: 0, outcome: null, detail: null };
    trace.push(entry);
    try {
      const { outcome, detail, value } = await fn();
      Object.assign(entry, { outcome, detail, model: lastModel ?? rec.model ?? null, cost_eur: lastCost, ms: now() - t0 });
      return value;
    } catch (error) {
      Object.assign(entry, { outcome: 'ERROR', detail: { code: error.code ?? null, message: String(error.message).slice(0, 300), field: error.field ?? null }, ms: now() - t0 });
      throw error;
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
      published: false, spent_without_authorisation: false, ...extra,
    };
    writeFileSync(join(workdir, 'trace.json'), JSON.stringify(result, null, 1));
    return result;
  };

  const textProvider = ports.state?.text ?? (ports.text ? PROVIDER_STATE.REAL : PROVIDER_STATE.NOT_CONNECTED);
  const visionProvider = ports.state?.vision ?? (ports.vision ? PROVIDER_STATE.REAL : PROVIDER_STATE.NOT_CONNECTED);

  // 1 BRIEF
  const photoBytes = readFileSync(input.photoPath);
  const { brief, facts } = await step({ step: 'BRIEF', component: 'buildAutonomousBrief + assessBrief', module: 'src/creative-autonomy/brief.js, src/creative-brain/brief-assessment.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE }, async () => {
    const built = buildAutonomousBrief({ ...input, photo: { bytes: photoBytes, ...input.photoMeta } });
    const assessment = assessBrief({ brief: built.brief });
    return { outcome: assessment.status, detail: { issues: assessment.issues, unknowns: assessment.unknowns, claims: built.brief.claims.map((c) => `${c.role}: ${c.wording}`), personalisation_offered: built.facts.personalisation_offered }, value: { ...built, assessment } };
  }).then((v) => v);
  const factsPath = join(workdir, 'faits.json');
  writeFileSync(factsPath, JSON.stringify({ product_title: facts.product_title, variant: facts.variant, price: facts.price, merchant: input.merchant ?? 'HABB, Namur', personalisation_offered: facts.personalisation_offered, source: facts.source }, null, 1));
  if (trace.at(-1).outcome !== 'PROCEED') return finish(RUN_STATUS.STOPPED_BRIEF_INCOMPLETE);

  // 2 EXAMINE
  const examDir = join(workdir, 'examen');
  mkdirSync(examDir, { recursive: true });
  const exam = await step({ step: 'EXAMINE', component: 'examine_product', module: 'scripts/creative-autonomy/examine_product.py', kind: KIND.LOCAL_ENGINE, provider: PROVIDER_STATE.REAL }, async () => {
    const r = await engines.examine({ photoPath: input.photoPath, outDir: examDir });
    return { outcome: r.status, detail: r, value: r };
  });
  const assetUsable = exam.status === 'CUT_OUT';
  if (!assetUsable) humanInterventions.push({ when: 'requis', who: 'propriétaire', what: `fournir une photo exploitable : ${(exam.reasons ?? [exam.status]).join(', ')}`, creative: false });

  // 3 OBSERVE
  const observation = await step({ step: 'OBSERVE', component: 'observeBrief', module: 'src/creative-brain/problem-frame.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE }, async () => {
    const o = observeBrief({ brief });
    return { outcome: 'OBSERVED', detail: { product_ref: o.product_ref, approved_text_roles: o.approved_text_roles, format: o.format }, value: o };
  });

  // 4 FRAME — the first decision that needs a language model
  const frameRec = { step: 'FRAME', component: 'createProblemFramer', module: 'src/creative-brain/problem-frame.js', kind: KIND.LLM };
  if (!metered) { notConnected(frameRec, 'text'); return finish(RUN_STATUS.STOPPED_PROVIDER_NOT_CONNECTED, { stopped_at: 'FRAME', asset_usable: assetUsable, exam }); }
  try {
    const frame = await step({ ...frameRec, provider: textProvider }, async () => {
      const { frame: f } = await createProblemFramer({ complete: metered }).frame({ observation });
      return { outcome: 'FRAMED', detail: f, value: f };
    });

    // 5 IDEATE
    const concepts = await step({ step: 'IDEATE', component: 'createConceptDirector (3, distinctness guard)', module: 'src/creative-brain/concept.js', kind: KIND.LLM, provider: textProvider }, async () => {
      const { concepts: c } = await createConceptDirector({ complete: metered, count: { min: 3, max: 3 } }).ideate({ frame });
      return { outcome: 'THREE_DISTINCT_CONCEPTS', detail: c.map((x) => ({ concept_id: x.concept_id, central_idea: x.central_idea, visual_metaphor: x.visual_metaphor })), value: c };
    });

    const artDirector = createArtDirector({ complete: metered });
    const stageDirector = createStageDirector({ complete: metered });
    const critic = ports.vision ? createConceptCritic({ vlm: ports.vision }) : null;
    const proposals = [];

    for (const concept of concepts) {
      const cid = concept.concept_id;
      const dir = join(workdir, cid); mkdirSync(dir, { recursive: true });
      const art = await step({ step: 'ART_DIRECT', concept_id: cid, component: 'createArtDirector', module: 'src/creative-brain/art-direction.js', kind: KIND.LLM, provider: textProvider }, async () => {
        const { art_direction: a } = await artDirector.direct({ frame, concept });
        return { outcome: 'DIRECTED', detail: a, value: a };
      });
      let stage = await step({ step: 'STAGE', concept_id: cid, component: 'createStageDirector', module: 'src/creative-autonomy/stage-contract.js', kind: KIND.LLM, provider: textProvider }, async () => {
        const { stage: s } = await stageDirector.stage({ frame, concept, artDirection: art, facts });
        return { outcome: 'STAGED', detail: s, value: s };
      });

      if (!assetUsable) { proposals.push({ concept, art_direction: art, stage, image: null, technical_quality: { state: 'NOT_RENDERED', reason: exam.status }, creative_quality: { state: 'NOT_MEASURED', reason: 'aucune image' }, status: 'CONCEPT_ONLY' }); continue; }

      let round = 0; let report; let imagePath; let critique = null; const history = [];
      for (;;) {
        const tag = `r${round}`;
        const stagePath = join(dir, `stage_${tag}.json`); writeFileSync(stagePath, JSON.stringify(stage, null, 1));
        const setPath = join(dir, `decor_${tag}.png`); imagePath = join(dir, `proposition_${tag}.png`);
        await step({ step: 'RENDER', concept_id: cid, round, component: engines.name?.render ?? 'render', module: 'scripts/creative-autonomy/render_stage.py', kind: KIND.LOCAL_ENGINE, provider: PROVIDER_STATE.REAL }, async () => {
          const info = await engines.render({ stagePath, examPath: join(examDir, 'examen.json'), rgbaPath: join(examDir, 'produit_rgba.png'), canvas: brief.format.canvas, outPath: setPath });
          return { outcome: 'RENDERED', detail: { resolution: info.resolution, foreground_props: info.foreground_props }, value: info };
        });
        report = await step({ step: 'COMPOSE+CHECK', concept_id: cid, round, component: engines.name?.compose ?? 'compose', module: 'scripts/creative-autonomy/compose_stage.py', kind: KIND.LOCAL_ENGINE, provider: PROVIDER_STATE.REAL }, async () => {
          const r = await engines.compose({ stagePath, setPath, rgbaPath: join(examDir, 'produit_rgba.png'), examPath: join(examDir, 'examen.json'), factsPath, outPath: imagePath });
          return { outcome: r.technical.defects.length ? 'DEFECTS' : 'CLEAN', detail: { defects: r.technical.defects, fidelity_max_levels: r.fidelity.max_level_difference_after_removing_layers }, value: r };
        });
        const criticRec = { step: 'CRITIC', concept_id: cid, round, component: 'createConceptCritic', module: 'src/creative-brain/concept-critic.js', kind: KIND.VISION };
        if (critic) {
          critique = await step({ ...criticRec, provider: visionProvider }, async () => {
            const png = readFileSync(imagePath);
            const { critique: c, provenance } = await critic.critique({ candidate: { ref: `render://${cid}/${tag}`, png_bytes: png }, brief: { public_facts: brief.public_facts } });
            lastCost = provenance.cost_eur ?? 0; lastModel = provenance.model ?? null; textCost += lastCost;
            return { outcome: c.dimensions.some(flagged) ? 'REVISION_ASKED' : 'NO_REVISION_ASKED', detail: c.dimensions, value: c };
          });
        } else if (round === 0) notConnected(criticRec, 'vision');

        if (round >= MAX_REFINE_ROUNDS) break;
        const defects = report.technical.defects;
        const fix = deterministicFix(stage, defects);
        const brainDefects = defects.filter((d) => NEEDS_BRAIN.has(d) || (!fix && d));
        const hints = [...brainDefects.map((d) => `technical defect on the render: ${d}`), ...(critique?.dimensions ?? []).filter((d) => flagged(d) && d.revision_hint).map((d) => `${d.dimension}: ${d.revision_hint}`)];
        if (fix && !hints.length) {
          stage = await step({ step: 'REFINE', concept_id: cid, round: round + 1, component: 'deterministicFix (placement du texte, cadrage)', module: 'src/creative-autonomy/run.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE }, async () => {
            const s = normalizeStage({ ...stripIds(stage), ...fix }, { concept, personalisation_offered: facts.personalisation_offered });
            return { outcome: 'FIXED_WITHIN_LIMITS', detail: { defects, change: fix }, value: s };
          });
        } else if (hints.length) {
          stage = await step({ step: 'REFINE', concept_id: cid, round: round + 1, component: 'createStageDirector (re-ask with hints)', module: 'src/creative-autonomy/stage-contract.js', kind: KIND.LLM, provider: textProvider }, async () => {
            const { stage: s } = await stageDirector.stage({ frame, concept, artDirection: art, facts, hints });
            return { outcome: 'RESTAGED', detail: { hints }, value: s };
          });
        } else break;
        history.push({ round, defects });
        round += 1;
      }
      proposals.push({
        concept, art_direction: art, stage, image: imagePath, rounds: round + 1,
        technical_quality: technicalQuality(report), creative_quality: creativeQuality(critique),
        text_for_owner_approval: { headline: stage.headline, facts_lines: report.text_used.facts_lines },
        status: 'PROPOSED_FOR_OWNER_VALIDATION',
      });
    }

    trace.push({ n: trace.length + 1, step: 'REVIEW', component: 'owner review package', module: 'src/creative-autonomy/run.js', kind: KIND.DETERMINISTIC, provider: PROVIDER_STATE.NONE, model: null, cost_eur: 0, ms: 0, outcome: 'AWAITING_OWNER', detail: { proposals: proposals.length } });
    humanInterventions.push({ when: 'après le passage', who: 'propriétaire', what: 'valide, refuse ou demande une révision de chaque proposition (titre compris)', creative: true });
    writeFileSync(join(workdir, 'propositions.json'), JSON.stringify(proposals, null, 1));
    return finish(assetUsable ? RUN_STATUS.PROPOSALS_READY_FOR_OWNER : RUN_STATUS.CONCEPTS_ONLY_ASSET_NOT_USABLE, { frame, proposals, asset_usable: assetUsable, exam });
  } catch (error) {
    return finish(RUN_STATUS.STOPPED_ERROR, { error: { code: error.code ?? null, message: String(error.message).slice(0, 300) }, asset_usable: assetUsable });
  }
}

export const runFileExists = (p) => existsSync(p);
