#!/usr/bin/env node
// Nordla Créateur — ACCEPTANCE DEMONSTRATION of the creative reasoning and execution SPECIFICATION for three different HABB products.
//   node scripts/creator-acceptance.mjs [out.md]
// HONEST SCOPE. The concepts, evaluations, art directions and stages below were WRITTEN BY CLAUDE IN THE ENGINEERING SESSION OF 2026-11-02 as a
// stand-in for Nordla's text provider (no provider call is authorised). Everything after that is NORDLA'S REAL CODE, deterministic: the distinctness
// guard, the tenant brand guard (HABB's rules from its configuration), invented-capability checks, the selection decision, the art-direction and stage
// contracts, and the exact image-model request and prompt. No image is rendered here: the catalogue photos are not reachable from this workspace and no
// real provider may run (NDR-D02). Technical and creative quality of a FINISHED image are therefore NOT_MEASURABLE in this document.
// Product facts: read-only from HABB's Shopify (Admin API), 2026-11-02. Nothing in Shopify was changed.
import { writeFileSync } from 'node:fs';
import { normalizeConceptSet } from '../src/creative-brain/concept.js';
import { normalizeEvaluation, selectConcept, decideConcept } from '../src/creative-brain/concept-selection.js';
import { normalizeArtDirection } from '../src/creative-brain/art-direction.js';
import { normalizeStage } from '../src/creative-autonomy/stage-contract.js';
import { assertConceptsBrandRules, assertArtDirectionGuard, assertStageGuard } from '../src/creative-autonomy/brand-guard.js';
import { loadMerchantCreativeBrand, resolveBrandProfile } from '../src/creative-autonomy/brand-profile.js';
import { buildSceneRequest } from '../src/creative-autonomy/scene-engine.js';
import { buildProductEditPrompt } from '../src/marketing-creative/alibaba/qwen-image-edit.js';

const HABB = resolveBrandProfile(loadMerchantCreativeBrand('habb'));
const C = (criteria) => criteria.map(([criterion, outcome, evidence]) => ({ criterion, outcome, evidence }));
const ALL = ['CONCEPT_STRENGTH', 'RELEVANCE_TO_BRIEF', 'EMOTIONAL_RESONANCE', 'PRODUCT_RELATIONSHIP', 'DISTINCTIVENESS', 'FEASIBILITY', 'BRAND_COMPATIBILITY', 'COMMERCIAL_CLARITY', 'NARRATIVE_COHESION', 'GENERIC_RISK'];
const evalOf = (verdicts) => C(ALL.map((k) => [k, verdicts[k]?.[0] ?? 'MEETS', verdicts[k]?.[1] ?? `${k.toLowerCase().replace(/_/g, ' ')}: holds for this concept on the verified facts.`]));

