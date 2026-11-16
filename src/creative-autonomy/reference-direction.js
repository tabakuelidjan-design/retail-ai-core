// DIRECTION BY REFERENCES (path A of the method test, 2026-11-08): the art director is a MULTIMODAL model that SEES approved reference images (and contrast examples with the owner's reasons) and the product photograph, READS what makes
// the references strong (not their content), then COMPOSES a scene for each product: the place and scale of the product, the structure, the light, a compact text reserve, and the roles the brand palette plays in it.
//   READ     one call: the references, each with the owner's note, its measured colours and its kind (POSITIVE: a quality to learn; NEGATIVE: a failure the owner refused, with the reason). Output: a structured reading, stored and inspectable.
//   COMPOSE  one call per product: the product photograph + the positive references + the stored reading + the measured placement options + the brand palette kit. Output: the scene sections (the same as the global completion) and the
//            provenance of every decision: what was borrowed from a reference, what was adapted to THIS product, what was rejected, and WHY, plus the roles given to the palette colours.
// The palette is FREE inside the brand's kit: any colour may take any role in any scene; the director assigns colours to surfaces and justifies the choice. The code writes no artistic content and adds no rule specific to a scene.
import { obj, text, word, list, renderContract } from '../creative-brain/contract.js';
import { askAndNormalize } from '../creative-brain/model-port.js';
import { unrefusedChanges } from './repair-integrity.js';
import { patchInstruction, patchable, mergeScoped } from './repair-patch.js';
import { validateSpec, collectSpecViolations } from '../creative-brain/contract.js';
import { pathOfField } from './repair-patch.js';
import { BrainError } from '../creative-brain/validation.js';
import { SCENE_GLOBAL_SPEC, sceneGlobalViolations, GLOBAL_LIMITS } from './scene-clarify.js';
import { visibleSceneViolations } from './visible-scene-check.js';
import { SCENE_ZONE } from '../creative-brain/art-direction.js';
import { assertElementsDoNotNameProduct } from './product-visible-request.js';
import { collectArtDirectionGuard } from './brand-guard.js';

export const REFERENCE_KINDS = Object.freeze({ POSITIVE: 'POSITIVE', NEGATIVE: 'NEGATIVE' });
export const PALETTE_ROLES = Object.freeze({ DOMINANT: 'DOMINANT', SECONDARY: 'SECONDARY', ACCENT: 'ACCENT', LIGHT_TINT: 'LIGHT_TINT', SHADOW_TINT: 'SHADOW_TINT' });
export const DECISIONS = Object.freeze({ COMPOSITION: 'COMPOSITION', PRODUCT_PLACEMENT: 'PRODUCT_PLACEMENT', LIGHT: 'LIGHT', PALETTE: 'PALETTE', TEXT_RESERVE: 'TEXT_RESERVE' });
// the first real READ stopped because the answer hit a 2 600-token cap in the middle of its synthesis (execution defect, not a creative result): the caps leave room for a complete answer
export const DIRECTION_MAX_OUTPUT_TOKENS = Object.freeze({ read: 4800, compose: 4500 });
const free = (max) => text({ max, fit: true });

/** The kit of a brand: { colours: { NAME: { hex, note } }, neutrals: [..] }. The NAMES are the vocabulary of the contract; the director may give any colour any role. */
export const paletteVocabulary = (kit) => Object.freeze(Object.fromEntries(Object.keys(kit.colours).map((n) => [n, n])));

export const REFERENCE_READING_SPEC = obj({
  references: list(obj({
    ref_id: text({ max: 40 }), planes: free(400), light: free(400), materials: free(400), restraint: free(350), product_role: free(350), palette_reading: free(350),
    transferable: free(400), to_ignore: free(350), why_it_fails: free(400),
  }), { min: 1, max: 6 }),
  synthesis: free(700), // the limits are the instruction's own: an answer at the contract's maximum (5 references) is about 19 000 characters, which fits the output cap with a margin
});

