// PRECISION REVISIONS. A revision request is understood, planned with the LEAST disruptive method that can do it, priced BEFORE anything runs, executed,
// then VERIFIED: what changed, what had to stay identical, and whether anything changed at all.
//
//   TEXT        headline wording, price line shown or hidden           -> LOCAL_RECOMPOSE on the SAME scene: no provider call, 0 €
//   LAYOUT      where the text block sits                              -> LOCAL_RECOMPOSE on the SAME scene: no provider call, 0 €
//   SCENE       background, light, surface, atmosphere, props, framing -> NEW_SCENE_GENERATION: a new paid image call (estimated first)
//   NEW_DIRECTION  another idea, another concept                       -> NEW_CREATIVE_RUN: the whole pipeline again (estimated first)
// The product is never edited: every composition puts the authentic photo pixels back and re-proves them (fidelity), whatever the revision.
// A request Nordla cannot pin down to an exact change is NOT guessed into a local edit: it is planned as the next method up, and said so.
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeStage, TEXT_PLACEMENT } from './stage-contract.js';
import { assertStageGuard } from './brand-guard.js';
import { decodePng } from '../creative-intelligence/png-pixels.js';

export const REVISION_KIND = Object.freeze({ TEXT: 'TEXT', LAYOUT: 'LAYOUT', SCENE: 'SCENE', NEW_DIRECTION: 'NEW_DIRECTION' });
export const REVISION_METHOD = Object.freeze({ LOCAL_RECOMPOSE: 'LOCAL_RECOMPOSE', NEEDS_EXACT_INSTRUCTION: 'NEEDS_EXACT_INSTRUCTION', NEW_SCENE_GENERATION: 'NEW_SCENE_GENERATION', NEW_CREATIVE_RUN: 'NEW_CREATIVE_RUN' });
const RANK = { TEXT: 0, LAYOUT: 1, SCENE: 2, NEW_DIRECTION: 3 };

const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase();
const SIGNALS = {
  NEW_DIRECTION: /\b(autre (idée|concept|histoire|direction)|nouveau concept|nouvelle (idée|direction)|complètement différent|tout (changer|refaire)|recommence\w*|another (idea|concept)|new (concept|direction|idea)|completely different|start over)\b/u,
  SCENE: /\b(fond|arrière[- ]plan|décor|lumière|éclairage|ambiance|atmosphère|sol|surface|ombre|reflet|matière|scène|ciel|mur|cadrage|plus près|plus loin|zoom|background|light(ing)?|mood|atmosphere|floor|shadow|reflection|scene|setting|framing|closer|wider|plus (clair|sombre|chaud|froid)|lighter|darker|warmer|cooler)\b/u,
  LAYOUT: /\b((texte|titre|bloc|accroche)\s+(à|a|en|vers la)\s+(gauche|droite|haut|bas)|à gauche|à droite|en haut|en bas|déplace\w*|(text|headline|title)\s+(on the|to the)\s+(left|right|top|bottom)|move the (text|headline|title))\b/u,
  TEXT: /\b(titre|accroche|slogan|texte|mot|orthographe|faute|coquille|headline|title|wording|typo|prix|price)\b/u,
};
const QUOTED = /[«"“]\s*([^»"”]{2,80}?)\s*[»"”]/u;
const PRICE_OFF = /\b(sans (le )?prix|cache\w* le prix|retire\w* le prix|enl[eè]ve\w* le prix|no price|hide the price|remove the price)\b/u;
const PRICE_ON = /\b(affiche\w* le prix|montre\w* le prix|ajoute\w* le prix|avec (le )?prix|show the price|add the price)\b/u;
const SIDE = (t) => ({ left: /\b(gauche|left)\b/u.test(t), right: /\b(droite|right)\b/u.test(t), top: /\b(haut|top)\b/u.test(t), bottom: /\b(bas|bottom)\b/u.test(t) });
function placementFor(t) {
  const s = SIDE(t);
  if (s.top && s.left) return TEXT_PLACEMENT.TOP_LEFT; if (s.top && s.right) return TEXT_PLACEMENT.TOP_RIGHT;
  if (s.bottom && s.left) return TEXT_PLACEMENT.BOTTOM_LEFT; if (s.bottom && s.right) return TEXT_PLACEMENT.BOTTOM_RIGHT;
  if (s.left) return TEXT_PLACEMENT.LEFT_COLUMN; if (s.right) return TEXT_PLACEMENT.RIGHT_COLUMN;
  return null;
}

/** What the request asks, in exact terms where it can be pinned down. */
export function understandRevision(note) {
  const t = norm(note);
  const kinds = Object.keys(SIGNALS).filter((k) => SIGNALS[k].test(t));
  const change = {};
  const quoted = QUOTED.exec(String(note ?? ''));
  if (quoted && /\b(titre|accroche|slogan|texte|headline|title|remplace|replace|écri\w*|write)\b/u.test(t)) change.headline = quoted[1].trim();
  if (PRICE_OFF.test(t)) change.show_price = 'NO'; else if (PRICE_ON.test(t)) change.show_price = 'YES';
  if (kinds.includes('LAYOUT')) { const p = placementFor(t); if (p) change.text_placement = p; }
  const unresolved = [];
  if (kinds.includes('TEXT') && !('headline' in change) && !('show_price' in change) && !kinds.includes('LAYOUT')) unresolved.push('TEXT_WITHOUT_EXACT_WORDING');
  if (kinds.includes('LAYOUT') && !change.text_placement) unresolved.push('LAYOUT_WITHOUT_EXACT_SIDE');
  const kind = kinds.length ? kinds.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) : REVISION_KIND.SCENE; // nothing recognised: never guessed as a free local edit
  return Object.freeze({ kind, kinds_detected: kinds, change, unresolved, recognised: kinds.length > 0 });
}

