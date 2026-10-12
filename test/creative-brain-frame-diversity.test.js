import test from 'node:test';
import assert from 'node:assert/strict';

import {
  askAndNormalize, assessBrief, BRIEF_STATUS, buildFramerInstruction, buildProblemFrame, findCollapsedKey, frameUnknowns, MAY_BE_UNKNOWN, observeBrief, parseAnswer, UNKNOWN,
} from '../src/creative-brain/index.js';
import { STAGE_CONTRACTS } from '../src/creative-brain/parity.js';
import { RESULT_STATE } from '../src/creative-brain-benchmark/index.js';
import { buildBrief } from './runtime-world.js';
import { frameAnswer } from './creative-brain-world.js';
import { live, world } from './creative-brain-benchmark-world.js';

// THE FRAME AT THE LEVEL OF ITS PURPOSE (`// FD-N` markers). Forensics of the live failure of 2026-10-12: json_object mode was on, the reply was valid JSON, and the model had written the two items of a list WITHOUT the
// square brackets ("a", "b" : "next" parses as a pair whose key is a sentence). The desired architecture is not "every input produces a frame" but "every input produces a valid next action without a crash".

const FRAME = STAGE_CONTRACTS.find((c) => c.stage === 'FRAME');

// the exact reply of the failed live run (request chatcmpl-5d01e418...), kept verbatim as evidence
const LIVE_RAW = '{"what_we_show":"A custom phone case for Samsung Galaxy A17 bearing a personal photo, presented to highlight the five-minute express printing and the twenty-five euro price.","audience":"People in Namur and Belgium scrolling Instagram who want a fast, affordable, meaningful personal gift or accessory for their Samsung Galaxy A17.","understood_immediately":"HABB prints your photo on a Samsung Galaxy A17 case in five minutes for twenty-five euros.","felt":"The thrill of seeing your own memory instantly transformed into something you can hold and use every day.","remembered":"A personal photo becoming a physical object in the blink of an eye at a local Namur shop.","commercial_objective":"Drive immediate foot traffic and orders by proving the speed and affordability of HABB\'s UV printing service.","occasion_context":"Spontaneous gifting or personal treat when someone needs a unique present urgently or wants to refresh their phone look instantly.","generic_risks":["A plain mockup of a phone case floating on a pastel background that any print shop could claim","Stock hands holding a blank case with generic text overlays","Over-reliance on printer machinery visuals instead of the emotional result","A cluttered layout where price, headline and subheadline fight for attention"],"distinctive_levers":"The visible contrast between a raw digital photo and the finished printed case to prove the five-minute transformation","Anchoring the visual in HABB\'s Namur identity to build local trust over faceless e-commerce competitors"\n  \t: "rationale",\n  "rationale": "Framing the five-minute creation as a visible transformation anchors the commercial claims in an emotional payoff that only HABB\'s local UV printing can deliver."\n}';

const ask = async (replies, brief = buildBrief()) => {
  const calls = []; const obs = observeBrief({ brief });
  const complete = async (instruction) => { calls.push(instruction); const r = replies[calls.length - 1]; if (r === undefined) throw new Error('no more replies'); return { text: typeof r === 'string' ? r : JSON.stringify(r), model: 'fake', request_id: `fd-${calls.length}` }; };
  const { value, meta } = await askAndNormalize({ complete, instruction: buildFramerInstruction({ observation: obs }), stage: 'FRAME', spec: FRAME.spec, normalize: (raw) => buildProblemFrame({ observation: obs, model: raw }) });
  return { frame: value, meta, calls: calls.length };
};

test('FD-1 forensics: the live reply is valid JSON, carries NO normalization and NO repair, and is refused by BRAIN_UNKNOWN_KEY at a key that is a sentence; it is reproduced offline', async () => {
  const parsed = JSON.parse(LIVE_RAW); // json_object mode delivered syntactically valid JSON
  assert.equal(typeof parsed.distinctive_levers, 'string'); // the list became a string
  const sentenceKey = Object.keys(parsed).find((k) => k.includes(' '));
  assert.match(sentenceKey, /^Anchoring the visual in HABB/);
  assert.equal(parsed[sentenceKey], 'rationale'); // the model wrote the NEXT KEY NAME as the value of the stray key
  assert.deepEqual(findCollapsedKey(parsed), { path: 'answer', key: sentenceKey });
  // the old behaviour (replayed against the validator alone): an unknown key, a closed contract
  await assert.rejects(async () => buildProblemFrame({ observation: observeBrief({ brief: buildBrief() }), model: parsed }), (e) => e.code === 'BRAIN_UNKNOWN_KEY');
  // now: this is a collapsed structure, so it gets the ONE protocol repair, and the repaired answer is validated like any other
  const r = await ask([LIVE_RAW, frameAnswer()]);
  assert.equal(r.calls, 2);
  assert.equal(r.meta.protocol_repair.outcome, 'PARSED');
  assert.match(r.meta.protocol_repair.parse_failure, /structure that collapsed/);
  assert.equal(r.meta.protocol_repair.malformed_response_chars, LIVE_RAW.length);
  assert.equal(r.meta.protocol_repair.original_request_id, 'fd-1');
});