/** The composition: the scene sections of the global completion (idea, product position and scale, structure, setting, materials, atmosphere, light, text reserve, elements, resolution) + the provenance of every decision. */
export const compositionSpec = (kit, { family = null } = {}) => obj({
  ...SCENE_GLOBAL_SPEC.fields,
  // PRODUCT_VISIBLE route: the generic substitute lexicon would refuse the bare word "product" (a plinth that carries it); visible-scene-check.js flags what really is a substitute, a second product or an added cable
  elements: list(obj({ zone: word(SCENE_ZONE), element: text({ max: GLOBAL_LIMITS.element, geometry: true, fit: true }) }), { min: 0, max: GLOBAL_LIMITS.max_elements }),
  product_reading: free(400),
  ...(family
    ? { family_used: obj({ family_id: text({ max: 40 }), kept: free(400), departed: free(400), why_not_the_same_scene_for_another_product: free(300) }) }
    : { reference_used: obj({ ref_id: text({ max: 40 }), borrowed: free(400), adapted: free(400), rejected: free(300) }) }),
  palette_roles: list(obj({ colour: word(paletteVocabulary(kit)), role: word(PALETTE_ROLES), surfaces: free(200) }), { min: 2, max: 6 }),
  choices: list(obj({ decision: word(DECISIONS), why: free(400) }), { min: 5, max: 5 }),
});

// ---- the instructions
const refLine = (r) => ({ ref_id: r.ref_id, kind: r.kind, owner_note: r.owner_note, measured_colours: r.measured_colours });

export function readingInstruction({ references, hints = [] }) {
  const system = [
    'You are the Nordla art director. You are shown reference images, each labelled with its ref_id, the OWNER\'s note and the colours measured on it. POSITIVE references are images whose quality the owner wants Nordla to learn; NEGATIVE references are images the owner REFUSED, with the reason.',
    'Your task is to READ them: understand WHAT MAKES a positive reference strong (the qualities that transfer to any product) and the VISUAL CAUSE of each failure; never to copy a reference\'s content (its subject, its objects, its architecture).',
    'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):',
    ...renderContract(REFERENCE_READING_SPEC, 'answer'),
    'For EVERY reference, in the order given, with its ref_id:',
    '- planes: how the depth is organised (foreground, middle ground, background) and what each plane holds.',
    '- light: its source, its direction, its quality (hard or veiled, haze, beams), what it reveals and what stays in shadow.',
    '- materials: what the surfaces are made of and how their grain reads.',
    '- restraint: how much of the image is calm, and where.',
    '- product_role: how the subject is presented in the scene (and how it is integrated: contact, shadow, scale, light agreement).',
    '- palette_reading: the colours (use the measured colours as facts) and the role each plays.',
    '- transferable: for a POSITIVE reference, the qualities that carry over to a different product and a different scene. For a NEGATIVE reference write "not applicable".',
    '- to_ignore: for a POSITIVE reference, the content that must NOT be reused (its objects, its subject). For a NEGATIVE reference, what is acceptable in it.',
    '- why_it_fails: for a NEGATIVE reference, the visual cause of the owner\'s refusal, connected to the owner\'s note. For a POSITIVE reference write "not applicable".',
    'synthesis: what the positive references have in common that makes them strong, and what the negative ones share that makes them weak, in a few sentences a director could apply to any product.',
    'Be concise: every field at most about 350 characters (two or three sentences), the synthesis at most 700; an answer that is cut off is refused.',
    ...(hints.length ? ['A previous answer was refused for these reasons: fix exactly these, keep the rest:', ...hints.map((h) => `- ${h}`)] : []),
  ].join('\n');
  return { system, user: JSON.stringify({ references: references.map(refLine) }), max_output_tokens: DIRECTION_MAX_OUTPUT_TOKENS.read };
}