const PRODUCTS = [
  {
    key: 'batterie', title: 'Batterie externe Mini 10 000 mAh – 22,5W', variant: 'Noir', price: '29,00 €',
    ids: { product: 'gid://shopify/Product/15500510986588', variant: 'gid://shopify/ProductVariant/57117887168860', media: 'gid://shopify/MediaImage/69241642025308', image: '800×799 WebP, linked to the Noir variant only' },
    description: 'La Remax MH136 offre 10 000 mAh dans un format compact, avec un câble USB-C intégré et une charge rapide jusqu’à 22,5W. Son écran numérique et son cordon tour de cou la rendent particulièrement pratique pour les journées actives, les voyages et les recharges d’appoint.',
    personalisation_offered: false,
    truth: 'A compact black power bank with its own USB-C cable, a small digital display and a neck lanyard: it travels ON the person, not in a bag.',
    opportunity: 'Not “more mAh” (a spec, and a figure the headline may not carry) but the moment a phone is about to die far from any socket, and the answer is already hanging around the neck.',
    concepts: [
      { central_idea: 'The rescue was hanging around the neck all along: when a phone nears empty far from any socket, the lanyard pack answers with its own short cable.',
        visual_metaphor: 'A late platform bench where one phone screen fades, while a small black pack on its lanyard rests beside it, cable already reaching out.',
        story: 'Someone waits for the last connection home; the phone is fading; nothing to search for, the help was worn all evening.',
        emotional_intent: 'Relief without drama, the calm of being already prepared.', product_role: 'HERO_OF_THE_STORY', message_role: 'EMBEDDED_IN_THE_STORY',
        memory_hook: 'The cable already reaching out from the pack on the bench.', distinctiveness_reason: 'It sells the lanyard and the integrated cable, the two things a generic battery advert never shows.',
        risks: ['a night platform could read as gloomy', 'the phone could steal attention from the pack'] },
      { central_idea: 'A whole travelling day packs into one pocket: the charge comes along like keys and a ticket, never as one more bag to remember.',
        visual_metaphor: 'A neat row of a day’s essentials on a café table, keys, a folded train ticket, sunglasses, with the black pack closing the line.',
        story: 'Before leaving, everything needed for the day is laid out once; the pack takes its place among the things nobody forgets.',
        emotional_intent: 'Lightness, the ease of a day without worry.', product_role: 'HERO_OF_THE_STORY', message_role: 'FOLLOWS',
        memory_hook: 'The pack lined up with keys and ticket as an equal.', distinctiveness_reason: 'It places a tech accessory among daily objects instead of a studio void.',
        risks: ['an essentials row is a familiar lifestyle cliché', 'small objects could crowd the product'] },
      { central_idea: 'The small display replaces an anxious guess with calm certainty: you read how much charge remains before you ever need it.',
        visual_metaphor: 'A dark hallway where the only light comes from the pack’s display, like a lighthouse telling a sailor exactly where the coast is.',
        story: 'Before going out, a glance at the pack tells the whole evening is covered; no more counting bars on a phone.',
        emotional_intent: 'Control and quiet confidence.', product_role: 'HERO_OF_THE_STORY', message_role: 'EMBEDDED_IN_THE_STORY',
        memory_hook: 'The display as the only light in the hallway.', distinctiveness_reason: 'It turns a minor feature, the display, into the whole story.',
        risks: ['the display lit as the only source would mean editing the product photo', 'a dark hallway can look generic'] },
    ],
    verdicts: [
      { FEASIBILITY: ['PARTIAL', 'The fading phone must stay implied: Nordla refuses any device in a generated scene, so the story is carried by the empty platform and the lamp.'] },
      { DISTINCTIVENESS: ['PARTIAL', 'An essentials row on a table is a common lifestyle composition; only the lanyard detail is specific.'], GENERIC_RISK: ['PARTIAL', 'Flat lifestyle arrangements are frequent in accessory adverts.'], FEASIBILITY: ['PARTIAL', 'The product photo stands upright; a top-down flat lay would need a different photograph.'] },
      { FEASIBILITY: ['FAILS', 'The idea needs the display to emit light; the real product photo is never edited, so its display cannot be lit.'] },
    ],
    art: { atmosphere: 'A quiet late-evening platform, cool and empty, with one patient pause before the last train.', depth_model: 'LAYERED_DEPTH', material_language: 'Worn platform concrete, a painted steel bench, matte black plastic of the pack.',
      lighting_intent: 'A single cool overhead platform light from the left, soft falloff into the dark beyond the bench.', visual_rhythm: 'STILL', product_relationship: 'GROUNDED_IN_SCENE', text_image_relationship: 'TEXT_IN_CALM_ZONES',
      realism: 'PHOTOREALISTIC', emotional_temperature: 'COOL', visual_tension: 'MEDIUM', negative_space_strategy: 'ASYMMETRIC_RESERVE',
      narrative_elements: [{ element: 'a folded paper ticket and a cold coffee cup left on the bench', reason: 'waiting for the last connection home, far from any socket', zone: 'MIDGROUND' },
        { element: 'an empty platform edge receding into the dark', reason: 'far from any socket, waiting for the last connection home', zone: 'BACKGROUND' }],
      permitted_secondary_elements: [], forbidden_decorative_noise: ['neon reflections', 'crowds'],
      rationale: 'Cool, empty and calm so the pack and its cable read as the quiet rescue the concept promises.' },
    stage: { backdrop: 'WALL_AND_FLOOR', backdrop_tone: 'CHARCOAL', floor_finish: 'SATIN', key_light: { kind: 'SPOT', side: 'LEFT', intensity: 'MEDIUM', temperature: 'COOL', purpose: 'a lone platform lamp isolating the pack on the bench' },
      accent_lights: [{ kind: 'RIM', side: 'BACK', intensity: 'LOW', temperature: 'COOL', purpose: 'separate the black pack from the dark platform' }],
      camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'RIGHT_THIRD' }, props: [], headline: 'Le secours était déjà autour du cou', text_placement: 'LEFT_COLUMN', show_price: 'YES',
      rationale: 'A cool, empty platform with one lamp: the pack sits where the phone fades, so the lanyard reads as the help that was worn all evening.',
      wanted_but_not_available: ['a steel platform bench as the surface', 'rails receding into the dark'] },
  },
  {
    key: 'coffret', title: 'Coffret cadeau Premium avec poignée et ruban', variant: 'Rouge Cramoisi / M', price: '14,90 €',
    ids: { product: 'gid://shopify/Product/15547356250460', variant: 'gid://shopify/ProductVariant/57444461773148', media: 'gid://shopify/MediaImage/69640105689436', image: '1480×1062 PNG, linked to Rouge Cramoisi S, M AND L (one image for three sizes)' },
    description: 'Un coffret cadeau Premium avec poignée et ruban sélectionné pour mettre en valeur cadeaux, accessoires et créations avec une présentation soignée, prête à offrir.',
    personalisation_offered: false,
    truth: 'A crimson gift box with a handle and a ribbon: the presentation that makes any object ready to give.',
    opportunity: 'The box is the first thing the receiver sees. The story is the second before opening, not the object inside (which Nordla must not invent).',
    concepts: [
      { central_idea: 'The present is already given on the way there: the handle lets the box travel through the city like a promise everyone can see.',
        visual_metaphor: 'A crimson box carried by its handle along a rainy evening street, its colour the only vivid note among grey facades.',
        story: 'Someone walks to a door with the box swinging by its handle; passers-by know a moment is about to happen.',
        emotional_intent: 'Anticipation shared with the street.', product_role: 'HERO_OF_THE_STORY', message_role: 'EMBEDDED_IN_THE_STORY',
        memory_hook: 'The crimson box swinging through a grey street.', distinctiveness_reason: 'It makes the handle, a practical detail, the reason the gift is seen.',
        risks: ['it needs a hand holding the box', 'rain could dull the crimson'] },
      { central_idea: 'The truest second of a present comes before the ribbon is pulled, while the box is still closed and anything is possible.',
        visual_metaphor: 'A closed crimson box on the edge of a dark table in a sharp shaft of light, the room behind it holding its breath.',
        story: 'The box has been set down in front of someone; nobody has touched the ribbon yet; the whole room waits.',
        emotional_intent: 'Suspense, tenderness held back.', product_role: 'HERO_OF_THE_STORY', message_role: 'EMBEDDED_IN_THE_STORY',
        memory_hook: 'The untouched ribbon in a single shaft of light.', distinctiveness_reason: 'It sells the packaging for what packaging truly gives: the moment before the gift.',
        risks: ['a dark room could read as cold', 'the shaft of light must not cross the box'] },
      { central_idea: 'Whatever you made or chose, the presentation makes it look intended: one crimson box gives a small object the dignity of a real gift.',
        visual_metaphor: 'A workbench of small handmade objects, slightly ordinary, with one closed crimson box standing apart, finished and ready.',
        story: 'Among the bits of a maker’s week, one thing has been boxed; it is the one that will be given.',
        emotional_intent: 'Pride in a gesture made properly.', product_role: 'HERO_OF_THE_STORY', message_role: 'FOLLOWS',
        memory_hook: 'One finished box among unfinished things.', distinctiveness_reason: 'It speaks to makers and small businesses, HABB’s own customers.',
        risks: ['the handmade objects could compete', 'a workbench is a familiar setting'] },
    ],
    verdicts: [
      { FEASIBILITY: ['FAILS', 'The story needs a hand carrying the box; people and hands are excluded from Nordla’s generated scenes.'] },
      {},
      { DISTINCTIVENESS: ['PARTIAL', 'Workbench settings are common for handmade goods.'], GENERIC_RISK: ['PARTIAL', 'Maker-bench imagery is widespread.'] },
    ],
    art: { atmosphere: 'A hushed dark room in the second before a gift is opened, every surface still.', depth_model: 'SHALLOW_LAYERS', material_language: 'Dark oiled table wood, matte crimson card, satin ribbon.',
      lighting_intent: 'One narrow shaft of light from above-left landing on the box and the table edge, the room falling into soft dark.', visual_rhythm: 'STILL', product_relationship: 'GROUNDED_IN_SCENE', text_image_relationship: 'TEXT_IN_CALM_ZONES',
      realism: 'PHOTOREALISTIC', emotional_temperature: 'CONTRASTED', visual_tension: 'HIGH', negative_space_strategy: 'SURROUNDING_REST',
      narrative_elements: [{ element: 'the edge of a dark table in sharp light', reason: 'the gift has been set down in front of someone: the moment before opening', zone: 'FOREGROUND' },
        { element: 'an empty chair back half lost in shadow', reason: 'the room waits; nobody has touched the ribbon yet', zone: 'BACKGROUND' }],
      permitted_secondary_elements: [], forbidden_decorative_noise: ['confetti', 'balloons', 'sparkles'],
      rationale: 'One shaft of light and a waiting room turn the closed gift into the suspense the concept is about.' },
    stage: { backdrop: 'WALL_AND_FLOOR', backdrop_tone: 'DEEP_BLACK', floor_finish: 'SATIN', key_light: { kind: 'SLIT_SHEET', side: 'TOP', intensity: 'HIGH', temperature: 'NEUTRAL', purpose: 'a single shaft of light on the closed box, the room in shadow' },
      accent_lights: [], camera: { height: 'LOW', framing: 'CLOSE', product_position: 'LEFT_THIRD' }, props: [], headline: 'La seconde avant le ruban', text_placement: 'RIGHT_COLUMN', show_price: 'YES',
      rationale: 'A low, close view in one shaft of light keeps the closed box at the centre of the waiting room, so the untouched ribbon carries the suspense.',
      wanted_but_not_available: ['dark oiled table wood as the surface', 'an empty chair back in shadow'] },
  },
  {
    key: 'cadre', title: 'Cadre Photo Ardoise Bois', variant: null, price: '45,90 €',
    ids: { product: 'gid://shopify/Product/15547356971356', variant: 'gid://shopify/ProductVariant/57398932210012', media: 'gid://shopify/MediaImage/69719818043740', image: '1402×1122 PNG (file name “cyclisme”): product-level image, the only one' },
    description: 'Un support personnalisable avec votre photo et votre texte, préparé avec soin dans notre atelier à Namur.',
    personalisation_offered: true,
    truth: 'A slate-and-wood photo support personalised with the customer’s own photo and text, prepared in HABB’s Namur workshop.',
    opportunity: 'A memory leaves the phone gallery and takes a place in the home; made locally, one at a time (both verified in the sheet).',
    concepts: [
      { central_idea: 'A photo that lived in a phone gallery finally gets a place at home, printed on slate and wood so it is met every morning.',
        visual_metaphor: 'An entry shelf at dawn where the frame leans against the wall, catching the first light, a set of keys dropped beside it.',
        story: 'Every morning on the way out, the same memory is there by the door, no longer buried under thousands of screenshots.',
        emotional_intent: 'Tenderness in the everyday.', product_role: 'HERO_OF_THE_STORY', message_role: 'EMBEDDED_IN_THE_STORY',
        memory_hook: 'The frame by the door in the first light.', distinctiveness_reason: 'It shows the frame where it lives, not on a white studio sweep.',
        risks: ['an entry shelf can look staged', 'the keys must stay secondary'] },
      { central_idea: 'Each frame is prepared one at a time in the Namur workshop for one memory, which no mass-made frame can offer.',
        visual_metaphor: 'The workshop bench just after printing, the finished frame standing upright among offcuts of slate, the city roofs through a window.',
        story: 'One order, one memory, one maker: the frame waits on the bench, ready to be wrapped for its owner.',
        emotional_intent: 'Trust in local care.', product_role: 'PROOF_OF_THE_STORY', message_role: 'FOLLOWS',
        memory_hook: 'The single frame standing among slate offcuts.', distinctiveness_reason: 'Only a local workshop can tell this; the sheet states it.',
        risks: ['offcuts could look messy', 'a workshop can feel industrial'] },
      { central_idea: 'Slate and wood give a photograph weight and texture: the memory becomes something you can touch instead of scroll past.',
        visual_metaphor: 'A raking side light across the slate surface revealing its grain, like the relief of a map of a place once walked.',
        story: 'A hand would stop on it; the eye does already, following the grain under the image.',
        emotional_intent: 'Presence and permanence.', product_role: 'HERO_OF_THE_STORY', message_role: 'FOLLOWS',
        memory_hook: 'The grain of the slate in raking light.', distinctiveness_reason: 'It sells the material, the one thing a print on paper lacks.',
        risks: ['texture alone can feel cold', 'raking light could hide the printed photo'] },
    ],
    verdicts: [
      {},
      { DISTINCTIVENESS: ['PARTIAL', 'Workshop scenes are common for handmade goods, even if the Namur claim is verified.'], GENERIC_RISK: ['PARTIAL', 'Maker-bench imagery is widespread.'] },
      { RELEVANCE_TO_BRIEF: ['PARTIAL', 'Material texture is secondary to the personal memory the customer buys.'], EMOTIONAL_RESONANCE: ['PARTIAL', 'Texture is felt less than a memory placed in the home.'] },
    ],
    art: { atmosphere: 'A calm entry at dawn, the house still asleep, the first light reaching the shelf by the door.', depth_model: 'LAYERED_DEPTH', material_language: 'Pale painted plaster wall, a simple oak shelf, slate and wood of the frame.',
      lighting_intent: 'Low soft morning light from the right through an unseen window, long gentle shadows across the wall.', visual_rhythm: 'MEASURED', product_relationship: 'GROUNDED_IN_SCENE', text_image_relationship: 'TEXT_IN_CALM_ZONES',
      realism: 'PHOTOREALISTIC', emotional_temperature: 'WARM', visual_tension: 'LOW', negative_space_strategy: 'ASYMMETRIC_RESERVE',
      narrative_elements: [{ element: 'a set of keys dropped on the shelf beside the frame', reason: 'every morning on the way out, the memory is met by the door', zone: 'FOREGROUND' },
        { element: 'the edge of a front door slightly ajar, soft daylight beyond', reason: 'on the way out, the frame takes its place at home', zone: 'BACKGROUND' }],
      permitted_secondary_elements: [], forbidden_decorative_noise: ['dried flowers', 'candles', 'string lights'],
      rationale: 'A real entry at dawn shows the frame where a memory now lives, met every morning, not stored in a phone.' },
    stage: { backdrop: 'WALL_AND_FLOOR', backdrop_tone: 'WHITE', floor_finish: 'MATTE', key_light: { kind: 'SOFTBOX', side: 'RIGHT', intensity: 'LOW', temperature: 'WARM', purpose: 'low morning light reaching the frame by the door' },
      accent_lights: [], camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'RIGHT_THIRD' }, props: [], headline: 'Ta photo, enfin à sa place', text_placement: 'LEFT_COLUMN', show_price: 'YES',
      rationale: 'Soft morning light on a pale entry wall places the personalised frame where the memory is met every day, with calm space for the words.',
      wanted_but_not_available: ['an oak shelf as the surface instead of a floor', 'a front door ajar with daylight'] },
  },
];

