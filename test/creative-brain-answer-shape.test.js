import test from 'node:test';
import assert from 'node:assert/strict';

import {
  askAndNormalize, buildFramerInstruction, buildProblemFrame, normalizeNearMisses, obj, observeBrief, REPAIR_KIND, renderShape, text,
} from '../src/creative-brain/index.js';
import { auditSpecStage, STAGE_CONTRACTS } from '../src/creative-brain/parity.js';
import { buildBrief } from './runtime-world.js';
import { frameAnswer } from './creative-brain-world.js';

// THE ANSWER SHAPE (`// AS-N` markers). Attempt 8 stopped at FRAME although the model's content was valid: the instruction listed the fields as "answer.audience", and the model wrapped its answer in an
// "answer" key. Parity of rules is not enough: the model must be shown the exact JSON object, and a lone wrapper must not decide the run. No provider, no network.

const frame = (over = {}) => ({ ...frameAnswer(), ...over });
const observation = observeBrief({ brief: buildBrief() });
const askFrame = (replies, brief = buildBrief()) => {
  const calls = [];
  const complete = async (instruction) => { calls.push(instruction); const text = replies[calls.length - 1]; if (text === undefined) throw new Error('no reply'); return { text: typeof text === 'string' ? text : JSON.stringify(text), model: 'm', request_id: `r${calls.length}` }; };
  const obs = observeBrief({ brief });
  return askAndNormalize({ complete, instruction: buildFramerInstruction({ observation: obs }), stage: 'FRAME', spec: STAGE_CONTRACTS.find((c) => c.stage === 'FRAME').spec, normalize: (raw) => buildProblemFrame({ observation: obs, model: raw }) }).then((r) => ({ ...r, calls }));
};

test('AS-1 every model stage shows the exact JSON object, at the top level, with no wrapper key', () => {
  for (const c of STAGE_CONTRACTS) {
    const { system } = c.instruction();
    const shape = renderShape(c.spec);
    assert.ok(shape.every((line) => system.includes(line)), c.stage);
    assert.match(system, /no wrapper key around it/, c.stage);
    assert.match(system, /the word "answer" is never a key/, c.stage);
    const first = shape.findIndex((l) => l.startsWith('{') || l.startsWith('  "'));
    assert.ok(first > 0, c.stage);
    for (const key of Object.keys(c.spec.fields)) assert.ok(shape.some((l) => l.startsWith(`  "${key}": `)), `${c.stage}: ${key} is a top-level key of the shown object`);
    assert.ok(system.indexOf(shape[1]) < system.indexOf('answer: an object with exactly'), `${c.stage}: the shape comes before the field lines`);
  }
});

test('AS-2 the parity audit fails an instruction that does not show the shape', () => {
  const frameContract = STAGE_CONTRACTS.find((c) => c.stage === 'FRAME');
  const lines = new Set(renderShape(frameContract.spec));
  const without = { ...frameContract, instruction: () => { const i = frameContract.instruction(); return { ...i, system: i.system.split('\n').filter((l) => !lines.has(l)).join('\n') }; } };
  const audit = auditSpecStage(without);
  assert.ok(audit.failures.some((f) => /does not show the answer shape/.test(f)));
  assert.equal(auditSpecStage(frameContract).failures.length, 0);
});

test('AS-3 a lone envelope around the whole answer is unwrapped, journaled, and the content is validated exactly as if it were flat', async () => {
  const flat = await askFrame([frame()]);
  for (const key of ['answer', 'Answer', 'response', 'result', 'output', 'data']) {
    const wrapped = await askFrame([{ [key]: frame() }]);
    assert.deepEqual(wrapped.value, flat.value, key);
    assert.equal(wrapped.calls.length, 1, `${key}: a wrapper is not a protocol failure, no repair call`);
    assert.deepEqual(wrapped.meta.repairs.map((r) => r.kind), [REPAIR_KIND.ENVELOPE], key);
    assert.equal(wrapped.meta.repairs[0].path, 'FRAME');
  }
  assert.deepEqual(flat.meta.repairs, []);
});