export function compositionInstruction({ kit, reading, referencesShown, productImageLabel, objective, productFacts, placementOptions, sceneProhibitions = [], hints = [], family = null, previous = [], avoid = [] }) {
  const spec = compositionSpec(kit, { family });
  const system = [
    ...(family ? [
      'You are the Nordla art director. You are shown the PHOTOGRAPH of one product (image labelled ' + productImageLabel + ').',
      'You COMPOSE the scene for THIS product. A visual FAMILY is given as a STARTING POINT: its principles of composition, light and material, and what may vary. You may depart from it where the product asks for it, and you say in what you departed. The scene must be one you would not have made for another product.',
    ] : [
      'You are the Nordla art director. You are shown the PHOTOGRAPH of one product (image labelled ' + productImageLabel + ') and the POSITIVE reference images (labelled with their ref_id). A stored READING of the references tells you what makes them strong and what to ignore.',
      'You COMPOSE the scene for THIS product: you borrow QUALITIES from a reference (the organisation of depth, the quality and direction of the light, the credibility of the materials, the restraint) and you adapt them to what this product is; you never reuse the reference\'s subject, objects or architecture as they are. The scene must be one you would not have made for another product.',
    ]),
    'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):',
    ...renderContract(spec, 'answer'),
    ...(family?.series ? [`SERIES: you make scene ${family.series.index} of ${family.series.of} for the SAME product photograph. The scenes of a series must be genuinely different from each other by their ORGANISATION (how the space is built), their MATERIALS and their LIGHT (its quality and mood, always compatible with the soft, even light of the packshot). already_chosen lists the scenes already made: do not repeat their organisation, their materials or their light. avoid_content lists contents that must not appear in any scene of the series. In family_used.departed say how this scene differs from the earlier ones (or, for the first, what makes it a clear choice).`] : []),
    'WHAT IS FIXED (facts of the product photograph, not decisions): its perspective (the camera sees it slightly from above) and the side its light comes from (product_facts.lit_side_of_the_photograph): the light of your scene comes from that side.',
    ...(family ? ['The QUALITY of your light (soft or hard, wide or narrow, how contrasted) must also agree with the way the photograph is lit: look at it, the product is not re-lit. In choices.LIGHT say what you saw in the photograph and how your light agrees with it.',
      'Judge, on the photograph and on the colours you chose, how the product reads in your composition (its outline against what is behind it and under it, by value, hue or an edge of light), and say it in choices.PALETTE. Do not assume it from the colour names.'] : []),
    'WHAT YOU DECIDE: the place and scale of the product (placement_options gives the MEASURED box of each combination and the free space on each side; one that does not fit is not allowed), the structure and the setting, the light, a COMPACT reserve for the title (a corner or a short band) and the colours.',
    'PALETTE: the brand kit is given with palette_kit. You are FREE inside it: any colour may take any role (DOMINANT, SECONDARY, ACCENT, LIGHT_TINT, SHADOW_TINT) in any scene; give each colour you use a role and the SURFACES it covers, and justify the choice. Use only colours of the kit. Beige, cream and sand are never used.',
    'EXPLAIN every decision: product_reading says what this product is (form, finish, colour, scale, character) and what that asks of the scene; ' + (family ? 'family_used says which family you started from (its family_id), what you kept, in what you departed, and what in this scene would not suit another product' : 'reference_used says which reference you drew from, what you borrowed, what you adapted to this product, what you rejected') + '; choices explains, for each of COMPOSITION, PRODUCT_PLACEMENT, LIGHT, PALETTE and TEXT_RESERVE, WHY.',
    'Be concise: every explanatory field at most about 350 characters; an answer that is cut off is refused.',
    'The idea, setting, atmosphere, materials, light, structure, elements and text_reserve go to the image generator as written: write them in English, with NO digit (relative words, spelled numbers), describing exactly the elements that are present and nothing absent; each element once.',
    'THE PRODUCT IN THE SCENE: it is the real photograph, never redrawn. A scene element may say what the product rests on or the shadow it casts, but never names its kind, stands in for it or adds a second one. You may describe the product\'s OWN cable exactly as photographed (say "its integrated cable"); never add a cable, never change how it lies (no arranging, draping, coiling or leaving the frame), and never promise charging without cable or wireless: the verified benefit is that it carries its own cables. The text_reserve describes a ZONE only, never a title to draw (no quoted text, no typeface). If you have nothing to resolve, say so in resolution.',
    ...(hints.length ? ['A previous answer was refused for these reasons: fix exactly these, keep the rest:', ...hints.map((h) => `- ${h}`)] : []),
  ].join('\n');
  const user = JSON.stringify({ objective, ...(family?.series ? { already_chosen: previous.map((c, i) => ({ scene: i + 1, idea: c.idea, structure: c.structure, setting: c.setting, materials: c.materials, light: c.light, palette: (c.palette_roles ?? []).map((x) => `${x.colour} ${x.role}`) })), avoid_content: avoid } : {}), ...(family ? { family: { family_id: family.id, ...family.principles } } : { reading, references_shown: referencesShown.map((r) => ({ ref_id: r.ref_id, owner_note: r.owner_note })) }), palette_kit: kit, placement_options: placementOptions, product_facts: productFacts, scene_prohibitions: sceneProhibitions });
  return { system, user, max_output_tokens: DIRECTION_MAX_OUTPUT_TOKENS.compose };
}

