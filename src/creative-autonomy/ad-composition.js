// ADVERTISEMENT COMPOSITION (2026-11-08): ONE decision for the whole advertisement of ONE product, taken by Nordla's own model from the photograph and the verified facts:
// what the scene answers in the product (its benefit, its nature, or an abstract intention), the idea, the setting and the light, the place of the product (among the measured placements), the headline and the room it needs.
// It replaces, for this route, the sequence ART_DIRECT -> STAGE -> global completion, whose decisions overwrote each other (the builder lists what it supersedes). The code writes no artistic content and adds no lexical guard:
// it reuses the generic checks that exist (scene texts in English, the placement that fits, the cable of the photograph, the brand guard) and the rules of a headline (stage-contract.js: 60 characters, 8 words, no figure, no invented claim).
import { obj, text, word, list, renderContract } from '../creative-brain/contract.js';
import { SCENE_ZONE } from '../creative-brain/art-direction.js';
import { SCENE_GLOBAL_SPEC, sceneGlobalViolations, GLOBAL_LIMITS } from './scene-clarify.js';
import { visibleSceneViolations } from './visible-scene-check.js';
import { productNamingFindings } from './product-visible-request.js';
import { pathOfField } from './repair-patch.js';
import { collectArtDirectionGuard, assertHeadlineGuard } from './brand-guard.js';
import { headlineProblem } from './stage-contract.js';
import { PALETTE_ROLES, DECISIONS, paletteVocabulary, ask } from './reference-direction.js';
import { SEEN } from './concept-route.js';
import { renderSpec } from '../creative-brain/contract.js';
import { compositionConstraints, displayedFiguresOf, foreignFigures, unverifiedDurationIn } from './scene-permissions.js';
import { phoneSpecFields, phoneInstruction, phoneViolations, scrubComposition } from './phone-placement.js';
import { chooseFraming, finalizeShort } from './framing.js';

export const STARTING_POINTS = Object.freeze({ BENEFIT: 'BENEFIT', PRODUCT_NATURE: 'PRODUCT_NATURE', ABSTRACT_INTENTION: 'ABSTRACT_INTENTION' });
export const RELATIONS = Object.freeze({ FUNCTIONAL: 'FUNCTIONAL', VISUAL: 'VISUAL', EMOTIONAL: 'EMOTIONAL' });
export const HEADLINE_LINES = Object.freeze({ ONE: 'ONE', TWO: 'TWO', THREE: 'THREE' });
// the guard prices the output ceiling of every call at its worst case (0.136 EUR text balance): the largest archived composition answer is about 7.1 KB (roughly 2k tokens), so 3200 leaves a margin and keeps the worst case of this call where it was before the two decisions were added (it was effectively 4000: the port's own cap)
export const AD_MAX_OUTPUT_TOKENS = 3200;
// a repair answers PATCHES for the refused fields only (a few hundred tokens): its output ceiling is lower, which lowers the WORST case the budget guard prices before the call (0.136 EUR text balance, AD_LIVE_CAPS)
export const AD_PATCH_MAX_OUTPUT_TOKENS = 1800;
// the SHORT form answers about half as much (no structure, no place of the product, no explanations): its ceiling is priced at that size
export const AD_SHORT_MAX_OUTPUT_TOKENS = 2200;
export const CAPTION_MAX = 600;
export const AD_FORM = Object.freeze({ LONG: 'LONG', SHORT: 'SHORT' });
const free = (max) => text({ max, fit: true });

/** The advertisement: the scene sections of the global completion + the nature of the product, the intention, the placement and the headline with the room it needs. */
export const CONCEPT_KEPT = Object.freeze({ CONSERVED: 'CONSERVED', ADAPTED: 'ADAPTED' });

/** With a GIVEN concept (the proposal Nordla retained, word for word) the composition no longer explores three intentions: it develops that one. concept_conserve and concept_changes are an indication for the owner, never a proof of fidelity. */
/** The SHORT form (2026-11-15): the scene, the calm area of the headline, the palette, the headline and the phone choice. Nothing about where the product stands or how large it is (the software decides, framing.js), no explanation fields:
 *  the retained proposal's own words (idea, visible cues, what the product brings) stand in for them in the records. It always develops a GIVEN concept. */