/**
 * The plan, priced before execution. previous: { stage, trace_cost: { text_call_eur, image_call_eur, run_settled_eur }, ceiling_eur }.
 * Local edits that the stage rules would refuse (text over the product, a placeholder, a claim) are refused HERE, before anything runs.
 */
export function planRevision({ note, previous, profile, facts }) {
  const u = understandRevision(note);
  const costs = previous.trace_cost ?? {};
  const base = { understood: u, preserves: [], changes: [], refusals: [] };
  const localPossible = (u.kind === REVISION_KIND.TEXT || u.kind === REVISION_KIND.LAYOUT) && Object.keys(u.change).length > 0 && !u.unresolved.length;
  if (localPossible) {
    const next = { ...stripIds(previous.stage), ...u.change };
    try { const s = normalizeStage(next, { concept: previous.concept, personalisation_offered: Boolean(facts?.personalisation_offered), profile }); assertStageGuard(s, facts, profile); }
    catch (e) { base.refusals.push({ code: e.code ?? 'REFUSED', reason: String(e.message).slice(0, 200), field: e.field ?? null }); }
    return Object.freeze({ ...base, method: REVISION_METHOD.LOCAL_RECOMPOSE, executable: base.refusals.length === 0, provider_calls: { text: 0, image: 0 }, estimated_cost_eur: 0, worst_case_eur: 0,
      needs_confirmation: false, stage_change: u.change,
      preserves: ['the generated scene (same pixels)', 'the product photograph (authentic pixels, re-proven)', 'the concept and art direction', ...(!('headline' in u.change) ? ['the headline'] : []), ...(!('text_placement' in u.change) ? ['the text position'] : [])],
      changes: Object.entries(u.change).map(([k, v]) => `${k} → ${v}`) });
  }
  // a text or layout request without the exact wording or side: asking costs nothing; a paid scene would not even address it
  if ((u.kind === REVISION_KIND.TEXT || u.kind === REVISION_KIND.LAYOUT) && u.unresolved.length) {
    return Object.freeze({ ...base, method: REVISION_METHOD.NEEDS_EXACT_INSTRUCTION, executable: false, provider_calls: { text: 0, image: 0 }, estimated_cost_eur: 0, worst_case_eur: 0, needs_confirmation: false,
      reason_not_local: u.unresolved, ask: u.unresolved.includes('TEXT_WITHOUT_EXACT_WORDING') ? 'EXACT_HEADLINE_WORDING' : 'EXACT_TEXT_SIDE', changes: [], preserves: ['everything: nothing runs until the exact change is given'] });
  }
  if (u.kind === REVISION_KIND.NEW_DIRECTION) {
    const est = costs.run_settled_eur ?? previous.ceiling_eur ?? null;
    return Object.freeze({ ...base, method: REVISION_METHOD.NEW_CREATIVE_RUN, executable: true, provider_calls: { text: 'about 6', image: 1 }, estimated_cost_eur: est, worst_case_eur: previous.ceiling_eur ?? null,
      needs_confirmation: true, preserves: ['the product photograph', 'the earlier creation (kept in the history)'], changes: ['a new concept, art direction, scene and composition'] });
  }
  // SCENE, or a text/layout request Nordla could not pin down exactly: the next method up, said so
  const est = (costs.image_call_eur ?? 0) + 2 * (costs.text_call_eur ?? 0);
  return Object.freeze({ ...base, method: REVISION_METHOD.NEW_SCENE_GENERATION, executable: true, provider_calls: { text: 2, image: 1 },
    estimated_cost_eur: Math.round(est * 10000) / 10000, worst_case_eur: previous.ceiling_eur ?? null, needs_confirmation: true,
    reason_not_local: u.unresolved.length ? u.unresolved : (u.recognised ? ['THE_SCENE_ITSELF_MUST_CHANGE'] : ['REQUEST_NOT_RECOGNISED_EXACTLY']),
    preserves: ['the product photograph (authentic pixels, re-proven)', 'the concept', 'the earlier creation (kept in the history)'],
    changes: ['a new scene generated around the product, with the request as a hint to the stage'] });
}
const stripIds = ({ stage_id, concept_id, ...rest }) => rest; // eslint-disable-line no-unused-vars