// ---- what is DETECTED (generic checks only; no rule specific to a scene)
export function readingViolations(reading, { references }) {
  const out = []; const want = references.map((r) => r.ref_id); const got = (reading?.references ?? []).map((r) => r.ref_id);
  for (const id of want) if (!got.includes(id)) out.push({ field: 'references', rule: 'REFERENCE_NOT_READ', message: `the reference ${id} has no reading: read every reference, in order` });
  for (const id of got) if (!want.includes(id)) out.push({ field: 'references', rule: 'UNKNOWN_REFERENCE', message: `${id} is not one of the references shown (${want.join(', ')})` });
  return out;
}

export function compositionViolations(c, { placementOptions, shownIds = [], facts = null, profile = null, sheet = null, familyId = null }) {
  const out = [...sceneGlobalViolations(c, { placementOptions, structureRules: false, cableRule: false }), ...visibleSceneViolations(c)];
  if (familyId) { if (c?.family_used?.family_id !== familyId) out.push({ field: 'family_used.family_id', rule: 'UNKNOWN_FAMILY', message: `family_used.family_id must be ${familyId}` }); }
  else if (!shownIds.includes(c?.reference_used?.ref_id)) out.push({ field: 'reference_used.ref_id', rule: 'UNKNOWN_REFERENCE', message: `reference_used.ref_id must be one of the references shown (${shownIds.join(', ')})` });
  const decided = new Set((c?.choices ?? []).map((x) => x.decision)); for (const d of Object.values(DECISIONS)) if (!decided.has(d)) out.push({ field: 'choices', rule: 'DECISION_NOT_EXPLAINED', message: `choices must explain ${d}` });
  if (!(c?.palette_roles ?? []).some((p) => p.role === PALETTE_ROLES.DOMINANT)) out.push({ field: 'palette_roles', rule: 'NO_DOMINANT_COLOUR', message: 'palette_roles must give one colour the DOMINANT role' });
  if (profile && facts) { // the brand's own forbidden words and the invented capabilities, through the existing guard (the generic rule of the brand, applied to the texts the generator receives)
    const art = { atmosphere: c.atmosphere, material_language: c.materials, lighting_intent: c.light, rationale: c.idea, narrative_elements: (c.elements ?? []).map((e) => ({ element: e.element, reason: 'direction', zone: e.zone })), permitted_secondary_elements: [], forbidden_decorative_noise: ['hands'] };
    for (const v of collectArtDirectionGuard(art, facts, profile, { productVisible: false })) if (v.detail?.problem !== 'GENERATOR_TEXT_NOT_ENGLISH') out.push({ field: v.field, rule: v.detail?.problem ?? v.code, message: v.message });
  }
  if (sheet && !out.length) { try { assertElementsDoNotNameProduct({ narrative_elements: c.elements, permitted_secondary_elements: [] }, sheet); } catch (e) { out.push({ field: 'elements', rule: e.code ?? 'ELEMENT_NAMES_THE_PRODUCT', message: e.message }); } }
  return out;
}