test('AS-3b a wrapper under ANY name is unwrapped when what is inside is exactly the contract object, and refused otherwise', async () => {
  const flat = await askFrame([frame()]);
  for (const key of ['frame', 'problem_frame', 'framing', 'json']) {
    const wrapped = await askFrame([{ [key]: frame() }]);
    assert.deepEqual(wrapped.value, flat.value, key);
    assert.deepEqual(wrapped.meta.repairs.map((r) => r.kind), [REPAIR_KIND.ENVELOPE], key);
  }
  await assert.rejects(askFrame([{ frame: frame({ extra: 'x' }) }]), (e) => e.code === 'BRAIN_UNKNOWN_KEY');
});

test('AS-4 attempt 8 exactly: an enveloped answer with a broken array is repaired ONCE, comes back enveloped, and is accepted', async () => {
  const body = frame();
  const broken = `{"answer":${JSON.stringify(body).replace('"distinctive_levers":[', '"distinctive_levers":').replace(']', ']').replace(/"distinctive_levers":(".*?")\],/, '"distinctive_levers":$1,')}}`;
  const r = await askFrame([broken, { answer: body }]);
  assert.equal(r.calls.length, 2);
  assert.equal(r.meta.protocol_repair.outcome, 'PARSED');
  assert.deepEqual(r.meta.repairs.map((x) => x.kind), [REPAIR_KIND.ENVELOPE]);
  assert.equal(r.value.rationale, body.rationale);
});

test('AS-5 the envelope repair never chooses: two keys, a real field name, a non-object inside or an unknown wrapper are all refused', async () => {
  const spec = obj({ answer: text({ min: 1, max: 20 }), other: text({ min: 1, max: 20 }) });
  const inner = { answer: 'real field', other: 'x' };
  const cases = [
    [obj({ a: text({ min: 1, max: 20 }) }), { answer: { a: 'x' }, extra: 1 }],
    [obj({ a: text({ min: 1, max: 20 }) }), { payload: { b: 'x' } }], // the inside is not the contract's object
    [obj({ a: text({ min: 1, max: 20 }) }), { payload: { a: 'x', b: 'y' } }], // an unknown key inside
    [obj({ a: text({ min: 1, max: 20 }), c: text({ min: 1, max: 20 }) }), { payload: { a: 'x' } }], // a required key missing inside
    [obj({ a: text({ min: 1, max: 20 }) }), { answer: ['a'] }],
    [obj({ a: text({ min: 1, max: 20 }) }), { answer: 'a' }],
    [spec, { answer: inner }], // "answer" IS a field of this contract: nothing to unwrap
  ];
  for (const [s, value] of cases) {
    const repairs = [];
    assert.deepEqual(normalizeNearMisses(s, value, repairs), value);
    assert.deepEqual(repairs, []);
  }
  // nested objects are never unwrapped, only the whole answer
  const repairs = [];
  const nested = { outer: { answer: { a: 'x' } } };
  assert.deepEqual(normalizeNearMisses(obj({ outer: obj({ a: text({ min: 1, max: 20 }) }) }), nested, repairs), nested);
  assert.deepEqual(repairs, []);
});