test('FD-2 a structure that collapses again stops after exactly two calls, both answers kept; a near-miss key, another casing and an invisible character are NOT a collapse', async () => {
  await assert.rejects(ask([LIVE_RAW, LIVE_RAW, frameAnswer()]), (e) => {
    assert.equal(e.code, 'BRAIN_MALFORMED');
    assert.equal(e.detail.problem, 'STRUCTURE_COLLAPSED');
    assert.equal(e.evidence.protocol_repair.outcome, 'STILL_MALFORMED');
    assert.equal(e.evidence.protocol_repair.original_raw_answer, LIVE_RAW);
    return true;
  });
  for (const key of ['felt', 'Felt', 'felt​', 'fel', 'concept_id', 'A_RECEDING_PRODUCT', 'HEADLINE']) assert.equal(findCollapsedKey({ [key]: 1 }), null, key);
  for (const key of ['a sentence key', 'has, comma', 'ends.', 'quote"d', 'x'.repeat(65), 'two\nlines']) assert.ok(findCollapsedKey({ [key]: 1 }), key);
  assert.ok(findCollapsedKey({ ok: [{ fine: 1 }, { 'not fine': 2 }] }));
  assert.throws(() => parseAnswer('{"a b": 1}', 'FRAME'), (e) => e.code === 'BRAIN_MALFORMED');
});

test('FD-3 a parseable but contract-breaking answer is still NOT re-asked (a string for a list, an unknown NAME): only a collapsed structure is a protocol accident', async () => {
  for (const bad of [{ ...frameAnswer(), generic_risks: 'one; two' }, { ...frameAnswer(), surprise: 'x' }]) {
    const calls = [];
    await assert.rejects(ask([bad, frameAnswer()]).then((r) => { calls.push(r); }), (e) => e.evidence.protocol_repair === undefined);
    assert.equal(calls.length, 0);
  }
});