// ALL REFUSALS AT ONCE (collectAll): a contract refusal (a digit in a text, a missing key...) stops validation at its FIRST error, so the rule checks that come after (the cable, the device, the product named in an element) never ran and appeared one repair later
// (real run cr-bc12c30da975). With collectAll the refused answer is read again: every contract error and every rule violation is reported together, each with its exact passage, and the refused answer is kept so the repair can be PATCHES.
const rawAnswerOf = (e) => { const t = e?.evidence?.raw_answer; if (typeof t !== 'string') return null; for (const c of [t, (t.match(/\{[\s\S]*\}/) ?? [])[0]]) { if (!c) continue; try { const o = JSON.parse(c); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* next */ } } return null; };
function allRefusalsOf({ e, spec, stage, violationsOf }) {
  if (/MALFORMED|PORT_FAILED/.test(String(e.code))) return null; const raw = rawAnswerOf(e); if (!raw) return null;
  const prefix = `${stage.toLowerCase()}.`; const strip = (f) => (String(f).startsWith(prefix) ? String(f).slice(prefix.length) : String(f)); const at = (path) => { try { return pathOfField(path).reduce((x, k) => x?.[k], raw); } catch { return undefined; } };
  const out = []; const seen = new Set(); const push = (v) => { const k = `${v.field}|${v.rule}`; if (!seen.has(k)) { seen.add(k); out.push(v); } };
  for (const sv of collectSpecViolations(spec, raw, stage.toLowerCase())) {
    const field = strip(sv.field); const val = at(field); const digit = /digit|unit|colour code/i.test(sv.message ?? '');
    push({ field, rule: sv.code, ...(typeof val === 'string' ? { passage: val.slice(0, 160) } : {}), message: `${String(sv.message ?? '').replace(prefix, '')}${digit ? ': write any distance or size in words (for example "just beside"), never as a number or a unit' : ''}` });
  }
  try { for (const v of violationsOf(raw)) push(v); } catch { /* the rule checks need a complete answer: the contract errors above are then the whole list */ }
  return out.length ? { violations: out, raw } : null;
}