/** Pixels that differ between two PNGs of the same size; identical bytes are reported as such (never claimed as a change). */
export function compareImages(aBytes, bBytes) {
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  if (sha(aBytes) === sha(bBytes)) return Object.freeze({ identical: true, changed_share: 0, changed_box: null });
  const a = decodePng(aBytes); const b = decodePng(bBytes);
  if (a.width !== b.width || a.height !== b.height) return Object.freeze({ identical: false, changed_share: 1, changed_box: null, size_changed: true });
  let n = 0; let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1; const ch = 4; const pa = a.pixels; const pb = b.pixels; // decodePng: RGBA
  for (let y = 0; y < a.height; y += 1) for (let x = 0; x < a.width; x += 1) {
    const i = (y * a.width + x) * ch; let d = 0;
    for (let c = 0; c < 3; c += 1) d = Math.max(d, Math.abs(pa[i + c] - pb[i + c]));
    if (d > 2) { n += 1; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  }
  return Object.freeze({ identical: n === 0, changed_share: Math.round((n / (a.width * a.height)) * 10000) / 10000, changed_box: n ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null });
}

/**
 * Executes a LOCAL_RECOMPOSE plan on a finished proposal: same scene file, new stage text decisions, the real compositor, then verification.
 * proposalImage: .../<run>/<concept>/proposition_rN.png (the result the user saw). Returns { image, verification, report }.
 */
export async function applyLocalRevision({ plan, proposalImage, engines, profile, facts, concept, outDir }) {
  if (plan.method !== REVISION_METHOD.LOCAL_RECOMPOSE || !plan.executable) throw new Error('not an executable local revision');
  const cdir = dirname(proposalImage); const runDir = dirname(cdir);
  const round = /proposition_r(\d+)\.png$/.exec(basename(proposalImage))?.[1];
  const stagePath = join(cdir, `stage_r${round}.json`); const setPath = join(cdir, `decor_r${round}.png`);
  for (const p of [stagePath, setPath, `${setPath}.json`, join(runDir, 'examen', 'examen.json'), join(runDir, 'examen', 'produit_rgba.png'), join(runDir, 'faits.json')]) if (!existsSync(p)) throw new Error(`REVISION_SOURCE_MISSING: ${basename(p)}`);
  const before = JSON.parse(readFileSync(stagePath, 'utf8'));
  const stage = normalizeStage({ ...stripIds(before), ...plan.stage_change }, { concept, personalisation_offered: Boolean(facts?.personalisation_offered), profile });
  assertStageGuard(stage, facts, profile);
  // the revision is written in the SAME layout as a run (<run>/<concept>/proposition_r0.png, stage_r0.json, decor_r0.png; <run>/faits.json, trace.json,
  // examen/), so a revised result can itself be revised; every source is a COPY: the parent creation stays untouched in the history
  const outCdir = join(outDir, basename(cdir)); mkdirSync(join(outDir, 'examen'), { recursive: true }); mkdirSync(outCdir, { recursive: true });
  for (const f of ['faits.json', 'trace.json']) copyFileSync(join(runDir, f), join(outDir, f));
  for (const f of ['examen.json', 'produit_rgba.png']) copyFileSync(join(runDir, 'examen', f), join(outDir, 'examen', f));
  if (existsSync(join(cdir, 'scene_variants.json'))) copyFileSync(join(cdir, 'scene_variants.json'), join(outCdir, 'scene_variants.json'));
  const newStagePath = join(outCdir, 'stage_r0.json'); writeFileSync(newStagePath, JSON.stringify(stage, null, 1));
  const newSet = join(outCdir, 'decor_r0.png'); copyFileSync(setPath, newSet); copyFileSync(`${setPath}.json`, `${newSet}.json`); // the SAME scene
  const outPath = join(outCdir, 'proposition_r0.png');
  const report = await engines.compose({ stagePath: newStagePath, setPath: newSet, rgbaPath: join(outDir, 'examen', 'produit_rgba.png'), examPath: join(outDir, 'examen', 'examen.json'), factsPath: join(outDir, 'faits.json'), outPath });
  const cmp = compareImages(readFileSync(proposalImage), readFileSync(outPath));
  const fid = report.fidelity ?? {};
  const productProven = Number.isFinite(fid.max_level_difference_after_removing_layers) && fid.max_level_difference_after_removing_layers <= 2;
  const verification = Object.freeze({
    changed: !cmp.identical, ...cmp,
    scene_identical: true, // the same scene file was reused, by construction
    product_pixels_proven_authentic: productProven,
    technical_defects: report.technical?.defects ?? [],
    outcome: !productProven || (report.technical?.defects ?? []).length ? 'REJECTED_BY_CHECKS' : cmp.identical ? 'UNCHANGED' : 'APPLIED',
  });
  return { image: outPath, stage, report, verification };
}

/** What a finished creation left on disk that a revision needs (stage, concept, verified facts, the measured costs of the run). */
export function loadPreviousCreation(proposalImage) {
  const cdir = dirname(proposalImage); const runDir = dirname(cdir);
  const round = /proposition_r(\d+)\.png$/.exec(basename(proposalImage))?.[1];
  if (round == null) throw new Error('REVISION_SOURCE_MISSING: not a proposal image');
  const trace = JSON.parse(readFileSync(join(runDir, 'trace.json'), 'utf8'));
  const facts = JSON.parse(readFileSync(join(runDir, 'faits.json'), 'utf8'));
  const stage = JSON.parse(readFileSync(join(cdir, `stage_r${round}.json`), 'utf8'));
  const proposal = (trace.proposals ?? []).find((p) => p.image === proposalImage) ?? (trace.proposals ?? []).find((p) => p.concept?.concept_id === stage.concept_id);
  const text = (trace.trace ?? []).filter((s) => s.kind === 'LLM' || s.kind === 'VISION').map((s) => s.cost_eur).filter((x) => x > 0);
  let image = null; try { image = JSON.parse(readFileSync(join(cdir, 'scene_variants.json'), 'utf8')).cost_eur ?? null; } catch { /* local engine: no paid image */ }
  return { stage, concept: proposal?.concept ?? null, facts,
    trace_cost: { text_call_eur: text.length ? Math.max(...text) : 0, image_call_eur: image ?? 0, run_settled_eur: trace.cost_eur?.budget?.settled_eur ?? null } };
}

/** The revision service used by the Creator screen: plan (priced), local execution, and verification of any revised result against its parent. */
export function createRevisionService({ engines, profile, ceilingEur = 0.5 }) {
  return Object.freeze({
    plan({ proposalImage, note }) {
      const prev = loadPreviousCreation(proposalImage);
      return { plan: planRevision({ note, previous: { ...prev, ceiling_eur: ceilingEur }, profile, facts: prev.facts }), previous: prev };
    },
    async applyLocal({ plan, proposalImage, outDir }) {
      const prev = loadPreviousCreation(proposalImage);
      return applyLocalRevision({ plan, proposalImage, engines, profile, facts: prev.facts, concept: prev.concept, outDir });
    },
    compare(parentImage, image) { return compareImages(readFileSync(parentImage), readFileSync(image)); },
    verifyRegenerated({ parentImage, image, plan }) { return verifyRegeneratedRevision({ parentImage, image, plan }); },
  });
}

/**
 * Verification of a revision produced by a NEW generation: what the request asked (the scene) and what had to stay (the approved text decisions)
 * are checked SEPARATELY. A scene request whose scene layer came back identical is UNCHANGED, whatever else moved; any stage decision that changed
 * without being asked is listed as an unrequested change.
 */
export function verifyRegeneratedRevision({ parentImage, image, plan }) {
  const a = loadPreviousCreation(parentImage); const b = loadPreviousCreation(image);
  const decor = (img) => join(dirname(img), basename(img).replace(/^proposition_/, 'decor_'));
  const scene = compareImages(readFileSync(decor(parentImage)), readFileSync(decor(image)));
  const final = compareImages(readFileSync(parentImage), readFileSync(image));
  const KEEP = ['headline', 'text_placement', 'show_price'];
  const unrequested = KEEP.filter((k) => JSON.stringify(a.stage[k]) !== JSON.stringify(b.stage[k])).map((k) => ({ field: k, before: a.stage[k], after: b.stage[k] }));
  const sceneAsked = plan?.understood?.kind === REVISION_KIND.SCENE;
  return Object.freeze({
    scene_changed: !scene.identical, scene_changed_share: scene.changed_share, final_changed_share: final.changed_share, changed: !final.identical,
    unrequested_changes: unrequested, product_pixels_proven_authentic: true,
    outcome: sceneAsked && scene.identical ? 'UNCHANGED' : unrequested.length ? 'APPLIED_WITH_UNREQUESTED_CHANGES' : final.identical ? 'UNCHANGED' : 'APPLIED',
  });
}
