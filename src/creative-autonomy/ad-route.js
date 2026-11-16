// ADVERTISEMENT ROUTE (AD), 2026-11-09: the ONE route chosen for Creator V1. Product + campaign -> understanding -> four developed proposals -> blind comparison and choice -> composition that DEVELOPS the chosen proposal word for word
// -> (the scene engine builds the frame, the request, the proof of transmission, calls the generator, restores the authentic pixels) -> headline -> review -> export.
// This module holds the TEXT decisions and the adapters to the delivered pipeline's records. It is PURE (a `complete` function and an optional `step` recorder are injected; no network, no file except the placement helper).
// Every artistic decision is Nordla's (the model's): the code writes no scene, no theme and no default depth, mood or support. The records it builds for the delivered pipeline carry the model's own words.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runUnderstand, runDevelop, runCompare, blindList, shownProposal, interpretationsOnly, groundedReason, CRITERIA, NONE_CHOICE, AD_DEVELOP_REPAIRS } from './concept-route.js';
import { runAdComposition, AD_FORM } from './ad-composition.js';
import { permissionsOf, displayedFiguresOf, foreignFigures } from './scene-permissions.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');
export const AD_ROUTE_ID = 'AD_V1';
export const AD_ROUTE_TEXT_CALLS = 4; // understand, develop, compare, composition (plus at most one repair each: the caller's pool)

/** The verified facts Nordla may rely on, with their ids (statuses SHOPIFY_READ and OWNER_CONFIRMED only). */
export const verifiedFactsOf = (sheet) => (sheet?.facts ?? []).filter((f) => ['SHOPIFY_READ', 'OWNER_CONFIRMED'].includes(f.status)).map((f) => ({ id: f.id, claim: f.claim }));