const lines = ['# Nordla Créateur — acceptance demonstration on three HABB products', '',
  '**Scope, stated first.** The concepts, evaluations, art directions and stages were **written by Claude (engineering session, 2026-11-02) as a stand-in for Nordla\'s text provider** — no provider may run (NDR-D02). Everything else below is **Nordla\'s real code, deterministic**: distinctness guard, HABB\'s brand rules (from its tenant configuration), invented-capability checks, the selection decision, the art-direction and stage contracts, and the exact image request and prompt. **No image is rendered**: the catalogue photos are not reachable from this workspace and no real provider may run. The visual result, its technical quality and its creative quality are **NOT_MEASURABLE here**; a real-provider benchmark must verify them.', '',
  'Product facts: read-only from HABB\'s Shopify on 2026-11-02 (nothing changed).', ''];
for (const p of PRODUCTS) {
  const facts = { product_title: p.title, variant: p.variant, description: p.description, personalisation_offered: p.personalisation_offered };
  const concepts = normalizeConceptSet(p.concepts); // distinctness + content guard (Nordla)
  assertConceptsBrandRules(concepts, facts, HABB); // HABB's taste + invented capabilities (Nordla)
  const evaluations = concepts.map((c, i) => normalizeEvaluation({ concept_id: c.concept_id, criteria: evalOf(p.verdicts[i]) }));
  const selection = selectConcept({ concepts, evaluations });
  const chosenId = selection.selected_concept_id ?? selection.concept_id ?? null;
  const chosen = concepts.find((c) => c.concept_id === chosenId) ?? null;
  lines.push(`## ${p.title}${p.variant ? ` — ${p.variant}` : ''} (${p.price})`, '',
    `Shopify: product \`${p.ids.product}\`, variant \`${p.ids.variant}\`, image \`${p.ids.media}\` (${p.ids.image}).`, '',
    `**Product truth.** ${p.truth}`, '', `**Creative opportunity.** ${p.opportunity}`, '', '### Three concepts and the selection', '',
    '| # | Central idea | Decision (Nordla, from the criteria) | Decisive evidence |', '| --- | --- | --- | --- |');
  concepts.forEach((c, i) => {
    const d = decideConcept(evaluations[i]); const ev = evaluations[i].criteria.filter((x) => x.outcome !== 'MEETS').map((x) => `${x.criterion} ${x.outcome}: ${x.evidence}`).join(' ') || 'every criterion MEETS';
    lines.push(`| ${i + 1} | ${c.central_idea} | ${d}${c.concept_id === chosenId ? ' → **selected**' : ''} | ${ev} |`);
  });
  lines.push('', `Selection outcome: \`${selection.outcome ?? selection.decision ?? JSON.stringify(Object.keys(selection))}\`.`, '');
  if (!chosen) { lines.push('No concept selected.', ''); continue; }
  const art = normalizeArtDirection(p.art, { concept: chosen }); assertArtDirectionGuard(art, facts, HABB);
  const stage = normalizeStage(p.stage, { concept: chosen, personalisation_offered: p.personalisation_offered, profile: HABB }); assertStageGuard(stage, facts, HABB);
  const req = buildSceneRequest({ concept: chosen, artDirection: art, stage, width: 1080, height: 1350, n: 3, profile: HABB });
  const prompt = buildProductEditPrompt(req);
  lines.push('### Chosen art direction (validated)', '', `- Atmosphere: ${art.atmosphere}`, `- Materials: ${art.material_language}`, `- Light: ${art.lighting_intent}`,
    `- Depth / space: ${art.depth_model} / ${art.negative_space_strategy}; emotional temperature ${art.emotional_temperature}, tension ${art.visual_tension}`,
    ...art.narrative_elements.map((e) => `- ${e.zone}: ${e.element} — *${e.reason}*`), '',
    '### Exact scene specification (validated stage, HABB profile)', '', '```json', JSON.stringify({ backdrop: stage.backdrop, backdrop_tone: stage.backdrop_tone, floor_finish: stage.floor_finish, key_light: stage.key_light, accent_lights: stage.accent_lights, camera: stage.camera, headline: stage.headline, text_placement: stage.text_placement, show_price: stage.show_price }, null, 1), '```', '',
    `Image-model prompt Nordla would send (${prompt.prompt.length} characters):`, '', `> ${prompt.prompt}`, '', `Negative prompt (${prompt.negative_prompt.length}/500 characters): \`${prompt.negative_prompt}\`${prompt.negative_dropped.length ? ` — dropped and reported: ${prompt.negative_dropped.join(', ')}` : ''}`, '',
    ...(req.execution.concept_text_withheld_for.length ? [`Concept sentences withheld from the image prompt because they name ${req.execution.concept_text_withheld_for.join(', ')} (forbidden in generated scenes): the story reaches the model through the art direction's planes instead.`, ''] : []),
    '### Limitations of the rendering engine', '',
    `- The closed stage vocabulary cannot name: ${stage.wanted_but_not_available.join('; ')}. In scene mode these are **requested** from the image model (above); whether they are drawn is only known on a real image. The local Blender engine cannot draw them at all.`,
    '- The image model redraws the product; Nordla puts the authentic photo pixels back and re-proves them. Lighting continuity between scene and real product is measured (warnings), not guaranteed.',
    ...(p.key === 'coffret' ? ['- **Variant identity:** one image is linked to S, M and L: the picture cannot prove the M size. Nordla\'s selector may accept it (the image IS linked to the variant), but the owner must confirm which size it shows before a real trial.'] : []),
    ...(p.key === 'cadre' ? ['- **Source eligibility:** the only image is named “cyclisme” and may show a person (a customer-style photo printed on the product). Under ADR 0007-A, images with people are refused (SOURCE_REQUIRES_SPECIFIC_CONSENT) unless the tenant attests otherwise: **not eligible for a real trial until verified**.'] : []),
    ...(p.key === 'batterie' ? ['- **Supplier image:** the photo comes from a supplier feed (alt text is a dropmagic URL): HABB\'s right to use and transform it must be confirmed (ADR 0007 open obligation).', '- **Resolution:** 800×799 source for a 1080×1350 output: the product is restored at ≈1:1 at this framing; a CLOSE framing would upscale the real pixels.'] : []),
    '', '### Assessment', '', '| Axis | Verdict | Why |', '| --- | --- | --- |',
    '| Concept contracts (distinct, content, HABB rules, no invented capability) | PASS | Nordla validators, above |',
    '| Stage and headline rules (no figure, no claim, no placeholder, text off the product) | PASS | Nordla validators, above |',
    '| Technical quality of a finished image | NOT_MEASURABLE | no render (photo not reachable here, no real provider) |',
    '| Creative quality / WOW / premium execution | NOT_MEASURABLE | judged only on a rendered image, by the concept critic and the owner |', '');
}
lines.push('## What this shows and does not show', '',
  '- **Shows:** three genuinely different ideas per product pass Nordla\'s distinctness and brand guards; Nordla\'s selection rejects a concept that would need an edited product (display lit) or people (a hand carrying the box) and prefers the specific over the generic; the chosen story reaches the image model as layered scene instructions; HABB\'s prohibitions apply from its configuration.',
  '- **Does not show:** that any of this becomes a WOW image. Only a real image provider, on a verified photo, judged by the critic and the owner, can show that.');
const out = process.argv[2] ?? null; const md = `${lines.join('\n')}\n`;
if (out) writeFileSync(out, md); else process.stdout.write(md);
