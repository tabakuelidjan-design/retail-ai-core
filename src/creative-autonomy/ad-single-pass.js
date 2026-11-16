// THE SHORT PATH OF "PROPOSE-MOI LA PROCHAINE PUBLICITÉ HABB" (2026-11-15): ONE text answer instead of the chain understand -> develop -> compare -> compose. The product is already chosen by Nordla (opportunity.js); Creator is asked, in a
// single response, for the benefit to show, the scene, the headline and the caption, or for NONE when it finds no convincing idea. The software then chooses the framing (framing.js) and builds the image request (composition-request.js).
// At most ONE targeted correction (a patch of the refused fields), and ONLY when the first call and that correction fit TOGETHER, at their worst case, under the text ceiling (planCorrection): the guard prices every input byte and the output cap
// at their worst, so this is a bound, not an estimate. Nothing here writes an idea: it reads the model's own answer, checks it, and ends the route cleanly on NONE (no image is ever paid after it).
import { obj, text, word, list, renderContract } from '../creative-brain/contract.js';
import { SEEN, groundedReason, DETAIL_SHOWS } from './concept-route.js';
import { ask } from './reference-direction.js';
import { adViolations, adShortSpec, AD_PATCH_MAX_OUTPUT_TOKENS, CAPTION_MAX, withoutProductElements } from './ad-composition.js';
import { chooseFraming, finalizeShort } from './framing.js';
import { compositionConstraints, displayedFiguresOf } from './scene-permissions.js';
import { conceptIdOf, conceptOf, adBriefOf, AD_ROUTE_ID } from './ad-route.js';
import { pathOfField } from './repair-patch.js';
import { worstCaseCallEur } from './providers.js';
import { brainOutputCap } from '../marketing-creative/alibaba/qwen-brain-port.js';
import { createHash } from 'node:crypto';

export const AD_SINGLE_MAX_OUTPUT_TOKENS = 2400;
/** Creator's reason cut to the contract's 300 characters at a sentence or a word boundary, with an ellipsis: never in the middle of a word (the full answer stays in the archived brain call). */
const clipReason = (t, n) => { if (t.length <= n) return t; const head = t.slice(0, n - 1); const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf(' ; ')); const cut = sentence > n * 0.5 ? head.slice(0, sentence + 1) : head.slice(0, head.lastIndexOf(' ')); return `${cut.trimEnd()}…`; };
export const SINGLE_VERDICT = Object.freeze({ IDEA: 'IDEA', NONE: 'NONE' });
const SCENE_KEYS = ['idea', 'setting', 'materials', 'atmosphere', 'light', 'text_reserve', 'elements', 'headline', 'headline_lines', 'caption', 'palette_roles', 'benefit', 'need_shown'];
const sha = (v) => createHash('sha256').update(v).digest('hex');

/** The single answer: the verdict, the benefit, the passage that shows the need, the scene, the headline, the caption. When the verdict is NONE only verdict and none_reason are needed. */
export const adSinglePassSpec = (kit) => {
  const short = adShortSpec(kit, { permissions: [] }).fields; const { concept_conserve, concept_changes, ...scene } = short; void concept_conserve; void concept_changes;
  return obj({ verdict: word(SINGLE_VERDICT), none_reason: text({ max: 300, fit: true, allowEmpty: true }), benefit: text({ max: 220, fit: true, allowEmpty: true }), need_shown: text({ max: 220, fit: true, allowEmpty: true }), ...scene }, { optional: SCENE_KEYS });
};