/** What the text calls are told about the NATURE of the product: verified references, measured appearance, what the photograph shows (observed, not confirmed unless the owner confirmed it). No photograph is sent. */
export function productFactsForAd({ sheet, exam = null, variant = null, references = [] }) {
  const hex = (rgb) => `#${rgb.map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
  const ownCables = [...(sheet?.invariants?.confirmed ?? []), ...(sheet?.invariants?.pending ?? [])].some((i) => i.kind === 'CABLE');
  return {
    product: sheet?.title ?? null, variant, verified_references: references.map((r) => r.display ?? r), lit_side_of_the_photograph: sheet?.measured?.lit_side?.side ?? null, tonal_class: sheet?.measured?.tonal_class ?? null,
    product_carries_its_own_cables: ownCables, pendant_cable_below_the_body_share_of_height: sheet?.measured?.hanging_part_share_of_height ?? null,
    appearance: { dominant_colours: (exam?.dominant_colours ?? []).map((c) => ({ hex: hex(c.rgb), share: c.share })), aspect_width_over_height: exam?.aspect_w_over_h ?? null, tonal_class: exam?.tonal_class ?? null },
    visible_on_the_photograph: [...(sheet?.invariants?.confirmed ?? []).map((i) => ({ item: i.item, kind: i.kind, owner_confirmed: true })), ...(sheet?.invariants?.pending ?? []).map((i) => ({ item: i.item, kind: i.kind, owner_confirmed: false }))],
    held_wordings: sheet?.promises?.held_wordings ?? [],
  };
}

/** The brief the text calls receive: what the merchant gave (campaign) and what the brand is. Missing audience stays null: nothing is invented. */
export const adBriefOf = (brief) => {
  const pf = brief?.public_facts ?? {};
  return { ...(Array.isArray(pf.scene_permissions) && pf.scene_permissions.length ? { scene_permissions: pf.scene_permissions } : {}), visual_prohibitions: pf.visual_prohibitions, merchant: pf.merchant, objective: pf.objective, audience: pf.audience ?? null, occasion: pf.occasion ?? null, merchant_identity: pf.merchant_identity, merchant_voice: pf.merchant_voice, facts_rule: pf.facts_rule, verified_selling_points: pf.verified_selling_points };
};

/** The measured placements of the product in the frame (python, local, free). */
export function placementOptionsOf({ python, scriptsDir, rgbaPath, examenPath }) {
  return JSON.parse(execFileSync(python, [`${scriptsDir}/placement_options.py`, rgbaPath, examenPath], { encoding: 'utf8' }));
}

/** A proposal that describes another figure on the product's display than the one the photograph shows is not usable (the pixels never change): it is withheld BEFORE the choice, with its reason. */
export function withholdProposals(proposals, displayed) {
  const withheld = []; const kept = [];
  proposals.forEach((source, index) => {
    const figures = [...new Set(['idea', 'visible_cues', 'cable_role', 'need'].flatMap((f) => foreignFigures(source[f], displayed)))];
    if (figures.length) withheld.push({ index, name: source.name, rule: 'DISPLAY_VALUE_CHANGED', figures, displayed: [...(displayed ?? [])] }); else kept.push({ origin: 'NEW', index, source });
  });
  return { withheld, kept };
}

export const conceptIdOf = (proposal) => `cnc_${sha(JSON.stringify([proposal.name, proposal.idea])).slice(0, 32)}`;

/** A proposal as the delivered pipeline's concept record: Nordla's own words, field to field. Nothing is added. */
export function conceptOf(proposal, { howTheyDiffer = null } = {}) {
  return Object.freeze({
    concept_id: conceptIdOf(proposal), name: proposal.name, central_idea: proposal.idea, visual_metaphor: proposal.link_to_product, story: proposal.speaks_to_the_public, emotional_intent: proposal.speaks_to_the_public, product_role: 'HERO_OF_THE_STORY', message_role: 'FOLLOWS',
    memory_hook: proposal.headline, distinctiveness_reason: howTheyDiffer ?? proposal.from_rapprochement ?? '', risks: [], from_rapprochement: proposal.from_rapprochement ?? null, starting_point: proposal.starting_point, supported_by: proposal.supported_by ?? [], source: AD_ROUTE_ID,
  });
}

/**
 * The art direction and the stage RECORDS the delivered pipeline reads (review, compositor, export). They carry the composition's own words; the enumerations the old pipeline filled by choice are left to neutral values that are NEVER sent to the generator
 * (the request is built from the composition itself: composition-request.js). Only the camera (the placement Nordla chose among the MEASURED ones), the headline and its place are decisions that the compositor and the frame use.
 */
export function decisionRecordsOf(composition, { litSide = null, sceneProhibitions = [] } = {}) {
  const side = litSide === 'RIGHT' ? 'RIGHT' : 'LEFT';
  const art = Object.freeze({
    atmosphere: composition.atmosphere, material_language: composition.materials, lighting_intent: composition.light, rationale: composition.intention, depth_model: 'LAYERED_DEPTH', visual_rhythm: 'STILL', product_relationship: 'GROUNDED_IN_SCENE',
    text_image_relationship: 'TEXT_IN_CALM_ZONES', realism: 'PHOTOREALISTIC', emotional_temperature: 'NEUTRAL', visual_tension: 'LOW', negative_space_strategy: 'ASYMMETRIC_RESERVE',
    narrative_elements: (composition.elements ?? []).map((e) => ({ element: e.element, reason: composition.visible_link, zone: e.zone })), permitted_secondary_elements: [], forbidden_decorative_noise: [...sceneProhibitions],
    source: AD_ROUTE_ID, records_only_not_sent_to_the_generator: true,
  });
  const stage = Object.freeze({
    backdrop: 'WALL_AND_FLOOR', backdrop_tone: 'COOL_GREY', floor_finish: 'SATIN', key_light: { kind: 'SOFTBOX', side, intensity: 'MEDIUM', temperature: 'NEUTRAL', purpose: 'the light of the packshot (measured); the scene light is the composition\'s' }, accent_lights: [],
    camera: { height: 'HIGH', framing: composition.product_framing, product_position: composition.product_position }, props: [], headline: composition.headline, text_placement: composition.text_reserve.zone, show_price: 'NO',
    rationale: composition.placement_why, source: AD_ROUTE_ID, records_only_not_sent_to_the_generator: true,
  });
  return { art, stage };
}

/**
 * The text decisions. `complete(instruction) -> { text, ... }` is the delivered text port (metered by the caller). `step(rec, fn)` is the caller's trace recorder (fn returns { outcome, detail, value }); optional.
 * Returns the records the pipeline needs plus every raw answer (history) for the owner's report.
 */
export async function runAdDecisions({ complete, step = null, brief, productFacts, verifiedFacts, placementOptions, sceneProhibitions, kit, facts, profile, sheet, provider = 'REAL', photo = false, maxRepairs = 1, compositionForm = AD_FORM.SHORT }) {
  const S = step ?? (async (_rec, fn) => (await fn()).value);
  const rec = (name, component, module) => ({ step: name, component, module, kind: 'LLM', provider });
  const adBrief = adBriefOf(brief);
  const permissions = permissionsOf(adBrief); // what THIS campaign allows beyond the default rules (none unless the campaign says so)
  const displayed = displayedFiguresOf(productFacts); // the figure(s) the product's display shows on the photograph
  const u = await S(rec('AD_UNDERSTAND', 'understand the product and the public (interpretations, rapprochements)', 'src/creative-autonomy/concept-route.js'), async () => {
    const r = await runUnderstand({ complete, brief: adBrief, productFacts, verifiedFacts, photo, maxRepairs });
    return { outcome: 'UNDERSTOOD', detail: { rapprochements: r.value.rapprochements.map((x) => x.domain), repairs: r.history.length - 1 }, value: r };
  });
  const d = await S(rec('AD_DEVELOP', 'develop four proposals from its own rapprochements', 'src/creative-autonomy/concept-route.js'), async () => {
    const r = await runDevelop({ complete, brief: adBrief, productFacts, verifiedFacts, sceneProhibitions, understanding: interpretationsOnly(u.value), photo, maxRepairs: maxRepairs > 0 ? AD_DEVELOP_REPAIRS : 0, permissions, enforce: true }); // a second and last repair at this step only
    return { outcome: 'FOUR_PROPOSALS', detail: { proposals: r.value.proposals.map((p) => ({ name: p.name, from_rapprochement: p.from_rapprochement, need: p.need, headline: p.headline })), withheld: withholdProposals(r.value.proposals, displayed).withheld }, value: r };
  });
  const { withheld, kept: entries } = withholdProposals(d.value.proposals, displayed);
  if (!entries.length) throw Object.assign(new Error('AD_ALL_PROPOSALS_WITHHELD: every proposal describes another figure than the one the display of the product shows'), { code: 'AD_ALL_PROPOSALS_WITHHELD', detail: { withheld } });
  const blind = blindList(entries, sha(JSON.stringify(adBrief))); const shown = blind.map((e) => shownProposal(e.id, e.source));
  const cmp = await S(rec('AD_COMPARE', 'compare the four proposals blind on five criteria and choose one', 'src/creative-autonomy/concept-route.js'), async () => {
    const r = await runCompare({ complete, brief: adBrief, productFacts, sceneProhibitions, proposals: shown, photo, maxRepairs, permissions, grid: true, headlines: blind.map((e) => ({ id: e.id, headline: e.source.headline })) }); // the judgment grid: the scene alone first, then the scene with its headline
    // the retained proposal must have a detail the comparator POINTED AT in its own text, and what the customer understands from it; otherwise the answer is NONE, even with a single proposal (no new call, no repair)
    const grounded = r.value.choice === NONE_CHOICE ? null : groundedReason(r.value.scores.find((s) => s.id === r.value.choice), shown.find((x) => x.id === r.value.choice));
    if (grounded && !grounded.ok) r.value = { ...r.value, choice_before_the_check: r.value.choice, choice: NONE_CHOICE, why_this_one: `NO_DETAIL_TO_BUY_FOR (${grounded.why.join(', ')}): the retained proposal's scene alone shows no described detail from which the customer understands a reason to buy. ${r.value.why_this_one}` };
    const none = r.value.choice === NONE_CHOICE; // no proposal answers the brief: the route ends cleanly below, before the composition
    return { outcome: none ? 'NO_PROPOSAL_ANSWERS_THE_BRIEF' : 'CHOSEN', detail: { choice: r.value.choice, ...(grounded ? { grounded_reason: grounded } : {}), ...(none ? { why: r.value.why_this_one } : {}), scores: r.value.scores.map((s) => ({ id: s.id, ...Object.fromEntries(CRITERIA.map((c) => [c, s[c]])), cues_in_scene: s.cues_in_scene, brief_fit: s.brief_fit, ...(s.scene_alone ? { scene_alone: s.scene_alone, with_headline: s.with_headline } : {}) })) }, value: r };
  });
  if (cmp.value.choice === NONE_CHOICE) throw Object.assign(new Error(`AD_NO_PROPOSAL_ANSWERS_THE_BRIEF: ${cmp.value.why_this_one}`), { code: 'AD_NO_PROPOSAL_ANSWERS_THE_BRIEF', detail: { proposals: d.value.proposals, comparison: cmp.value, blind: blind.map((e) => ({ id: e.id, name: e.source.name })) } }); // no retry, no composition, nothing paid after this point
  const chosen = blind.find((e) => e.id === cmp.value.choice)?.source;
  // the headline judged AFTER the scene: when it does not add a reason to buy, the composition is told what the headline should express (never the headline itself)
  const headlineVerdict = cmp.value.scores.find((s) => s.id === cmp.value.choice)?.with_headline;
  const headlineJudgement = headlineVerdict && headlineVerdict.adds !== 'ADDS_A_REASON' ? { adds: headlineVerdict.adds, direction: cmp.value.headline_direction ?? 'AUCUN' } : null;
  if (!chosen) throw Object.assign(new Error('AD_CHOICE_NOT_FOUND: the comparison chose an id that is not a proposal'), { code: 'AD_CHOICE_NOT_FOUND' });
  const comp = await S(rec('AD_COMPOSE', 'compose the advertisement FROM the chosen proposal (placement, light, decor, calm area, headline)', 'src/creative-autonomy/ad-composition.js'), async () => {
    const r = await runAdComposition({ complete, kit, brief: adBrief, productFacts, verifiedFacts, placementOptions, sceneProhibitions, concept: headlineJudgement ? { ...chosen, headline_judgement: headlineJudgement } : chosen, photo, facts, profile, sheet, maxRepairs, permissions, form: compositionForm });
    return { outcome: 'COMPOSED', detail: { concept_conserve: r.value.concept_conserve, concept_changes: r.value.concept_changes, headline: r.value.headline, placement: `${r.value.product_position}/${r.value.product_framing}`, phone: r.value.phone_presence ? `${r.value.phone_presence}/${r.value.phone_position}` : null, normalised: r.normalised, repairs: r.history.length - 1 }, value: r };
  });
  const concepts = d.value.proposals.map((p) => conceptOf(p, { howTheyDiffer: d.value.how_they_differ }));
  const chosenId = conceptIdOf(chosen);
  const byOrigin = new Map(blind.map((e) => [e.id, conceptIdOf(e.source)]));
  const evaluations = cmp.value.scores.map((s) => ({ concept_id: byOrigin.get(s.id), blind_id: s.id, ...Object.fromEntries(CRITERIA.map((c) => [c, s[c]])), cues_in_scene: s.cues_in_scene, brief_fit: s.brief_fit, note: s.note }));
  const selection = { selection: { concept_id: chosenId, outcome: 'SELECT', order: [chosenId], reasons: cmp.value.why_this_one, source: AD_ROUTE_ID }, evaluations };
  return { understanding: u.value, develop: d.value, withheld, comparison: cmp.value, blind: blind.map((e) => ({ id: e.id, concept_id: conceptIdOf(e.source) })), composition: comp.value, chosen_proposal: chosen, concepts, selection, chosen_concept_id: chosenId,
    history: { understand: u.history, develop: d.history, compare: cmp.history, composition: comp.history } };
}