// realistic frames for briefs that are NOT HABB: different domains, registers, lengths close to the limits, accents, quotes, dashes, digits in names
const CORPUS = [
  ['a perfume bottle', { merchant: 'Maison Aubrac, Lyon', product: 'Eau de parfum 50 ml, notes de figuier et de cèdre' }, {
    what_we_show: 'The bottle on a sun-warmed stone ledge, the glass catching one hard line of evening light, a fig leaf casting the only shadow.',
    audience: 'Adults 30–55 who buy fragrance as a gift or a ritual, in France and Belgium, and read a label before they trust a scent.',
    understood_immediately: 'A fig-and-cedar perfume from a small French house, a serious object rather than a department-store bottle.',
    felt: 'Late-summer stillness: warmth that is about to end, and the wish to keep it.',
    remembered: 'One leaf, one line of light, one bottle: "the scent of the last warm hour".',
    commercial_objective: 'Lift sales of the 50 ml bottle in the gifting window by making it feel rare, not discounted.',
    occasion_context: 'Gifting for an anniversary or a thank-you; also a quiet self-purchase at the change of season.',
    generic_risks: ['Floating bottle with petals and a pastel gradient', 'Model with closed eyes smelling her wrist', 'Gold-foil luxury clichés that every perfume uses'],
    distinctive_levers: ['The fig leaf as the only prop, tied to the real notes', 'A hard evening light line that reads as a place, not a studio', 'Stone and glass: mineral calm against organic scent'],
    rationale: 'The frame turns a smell into a time of day so the image can carry what a photograph cannot.',
  }],
  ['running shoes', { merchant: 'Strider Co.', product: 'Trail running shoe, 8 mm drop, recycled mesh' }, {
    what_we_show: 'The shoe mid-stride on wet slate, mud on the outsole, the lugs biting — shot low and close so the grip is the subject.',
    audience: 'Weekend trail runners who care about grip and durability more than colourways; sceptical of marketing, loyal to what works.',
    understood_immediately: 'A trail shoe that has actually been run in: grip first, looks second.',
    felt: 'The small thrill of a wet descent taken at speed with full confidence in your feet.',
    remembered: 'The mud-packed lugs, sharp against the slate — traction you can see.',
    commercial_objective: 'Win the comparison against two better-known trail shoes on proof of grip, not on price.',
    occasion_context: 'Autumn training season, when trails turn wet and runners replace worn pairs.',
    generic_risks: ['Spotless shoe on a white cyclorama', 'Runner silhouette at sunrise on a mountain ridge', 'Neon splash effects behind the shoe'],
    distinctive_levers: ['Real mud and real wear as the proof of use', 'A low camera that makes the outsole the hero'],
    rationale: 'Showing the shoe after the run replaces claims about grip with evidence the viewer can read at a glance.',
  }],
  ['a coffee subscription', { merchant: 'Torréfaction du Quai', product: 'Abonnement café en grains, livraison mensuelle' }, {
    what_we_show: 'A kitchen counter at 7 a.m.: the paper bag opened, beans spilling into a ceramic scoop, a half-drunk cup beside a handwritten roast date.',
    audience: 'Home coffee drinkers who have outgrown supermarket beans and want fresh roasting without having to remember to order.',
    understood_immediately: 'Freshly roasted beans arrive every month, picked by a roaster who signs the bag.',
    felt: 'A calm, unhurried start to the day — the pleasure of a small ritual that someone cared about.',
    remembered: 'The handwritten roast date on the bag.',
    commercial_objective: 'Convert one-off buyers into monthly subscribers by making the habit feel personal, not logistical.',
    occasion_context: 'The daily morning routine; a gift subscription at the end of the year.',
    generic_risks: ['Steam rising from a cup against a dark wooden table', 'Beans scattered in a heart shape', 'A barista pouring latte art'],
    distinctive_levers: ['The signed bag and the visible roast date as proof of craft', 'The ordinary kitchen instead of a café set'],
    rationale: 'A subscription sells reliability, so the frame makes the human hand behind each delivery visible.',
  }],
  ['B2B accounting software', { merchant: 'Ledgerly', product: 'Cloud accounting for small firms' }, {
    what_we_show: 'A tidy desk where a closed laptop sits beside a stack of paper receipts that has been reduced to one folded invoice.',
    audience: 'Owners of firms with fewer than ten employees who do the books themselves late in the evening and dread month-end.',
    understood_immediately: 'The month-end paperwork that used to take a night now takes minutes.',
    felt: 'Relief: the feeling of closing a laptop early and going home.',
    remembered: 'Many receipts shrunk to a single folded page.',
    commercial_objective: 'Start more free trials among owner-managers by promising time back, not features.',
    occasion_context: 'The end of each month and the quarterly VAT deadline.',
    generic_risks: ['Dashboard screenshots on a laptop', 'Smiling team high-fiving in an open-plan office', 'Blue gradients with floating charts'],
    distinctive_levers: ['The physical paper stack as a before-and-after, not the interface', 'Evening light that says the day ended on time'],
    rationale: 'Software is invisible, so the frame shows the paper it replaces and the time it returns.',
  }],
  ['funeral flowers', { merchant: 'Fleurs du Souvenir', product: 'Gerbe de deuil, livraison le jour même' }, {
    what_we_show: 'A single spray of white lilies laid on a plain wooden bench in soft overcast light, nothing else in the frame.',
    audience: 'People arranging flowers at short notice for a funeral, often in grief and unsure of what is appropriate.',
    understood_immediately: 'A dignified tribute that can be delivered today, chosen without having to find the right words.',
    felt: 'Quiet respect; a gentle sense that someone has helped carry a burden.',
    remembered: 'The stillness of the white lilies on an empty bench.',
    commercial_objective: 'Be the trusted choice for urgent orders by showing restraint and reliability rather than variety.',
    occasion_context: 'A bereavement, with little time to decide; tone must never feel promotional.',
    generic_risks: ['Stock crying hands or candles', 'Dark dramatic lighting', 'A catalogue grid of arrangements with prices'],
    distinctive_levers: ['Absence: the empty bench makes room for the person remembered', 'Overcast daylight, true to the day'],
    rationale: 'In grief a restrained image reads as respect, so the frame removes everything that could feel like a sale.',
  }],
  ['a wooden toy', { merchant: 'Petit Atelier', product: 'Wooden stacking toy for toddlers, beech, non-toxic paint' }, {
    what_we_show: 'The toy on a rug, half-built, with a small hand just entering the frame to place the last ring.',
    audience: 'Parents and grandparents of one-to-three-year-olds who prefer lasting, safe toys to plastic that breaks.',
    understood_immediately: 'A well-made wooden toy that is safe for toddlers and made to be passed on.',
    felt: 'The tenderness of watching a child concentrate; the pride of choosing something good.',
    remembered: 'The tiny hand placing the last ring.',
    commercial_objective: 'Make it the default gift for first birthdays by tying quality to the moment a child plays.',
    occasion_context: 'First and second birthdays and Christmas.',
    generic_risks: ['Toy in a white void with a drop shadow', 'Toddler laughing at the camera with a toy in the air', 'Pastel confetti backgrounds'],
    distinctive_levers: ['The hand entering the frame — scale and tenderness in one gesture'],
    rationale: 'The product is trusted when the viewer sees the child, so the frame shows play, never packaging.',
  }],
  ['jewellery', { merchant: 'Atelier Marais', product: 'Gold-plated silver ring, hand-engraved' }, {
    what_we_show: 'The ring resting on the pad of a finger, the engraving in sharp focus, a soft blur of linen behind it.',
    audience: 'Women 25–45 buying a meaningful piece for themselves or a partner; they zoom into details and read about craft.',
    understood_immediately: 'A hand-engraved ring: small, personal, made by a person.',
    felt: 'Intimacy — the closeness of something worn every day.',
    remembered: 'The engraving, readable in a thumbnail.',
    commercial_objective: 'Raise the share of engraved rings in orders by making the engraving the visible point.',
    occasion_context: 'Anniversaries, engagements, a personal milestone.',
    generic_risks: ['Ring on a velvet cushion under a spotlight', 'Sparkle effects added in post', 'Model hand with a heavy manicure'],
    distinctive_levers: ['Sharp macro focus on the engraving', 'Linen and skin instead of velvet and glitter'],
    rationale: 'Engraving is the reason to buy, so the frame spends its focus on it.',
  }],
  ['a restaurant offer', { merchant: 'Chez Odile', product: 'Menu du midi, deux plats et un dessert' }, {
    what_we_show: 'A table set for one by a sunny window: the plat du jour just arrived, bread torn, a blackboard menu visible at the edge.',
    audience: 'Office workers and retirees within walking distance who want a proper lunch without a long wait.',
    understood_immediately: 'A real two-course lunch at a fair price, served quickly, in a restaurant you can walk into today.',
    felt: 'The relief of a proper break in the middle of a busy day.',
    remembered: 'The torn bread beside the hot plate by the window.',
    commercial_objective: 'Fill weekday lunch covers by showing that the set menu is a treat, not a compromise.',
    occasion_context: 'Weekday lunch, between noon and two; seasonal updates each month.',
    generic_risks: ['Overhead flat-lay of dishes on rustic wood', 'Chef in a white hat smiling', 'Stock sizzling-pan action shots'],
    distinctive_levers: ['The single place setting, which invites the viewer to sit', 'The blackboard that proves the menu changes'],
    rationale: 'An offer at lunch wins when the viewer can already picture sitting down, so the frame sets one chair.',
  }],
];