export const adShortSpec = (kit, { permissions = [] } = {}) => {
  const { product_position, product_framing, structure, resolution, ...scene } = SCENE_GLOBAL_SPEC.fields; void product_position; void product_framing; void structure; void resolution;
  return obj({
    concept_conserve: word(CONCEPT_KEPT), concept_changes: text({ max: 400, fit: true, allowEmpty: true }),
    ...scene, ...phoneSpecFields(permissions),
    elements: list(obj({ zone: word(SCENE_ZONE), element: text({ max: GLOBAL_LIMITS.element, geometry: true, fit: true }) }), { min: 0, max: GLOBAL_LIMITS.max_elements }),
    headline: text({ max: 60 }), headline_lines: word(HEADLINE_LINES),
    caption: text({ max: CAPTION_MAX, fit: true }), // the Instagram and Facebook post text that goes with the advertisement (2026-11-15), written by Creator in the same answer: no extra call
    palette_roles: list(obj({ colour: word(paletteVocabulary(kit)), role: word(PALETTE_ROLES), surfaces: free(200) }), { min: 2, max: 6 }),
  });
};
export const adSpec = (kit, factIds = [], { concept = false, permissions = [] } = {}) => obj({
  ...(concept ? { concept_conserve: word(CONCEPT_KEPT), concept_changes: text({ max: 400, fit: true, allowEmpty: true }) } : { ideas_considered: list(free(320), { min: 3, max: 3 }) }),
  starting_point: word(STARTING_POINTS),
  relation: word(RELATIONS),
  intention: free(400),
  visible_link: free(400),
  reason_to_care: free(300),
  audience_use: free(300),
  supported_by: list(word(Object.fromEntries(factIds.map((i) => [i, i]))), { min: 0, max: 4 }),
  product_nature: free(500),
  ...SCENE_GLOBAL_SPEC.fields,
  ...phoneSpecFields(permissions),
  elements: list(obj({ zone: word(SCENE_ZONE), element: text({ max: GLOBAL_LIMITS.element, geometry: true, fit: true }) }), { min: 0, max: GLOBAL_LIMITS.max_elements }),
  placement_why: free(300),
  headline: text({ max: 60 }),
  headline_role: free(300),
  headline_lines: word(HEADLINE_LINES),
  palette_roles: list(obj({ colour: word(paletteVocabulary(kit)), role: word(PALETTE_ROLES), surfaces: free(200) }), { min: 2, max: 6 }),
  choices: list(obj({ decision: word(DECISIONS), why: free(400) }), { min: 5, max: 5 }),
});