test('FD-4 the lists show TWO items in the answer shape, so a list is always bracketed', () => {
  const { system } = buildFramerInstruction({ observation: observeBrief({ brief: buildBrief() }) });
  assert.match(system, /"generic_risks": \["<one line of text>", "<one line of text>", \.\.\.\]/);
  assert.match(system, /"distinctive_levers": \["<one line of text>", "<one line of text>", \.\.\.\]/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------- what FRAME must state, and what it may leave UNKNOWN
test('FD-5 audience, commercial objective and occasion are facts of the brief: UNKNOWN is a valid, honest statement, in any wording; nothing else may be UNKNOWN-d away', async () => {
  const unknown = { ...frameAnswer(), audience: 'UNKNOWN', commercial_objective: 'Not specified.', occasion_context: 'n/a' };
  const r = await ask([unknown]);
  assert.deepEqual(frameUnknowns(r.frame), MAY_BE_UNKNOWN);
  assert.deepEqual([r.frame.audience, r.frame.commercial_objective, r.frame.occasion_context], [UNKNOWN, UNKNOWN, UNKNOWN]);
  const { system } = buildFramerInstruction({ observation: observeBrief({ brief: buildBrief() }) });
  assert.match(system, /RULE UNKNOWN_IS_HONEST: audience, commercial_objective and occasion_context are facts the brief may not give: when it does not, write exactly UNKNOWN/);
  // the other fields are the framer's own judgment or derived from the brief: UNKNOWN there is just a (poor) text, not a recognized absence
  const odd = await ask([{ ...frameAnswer(), felt: 'UNKNOWN' }]);
  assert.deepEqual(frameUnknowns(odd.frame), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------------- 50+ realistic briefs
const STEMS = {
  en: (b) => ({ shows: `${b.product} shown plainly, with the approved line readable at once.`, aud: b.audience, msg: `${b.merchant} offers ${b.product}.`, felt: 'Confidence that this is the right choice.', rem: `One clear image of ${b.product}.`, obj: b.objective, occ: b.occasion }),
  fr: (b) => ({ shows: `${b.product}, montré simplement, avec la phrase approuvée lisible tout de suite.`, aud: b.audience, msg: `${b.merchant} propose ${b.product}.`, felt: 'La confiance d’avoir fait le bon choix.', rem: `Une image claire de ${b.product}.`, obj: b.objective, occ: b.occasion }),
  nl: (b) => ({ shows: `${b.product}, eenvoudig getoond, met de goedgekeurde zin direct leesbaar.`, aud: b.audience, msg: `${b.merchant} biedt ${b.product} aan.`, felt: 'Het vertrouwen de juiste keuze te maken.', rem: `Eén duidelijk beeld van ${b.product}.`, obj: b.objective, occ: b.occasion }),
  ar: (b) => ({ shows: `${b.product} يظهر ببساطة مع النص المعتمد واضحاً.`, aud: b.audience, msg: `${b.merchant} — ${b.product}.`, felt: 'الثقة بالاختيار الصحيح.', rem: `${b.product}.`, obj: b.objective, occ: b.occasion }),
  zh: (b) => ({ shows: `${b.product}，简洁展示，核准文案一目了然。`, aud: b.audience, msg: `${b.merchant}提供${b.product}。`, felt: '选对了的安心感。', rem: `${b.product}。`, obj: b.objective, occ: b.occasion }),
};
/** A natural frame answer for a brief: facts the brief gives are used, facts it does not give are UNKNOWN, never invented. */
const naturalReply = (b, lang = 'en') => {
  const s = STEMS[lang](b);
  return {
    what_we_show: s.shows, audience: b.audience ?? UNKNOWN, understood_immediately: s.msg, felt: s.felt, remembered: s.rem, commercial_objective: b.objective ?? UNKNOWN, occasion_context: b.occasion ?? UNKNOWN,
    generic_risks: ['The category cliche that any competitor could publish', 'A cluttered layout where the offer is hard to find'], distinctive_levers: ['What only this product and this merchant can show', 'One restrained detail that is true to the product'],
    rationale: 'The frame keeps to what the brief states and leaves the rest to the later stages.',
  };
};

const copy = (role, content, n = 1) => ({ ref: `copy://fd/${role}-${n}`, role, content });
const claim = (role, wording, n = 1) => ({ ref: `claim://fd/${role}-${n}`, role, wording });
const brief = ({ facts, copies, claims, format, asset, ids } = {}) => buildBrief({
  ...(facts ? { public_facts: facts } : {}), ...(copies ? { approved_copy: copies } : {}), ...(claims ? { claims } : {}), ...(format ? { format } : {}),
  ...(asset ? { asset: { ...buildBrief().asset, ...asset } } : {}), ...(ids ? { ids: { ...buildBrief().ids, ...ids } } : {}),
});
const L = 'x'.repeat(0);

// [name, category, brief, reply (null: use the natural one), language, expected class]
const BRIEFS = [
  ['complete brief, retail', 'complete', { facts: { product: 'Leather card holder', merchant: 'Atelier Nord', audience: 'Adults who carry few cards', objective: 'Sell the holder in the gifting season', occasion: 'Gifting' }, copies: [copy('HEADLINE', 'Small, made to last')], claims: [claim('PRICE', '39 EUR')] }, null, 'en', 'VALID_FRAME'],
  ['complete brief, service', 'complete', { facts: { product: 'Home cleaning subscription', merchant: 'Clean & Co', audience: 'Busy families', objective: 'Start more trials', occasion: 'Moving house' }, copies: [copy('HEADLINE', 'Come home to a clean home')], claims: [claim('SUBHEADLINE', 'First visit half price')] }, null, 'en', 'VALID_FRAME'],
  ['complete brief, restaurant', 'restaurant', { facts: { product: 'Lunch menu, two courses and dessert', merchant: 'Chez Odile', audience: 'Office workers nearby', objective: 'Fill weekday lunch', occasion: 'Weekday lunch' }, copies: [copy('HEADLINE', 'Un vrai déjeuner')], claims: [claim('PRICE', '17 EUR')] }, null, 'fr', 'VALID_FRAME'],
  ['restaurant, no audience and no objective', 'restaurant', { facts: { product: 'Sunday brunch', merchant: 'Maison Lumière' }, copies: [copy('HEADLINE', 'Brunch, enfin')], claims: [] }, null, 'fr', 'SAFE_UNKNOWN'],
  ['memorial', 'memorial', { facts: { product: 'White lily tribute spray', merchant: 'Fleurs du Souvenir', audience: 'Families arranging a funeral', occasion: 'Bereavement' }, copies: [copy('HEADLINE', 'With respect')], claims: [claim('SUBHEADLINE', 'Delivered today')] }, null, 'en', 'SAFE_UNKNOWN'],
  ['birth gift', 'birth gift', { facts: { product: 'Engraved silver baby spoon', merchant: 'Petit Trésor', audience: 'Parents and godparents', occasion: 'A birth', objective: 'Win the birth-gift choice' }, copies: [copy('HEADLINE', 'Welcome, little one')], claims: [claim('PRICE', '29 EUR')] }, null, 'en', 'VALID_FRAME'],
  ['luxury watch', 'luxury', { facts: { product: 'Automatic wristwatch, sapphire crystal', merchant: 'Maison Aubrac', audience: 'Collectors', objective: 'Reinforce desirability, not discount' }, copies: [copy('HEADLINE', 'Time, held')], claims: [] }, null, 'en', 'SAFE_UNKNOWN'],
  ['technical product', 'technical', { facts: { product: 'Industrial torque sensor, 0.1 percent accuracy', merchant: 'Metrix', audience: 'Maintenance engineers', objective: 'Generate quote requests', occasion: 'Plant upgrade' }, copies: [copy('HEADLINE', 'Know the torque')], claims: [claim('SUBHEADLINE', 'Calibrated in the factory')] }, null, 'en', 'VALID_FRAME'],
  ['B2B software', 'B2B', { facts: { product: 'Cloud accounting for small firms', merchant: 'Ledgerly', audience: 'Owner-managers', objective: 'Start free trials' }, copies: [copy('HEADLINE', 'Close the month early')], claims: [] }, null, 'en', 'SAFE_UNKNOWN'],
  ['B2B wholesale', 'B2B', { facts: { product: 'Wholesale coffee beans, 5 kg bags', merchant: 'Quai Torréfaction', audience: 'Café owners', objective: 'Open trade accounts', occasion: 'New season' }, copies: [copy('HEADLINE', 'Fresh by the kilo')], claims: [claim('SUBHEADLINE', 'Delivered weekly')] }, null, 'en', 'VALID_FRAME'],
  ['one-sentence brief', 'one sentence', { facts: { product: 'Handmade soap' }, copies: [copy('HEADLINE', 'Soap')], claims: [] }, null, 'en', 'SAFE_UNKNOWN'],
  ['vague brief', 'vague', { facts: { product: 'Something nice for the home', merchant: 'Shop' }, copies: [copy('HEADLINE', 'New in')], claims: [] }, null, 'en', 'SAFE_UNKNOWN'],
  ['long brief', 'long', { facts: { product: `Reversible wool coat in three colourways ${'with a lining that is cut from the same cloth as the shell '.repeat(10)}`, merchant: 'Maison Laine', audience: 'Adults who buy one good coat', objective: 'Sell the coat before the first cold', occasion: 'Autumn' }, copies: [copy('HEADLINE', 'One coat, two ways')], claims: [claim('PRICE', '249 EUR')] }, null, 'en', 'VALID_FRAME'],
  ['long approved copy', 'long copy', { facts: { product: 'Ceramic mug', merchant: 'Terre', audience: 'Home cooks', objective: 'Sell the mug' }, copies: [copy('HEADLINE', 'Made by hand'), copy('BODY', 'Each mug is thrown, trimmed and glazed by hand in our studio. '.repeat(25))], claims: [] }, null, 'en', 'SAFE_UNKNOWN'],
  ['no price', 'no price', { facts: { product: 'Hand-bound notebook', merchant: 'Papier', audience: 'Students', objective: 'Sell notebooks', occasion: 'Back to school' }, copies: [copy('HEADLINE', 'Write it down')], claims: [] }, null, 'en', 'VALID_FRAME'],
  ['no emotional goal stated', 'no emotional goal', { facts: { product: 'Phone charger, 20 W', merchant: 'Volt', audience: 'Commuters', objective: 'Sell chargers', occasion: 'Any day' }, copies: [copy('HEADLINE', 'Charge fast')], claims: [claim('PRICE', '15 EUR')] }, null, 'en', 'VALID_FRAME'],
  ['multilingual brief, French', 'multilingual', { facts: { product: 'Coque de téléphone personnalisée', merchant: 'HABB', audience: 'Habitants de Namur', objective: 'Attirer en boutique', occasion: 'Cadeau de dernière minute' }, copies: [copy('HEADLINE', 'Vos souvenirs. Votre création.')], claims: [claim('PRICE', '25 €')] }, null, 'fr', 'VALID_FRAME'],
  ['multilingual brief, Dutch', 'multilingual', { facts: { product: 'Gepersonaliseerd telefoonhoesje', merchant: 'HABB', audience: 'Inwoners van Namen', objective: 'Bezoek aan de winkel', occasion: 'Last-minute cadeau' }, copies: [copy('HEADLINE', 'Jouw herinneringen. Jouw creatie.')], claims: [claim('PRICE', '25 €')] }, null, 'nl', 'VALID_FRAME'],
  ['multilingual brief, Arabic', 'multilingual', { facts: { product: 'كوب مخصص', merchant: 'متجر النور', audience: 'عائلات', objective: 'زيادة المبيعات', occasion: 'هدية' }, copies: [copy('HEADLINE', 'هدية شخصية')], claims: [] }, null, 'ar', 'VALID_FRAME'],
  ['multilingual brief, Chinese', 'multilingual', { facts: { product: '定制手机壳', merchant: '小店', audience: '年轻人', objective: '吸引到店', occasion: '生日礼物' }, copies: [copy('HEADLINE', '你的回忆')], claims: [] }, null, 'zh', 'VALID_FRAME'],
  ['mixed-language brief', 'multilingual', { facts: { product: 'Phone case — coque — hoesje', merchant: 'HABB', audience: 'Namur, Liège, Bruxelles', objective: 'Foot traffic', occasion: 'Gift' }, copies: [copy('HEADLINE', 'Your photo — votre photo')], claims: [] }, null, 'fr', 'VALID_FRAME'],
  ['emoji in the brief', 'unicode', { facts: { product: 'Birthday candle set \u{1F382}', merchant: 'Fête', audience: 'Parents', objective: 'Sell sets', occasion: 'Birthdays' }, copies: [copy('HEADLINE', 'Make a wish ✨')], claims: [] }, null, 'en', 'VALID_FRAME'],
  ['zero-width characters in the brief', 'unicode', { facts: { product: 'Sea​salt caramel', merchant: 'Confiserie', audience: 'Gourmets', objective: 'Sell boxes', occasion: 'Gifting' }, copies: [copy('HEADLINE', 'Sal​ty. Sweet.')], claims: [] }, null, 'en', 'VALID_FRAME'],
  // ---- the brief itself needs a person
  ['no product stated', 'incomplete', { facts: { merchant: 'Shop' }, copies: [copy('HEADLINE', 'New')], claims: [] }, null, 'en', 'NEEDS_CLARIFICATION'],
  ['product is a null-like word', 'incomplete', { facts: { product: 'N/A', merchant: 'Shop' }, copies: [copy('HEADLINE', 'New')], claims: [] }, null, 'en', 'NEEDS_CLARIFICATION'],
  ['product is blank', 'incomplete', { facts: { product: '   ', merchant: 'Shop' }, copies: [copy('HEADLINE', 'New')], claims: [] }, null, 'en', 'NEEDS_CLARIFICATION'],
  ['nothing approved to say', 'incomplete', { facts: { product: 'Hand cream', merchant: 'Soin' }, copies: [], claims: [] }, null, 'en', 'NEEDS_CLARIFICATION'],
  ['no format', 'incomplete', { facts: { product: 'Hand cream', merchant: 'Soin' }, copies: [copy('HEADLINE', 'Soft')], claims: [], format: { ...buildBrief().format, aspect_ratio: null } }, null, 'en', 'NEEDS_CLARIFICATION'],
  ['no product photograph', 'incomplete', { facts: { product: 'Hand cream', merchant: 'Soin' }, copies: [copy('HEADLINE', 'Soft')], claims: [], asset: { ref: null } }, null, 'en', 'NEEDS_CLARIFICATION'],
  ['no product reference', 'incomplete', { facts: { product: 'Hand cream', merchant: 'Soin' }, copies: [copy('HEADLINE', 'Soft')], claims: [], ids: { product_ref: null } }, null, 'en', 'NEEDS_CLARIFICATION'],
  ['product, nothing else, nothing approved', 'incomplete', { facts: { product: 'Candle' }, copies: [], claims: [] }, null, 'en', 'NEEDS_CLARIFICATION'],
  // ---- the brief contradicts itself
  ['two different headlines', 'contradictory', { facts: { product: 'Running shoe', merchant: 'Strider' }, copies: [copy('HEADLINE', 'Run faster', 1), copy('HEADLINE', 'Run longer', 2)], claims: [] }, null, 'en', 'USER_CONTRADICTION'],
  ['two different prices', 'contradictory', { facts: { product: 'Running shoe', merchant: 'Strider' }, copies: [copy('HEADLINE', 'Run')], claims: [claim('PRICE', '89 EUR', 1), claim('PRICE', '99 EUR', 2)] }, null, 'en', 'USER_CONTRADICTION'],
  ['two different subheadlines, in two languages', 'contradictory', { facts: { product: 'Tea', merchant: 'Thé' }, copies: [copy('HEADLINE', 'Tea')], claims: [claim('SUBHEADLINE', 'Livraison gratuite', 1), claim('SUBHEADLINE', 'Gratis verzending', 2)] }, null, 'en', 'USER_CONTRADICTION'],
  ['the same headline twice, written differently, is not a contradiction', 'contradictory', { facts: { product: 'Tea', merchant: 'Thé', audience: 'Tea lovers', objective: 'Sell tea', occasion: 'Winter' }, copies: [copy('HEADLINE', 'Warm up', 1), copy('HEADLINE', '  warm  UP ', 2)], claims: [] }, null, 'en', 'VALID_FRAME'],
  // ---- what the model does
  ['the model wraps its answer', 'model behaviour', { facts: { product: 'Soap', merchant: 'Savon', audience: 'Everyone', objective: 'Sell', occasion: 'Any' }, copies: [copy('HEADLINE', 'Clean')], claims: [] }, (b) => ({ answer: naturalReply(b.facts) }), 'en', 'VALID_FRAME'],
  ['the model collapses a list, then repairs it', 'model behaviour', { facts: { product: 'Soap', merchant: 'Savon', audience: 'Everyone', objective: 'Sell', occasion: 'Any' }, copies: [copy('HEADLINE', 'Clean')], claims: [] }, (b) => [LIVE_RAW, naturalReply(b.facts)], 'en', 'VALID_FRAME'],
  ['the model breaks the JSON once, then repairs it', 'model behaviour', { facts: { product: 'Soap', merchant: 'Savon', audience: 'Everyone', objective: 'Sell', occasion: 'Any' }, copies: [copy('HEADLINE', 'Clean')], claims: [] }, (b) => ['{"what_we_show": ["broken"', naturalReply(b.facts)], 'en', 'VALID_FRAME'],
  ['the model collapses a list twice', 'model behaviour', { facts: { product: 'Soap', merchant: 'Savon', audience: 'Everyone', objective: 'Sell', occasion: 'Any' }, copies: [copy('HEADLINE', 'Clean')], claims: [] }, () => [LIVE_RAW, LIVE_RAW], 'en', 'INVALID_FRAME'],
  ['the model repeats a key', 'model behaviour', { facts: { product: 'Soap', merchant: 'Savon', audience: 'Everyone', objective: 'Sell', occasion: 'Any' }, copies: [copy('HEADLINE', 'Clean')], claims: [] }, (b) => JSON.stringify(naturalReply(b.facts)).replace('{', '{"felt":"another feeling",'), 'en', 'INVALID_FRAME'],
  ['the model gives a list as one string', 'model behaviour', { facts: { product: 'Soap', merchant: 'Savon', audience: 'Everyone', objective: 'Sell', occasion: 'Any' }, copies: [copy('HEADLINE', 'Clean')], claims: [] }, (b) => ({ ...naturalReply(b.facts), generic_risks: 'cliche; clutter' }), 'en', 'INVALID_FRAME'],
  ['the model overflows a field', 'model behaviour', { facts: { product: 'Soap', merchant: 'Savon', audience: 'Everyone', objective: 'Sell', occasion: 'Any' }, copies: [copy('HEADLINE', 'Clean')], claims: [] }, (b) => ({ ...naturalReply(b.facts), felt: 'f'.repeat(301) }), 'en', 'INVALID_FRAME'],
  ['the model writes a number', 'model behaviour', { facts: { product: 'Soap', merchant: 'Savon', audience: 'Everyone', objective: 'Sell', occasion: 'Any' }, copies: [copy('HEADLINE', 'Clean')], claims: [] }, (b) => ({ ...naturalReply(b.facts), felt: 7 }), 'en', 'INVALID_FRAME'],
  ['the model writes UNKNOWN a different way', 'model behaviour', { facts: { product: 'Soap', merchant: 'Savon' }, copies: [copy('HEADLINE', 'Clean')], claims: [] }, (b) => ({ ...naturalReply(b.facts), audience: 'Not specified.', commercial_objective: 'N/A', occasion_context: 'Unspecified' }), 'en', 'SAFE_UNKNOWN'],
  ['the model answers in prose with a JSON object inside', 'model behaviour', { facts: { product: 'Soap', merchant: 'Savon', audience: 'Everyone', objective: 'Sell', occasion: 'Any' }, copies: [copy('HEADLINE', 'Clean')], claims: [] }, (b) => `Here is the frame:\n\`\`\`json\n${JSON.stringify(naturalReply(b.facts))}\n\`\`\`\nHope it helps.`, 'en', 'VALID_FRAME'],
  ['the model returns nothing', 'model behaviour', { facts: { product: 'Soap', merchant: 'Savon', audience: 'Everyone', objective: 'Sell', occasion: 'Any' }, copies: [copy('HEADLINE', 'Clean')], claims: [] }, () => [''], 'en', 'INVALID_FRAME'],
  ['the model refuses with prose', 'model behaviour', { facts: { product: 'Soap', merchant: 'Savon', audience: 'Everyone', objective: 'Sell', occasion: 'Any' }, copies: [copy('HEADLINE', 'Clean')], claims: [] }, () => ['I cannot help with that.', 'I still cannot help with that.'], 'en', 'INVALID_FRAME'],
  ['the model answers with a list of frames', 'model behaviour', { facts: { product: 'Soap', merchant: 'Savon', audience: 'Everyone', objective: 'Sell', occasion: 'Any' }, copies: [copy('HEADLINE', 'Clean')], claims: [] }, (b) => [JSON.stringify([naturalReply(b.facts)]), naturalReply(b.facts)], 'en', 'VALID_FRAME'],
  // ---- more business shapes
  ['marketplace seller', 'retail product', { facts: { product: 'Second-hand camera lens', merchant: 'Lens Exchange', audience: 'Hobby photographers', objective: 'Sell the lens' }, copies: [copy('HEADLINE', 'Tested, graded, guaranteed')], claims: [claim('PRICE', '320 EUR')] }, null, 'en', 'SAFE_UNKNOWN'],
  ['non-profit appeal', 'service', { facts: { product: 'Monthly donation to a food bank', merchant: 'Banque Alimentaire', audience: 'Local residents', objective: 'Recruit donors', occasion: 'Winter appeal' }, copies: [copy('HEADLINE', 'One meal, every month')], claims: [] }, null, 'fr', 'VALID_FRAME'],
  ['real estate agency', 'service', { facts: { product: 'Free home valuation', merchant: 'Immo Namur' }, copies: [copy('HEADLINE', 'What is your home worth?')], claims: [] }, null, 'fr', 'SAFE_UNKNOWN'],
  ['automotive service', 'technical', { facts: { product: 'Winter tyre fitting', merchant: 'Garage Meuse', audience: 'Drivers', objective: 'Book fittings', occasion: 'First frost' }, copies: [copy('HEADLINE', 'Ready for the first frost')], claims: [claim('SUBHEADLINE', 'Same-day fitting')] }, null, 'nl', 'VALID_FRAME'],
  ['jewellery', 'luxury', { facts: { product: 'Hand-engraved silver ring', merchant: 'Atelier Marais', audience: 'Partners and friends', occasion: 'Anniversary' }, copies: [copy('HEADLINE', 'Yours alone')], claims: [] }, null, 'en', 'SAFE_UNKNOWN'],
  ['wine producer', 'retail product', { facts: { product: 'Organic red wine, 2022 vintage', merchant: 'Domaine du Vent', audience: 'Wine lovers', objective: 'Direct sales', occasion: 'Harvest season' }, copies: [copy('HEADLINE', 'From our vines')], claims: [claim('PRICE', '14 EUR')] }, null, 'fr', 'VALID_FRAME'],
  ['toy for toddlers', 'birth gift', { facts: { product: 'Wooden stacking toy', merchant: 'Petit Atelier', audience: 'Parents of toddlers', objective: 'Win first birthdays', occasion: 'First birthday' }, copies: [copy('HEADLINE', 'Built to be passed on')], claims: [] }, null, 'nl', 'VALID_FRAME'],
  ['fitness class', 'service', { facts: { product: 'Beginner yoga class, Tuesday evenings', merchant: 'Studio Souffle', audience: 'Beginners', objective: 'Fill the class' }, copies: [copy('HEADLINE', 'Start where you are')], claims: [] }, null, 'en', 'SAFE_UNKNOWN'],
  ['tool rental', 'B2B', { facts: { product: 'Scaffolding rental by the week', merchant: 'Echafaudages Plus', audience: 'Builders', objective: 'Win rental contracts', occasion: 'Spring building season' }, copies: [copy('HEADLINE', 'On site tomorrow')], claims: [claim('SUBHEADLINE', 'Delivery included')] }, null, 'fr', 'VALID_FRAME'],
  ['funeral service', 'memorial', { facts: { product: 'Memorial book of condolences', merchant: 'Souvenir', audience: 'Grieving families', occasion: 'A funeral' }, copies: [copy('HEADLINE', 'Words that stay')], claims: [] }, null, 'en', 'SAFE_UNKNOWN'],
  ['one-word headline, one-word product', 'one sentence', { facts: { product: 'Tea' }, copies: [copy('HEADLINE', 'Tea')], claims: [] }, null, 'en', 'SAFE_UNKNOWN'],
];

async function frameClass(b, spec) {
  const assessment = assessBrief({ brief: b });
  if (assessment.status === BRIEF_STATUS.NEEDS_CLARIFICATION) return { cls: 'NEEDS_CLARIFICATION', calls: 0, assessment };
  if (assessment.status === BRIEF_STATUS.USER_CONTRADICTION) return { cls: 'USER_CONTRADICTION', calls: 0, assessment };
  const [, , , reply, lang] = spec;
  const facts = b.public_facts;
  const base = { product: String(facts.product).replace(/\s+/g, ' ').trim().slice(0, 60), merchant: facts.merchant ?? 'the merchant', audience: facts.audience ?? null, objective: facts.objective ?? null, occasion: facts.occasion ?? null };
  const fromBrief = { facts: base, ...base };
  const replies = reply === null ? [naturalReply(fromBrief, lang)] : (() => { const r = reply({ facts: fromBrief }); return Array.isArray(r) ? r : [r]; })();
  try {
    const r = await ask(replies, b);
    return { cls: frameUnknowns(r.frame).length ? 'SAFE_UNKNOWN' : 'VALID_FRAME', calls: r.calls, assessment, frame: r.frame, repaired: r.meta.protocol_repair?.outcome ?? null };
  } catch (error) {
    return { cls: 'INVALID_FRAME', calls: replies.length, code: error.code, assessment };
  }
}

test('FD-6 fifty-plus realistic briefs: every brief ends in a valid NEXT ACTION without a crash, and no fact is invented', async () => {
  assert.ok(BRIEFS.length >= 50, `${BRIEFS.length} briefs`);
  const tally = {};
  const categories = new Set();
  for (const spec of BRIEFS) {
    const [name, category, parts, , , expected] = spec;
    categories.add(category);
    const b = brief(parts);
    const out = await frameClass(b, spec);
    assert.equal(out.cls, expected, `${name}: ${out.cls} ${out.code ?? ''}`);
    tally[out.cls] = (tally[out.cls] ?? 0) + 1;
    // a brief that needs a person costs nothing and is asked a precise question
    if (out.cls === 'NEEDS_CLARIFICATION' || out.cls === 'USER_CONTRADICTION') { assert.equal(out.calls, 0, name); assert.ok(out.assessment.issues.every((i) => i.question.includes('?')), name); }
    // a frame never invents a fact the brief did not give
    if (out.frame) {
      for (const [field, key] of [['audience', 'audience'], ['commercial_objective', 'objective'], ['occasion_context', 'occasion']]) if (!b.public_facts[key]) assert.equal(out.frame[field], UNKNOWN, `${name}: ${field} was invented`);
    }
  }
  for (const needed of ['complete', 'incomplete', 'vague', 'long', 'one sentence', 'multilingual', 'contradictory', 'no price', 'long copy', 'B2B', 'retail product', 'service', 'restaurant', 'memorial', 'birth gift', 'luxury', 'technical', 'no emotional goal']) assert.ok(categories.has(needed), needed);
  assert.deepEqual(Object.keys(tally).sort(), ['INVALID_FRAME', 'NEEDS_CLARIFICATION', 'SAFE_UNKNOWN', 'USER_CONTRADICTION', 'VALID_FRAME']);
  assert.ok(tally.VALID_FRAME >= 15 && tally.SAFE_UNKNOWN >= 8 && tally.NEEDS_CLARIFICATION >= 6 && tally.USER_CONTRADICTION >= 3 && tally.INVALID_FRAME >= 6, JSON.stringify(tally));
});

test('FD-7 a brief that needs a person stops the Brain before any model call, in the runner too: BLOCKED with the precise questions, no cost, nothing invented', async () => {
  const w = world({ brief: buildBrief({ public_facts: { merchant: 'Shop' } }) });
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.BLOCKED);
  const s = await w.store.readJson('summary.json');
  assert.deepEqual([s.final.reason, s.final.stopped_at, s.final.provider_calls.text], ['BRIEF_NEEDS_CLARIFICATION', 'OBSERVE', 0]);
  assert.equal(s.final.questions[0].code, 'PRODUCT_NOT_STATED');
  assert.equal(w.script.calls.length, 0);
  const contradictory = world({ brief: buildBrief({ claims: [claim('PRICE', '10 EUR', 1), claim('PRICE', '12 EUR', 2)] }) });
  await live(contradictory);
  const c = await contradictory.store.readJson('summary.json');
  assert.deepEqual([c.final.reason, c.final.provider_calls.text], ['BRIEF_CONTRADICTORY', 0]);
});

test('FD-8 edges of the collapse detection and of the assessment: invisible characters do not count toward a name\'s length, a path names the array index, and a missing fact is asked before a contradiction', () => {
  assert.equal(findCollapsedKey({ [`${'k'.repeat(64)}\u200B\u200B\u200B`]: 1 }), null); // 64 letters and three zero-width characters: still a name
  assert.ok(findCollapsedKey({ ['k'.repeat(65)]: 1 }));
  assert.deepEqual(findCollapsedKey({ ok: [{ fine: 1 }, { 'not fine': 2 }] }), { path: 'answer.ok[1]', key: 'not fine' });
  const both = assessBrief({ brief: buildBrief({ format: { ...buildBrief().format, aspect_ratio: null }, approved_copy: [copy('HEADLINE', 'Run faster', 1), copy('HEADLINE', 'Run longer', 2)] }) });
  assert.equal(both.status, BRIEF_STATUS.NEEDS_CLARIFICATION);
  assert.deepEqual(both.issues.map((i) => i.kind), ['MISSING']); // the contradiction is asked afterwards, once the missing fact is given
});