test('AS-6 realistic frames for eight non-HABB briefs, flat or enveloped, pass the FRAME contract; the longest lines sit exactly at their limits', async () => {
  assert.equal(CORPUS.length, 8);
  for (const [name, facts, answer] of CORPUS) {
    const brief = buildBrief({ public_facts: facts });
    for (const reply of [answer, { answer }]) {
      const r = await askFrame([reply], brief);
      assert.equal(r.value.what_we_show, answer.what_we_show, name);
      assert.equal(r.value.generic_risks.length, answer.generic_risks.length, name);
      assert.equal(r.calls.length, 1, name);
    }
  }
  // a boundary text of exactly 300 characters is accepted, 301 is refused
  const at = (n) => 'a'.repeat(n);
  const brief = buildBrief();
  assert.equal((await askFrame([frame({ rationale: at(300) })], brief)).value.rationale.length, 300);
  await assert.rejects(askFrame([frame({ rationale: at(301) })], brief), (e) => e.code === 'BRAIN_TEXT_INVALID' || /rationale/.test(e.field));
});

test('AS-7 a genuinely poor frame is still refused: it is the content that is judged, never the envelope', async () => {
  const bad = [
    frame({ generic_risks: [] }),
    frame({ distinctive_levers: [] }),
    frame({ rationale: undefined }),
    frame({ felt: 7 }),
    frame({ unexpected_key: 'x' }),
    { answer: frame({ generic_risks: [] }) },
    { answer: frame(), rationale: 'a second top-level key next to the wrapper' },
  ];
  for (const reply of bad) {
    const calls = [];
    await assert.rejects(askFrame([JSON.parse(JSON.stringify(reply))]).then((r) => { calls.push(r); }), (e) => e.name === 'BrainError' && e.evidence.protocol_repair === undefined);
    assert.equal(calls.length, 0);
  }
});