/** The contract lines of a PATCH repair: only the fields being patched (their rules), not the whole answer. */
function patchContractLines(spec, patchFields) {
  const tops = [...new Set(patchFields.map((f) => String(f).split(/[.[]/)[0]))];
  return renderSpec(spec, 'answer').filter((l) => tops.some((t) => l.startsWith(`answer.${t}`) && /^[:.[]/.test(l.slice(`answer.${t}`.length))));
}
export function adInstruction({ kit, brief, productFacts, verifiedFacts, placementOptions, sceneProhibitions = [], concept = null, revision = null, photo = true, hints = [], previous = null, permissions = [], patchFields = null }) {
  const spec = adSpec(kit, verifiedFacts.map((f) => f.id), { concept: Boolean(concept), permissions });
  const system = [
    'You are the Nordla art director. ' + SEEN(photo) + '. You compose ONE advertisement for it, as ONE decision: the idea, the setting, the light, the place of the product in the frame, and the headline with the room it needs.',
    'Look at the product itself before anything else: its nature (what it is, what it does, the technology it carries), its appearance (form and proportions, colours, materials and finish, details) and its verified characteristics (product_facts). The setting, the light and the composition must set THESE off, and the product must look as if it belongs to the place.',
    'Your advertisement has ONE visual intention: the universe, the composition and the headline are the same idea seen three ways. It must make the product desirable, give it a clear place and give a reason to look at it or to buy it, for the public defined in the brief. A beautiful setting is not enough, and neither is a wall, a support and a colour: the viewer must SEE something in the scene that comes from THIS product (its function, its technology, its appearance, its use or the feeling it gives). The relation can be FUNCTIONAL, VISUAL or EMOTIONAL. An abstract scene is allowed when it expresses something real of the product. Adding accessories of a theme is not an idea, and this advertisement has its own proposal: do not fall back on a generic studio.',
    `THE PUBLIC: brief.audience is the public defined by the merchant (its needs, its uses, its purchase context, its age range when it matters) and brief.occasion the occasion, if any; brief.merchant_identity and brief.merchant_voice give the brand and the tone. The public must shape ${concept ? 'the concept as you develop it' : 'the three intentions, your choice'}, the setting, the composition and the tone of the headline. Do NOT deduce tastes from an age alone: rely on what the brief says. When brief.audience is null the public is NOT defined: do not invent a target, say so in audience_use, and address the customers of the brand in general as brief.merchant_identity describes them. audience_use says what in the public you relied on and what information is missing.`,
    ...(revision ? ['THE OWNER ASKED FOR A REVISION (user.revision.note). user.revision.previous_composition is what was made. Keep the concept and everything the note does not ask to change; change only what the note asks, and say exactly what you changed in concept_changes (concept_conserve is then ADAPTED if the idea itself changed).'] : []),
    ...(concept ? ["THE CONCEPT IS GIVEN (user.concept): it is the proposal Nordla itself retained, with its universe, the place and presentation of the product, its light and its headline. You do NOT invent another idea and you do NOT choose between ideas: you DEVELOP this one, faithfully, into the decor, the structure, the light, the place of the product, the reserve and the headline. The universe, what the viewer sees, the mood and the sense of the headline of the concept must be recognisable in your answer. Write the headline from concept.headline; change it only if it breaks the rules of a headline below, and then keep its sense. EXCEPTION: when user.concept.headline_judgement exists, the comparison judged that this headline does NOT add a reason to buy (headline_judgement.adds: it repeats a characteristic the scene already shows, or it stays vague): then write a new headline that speaks to the customer, a lived moment or the relief the product brings, and that adds a reason the scene does not show; headline_judgement.direction says what it should express (it is not the headline). Where the concept cannot be followed exactly (the product cannot be changed, the placement must fit, the light of the photograph), adapt the least possible and say what you changed. concept_conserve is CONSERVED when the concept is developed as given and ADAPTED when you had to change something; concept_changes says exactly what, or that nothing changed. intention restates the concept in your words; visible_link and reason_to_care say what the viewer sees that comes from the product and why it gives a reason to be interested (a promise only if the verified facts support it). starting_point and relation describe the concept as given."] : ['First write in ideas_considered three intentions that are genuinely different in kind (not in colour), each a complete commercial proposal for the public (the universe, the place of the product, and what the headline would say), then choose one and say in intention why. You choose where it starts (starting_point): BENEFIT (a real, supported benefit), PRODUCT_NATURE (what the product is or looks like) or ABSTRACT_INTENTION. No benefit is required. visible_link says what the viewer sees in the scene that comes from the product, and reason_to_care why this gives a reason to be interested in it or to buy it (a promise only if the verified facts support it).']),
    'Any promise you express (in the idea, the intention or the headline) must rest on the verified facts: list their ids in supported_by (it may stay empty when you promise nothing). Never invent a capability, a duration, a number of charges or a price.',
    patchFields ? 'The fields of the answer are described by these lines; a patch value must respect the line of its field:' : 'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):',
    ...(patchFields ? patchContractLines(spec, patchFields) : renderContract(spec, 'answer')),
    'WHAT IS GIVEN (facts of the photograph, not decisions): its perspective (the camera sees it slightly from above), the soft and even light it was photographed in (the side it comes from is product_facts.lit_side_of_the_photograph), and how its cables are (the real pose is never changed). The light of your scene must be compatible with that light.',
    'THE PLACE OF THE PRODUCT: choose product_position and product_framing among placement_options (each gives the MEASURED box of the product and the free space on each side; one that does not fit is not allowed). The support, the contact with it and the light are part of the same composition: say in placement_why why the product stands where it stands. The measured box is FIXED and is the truth of the frame: the foot of the product is at body_foot_y_share percent of the frame height and its top at box_share_of_frame.top. Describe the support and the setting around THAT place (what is under the foot, what is behind the body); never describe an edge, a fold, a horizon or a step at a height that contradicts it, and never say the product sits "on the upper edge" of something when the measured box puts it elsewhere.',
    'THE HEADLINE: written in French (fr-BE), at most 8 words and 60 characters, no figure, in your own words, exact on the facts, so that it prolongs the idea of the image (headline_role says how). It is NOT a technical sheet. The image generator never draws it: Nordla adds it after the render, in the reserve you describe. headline_lines (ONE, TWO or THREE) is how many lines it needs.',
    'THE RESERVE: text_reserve is the zone where the headline goes and a description of the SURFACE there (its tone and its calm), never of any text: no title, no words, no letters. It must be just large enough for the headline you wrote and have a surface that gives it contrast; it must not take a large part of the image for nothing, and it must not touch the product.',
    'PALETTE: the brand kit is given with palette_kit. You are FREE inside it: any colour may take any role (DOMINANT, SECONDARY, ACCENT, LIGHT_TINT, SHADOW_TINT) in any scene; give each colour you use a role and the SURFACES it covers. Use only colours of the kit. Beige, cream and sand are never used.',
    'EXPLAIN every decision: product_nature says what you saw in the product and what it asks of the scene; choices explains, for each of COMPOSITION, PRODUCT_PLACEMENT, LIGHT, PALETTE and TEXT_RESERVE, WHY. Be concise: every explanatory field at most about 350 characters; an answer that is cut off is refused.',
    'The idea, setting, atmosphere, materials, light, structure, elements and text_reserve go to the image generator as written: write them in English, with NO digit anywhere (relative words, spelled numbers; a distance, a size, a time and the MODEL NUMBER of the product such as "FC-02" are digits too: say "just beside", "the power bank"), describing exactly the elements that are present and nothing absent; each element once.',
    compositionConstraints({ permissions }),
    ...(phoneInstruction(permissions) && (!patchFields || patchFields.some((f) => /^phone_/.test(String(f)))) ? [phoneInstruction(permissions)] : []),
    'THE PRODUCT IN THE SCENE: it is the real photograph, never redrawn. A scene element may say what the product rests on or the shadow it casts, but never names its kind, stands in for it or adds a second one. You may describe the product\'s OWN parts (its cables, straps, lids) exactly as photographed (say "its integrated cable"); never add one, never change how it lies, and never promise a capability that the verified facts do not give. If you have nothing to resolve, say so in resolution.',
    ...(hints.length ? ['A previous answer was refused for these reasons: fix exactly these, keep the rest:', ...hints.map((h) => `- ${h}`)] : []),
    ...(hints.length && previous && patchFields ? ['THIS IS A CORRECTION OF A REFUSED ANSWER (user.previous_answer). Answer with patches ONLY, for the fields named in the refusals above and in the answer format at the end: you do not return the other fields and you do not change them, Nordla keeps them exactly as they are. When a text is refused for not being in English, write the same content in English; do not change what it describes. When the headline is refused, shorten it, in French, keep its sense and respect the rules of a headline.'] : []),
    ...(hints.length && previous && !patchFields ? ['THIS IS A CORRECTION, NOT A NEW COMPOSITION. user.previous_answer is your refused answer. Return the complete answer again, but change ONLY the fields named in the refusals above (and what a named field strictly needs to stay coherent). Every other field, and every decision (product_position, product_framing, headline, headline_lines, palette_roles, choices), must be repeated WORD FOR WORD. When a text is refused for not being in English, write the same content in English; do not change what it describes.'] : []),
  ].join('\n');
  // a PATCH repair is a small request: the place of the product (placement_options) and the palette kit are sent only when a refused field needs them (the budget guard prices every input byte at its worst case)
  const tops = new Set((patchFields ?? []).map((f) => String(f).split(/[.[]/)[0])); const needs = (...keys) => !patchFields || keys.some((k) => tops.has(k));
  const user = JSON.stringify({ brief, ...(concept ? { concept } : {}), ...(revision ? { revision } : {}), ...(hints.length && previous ? { previous_answer: previous } : {}), product_facts: productFacts, verified_facts: verifiedFacts, ...(needs('palette_roles') ? { palette_kit: kit } : {}), ...(needs('product_position', 'product_framing', 'placement_why') ? { placement_options: placementOptions } : {}), scene_prohibitions: sceneProhibitions });
  return { system, user, max_output_tokens: patchFields ? AD_PATCH_MAX_OUTPUT_TOKENS : AD_MAX_OUTPUT_TOKENS };
}

/** The SHORT instruction: the same facts and the same limits as the long one, about half the words, and no place, no size, no structure for the product (the software decides them after reading the scene). */
export function adInstructionShort({ kit, brief, productFacts, verifiedFacts, sceneProhibitions = [], concept, revision = null, photo = true, hints = [], previous = null, permissions = [], patchFields = null }) {
  if (!concept) throw new TypeError('the SHORT composition develops a GIVEN concept');
  const spec = adShortSpec(kit, { permissions });
  const system = [
    'You are the Nordla art director. ' + SEEN(photo) + '. You compose ONE advertisement for it by DEVELOPING the proposal Nordla retained (user.concept), faithfully: its universe, what the viewer sees, its mood and the sense of its headline must be recognisable. THE SOFTWARE DECIDES THE FRAMING: where the product stands in the frame and how large it is are chosen by Nordla after your answer, from measured placements. Never write where the product stands, how large it is, a distance or a size.',
    'Look at the product first (its form, colours, materials, finish, the verified characteristics in product_facts): the scene, the light and the palette must set THESE off. The public is brief.audience (when null, it is not defined: invent no target); brief.merchant_identity and brief.merchant_voice give the brand and the tone.',
    ...(revision ? ['THE OWNER ASKED FOR A REVISION (user.revision.note): keep the concept and everything the note does not ask to change; say in concept_changes what you changed (concept_conserve ADAPTED).'] : []),
    'concept_conserve is CONSERVED when you develop the concept as given and ADAPTED when you had to change something; concept_changes says exactly what, or that nothing changed. Write the headline from concept.headline; change it only if it breaks the headline rules below. EXCEPTION: when user.concept.headline_judgement exists, that headline does NOT add a reason to buy: write a new one that speaks to the customer and adds a reason the scene does not show (headline_judgement.direction says what it should express; it is not the headline).',
    'Any promise (in the scene or the headline) rests on the verified facts (verified_facts). Never invent a capability, a duration, a number of charges or a price.',
    patchFields ? 'The fields of the answer are described by these lines; a patch value must respect the line of its field:' : 'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):',
    ...(patchFields ? patchContractLines(spec, patchFields) : renderContract(spec, 'answer')),
    'GIVEN (facts of the photograph, not decisions): the camera sees the product slightly from above, in the soft even light it was photographed in (the side it comes from is product_facts.lit_side_of_the_photograph); the light of your scene must be compatible with it, and the product stays as photographed.',
    'THE HEADLINE: French (fr-BE), at most 8 words and 60 characters, no figure, exact on the facts, prolonging the idea of the image. The generator never draws it: Nordla adds it after the render, in the calm area. headline_lines (ONE, TWO or THREE) is how many lines it needs.',
    'THE CAPTION (caption): the text of the Instagram and Facebook post that goes with the advertisement, in French (fr-BE), HABB\'s warm and sober tone: two or three short sentences, written to the customer, that give the reason to want this product (the reason the scene shows), then ONE last line of at most four hashtags, the first being #HABB. Use ONLY the verified facts: no price, promotion, delivery, stock, duration or figure that verified_facts does not hold, no emoji.',
    'THE CALM AREA: text_reserve.zone is where the headline goes and text_reserve.description the SURFACE there (tone and calm), never any text. Compact, not touching the product (Nordla keeps the product clear of that side).',
    'PALETTE: use only colours of palette_kit; give each colour you use a role (DOMINANT, SECONDARY, ACCENT, LIGHT_TINT, SHADOW_TINT) and the SURFACES it covers. Beige, cream and sand are never used.',
    'The idea, setting, materials, atmosphere, light, elements and calm area go to the image generator as written: write them in English, with NO digit anywhere (spelled numbers; a distance, a size, a time and the model number of the product are digits too), describing exactly what is present, each element once. Be concise: every field at most about 350 characters; an answer that is cut off is refused.',
    compositionConstraints({ permissions }),
    ...(phoneInstruction(permissions) && (!patchFields || patchFields.some((f) => /^phone_/.test(String(f)))) ? [phoneInstruction(permissions)] : []),
    'THE PRODUCT IN THE SCENE: it is the real photograph, never redrawn. An element may say what the product rests on or the shadow it casts, but never names its kind, stands in for it or adds a second one. You may describe its OWN parts exactly as photographed ("its integrated cable"); never add one, never change how it lies.',
    ...(hints.length ? ['A previous answer was refused for these reasons: fix exactly these, keep the rest:', ...hints.map((h) => `- ${h}`)] : []),
    ...(hints.length && previous && patchFields ? ['THIS IS A CORRECTION OF A REFUSED ANSWER (user.previous_answer). Answer with patches ONLY, for the fields named above and in the answer format at the end: you do not return the other fields and you do not change them. A text refused for not being in English: write the same content in English. A headline refused: shorten it, in French, keep its sense.'] : []),
  ].join('\n');
  const tops = new Set((patchFields ?? []).map((f) => String(f).split(/[.[]/)[0]));
  const user = JSON.stringify({ brief, concept, ...(revision ? { revision } : {}), ...(hints.length && previous ? { previous_answer: previous } : {}), product_facts: productFacts, verified_facts: verifiedFacts, ...(!patchFields || tops.has('palette_roles') ? { palette_kit: kit } : {}), scene_prohibitions: sceneProhibitions });
  return { system, user, max_output_tokens: patchFields ? AD_PATCH_MAX_OUTPUT_TOKENS : AD_SHORT_MAX_OUTPUT_TOKENS };
}

/** The caption's own checks: nothing commercial that no verified fact gives (price, promotion, delivery, stock), every figure present in a verified fact, no duration promise, at most five hashtags. Absent caption: nothing to check here. */
export function captionViolations(c, { verifiedFacts = [] } = {}) {
  const t = String(c?.caption ?? ''); if (!t.trim()) return [];
  const out = []; const facts = verifiedFacts.map((f) => String(f.claim ?? '')).join(' ').toLowerCase().replace(/\s+/g, ' ');
  const claim = t.match(/(?<![\p{L}])(prix|promo\w*|remise|soldes?|gratuit\w*|offert\w*|livraison|stock|r[ée]duction|rupture)(?![\p{L}])|[€$%]|(?<![\p{L}])euros?(?![\p{L}])/iu);
  if (claim) out.push({ field: 'caption', rule: 'CAPTION_COMMERCIAL_CLAIM', message: `the caption says "${claim[0]}": no price, promotion, delivery or stock claim (no verified fact gives it)` });
  for (const n of new Set(t.match(/\d[\d.,]*/g) ?? [])) if (!facts.replace(/\s/g, '').includes(n.replace(/\s/g, '').toLowerCase())) out.push({ field: 'caption', rule: 'CAPTION_FIGURE_NOT_VERIFIED', message: `the caption holds the figure "${n}" which no verified fact states` });
  const tags = t.match(/#[\p{L}\p{N}_]+/gu) ?? []; if (tags.length > 5) out.push({ field: 'caption', rule: 'CAPTION_TOO_MANY_HASHTAGS', message: `the caption has ${tags.length} hashtags: at most five` });
  const dur = unverifiedDurationIn(t, verifiedFacts); if (dur) out.push({ field: 'caption', rule: 'CAPTION_PROMISES_A_DURATION', message: `the caption promises "${dur}": no verified fact gives a duration or an autonomy` });
  return out;
}

/** What is DETECTED: the generic checks that exist + the rules of a headline that exist. No rule specific to a scene. */
export function adViolations(c, { placementOptions, facts = null, profile = null, sheet = null, permissions = [], displayed = null, verifiedFacts = [], short = false }) {
  const out = [...sceneGlobalViolations(c, { placementOptions, structureRules: false, cableRule: false, reserveSideRule: false }), ...visibleSceneViolations(c, { permissions, strict: true }), ...phoneViolations(c, permissions)]; // strict: the limits of scene-permissions.js apply to every text of THIS route only
  // the display of the product shows what the photograph shows (protected pixels): no text of the scene may describe another figure on it
  if (displayed && displayed.size) for (const [field, t] of [['idea', c?.idea], ['structure', c?.structure], ['setting', c?.setting], ['visible_link', c?.visible_link], ['materials', c?.materials]]) { const f = foreignFigures(t, displayed); if (f.length) out.push({ field, rule: 'DISPLAY_VALUE_CHANGED', message: `${field} describes ${f.join(', ')} on the product's display, but the photograph shows ${[...displayed].join(', ')} and its pixels never change` }); }
  if (c?.concept_conserve === CONCEPT_KEPT.ADAPTED && !String(c?.concept_changes ?? '').trim()) out.push({ field: 'concept_changes', rule: 'ADAPTED_WITHOUT_EXPLANATION', message: 'concept_conserve is ADAPTED: concept_changes must say exactly what was changed' });
  const decided = new Set((c?.choices ?? []).map((x) => x.decision)); if (!short) for (const d of Object.values(DECISIONS)) if (!decided.has(d)) out.push({ field: 'choices', rule: 'DECISION_NOT_EXPLAINED', message: `choices must explain ${d}` });
  if (!(c?.palette_roles ?? []).some((p) => p.role === PALETTE_ROLES.DOMINANT)) out.push({ field: 'palette_roles', rule: 'NO_DOMINANT_COLOUR', message: 'palette_roles must give one colour the DOMINANT role' });
  if (!short && c?.starting_point === STARTING_POINTS.BENEFIT && !(c.supported_by ?? []).length) out.push({ field: 'supported_by', rule: 'BENEFIT_WITHOUT_FACT', message: 'a composition that starts from a benefit must cite, in supported_by, the verified fact(s) it rests on' });
  const hp = headlineProblem(c?.headline, { personalisation_offered: Boolean(facts?.personalisation_offered), profile, headlineCheck: facts && profile ? (h) => assertHeadlineGuard(h, facts, profile) : null });
  if (hp) out.push({ field: 'headline', rule: hp, message: `the headline is refused (${hp}): at most 8 words and 60 characters, no figure, no invented claim, only what the verified facts allow` });
  else { const dur = unverifiedDurationIn(c?.headline, verifiedFacts); if (dur) out.push({ field: 'headline', rule: 'HEADLINE_PROMISES_A_DURATION', message: `the headline promises "${dur}": no verified fact gives a duration or an autonomy` }); } // the existing headline rules keep their priority
  if (profile && facts) {
    const art = { atmosphere: c.atmosphere, material_language: c.materials, lighting_intent: c.light, rationale: c.idea, narrative_elements: (c.elements ?? []).map((e) => ({ element: e.element, reason: 'direction', zone: e.zone })), permitted_secondary_elements: [], forbidden_decorative_noise: ['hands'] };
    for (const v of collectArtDirectionGuard(art, facts, profile, { productVisible: false })) if (v.detail?.problem !== 'GENERATOR_TEXT_NOT_ENGLISH') out.push({ field: v.field, rule: v.detail?.problem ?? v.code, message: v.message });
  }
  out.push(...captionViolations(c, { verifiedFacts }));
  // always run (not only when nothing else is refused): a repair must be told EVERY defect at once, not one per round
  for (const f of productNamingFindings(c?.elements, sheet)) out.push({ field: `elements[${f.index}].element`, rule: 'ELEMENT_NAMES_THE_PRODUCT', passage: f.text, message: `elements[${f.index}] names the product ("${f.noun}"): a scene element never names the product or its kind. Situate the object by reference to the other elements of the scene (what it rests on, what lies beside it); if its position relative to the product matters, keep that relation in the idea or in the structure, where the product may be named` });
  // every refusal cites the exact passage that triggered it (a whole text is cut at 160 characters): the repair is told WHERE, not only which field
  return out.map((v) => { if (v.passage) return v; const t = pathOfField(v.field).reduce((o, k) => o?.[k], c); return typeof t === 'string' && t.trim() ? { ...v, passage: t.length > 160 ? `${t.slice(0, 157)}...` : t } : v; });
}

/** Nordla takes out, BEFORE validation, the model number of the product and (when the phone is a structured choice) the phone sentences that carry a distance: the composition is then judged on what remains. Recorded, never silent. */
/** An element whose subject is the product itself ("Mauve bottle resting flat on the bench, handle forward, beside a map and a ticket") is redundant: the product is the real photograph. It used to stop the composition (real attempt 2026-11-15,
 *  cr-547a597f5b44: refused twice on the same rule); it is now taken out BEFORE validation, recorded, and the scene keeps its idea, its setting and its other elements. */
export const withoutProductElements = (o, sheet, log) => {
  if (!sheet || !Array.isArray(o.elements)) return o;
  const hits = productNamingFindings(o.elements, sheet); if (!hits.length) return o;
  const gone = new Set(hits.map((h) => h.index)); for (const h of hits) log.push({ field: 'elements.element', passage: h.text, reason: 'PRODUCT_ELEMENT_REMOVED' });
  return { ...o, elements: o.elements.filter((_, i) => !gone.has(i)) };
};
const scrubbing = (complete, permissions, log, sheet = null) => async (instruction) => { // sheet null = product elements are left to the usual rules
  const r = await complete(instruction); if (typeof r?.text !== 'string') return r;
  let o = null; for (const c of [r.text, (r.text.match(/\{[\s\S]*\}/) ?? [])[0]]) { if (!c) continue; try { const v = JSON.parse(c); if (v && typeof v === 'object' && !Array.isArray(v)) { o = v; break; } } catch { /* next */ } }
  if (!o || 'patches' in o) return r;
  const scrubbed = scrubComposition(o, { permissions }); const before = log.length; const value = withoutProductElements(scrubbed.value, sheet, log); if (!scrubbed.removed.length && log.length === before) return r;
  log.push(...scrubbed.removed); return { ...r, text: JSON.stringify(value) };
};

/** One ask, at most one repair that names the refusals (the same loop as the other direction calls). Returns { value, history, normalised } (normalised: what Nordla took out before validation).
 *  form SHORT (the route's form): the answer is the short scene; the software then chooses the framing and completes the record with the concept's own words (framing.js). form LONG: the previous full answer (kept for the archived runs). */
export const runAdComposition = async ({ complete, kit, brief, productFacts, verifiedFacts, placementOptions, sceneProhibitions, concept = null, revision = null, photo = true, facts = null, profile = null, sheet = null, maxRepairs = 1, permissions = [], form = AD_FORM.LONG, scrubProductElements = true }) => {
  const normalised = []; const short = form === AD_FORM.SHORT;
  const common = { complete: scrubbing(complete, permissions, normalised, scrubProductElements ? sheet : null), stage: 'DIRECTION_AD', maxRepairs, keepUnrefused: true, patchRepair: true, collectAll: true };
  if (!short) {
    const r = await ask({ ...common, spec: adSpec(kit, verifiedFacts.map((f) => f.id), { concept: Boolean(concept), permissions }),
      build: (hints, previous, patchFields) => adInstruction({ kit, brief, productFacts, verifiedFacts, placementOptions, sceneProhibitions, concept, revision, photo, hints, previous, permissions, patchFields }),
      violationsOf: (v) => adViolations(v, { placementOptions, facts, profile, sheet, permissions, displayed: displayedFiguresOf(productFacts), verifiedFacts }) });
    return { ...r, normalised };
  }
  const shortRules = (v) => {
    const out = []; let full = v;
    const f = chooseFraming({ placementOptions, textZone: v?.text_reserve?.zone, phone: { presence: v?.phone_presence, position: v?.phone_position } });
    if (!f.ok) out.push({ field: f.field, rule: f.code, message: f.message }); else full = { ...v, product_position: f.option.product_position, product_framing: f.option.product_framing };
    return [...out, ...adViolations(full, { placementOptions, facts, profile, sheet, permissions, displayed: displayedFiguresOf(productFacts), verifiedFacts, short: true })];
  };
  const r = await ask({ ...common, spec: adShortSpec(kit, { permissions }),
    build: (hints, previous, patchFields) => adInstructionShort({ kit, brief, productFacts, verifiedFacts, sceneProhibitions, concept, revision, photo, hints, previous, permissions, patchFields }),
    violationsOf: shortRules });
  return { ...r, value: finalizeShort(r.value, { concept, placementOptions }), normalised };
};