export async function ask({ complete, build, stage, spec, violationsOf, maxRepairs, keepUnrefused = false, patchRepair = false, patchSiblings = true, collectAll = false }) {
  const history = []; let hints = []; let previous = null; let refused = [];
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    let value = null; let violations = []; let completeNow = complete; let patchReject = null; let repairForm = null; let refusedRaw = null;
    // PATCH REPAIR: the model answers only the refused fields; Nordla applies them to the refused answer (every other field is conserved by construction). The builder is told the fields (third argument) so that its repair
    // instruction asks for patches ONLY: no "return the complete answer" sentence, no full-answer format.
    const all = [...new Set(refused)]; const fields = all.filter((f) => !all.some((g) => g !== f && (f.startsWith(`${g}.`) || f.startsWith(`${g}[`)))); // a refused list is patched as a whole, not item by item as well
    const patching = patchRepair && previous && attempt > 0 && patchable(previous, fields);
    let instruction = build(hints, previous, patching ? fields : null);
    if (patching) {
      instruction = { ...instruction, system: instruction.system + patchInstruction(fields, patchSiblings, true) };
      completeNow = async (i) => { const r = await complete(i); const m = mergeScoped(previous, r.text, fields, { siblings: patchSiblings }); if (m.applied) repairForm = m.form; if (!m.applied) { patchReject = m.reject; throw new BrainError('REPAIR_REJECTED', 'the repair does not follow the patch contract', 'repair', m.reject); } return { ...r, text: m.text }; };
    }
    try {
      ({ value } = await askAndNormalize({ complete: completeNow, instruction, stage, spec, normalize: (raw) => validateSpec(spec, raw, stage.toLowerCase()) }));
      violations = violationsOf(value);
      // a repair that was told to change only the refused fields is checked: any other field that moved refuses the repair (the code does not rely on the instruction alone)
      if (keepUnrefused && previous && attempt > 0) for (const p of unrefusedChanges(previous, value, refused)) violations.push({ field: p, rule: 'REPAIR_CHANGED_UNREFUSED_FIELD', message: `${p} was not refused and must stay as it was, but the repair changed it` });
    } catch (e) { if (!(e instanceof BrainError)) throw e; if (collectAll && !patchReject) { const all = allRefusalsOf({ e, spec, stage, violationsOf }); if (all) { refusedRaw = all.raw; violations = all.violations; } } if (!violations.length) violations = patchReject ? [{ field: 'repair', rule: patchReject.code ?? 'REPAIR_REJECTED', message: `the repair was rejected and nothing of it was applied (${patchReject.code ?? 'REJECTED'} ${JSON.stringify(patchReject.detail ?? {}).slice(0, 160)}): it must answer exactly the refused fields` }] : [{ field: e.field ?? 'answer', rule: e.code, message: e.message }]; }
    history.push({ attempt, violations, ...(repairForm ? { repair_form: repairForm } : {}) }); // 'PATCHES' = the model followed the patch format; 'WHOLE_ANSWER' = the FALLBACK (only the flagged fields were extracted)
    if (!violations.length) return { value, history };
    // the refused fields of the NEXT repair are the ones still refused by this answer; a patch rejected as a whole (field "repair") keeps the previous answer and the same fields
    const named = violations.filter((v) => v.field !== 'repair' && v.rule !== 'REPAIR_CHANGED_UNREFUSED_FIELD').map((v) => v.field); if (named.length || !patchReject) refused = named;
    // a violation that carries its passage is cited with the EXACT passage and the rule
    hints = violations.map((v) => (v.passage ? `${v.field} [${v.rule}] — passage: « ${v.passage} » — ${v.message}` : `${v.field}: ${v.message}`)); previous = value ?? refusedRaw ?? previous; // the refused answer, for builders that correct it instead of starting again
  }
  throw Object.assign(new Error(`${stage}_REFUSED: ${history.at(-1).violations.map((v) => `${v.field} ${v.rule}`).join('; ')}`), { code: `${stage}_REFUSED`, history });
}

/** READ: one ask, at most one repair that names the refusals. */
export const runReading = ({ complete, references, maxRepairs = 1 }) => ask({ complete, stage: 'DIRECTION_READ', spec: REFERENCE_READING_SPEC, maxRepairs, build: (hints) => readingInstruction({ references, hints }), violationsOf: (v) => readingViolations(v, { references }) });

/** COMPOSE one product: one ask, at most one repair. `complete` already carries the images of this call. */
export const runComposition = ({ complete, kit, reading, referencesShown = [], productImageLabel, objective, productFacts, placementOptions, sceneProhibitions, facts = null, profile = null, sheet = null, maxRepairs = 1, family = null, previous = [], avoid = [] }) => ask({
  complete, stage: 'DIRECTION_COMPOSE', spec: compositionSpec(kit, { family }), maxRepairs,
  build: (hints) => compositionInstruction({ kit, reading, referencesShown, productImageLabel, objective, productFacts, placementOptions, sceneProhibitions, hints, family, previous, avoid }),
  violationsOf: (v) => compositionViolations(v, { placementOptions, shownIds: referencesShown.map((r) => r.ref_id), facts, profile, sheet, familyId: family?.id ?? null }),
});

export { GLOBAL_LIMITS };