test('AS-8 punctuation and Unicode variants a model writes are content, not errors; a key damaged by an invisible character is repaired once and journaled; duplicate keys are refused, never resolved', async () => {
  const base = frame();
  const variants = {
    non_breaking_space: (t) => t.replace(' ', ' '),
    curly_quotes: (t) => `“${t}”`,
    dashes: (t) => `${t} — and – ranges`,
    emoji: (t) => `${t} \u{1F3A8}`,
    accents: (t) => `${t} café à la crème d’été`,
    ampersand_slash_parens: (t) => `${t} (A/B & C)`,
    escaped_newline: (t) => t.replace(' ', '\n'),
  };
  for (const [name, change] of Object.entries(variants)) {
    const r = await askFrame([{ ...base, felt: change(base.felt).slice(0, 300) }]);
    assert.ok(r.value.felt.length > 0, name);
    assert.equal(r.calls.length, 1, name);
  }
  const damaged = JSON.parse(JSON.stringify(base)); damaged['felt​'] = damaged.felt; delete damaged.felt;
  const repaired = await askFrame([damaged]);
  assert.deepEqual(repaired.meta.key_repairs.map((r) => r.to), ['felt']);
  const upper = JSON.parse(JSON.stringify(base)); upper.Felt = upper.felt; delete upper.felt;
  assert.deepEqual((await askFrame([upper])).meta.key_repairs.map((r) => r.to), ['felt']);
  // two equal keys in one object: refused, with no re-ask and the answer kept as evidence
  const text = JSON.stringify(base).replace('{', '{"felt":"a different feeling of the same field",');
  await assert.rejects(askFrame([text]), (e) => e.code === 'BRAIN_RULE_VIOLATION' && e.detail.problem === 'DUPLICATE_KEY' && e.detail.words[0] === 'felt' && e.evidence.raw_answer === text && e.evidence.protocol_repair === undefined);
});
