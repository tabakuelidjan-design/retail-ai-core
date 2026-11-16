// CREATIVE ROUTE IN THREE CALLS (2026-11-08): UNDERSTAND the product and the public, then DEVELOP proposals from rapprochements Nordla itself found, then COMPARE them (blind, with other proposals) and retain one.
// The retained proposal goes to the composition WORD FOR WORD (ad-composition.js, option `concept`). The code writes no scene, no theme, no example and adds no lexical guard: only the structure of the answers is checked.
// The ranking of the model and the field concept_conserve are INDICATIONS for the owner, never proof of quality or of fidelity to the idea.
import { createHash } from 'node:crypto';
import { obj, text, word, list, renderContract } from '../creative-brain/contract.js';
import { STARTING_POINTS } from './ad-composition.js';
import { PRODUCT_UNCHANGEABLE, VERIFIED_FACTS_ONLY } from './concept-creation.js';
import { ask } from './reference-direction.js';
import { compositionConstraints, sceneLimitViolations, unverifiedDurationIn } from './scene-permissions.js';
import { headlineProblem } from './stage-contract.js';

export const ROUTE_MAX_OUTPUT_TOKENS = Object.freeze({ understand: 2400, develop: 4800, develop_grid: 5300, develop_patch: 2400, compare: 3000, compare_grid: 3500 }); // develop_patch: a repair answers a few patches, not four proposals // develop and compare carry three and two more fields per proposal (use situation, brief fit)
const free = (max) => text({ max, fit: true });
export const BASIS = Object.freeze({ VERIFIED_FACT: 'VERIFIED_FACT', VISIBLE_ON_PHOTO: 'VISIBLE_ON_PHOTO', INTERPRETATION: 'INTERPRETATION' });
export const LEVEL = Object.freeze({ VERY_LOW: 'VERY_LOW', LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', VERY_HIGH: 'VERY_HIGH' });
export const CRITERIA = Object.freeze(['harmony', 'relevance', 'desirability', 'originality', 'feasibility']);
// BRIEF FIT (2026-11-14): does the scene, as a customer would SEE it, answer what the brief asks (a real need, why the product is carried, what its own cable brings)? Judged on the visible description only, never on the title or the argument.
/** The comparator's own pointer to a described detail (scene_alone.detail), checked against the proposal's text as the comparator saw it: the detail must be a passage of idea, visible_cues or cable_role (copied, or all its words present there)
 *  and the customer must understand something from it. Nordla judges nothing about the scene: it only checks that the comparator pointed at something that is written. Returns null when the answer has no grid (replayed pre-grid answers). */
export function groundedReason(score, shown) {
  const sa = score?.scene_alone; if (!sa) return null;
  const norm = (t) => String(t ?? '').normalize('NFC').replace(/[‘’ʼ]/g, "'").replace(/[«»"“”]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const detail = norm(sa.detail); const understands = norm(sa.customer_understands); const why = [];
  if (!detail || /^aucune?(?![\p{L}])/u.test(detail)) why.push('NO_DETAIL_POINTED_AT');
  else {
    const scene = norm([shown?.idea, shown?.visible_cues, shown?.cable_role].join(' '));
    const words = detail.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4); const present = words.filter((w) => scene.includes(w)).length;
    if (!(scene.includes(detail) || (words.length >= 2 && present / words.length >= 0.8))) why.push('DETAIL_NOT_IN_THE_SCENE_TEXT');
  }
  if (!understands || /^aucune?(?![\p{L}])/u.test(understands)) why.push('NOTHING_UNDERSTOOD_FROM_IT');
  if (sa.detail_shows !== DETAIL_SHOWS.THE_NEED) why.push('THE_DETAIL_DOES_NOT_SHOW_A_NEED');
  return { ok: why.length === 0, why, detail: sa.detail, customer_understands: sa.customer_understands };
}
// what the pointed-at detail shows: the customer's NEED (what they lack or risk in that moment) is the only answer that lets a proposal be retained; a feature of the product or the setting shows the product or the place, not the need
export const DETAIL_SHOWS = Object.freeze({ THE_NEED: 'THE_NEED', A_FEATURE_OF_THE_PRODUCT: 'A_FEATURE_OF_THE_PRODUCT', THE_SETTING: 'THE_SETTING', NOTHING: 'NOTHING' });
export const NONE_CHOICE = 'NONE'; // a valid answer of the comparison: no proposal answers the brief; the route stops before the composition
export const CUES = Object.freeze({ ALL: 'ALL', SOME: 'SOME', NONE: 'NONE' });
export const BRIEF_FIT_MIN = 'HIGH'; // a proposal is retained only at HIGH or VERY_HIGH
// NORDLA_GRID_OPTIONAL=1 is for the tests that REPLAY answers written before the grid existed: the grid fields are then optional. A real run never sets it.
const gridOptional = () => process.env.NORDLA_GRID_OPTIONAL === '1';
export const HEADLINE_ADDS = Object.freeze({ ADDS_A_REASON: 'ADDS_A_REASON', REPEATS_A_VISIBLE_FEATURE: 'REPEATS_A_VISIBLE_FEATURE', VAGUE: 'VAGUE' });
// THE JUDGMENT GRID (owner's feedback, 2026-11-15): three questions asked BEFORE an idea is retained. The examples are examples of JUDGMENT written without any product-specific scene: they say what was valued and what was penalised, never what to draw.
export const JUDGMENT_QUESTIONS = Object.freeze([
  '1. In this situation, what does the customer NEED, and which VISIBLE detail makes them understand that need?',
  '2. What does this product bring them in this precise moment, and what can the customer understand by looking at the scene ALONE (no text)?',
  '3. Once the headline is read, does it ADD a reason to buy, or does it repeat a characteristic that the scene already shows?',
]);
export const JUDGMENT_EXAMPLES = Object.freeze([
  'Example 1, rated 5/10 by the owner (a scene of use for an accessory that serves a phone): the situation was believable and the need could be guessed, but the secondary object stood too far from the product for the link between them to be read at a glance; the light was flat and the colours of the decor dull, so the true colour of the product did not stand out; the headline restated a characteristic of the product instead of speaking to the person. Penalised: a link that has to be searched for, a flat light, a headline that only restates a characteristic.',
  'Example 2, rated 6.5/10 by the owner (a calm local place with well-composed everyday objects): the place and the composition were pleasant and local, but nothing in the scene showed a need: the objects beside the product could accompany any other product, so the scene alone said only "a calm table"; the headline named a characteristic already visible in the image and its promise of comfort stayed vague. Valued: a local place and a careful composition. Penalised: a scene in which no detail shows what the product relieves, and a headline that adds no reason to buy. A beautiful composition or a local place improves an idea that already answers the three questions; it never replaces them.',
  'These are examples of how to JUDGE, for any product: do not reproduce their places, their objects or their words.',
]);
const LEVEL_ORDER = ['VERY_LOW', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'];
const atLeast = (level, min) => LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(min);

export const understandSpec = () => obj({
  characteristics: list(obj({ characteristic: free(200), basis: word(BASIS), why_it_can_interest: free(200) }), { min: 3, max: 6 }),
  public_needs: list(free(200), { min: 3, max: 5 }),
  standing: free(300),
  rapprochements: list(obj({ domain: free(60), link: free(220) }), { min: 6, max: 8 }),
});

export const developSpec = (factIds = [], { grid = false } = {}) => obj({
  proposals: list(obj({
    name: free(60), from_rapprochement: free(80), starting_point: word(STARTING_POINTS), need: free(200), idea: free(520), visible_cues: free(300), cable_role: free(240), link_to_product: free(260), speaks_to_the_public: free(260), headline: free(100),
    ...(grid ? { product_brings: free(170), scene_alone_reading: free(150), headline_adds: free(140) } : {}),
    supported_by: list(word(Object.fromEntries(factIds.map((i) => [i, i]))), { min: 0, max: 4 }),
  }, { optional: grid && gridOptional() ? ['product_brings', 'scene_alone_reading', 'headline_adds'] : [] }), { min: 4, max: 4 }),
  how_they_differ: free(260),
});

export const compareSpec = (ids, { grid = false } = {}) => {
  const level = word(LEVEL); const idWord = word(Object.fromEntries(ids.map((i) => [i, i]))); const choiceWord = word(Object.fromEntries([...ids, NONE_CHOICE].map((i) => [i, i])));
  return obj({
    // grid: the scene ALONE is judged first (scene_alone is written before anything else), the headline after (with_headline, last)
    scores: list(obj({ id: idWord, ...(grid ? { scene_alone: obj({ need_clear: level, benefit_clear: level, reading: free(150), detail: free(170), detail_shows: word(DETAIL_SHOWS), customer_understands: free(150) }) } : {}), ...Object.fromEntries(CRITERIA.map((c) => [c, level])), cues_in_scene: word(CUES), brief_fit: level, note: free(240), ...(grid ? { with_headline: obj({ adds: word(HEADLINE_ADDS), note: free(100) }) } : {}) }, { optional: grid && gridOptional() ? ['scene_alone', 'with_headline'] : [] }), { min: ids.length, max: ids.length }),
    choice: choiceWord, why_this_one: free(400), ...(grid ? { headline_direction: free(160) } : {}),
  }, { optional: grid && gridOptional() ? ['headline_direction'] : [] });
};

/** The sentence about the photograph: true when an image is sent with the call (trials), false in the delivered text-only path (the product is then described by its facts and by what is visible on the photograph). */
export const SEEN = (photo) => (photo ? 'You are shown the PHOTOGRAPH of one product (image labelled PRODUCT)' : 'You are NOT shown a photograph: the product is described by product_facts (its measured appearance and what is visible on the photograph) and by verified_facts');
const OUTPUT_LINE = 'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):';

/** The limits the composition will enforce, told to the DEVELOP and COMPARE steps (scene-permissions.js builds them, campaign permissions included). */
export const COMPOSITION_CONSTRAINTS = compositionConstraints();

export function understandInstruction({ brief, productFacts, verifiedFacts, photo = true, hints = [] }) {
  const system = [
    'You are the Nordla creative director. ' + SEEN(photo) + ' and a campaign defined in the brief. This is the first step: you UNDERSTAND, you do not imagine any scene yet. Write everything in French (fr-BE).',
    'characteristics: three to six characteristics of THIS product that an advertisement can use (its function, its technology, its form, its colours, its materials and finish, its details, its use). For each, basis says where it comes from: VERIFIED_FACT (it is in verified_facts), VISIBLE_ON_PHOTO (you see it on the photograph) or INTERPRETATION (you infer it). why_it_can_interest says what it can mean for the public of the campaign.',
    'public_needs: what the public of the brief needs, wants or feels in relation to this kind of product, as needs, desires and feelings. Do not describe where or when they live: places are not needs. Do not deduce tastes from an age alone; when brief.audience is null, the public is not defined: say so and do not invent one.',
    'standing: what, if anything, sets this product apart in its category. Do NOT claim that it is unique, the best or exceptional: an advertisement can make a product desirable without claiming that. You may answer that nothing sets it apart and that its appeal lies elsewhere. Never compare it to a named competitor.',
    'rapprochements: six to eight rapprochements between this product (or what it gives its owner) and something else, each from a DIFFERENT field of human experience or of the world (domain), with the link in one sentence. Two rapprochements from the same field are not different. Do not describe a scene: a rapprochement is a way of looking at the product.',
    VERIFIED_FACTS_ONLY,
    OUTPUT_LINE, ...renderContract(understandSpec(), 'answer'),
    'Be concise: respect the lengths, an answer that is cut off is refused.',
    ...(hints.length ? ['A previous answer was refused for these reasons: fix exactly these, keep the rest:', ...hints.map((h) => `- ${h}`)] : []),
  ].join('\n');
  return { system, user: JSON.stringify({ brief, product_facts: productFacts, verified_facts: verifiedFacts }), max_output_tokens: ROUTE_MAX_OUTPUT_TOKENS.understand };
}

export function developInstruction({ brief, productFacts, verifiedFacts, sceneProhibitions = [], understanding, photo = true, hints = [], permissions = [], previous = null, patchFields = null, grid = false }) {
  const spec = developSpec(verifiedFacts.map((f) => f.id), { grid });
  const system = [
    'You are the Nordla creative director. ' + SEEN(photo) + ' and what you understood of it and of the public (user.understanding). Write everything in French (fr-BE), in the voice of the brand (brief.merchant_voice).',
    'Each proposal STARTS from a situation of use. Pick, in user.understanding.public_needs, the need that the proposal shows, and imagine a situation in which the public has that need and this product answers it (several proposals may show different needs, or different situations of the same need). The rapprochements of the understanding may help to stage a situation, as a way of looking at it; they are never the starting point, and a proposal with no situation of use does not answer the brief. Develop each into a complete commercial proposal: the situation and decor, the place and the presentation of the product, the light and the mood, and the headline you imagine. The four proposals must be different in kind from each other (a different need or a different situation), not in colour or in material, and none is required to be unusual: a familiar universe is allowed if the idea is strong.',
    'Fill for EACH proposal: need (the need of the public, taken from public_needs, that this proposal shows, in your words); visible_cues (what a customer would SEE in the scene, without reading any text or headline, that lets them understand this need: EVERY cue must also be written in idea, because the comparison checks the cues against the scene description and a cue that is only listed here does not count); cable_role (what the product\'s own integrated cable shows, or lets the customer understand, in this situation: it may stay unplugged if the scene makes clear what it is for here). Write AUCUN in visible_cues or in cable_role when nothing visible shows it: an honest AUCUN is better than a cue that is not in the scene.',
    ...(grid ? ['BEFORE you keep an idea, it must answer three questions (the comparison asks them again, on the scene alone and then with the headline): ' + JUDGMENT_QUESTIONS.join(' ') + ' Fill for EACH proposal: product_brings (what the product brings the customer in that precise moment, as a relief or a gain for the person, not as a characteristic); scene_alone_reading (what a customer who sees ONLY the scene, with no text, understands: if it is only a mood or a place, say so); headline_adds (the reason to buy that the headline adds and that the scene does not already show; write REPETE when the headline only restates a visible characteristic, and then rewrite the headline until it speaks to the person: a lived moment or the relief the product brings). A beautiful place or a careful composition makes a proposal better only if it already answers the questions.', ...JUDGMENT_EXAMPLES] : []),
    'Each proposal also says from which rapprochement it comes (or that it comes from none), why it comes from THIS product, and why it speaks to the public of the campaign.',
    'headline: the headline you imagine is reused as written by the composition: in French (fr-BE), at most 8 words and 60 characters, no figure, exact on the facts. A longer headline is refused here.',
    compositionConstraints({ permissions }), PRODUCT_UNCHANGEABLE, VERIFIED_FACTS_ONLY,
    patchFields ? 'The fields of the answer are described by these lines; a patch value must respect the line of its field:' : OUTPUT_LINE, ...renderContract(spec, 'answer'),
    'how_they_differ says how the four differ in kind. Be concise: respect the lengths, an answer that is cut off is refused.',
    ...(hints.length ? ['A previous answer was refused for these reasons: fix exactly these, keep the rest:', ...hints.map((h) => `- ${h}`)] : []),
    ...(hints.length && previous && patchFields ? ['THIS IS A CORRECTION OF A REFUSED ANSWER (user.previous_answer). Answer with patches ONLY, for the fields named in the refusals above and in the answer format at the end: you do not return the other fields, you do not change them and you do not touch the other fields of the same proposal, Nordla keeps them exactly as they are. A refused headline is rewritten in French, at most 8 words and 60 characters, no figure, no number, and no promise that the verified facts do not give (a duration, an autonomy, a number of charges); a refused text keeps its meaning.'] : []),
  ].join('\n');
  return { system, user: JSON.stringify({ brief, product_facts: productFacts, verified_facts: verifiedFacts, scene_prohibitions: sceneProhibitions, understanding, ...(hints.length && previous && patchFields ? { previous_answer: previous } : {}) }), max_output_tokens: patchFields ? ROUTE_MAX_OUTPUT_TOKENS.develop_patch : (grid ? ROUTE_MAX_OUTPUT_TOKENS.develop_grid : ROUTE_MAX_OUTPUT_TOKENS.develop) };
}

export function compareInstruction({ brief, productFacts, sceneProhibitions = [], proposals, photo = true, hints = [], permissions = [], grid = false, headlines = [] }) {
  const ids = proposals.map((p) => p.id); const spec = compareSpec(ids, { grid });
  const system = [
    'You are the Nordla creative director. ' + SEEN(photo) + ' and several advertising proposals for one campaign (user.proposals). You do not know where they come from. Write everything in French (fr-BE).',
    'Compare them for real. For EACH proposal give a level (VERY_LOW, LOW, MEDIUM, HIGH, VERY_HIGH) on five criteria: harmony (does the universe belong with THIS product: its form, colours, materials, function), relevance (does it speak to the public and the objective of the brief), desirability (would it make the product desirable and give a reason to look at it or to buy it), originality (is it a fresh idea rather than the first scene that comes to mind) and feasibility (can it be made with the real product placed as photographed and never transformed, in a light compatible with the photograph, within scene_prohibitions). Use the whole scale: do not give every proposal the same levels, and do not be generous; all of them may be weak.',
    'Do not prefer a proposal, and do not penalise one, because of the kind of universe it uses (a familiar place can be strong if the idea is strong; an unusual one can be empty). Judge the idea and how much it shows of the product.',
    'Two more judgments for EACH proposal, made ONLY on what a customer would SEE: the scene description (idea), the need it shows (need), the cues announced (visible_cues) and the role of the cable (cable_role). The name, the headline and the arguments of a proposal are not shown to you: nothing written about a scene can make up for what the scene does not show, and a generic decor stays generic whatever it is called. cues_in_scene: ALL when every cue announced in visible_cues is really written in idea, SOME when only part of them is, NONE when none is or when visible_cues is AUCUN. brief_fit: how well the scene, as a customer would see it, answers what the brief asks (brief.objective and brief.audience): a real need of the public is staged, the place and the objects help to understand why one carries this product, and the benefit of its integrated cable can be understood. A decor that could present any other object just as well does not answer the brief, and brief_fit cannot be above LOW when cues_in_scene is NONE.',
    'Then retain the ONE proposal you consider the strongest for this campaign (choice) and say why (why_this_one), comparing it with the closest alternative, but ONLY if its brief_fit is HIGH or VERY_HIGH. If no proposal answers the brief, choice is NONE and why_this_one says why, in terms of what a customer would see: NONE is a valid and expected answer, never choose a proposal to avoid it. note gives, for each proposal, its main strength or weakness in one sentence.',
    ...(grid ? ["THE GRID. Judge in TWO STEPS, in this order. STEP 1, the scene ALONE (user.proposals; the headlines are not part of the scene): for EACH proposal write scene_alone FIRST, before any other field: need_clear (is the customer's need understood from a visible detail of the scene), benefit_clear (does the scene alone let a customer understand what the product brings them in that moment) and reading (in one sentence, what a customer who sees only this scene understands; if it is only a mood or a place, write that)), then detail: the ONE passage of the proposal's own text (idea, visible_cues or cable_role), copied word for word, that describes a visible detail showing the need or what the product brings, and customer_understands: what the customer understands from that detail (the relief or gain for the person). A table, a cup, a notebook, a phone near the product or the mere presence of the cable are not such a detail, and a headline is not part of the scene: when no passage of the text describes one, write AUCUN in detail and in customer_understands. Then detail_shows says what that passage shows: THE_NEED (what the customer lacks or risks in that moment, visible in the scene), A_FEATURE_OF_THE_PRODUCT (the product, its parts or its readiness), THE_SETTING (the place, the objects around) or NOTHING. A proposal can be retained ONLY when detail_shows is THE_NEED; otherwise the choice is NONE, even if it is the only proposal. A proposal whose scene alone shows neither a need nor a benefit cannot have a brief_fit above MEDIUM, whatever the beauty of its composition or the charm of its place. A beautiful composition or a local place may raise an idea that already answers the questions; it never replaces the answers. STEP 2, the scene WITH its headline (user.headlines, one per proposal): with_headline.adds is ADDS_A_REASON when the headline gives a reason to buy that the scene does not already show, REPEATS_A_VISIBLE_FEATURE when it restates a characteristic the scene or the product already shows, VAGUE when it promises a feeling without a reason. The headline never raises brief_fit: it is judged after, and separately. headline_direction: when the retained proposal's headline is not ADDS_A_REASON, say in one sentence what reason or relief for the person its headline should express (do not write the headline); otherwise write AUCUN.", ...(proposals.length === 1 ? ['ONLY ONE PROPOSAL IS LEFT (the others were withheld before this comparison). Being the only one is NOT a reason to retain it: judge it exactly as you would among several. Retain it only if its scene ALONE shows a concrete need AND what the product brings (need_clear and benefit_clear both HIGH or VERY_HIGH); otherwise the choice is NONE, which is a valid and expected answer.'] : []), ...JUDGMENT_QUESTIONS, ...JUDGMENT_EXAMPLES] : []),
    compositionConstraints({ permissions }), PRODUCT_UNCHANGEABLE,
    OUTPUT_LINE, ...renderContract(spec, 'answer'),
    'Be concise: respect the lengths, an answer that is cut off is refused.',
    ...(hints.length ? ['A previous answer was refused for these reasons: fix exactly these, keep the rest:', ...hints.map((h) => `- ${h}`)] : []),
  ].join('\n');
  return { system, user: JSON.stringify({ brief, product_facts: productFacts, scene_prohibitions: sceneProhibitions, proposals, ...(grid ? { headlines } : {}) }), max_output_tokens: grid ? ROUTE_MAX_OUTPUT_TOKENS.compare_grid : ROUTE_MAX_OUTPUT_TOKENS.compare };
}

/** What the DEVELOP call receives of an earlier understanding when that understanding contained claims that no verified fact supports: only what is an INTERPRETATION by Nordla (the needs of the public and the rapprochements), word for word and labelled.
 *  Facts stay in verified_facts, observations in the photograph and product_facts.visible_on_the_photograph. The characteristics, their "why it interests" and the "standing" are NOT passed on (they carried claims such as several charges, a day of autonomy, laptop compatibility). Nothing is rewritten. */
export const interpretationsOnly = (understanding) => ({
  status: 'INTERPRETATIONS_OF_AN_EARLIER_STEP_NOT_FACTS',
  rule: 'These are interpretations by Nordla, not facts and not promises. The facts are verified_facts. The observations are the photograph and product_facts.visible_on_the_photograph (not confirmed by the owner).',
  public_needs: understanding.public_needs,
  rapprochements: understanding.rapprochements,
});

/** The fields every proposal shows in the comparison: the same shape for the new proposals and for the archived concepts (taken word for word). */
// the comparison sees the scene and what it shows, NOT the name, the headline or the arguments (they cannot make up for a generic decor)
export const SHOWN = Object.freeze(['starting_point', 'idea', 'need', 'visible_cues', 'cable_role', 'supported_by', 'product_brings']); // product_brings exists only on proposals written under the grid
export const shownProposal = (id, p) => ({ id, ...Object.fromEntries(SHOWN.map((k) => [k, p[k]])) });

/** A deterministic order that hides the origin: the same inputs always give the same order, and it does not follow new / archived. */
export function blindList(entries, seed) {
  const key = (e) => createHash('sha256').update(`${seed}|${e.origin}|${e.index}`).digest('hex');
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : 1)).map((e, i) => ({ ...e, id: `P${i + 1}` }));
}

export const runUnderstand = ({ complete, brief, productFacts, verifiedFacts, photo = true, maxRepairs = 1 }) => ask({
  complete, stage: 'IDEAS_UNDERSTAND', spec: understandSpec(), maxRepairs,
  build: (hints) => understandInstruction({ brief, productFacts, verifiedFacts, photo, hints }), violationsOf: () => [],
});

/** What the proposals must already respect at the step where they are written (so a defect is repaired where it is born, not after the choice): the headline rules and the device limit, in the proposal's OWN texts. */
export const AD_DEVELOP_REPAIRS = 2; // the first repair, and a second and LAST one, each limited to the fields still refused
const figureIn = (t) => (String(t ?? '').match(/\d[\d\s.,]*\d|\d/) ?? [''])[0];
export const developViolations = (v, { permissions = [], verifiedFacts = [] } = {}) => {
  const out = [];
  (v?.proposals ?? []).forEach((p, i) => {
    const hp = headlineProblem(p?.headline, { personalisation_offered: false });
    if (hp) out.push({ field: `proposals[${i}].headline`, rule: hp, passage: hp === 'HEADLINE_HAS_A_FIGURE' ? `${p.headline} (figure: "${figureIn(p.headline)}")` : p.headline, message: `the headline is refused (${hp}): at most 8 words and 60 characters, no figure, no invented claim` });
    const dur = unverifiedDurationIn(p?.headline, verifiedFacts);
    if (dur) out.push({ field: `proposals[${i}].headline`, rule: 'HEADLINE_PROMISES_A_DURATION', passage: p.headline, message: `the headline promises "${dur}": no verified fact gives a duration or an autonomy` });
    // the scene texts only: a need may speak of devices ("three devices to charge")
    for (const f of ['idea', 'visible_cues', 'cable_role']) for (const v of sceneLimitViolations(p?.[f], { permissions })) out.push({ field: `proposals[${i}].${f}`, rule: v.rule, passage: v.passage, message: `${f}: ${v.message}` });
  });
  return out;
};

// enforce (default false): the headline limit and the scene limits are held at this step only when the caller asks (the AD route does); the trial scripts keep what they always had
export const runDevelop = ({ complete, brief, productFacts, verifiedFacts, sceneProhibitions, understanding, photo = true, maxRepairs = 1, permissions = [], enforce = false, grid = enforce }) => ask({
  // patchRepair (only when enforced, i.e. the AD route): a repair answers patches for the refused fields ONLY, and only those fields (no sibling text of the same proposal)
  complete, stage: 'IDEAS_DEVELOP', spec: developSpec(verifiedFacts.map((f) => f.id), { grid }), maxRepairs, patchRepair: enforce, patchSiblings: false, collectAll: enforce,
  build: (hints, previous, patchFields) => developInstruction({ brief, productFacts, verifiedFacts, sceneProhibitions, understanding, photo, hints, permissions, previous, patchFields, grid }), violationsOf: (v) => (enforce ? developViolations(v, { permissions, verifiedFacts }) : []),
});

/** Structure only: each id is scored exactly once. */
export const runCompare = ({ complete, brief, productFacts, sceneProhibitions, proposals, photo = true, maxRepairs = 1, permissions = [], grid = false, headlines = [] }) => ask({
  complete, stage: 'IDEAS_COMPARE', spec: compareSpec(proposals.map((p) => p.id), { grid }), maxRepairs,
  build: (hints) => compareInstruction({ brief, productFacts, sceneProhibitions, proposals, photo, hints, permissions, grid, headlines }),
  violationsOf: (v) => {
    const seen = new Map(); for (const s of v?.scores ?? []) seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
    const out = proposals.filter((p) => seen.get(p.id) !== 1).map((p) => ({ field: 'scores', rule: 'EVERY_PROPOSAL_SCORED_ONCE', message: `scores must contain ${p.id} exactly once` }));
    if (out.length) return out;
    // structural consistency of the model's OWN judgments (nothing lexical, no artistic rule): the cues must be in the scene for a fit above LOW, and only a fitting proposal may be retained
    for (const s of v.scores) if (s.cues_in_scene === CUES.NONE && atLeast(s.brief_fit, 'MEDIUM')) out.push({ field: 'scores', rule: 'BRIEF_FIT_WITHOUT_CUES', message: `${s.id}: brief_fit cannot be above LOW when cues_in_scene is NONE` });
    // grid: a scene whose OWN reading shows neither the need nor the benefit cannot be a good fit (the model's own judgments, nothing lexical)
    if (grid) for (const s of v.scores) { const sa = s.scene_alone; if (sa && atLeast(s.brief_fit, 'HIGH') && (!atLeast(sa.need_clear, 'MEDIUM') || !atLeast(sa.benefit_clear, 'MEDIUM'))) out.push({ field: 'scores', rule: 'FIT_WITHOUT_A_READABLE_NEED', message: `${s.id}: brief_fit cannot be HIGH or more when the scene alone does not show the need (need_clear ${sa.need_clear}) or what the product brings (benefit_clear ${sa.benefit_clear}): lower brief_fit, or lower the choice to NONE` }); }
    // grid, ONE proposal left: being alone is not a reason to retain it; it needs a concrete reason, readable from the scene alone, or the answer is NONE
    if (grid && proposals.length === 1 && v.choice !== NONE_CHOICE) { const sa = v.scores[0]?.scene_alone; if (sa && (!atLeast(sa.need_clear, 'HIGH') || !atLeast(sa.benefit_clear, 'HIGH'))) out.push({ field: 'choice', rule: 'LONE_PROPOSAL_WITHOUT_A_CONCRETE_REASON', message: `${v.scores[0].id} is the only proposal left and its scene alone does not show both the need (need_clear ${sa.need_clear}) and what the product brings (benefit_clear ${sa.benefit_clear}) at HIGH or more: being alone is not a reason to retain it, the choice is NONE` }); }
    const fitting = v.scores.filter((s) => atLeast(s.brief_fit, BRIEF_FIT_MIN));
    if (v.choice === NONE_CHOICE) { if (fitting.length) out.push({ field: 'choice', rule: 'NONE_WITH_A_FITTING_PROPOSAL', message: `choice is NONE but ${fitting.map((s) => s.id).join(', ')} has brief_fit ${BRIEF_FIT_MIN} or more: retain one, or lower the brief_fit you gave` }); }
    else { const fit = v.scores.find((s) => s.id === v.choice)?.brief_fit; if (!atLeast(fit, BRIEF_FIT_MIN)) out.push({ field: 'choice', rule: 'CHOICE_BELOW_BRIEF_FIT', message: `${v.choice} has brief_fit ${fit}: a proposal is retained only when its brief_fit is ${BRIEF_FIT_MIN} or VERY_HIGH, otherwise the choice is NONE` }); }
    return out;
  },
});