export function adSingleInstruction({ kit, brief, productFacts, verifiedFacts, sceneProhibitions = [], photo = false, hints = [], previous = null, patchFields = null }) {
  const spec = adSinglePassSpec(kit);
  const tops = new Set((patchFields ?? []).map((f) => String(f).split(/[.[]/)[0]));
  const patchLines = () => { const keep = [...tops]; return renderContractLines(spec, keep); };
  const system = [
    'You are the Nordla art director. ' + SEEN(photo) + '. The product of this advertisement is already CHOSEN by Nordla and its photograph is given: it is placed as photographed and never redrawn. In ONE answer you decide what the advertisement shows and says.',
    'verdict: IDEA when you find a convincing idea, NONE when you do not. A convincing idea gives a customer a concrete reason to buy THIS product, shown by a visible detail of the scene. A table, a cup, a notebook, a phone near the product or the mere presence of a cable is not a reason. NONE is valid and expected: it ends the work before any image is paid; never keep an idea to avoid NONE. With NONE, write none_reason (what blocks, in French) and nothing else.',
    'With IDEA: benefit = the relief or the gain the customer gets in that precise moment (French, written to the person, not a characteristic). need_shown = the ONE passage of your own scene text (idea, setting or an element), copied WORD FOR WORD, that shows the customer\'s NEED (what they lack or risk in that moment), visible in the scene. Then the scene, the headline and the caption.',
    `Look at the product first (product_facts: its measured appearance and its verified characteristics, verified_facts): the scene, the light and the palette must set THESE off. The public and the style are in brief (brief.objective is the owner's brief and its prohibitions: obey them; brief.audience, brief.merchant_identity and brief.merchant_voice). When brief.audience is null the public is not defined: invent no target.`,
    'THE SOFTWARE DECIDES THE FRAMING: where the product stands in the frame and how large it is are chosen by Nordla after your answer. Never write where the product stands, how large it is, a distance or a size.',
    'Any promise (scene, headline, caption) rests on the verified facts. Never invent a capability, a duration, a number of charges or a price. Do not name a place, a shop or a brand other than HABB and the product\'s own brand.',
    patchFields ? 'The fields of the answer are described by these lines; a patch value must respect the line of its field:' : 'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):',
    ...(patchFields ? patchLines() : renderContract(spec, 'answer')),
    'GIVEN: the camera sees the product slightly from above, in the soft even light it was photographed in (product_facts.lit_side_of_the_photograph); the light of your scene must be compatible with it, and the product stays as photographed.',
    'THE HEADLINE: French (fr-BE), at most 8 words and 60 characters, no figure, exact on the facts, prolonging the idea of the image. The generator never draws it: Nordla adds it after the render, in the calm area. headline_lines (ONE, TWO or THREE) is how many lines it needs.',
    'THE CAPTION (caption): the text of the Instagram and Facebook post that goes with the advertisement, in French (fr-BE), HABB\'s warm and sober tone: two or three short sentences, written to the customer, that give the reason to want this product (the reason the scene shows), then ONE last line of at most four hashtags, the first being #HABB. Use ONLY the verified facts: no price, promotion, delivery, stock, duration or figure that verified_facts does not hold, no emoji.',
    'THE CALM AREA: text_reserve.zone is where the headline goes and text_reserve.description the SURFACE there (tone and calm), never any text. Compact, not touching the product (Nordla keeps the product clear of that side).',
    'PALETTE: use only colours of palette_kit; give each colour you use a role (DOMINANT, SECONDARY, ACCENT, LIGHT_TINT, SHADOW_TINT) and the SURFACES it covers. Beige, cream and sand are never used.',
    'The idea, setting, materials, atmosphere, light, elements and calm area go to the image generator as written: write them in English, with NO digit anywhere (spelled numbers; a distance, a size, a time and the model number of the product are digits too), describing exactly what is present, each element once. Be concise: every field at most about 350 characters; an answer that is cut off is refused.',
    compositionConstraints({ permissions: [] }),
    'THE PRODUCT IN THE SCENE: it is the real photograph, never redrawn. An element may say what the product rests on or the shadow it casts, but never names its kind, stands in for it or adds a second one. You may describe its OWN parts exactly as photographed; never add one, never change how it lies.',
    ...(hints.length ? ['A previous answer was refused for these reasons: fix exactly these, keep the rest:', ...hints.map((h) => `- ${h}`)] : []),
    ...(hints.length && previous && patchFields ? ['THIS IS THE ONE CORRECTION OF A REFUSED ANSWER (user.previous_answer). Answer with patches ONLY, for the fields named above and in the answer format at the end: you do not return the other fields and you do not change them. A text refused for not being in English: write the same content in English. A headline refused: shorten it, in French, keep its sense. A caption refused: remove what is refused, keep the rest.'] : []),
  ].join('\n');
  const user = JSON.stringify({ brief, ...(hints.length && previous ? { previous_answer: previous } : {}), product_facts: productFacts, verified_facts: verifiedFacts, ...(!patchFields || tops.has('palette_roles') ? { palette_kit: kit } : {}), scene_prohibitions: sceneProhibitions });
  return { system, user, max_output_tokens: patchFields ? AD_PATCH_MAX_OUTPUT_TOKENS : AD_SINGLE_MAX_OUTPUT_TOKENS };
}
import { renderSpec } from '../creative-brain/contract.js';
function renderContractLines(spec, tops) { return renderSpec(spec, 'answer').filter((l) => tops.some((t) => l.startsWith(`answer.${t}`) && /^[:.[]/.test(l.slice(`answer.${t}`.length)))); }

/**
 * THE WORST CASE OF THE TEXT, BEFORE ANY CALL: the first call priced as the guard prices it (every input byte, the output cap), and the correction (a patch of the refused fields on the same request + the previous answer + the reasons).
 * ONE correction is planned only when both fit together under the ceiling.
 */
export function planCorrection({ first, ceilingEur, usdToEur = 1, answerBytesEstimate = 6000 }) {
  const worst = (system, user, cap) => worstCaseCallEur({ texts: [system, user], maxOutputTokens: brainOutputCap(cap), usdToEur }).eur;
  const firstWorst = worst(first.system, first.user, first.max_output_tokens);
  const repairWorst = worst(first.system, `${first.user}${'x'.repeat(answerBytesEstimate)}`, AD_PATCH_MAX_OUTPUT_TOKENS);
  const together = firstWorst + repairWorst;
  return { first_worst_eur: Math.round(firstWorst * 10000) / 10000, correction_worst_eur: Math.round(repairWorst * 10000) / 10000, together_eur: Math.round(together * 10000) / 10000, ceiling_eur: ceilingEur, correction_planned: together <= ceilingEur, maxRepairs: together <= ceilingEur ? 1 : 0, margin_eur: Math.round((ceilingEur - together) * 10000) / 10000 };
}

/** The contract keeps every text on one line: the trailing group of hashtags goes back on its own line (the way a post is written), the words are not touched. */
export const formatCaption = (t) => { const m = String(t ?? '').trim().match(/^(.*?)\s+((?:#[\p{L}\p{N}_]+\s*)+)$/su); return m ? `${m[1].trim()}
${m[2].trim().replace(/\s+/g, ' ')}` : String(t ?? '').trim(); };

/** The rules of the single answer, on the answer COMPLETED with the framing the software chose (so the usual checks of the composition apply). */
export function singleViolations(v, { placementOptions, facts, profile, sheet, verifiedFacts, productFacts }) {
  if (v?.verdict === SINGLE_VERDICT.NONE) return String(v.none_reason ?? '').trim() ? [] : [{ field: 'none_reason', rule: 'NONE_WITHOUT_A_REASON', message: 'verdict NONE needs none_reason: what blocks, in French' }];
  const out = [];
  for (const k of SCENE_KEYS) { const t = v?.[k]; if (t == null || (typeof t === 'string' && !t.trim()) || (Array.isArray(t) && !t.length && k !== 'elements')) out.push({ field: k, rule: 'IDEA_FIELD_MISSING', message: `verdict IDEA needs ${k}` }); }
  if (out.length) return out;
  const shown = { idea: v.idea, visible_cues: [v.setting, ...(v.elements ?? []).map((e) => e.element)].join(' . '), cable_role: '' };
  const g = groundedReason({ scene_alone: { detail: v.need_shown, detail_shows: DETAIL_SHOWS.THE_NEED, customer_understands: v.benefit } }, shown);
  if (g && !g.ok) out.push({ field: 'need_shown', rule: 'NEED_NOT_SHOWN_IN_THE_SCENE', passage: String(v.need_shown).slice(0, 160), message: `need_shown must be a passage of your own scene text (idea, setting or an element), copied word for word, that shows the customer's need (${g.why.join(', ')})` });
  const f = chooseFraming({ placementOptions, textZone: v.text_reserve?.zone, phone: { presence: 'ABSENT', position: 'NOT_APPLICABLE' } });
  let full = v; if (!f.ok) out.push({ field: f.field, rule: f.code, message: f.message }); else full = { ...v, product_position: f.option.product_position, product_framing: f.option.product_framing };
  return [...out, ...adViolations(full, { placementOptions, facts, profile, sheet, permissions: [], displayed: displayedFiguresOf(productFacts), verifiedFacts, short: true })];
}

/**
 * @returns the same shape as runAdDecisions (composition, concepts, selection, chosen_proposal, ...), or throws AD_NO_CONVINCING_IDEA when Creator answers NONE.
 * `ceilingEur` = the text ceiling (0.0932 with the OpenAI engine); `step` = the caller's trace recorder.
 */
export async function runAdSinglePass({ complete, step = null, brief, productFacts, verifiedFacts, placementOptions, sceneProhibitions, kit, facts, profile, sheet, provider = 'REAL', photo = false, ceilingEur = null }) {
  const S = step ?? (async (_rec, fn) => (await fn()).value);
  const adBrief = brief?.public_facts ? adBriefOf(brief) : brief; // the run's brief is the whole public record: the text receives only what the campaign and the brand say (as in runAdDecisions)
  const base = adSingleInstruction({ kit, brief: adBrief, productFacts, verifiedFacts, sceneProhibitions, photo });
  const plan = ceilingEur != null ? planCorrection({ first: base, ceilingEur }) : { maxRepairs: 1, correction_planned: true };
  const normalised = [];
  const scrubbed = async (instruction) => { // the product's own element is taken out before validation (recorded), as in the composition
    const r = await complete(instruction); if (typeof r?.text !== 'string') return r;
    let o = null; for (const c of [r.text, (r.text.match(/\{[\s\S]*\}/) ?? [])[0]]) { if (!c) continue; try { const j = JSON.parse(c); if (j && typeof j === 'object' && !Array.isArray(j)) { o = j; break; } } catch { /* next */ } }
    if (!o || 'patches' in o) return r;
    // A NONE is Creator's honest answer (real attempt cr-b45e9463d81a, 2026-11-15: it answered NONE with empty scene fields and a 380-character reason; the contract refused the empty fields, the correction forced an idea out of it). Only the verdict and the reason count: the rest is dropped, the reason cut to its limit.
    if (String(o.verdict ?? '').toUpperCase() === SINGLE_VERDICT.NONE) return { ...r, text: JSON.stringify({ verdict: SINGLE_VERDICT.NONE, none_reason: clipReason(String(o.none_reason ?? '').replace(/\s+/g, ' ').trim(), 300) || 'Creator a donné aucune raison.' }) };
    const before = normalised.length; const v = withoutProductElements(o, sheet, normalised); return normalised.length === before ? r : { ...r, text: JSON.stringify(v) };
  };
  const dec = await S({ step: 'AD_SINGLE', component: 'ONE answer: the benefit, the scene, the headline and the caption (or NONE); at most one targeted correction', module: 'src/creative-autonomy/ad-single-pass.js', kind: 'LLM', provider }, async () => {
    const r = await ask({ complete: scrubbed, stage: 'DIRECTION_AD_SINGLE', spec: adSinglePassSpec(kit), maxRepairs: plan.maxRepairs, keepUnrefused: true, patchRepair: true, collectAll: true,
      build: (hints, previous, patchFields) => adSingleInstruction({ kit, brief: adBrief, productFacts, verifiedFacts, sceneProhibitions, photo, hints, previous, patchFields }),
      violationsOf: (v) => singleViolations(v, { placementOptions, facts, profile, sheet, verifiedFacts, productFacts }) });
    const none = r.value.verdict === SINGLE_VERDICT.NONE;
    return { outcome: none ? 'NONE' : 'IDEA', detail: { worst_case_text: plan, corrections_used: r.history.length - 1, normalised, ...(none ? { none_reason: r.value.none_reason } : { headline: r.value.headline, caption: r.value.caption, benefit: r.value.benefit, need_shown: r.value.need_shown }) }, value: r };
  });
  const v = dec.value;
  if (v.verdict === SINGLE_VERDICT.NONE) throw Object.assign(new Error(`AD_NO_CONVINCING_IDEA: ${v.none_reason}`), { code: 'AD_NO_CONVINCING_IDEA', detail: { none_reason: v.none_reason, worst_case_text: plan } }); // no image, nothing paid after this point
  const proposal = { name: 'Proposition de Creator (réponse unique)', from_rapprochement: null, starting_point: 'BENEFIT', need: v.benefit, idea: v.idea, visible_cues: v.need_shown, cable_role: 'AUCUN', link_to_product: v.need_shown, speaks_to_the_public: v.benefit, headline: v.headline, product_brings: v.benefit, supported_by: [] };
  const composition = { ...finalizeShort(v, { concept: proposal, placementOptions }), caption: formatCaption(v.caption) };
  const concepts = [conceptOf(proposal)]; const chosenId = conceptIdOf(proposal);
  const selection = { selection: { concept_id: chosenId, outcome: 'SELECT', order: [chosenId], reasons: v.benefit, source: AD_ROUTE_ID }, evaluations: [] };
  return { understanding: null, develop: null, withheld: [], comparison: null, blind: [], composition, chosen_proposal: proposal, concepts, selection, chosen_concept_id: chosenId, worst_case_text: plan, history: { single: dec.history } };
}
void list; void pathOfField; void sha;