/** A REVISION of the scene (the owner's note): the retained proposal is kept, only the composition is made again, told what to change. One text call (plus the one repair). */
export async function runAdRecomposition({ complete, step = null, brief, productFacts, verifiedFacts, placementOptions, sceneProhibitions, kit, facts, profile, sheet, previous, note, provider = 'REAL', maxRepairs = 1, compositionForm = AD_FORM.SHORT }) {
  const S = step ?? (async (_rec, fn) => (await fn()).value);
  const comp = await S({ step: 'AD_RECOMPOSE', component: 'make the composition again for the owner\'s revision (same proposal)', module: 'src/creative-autonomy/ad-composition.js', kind: 'LLM', provider }, async () => {
    const r = await runAdComposition({ complete, kit, brief: adBriefOf(brief), productFacts, verifiedFacts, placementOptions, sceneProhibitions, concept: previous.chosen_proposal, revision: { note, previous_composition: previous.composition }, photo: false, facts, profile, sheet, maxRepairs, permissions: permissionsOf(adBriefOf(brief)), form: compositionForm });
    return { outcome: 'RECOMPOSED', detail: { concept_conserve: r.value.concept_conserve, concept_changes: r.value.concept_changes, headline: r.value.headline, repairs: r.history.length - 1 }, value: r };
  });
  return comp;
}
