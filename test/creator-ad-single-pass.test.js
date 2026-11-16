// THE SHORT PATH: ONE text answer (benefit, scene, headline, caption, or NONE), the software chooses the framing, at most ONE targeted correction planned only when both calls fit together under the text ceiling. OFFLINE; every model answer is SIMULATED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAdSinglePass, adSingleInstruction, planCorrection, adSinglePassSpec, AD_SINGLE_MAX_OUTPUT_TOKENS } from '../src/creative-autonomy/ad-single-pass.js';
import { loadAdProducts } from '../src/creative-autonomy/ad-products.js';
import { buildProductSheet } from '../src/creative-autonomy/product-sheet.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); const FIX = join(ROOT, 'test', 'fixtures', 'creative-autonomy', 'ad-develop-archive');
const KIT = JSON.parse(readFileSync(join(ROOT, 'config', 'creator', 'palette-habb.json'), 'utf8')); const USER = JSON.parse(readFileSync(join(FIX, 'tyeso-cr-547a597f5b44-user-block.json'), 'utf8'));
const OPTIONS = JSON.parse(readFileSync(join(FIX, 'remax-placement-options.json'), 'utf8'));
const entry = loadAdProducts().find('gid://shopify/Product/15507746914652'); const SHEET = buildProductSheet({ definition: entry.definition, snapshots: entry.snapshots, exam: null });
const IDEA = { verdict: 'IDEA', none_reason: '', benefit: 'Le client repart tout de suite, sans rien chercher.', need_shown: 'ready to be grabbed when the plans change',
  idea: 'A pale object rests on a light bench beside a half-open bag, ready to be grabbed when the plans change.', setting: 'A bright morning corner with clear walls and soft natural light.', materials: 'Pale wood and smooth plaster.', atmosphere: 'Lively and calm.', light: 'Soft natural light from the left.',
  text_reserve: { zone: 'TOP_RIGHT', description: 'A calm light wall surface in the upper right corner.' }, elements: [{ zone: 'BACKGROUND', element: 'A clear wall with a window' }, { zone: 'MIDGROUND', element: 'A light wooden bench' }], headline: 'Prêt quand tu changes de plan', headline_lines: 'TWO',
  caption: 'Pour les journées qui changent de plan : prêt à partir, sans y penser.\n#HABB #Namur', palette_roles: [{ colour: 'STEEL_NAVY', role: 'DOMINANT', surfaces: 'the wall accents' }, { colour: 'WHITE', role: 'LIGHT_TINT', surfaces: 'the bench highlight' }] };
const seq = (answers) => { const sent = []; return { sent, complete: async (i) => { sent.push(i); const a = answers[Math.min(sent.length - 1, answers.length - 1)]; return { text: typeof a === 'string' ? a : JSON.stringify(a), model: 'test-double', request_id: null, cost_eur: 0 }; } }; };
const args = (complete, extra = {}) => ({ complete, brief: USER.brief, productFacts: USER.product_facts, verifiedFacts: USER.verified_facts, placementOptions: OPTIONS, sceneProhibitions: USER.scene_prohibitions, kit: KIT, facts: null, profile: null, sheet: SHEET, ...extra });

test('SP-1 ONE call: an IDEA comes back as a composition with the framing chosen by the software, the caption, and the proposal records the pipeline needs; nothing about the product place or size was asked of the model', async () => {
  const m = seq([IDEA]); const r = await runAdSinglePass(args(m.complete)); assert.equal(m.sent.length, 1);
  assert.equal(r.composition.product_position, 'LEFT_THIRD'); assert.equal(r.composition.product_framing, 'MEDIUM'); assert.match(r.composition.placement_why, /framing rule of Nordla/); assert.equal(r.composition.caption, IDEA.caption); assert.equal(r.composition.intention, IDEA.idea);
  assert.equal(r.concepts.length, 1); assert.equal(r.selection.selection.concept_id, r.chosen_concept_id); assert.equal(r.chosen_proposal.visible_cues, IDEA.need_shown);
  const i = m.sent[0]; for (const w of ['In ONE answer you decide what the advertisement shows and says', 'NONE is valid and expected', 'copied WORD FOR WORD', 'THE SOFTWARE DECIDES THE FRAMING', 'THE CAPTION (caption)']) assert.ok(i.system.includes(w), w); assert.ok(!('placement_options' in JSON.parse(i.user)), 'the placement options are not sent');
  assert.equal(i.max_output_tokens, AD_SINGLE_MAX_OUTPUT_TOKENS);
});

test('SP-2 NONE ends the route after ONE call with Creator\'s own reason: no composition, no image, nothing paid after it; an IDEA whose need is not a passage of its own scene is refused (one call and ONE correction, no more)', async () => {
  const none = seq([{ verdict: 'NONE', none_reason: 'Aucune idée convaincante : rien ne montre un besoin.' }]); const e = await runAdSinglePass(args(none.complete)).then(() => null, (x) => x);
  assert.equal(e?.code, 'AD_NO_CONVINCING_IDEA'); assert.match(e.message, /Aucune idée convaincante/); assert.equal(none.sent.length, 1);
  const bad = seq([{ ...IDEA, need_shown: 'a whale sings under the bench' }, { ...IDEA, need_shown: 'a whale sings under the bench' }]); const e2 = await runAdSinglePass(args(bad.complete, { ceilingEur: 1 })).then(() => null, (x) => x); assert.equal(e2?.code, 'DIRECTION_AD_SINGLE_REFUSED'); assert.match(e2.message, /need_shown/); assert.equal(bad.sent.length, 2);
});

test('SP-3 ONE targeted correction: a refused caption is patched alone and the rest of the answer is identical; the correction is planned only when both calls fit together in the text ceiling (0.0932 fits, a tight ceiling plans none)', async () => {
  const badCaption = { ...IDEA, caption: 'Seulement 34,90 € cette semaine !\n#HABB' };
  const fixed = seq([badCaption, '{"patches":[{"path":"caption","value":"Pour les journées qui changent de plan : prêt à partir.\\n#HABB"}]}']); const r = await runAdSinglePass(args(fixed.complete, { ceilingEur: 0.0932 }));
  assert.equal(fixed.sent.length, 2); assert.equal(r.composition.caption, 'Pour les journées qui changent de plan : prêt à partir.\n#HABB'); assert.equal(r.composition.headline, IDEA.headline); assert.ok(r.worst_case_text.correction_planned);
  const tight = seq([badCaption]); const e = await runAdSinglePass(args(tight.complete, { ceilingEur: 0.04 })).then(() => null, (x) => x); assert.equal(e?.code, 'DIRECTION_AD_SINGLE_REFUSED'); assert.equal(tight.sent.length, 1, 'no correction was planned: one call only');
});

test('SP-4 THE WORST CASE OF THE TEXT, before any call, priced as the guard prices it (every input byte, the output cap): the first call, the one correction, both together, against the 0.0932 ceiling', () => {
  const first = adSingleInstruction({ kit: KIT, brief: USER.brief, productFacts: USER.product_facts, verifiedFacts: USER.verified_facts, sceneProhibitions: USER.scene_prohibitions });
  const p = planCorrection({ first, ceilingEur: 0.0932 }); assert.ok(p.first_worst_eur > 0.02 && p.first_worst_eur < 0.06, JSON.stringify(p)); assert.ok(p.correction_worst_eur > 0.02 && p.correction_worst_eur < 0.06, JSON.stringify(p));
  assert.ok(Math.abs(p.together_eur - (p.first_worst_eur + p.correction_worst_eur)) < 0.0002); assert.equal(p.correction_planned, p.together_eur <= 0.0932); assert.ok('caption' in adSinglePassSpec(KIT).fields);
});

test('SP-5 a NONE with EMPTY scene fields and a reason longer than 300 characters (the real answer of cr-b45e9463d81a) is ACCEPTED as NONE after ONE call: no correction is asked, no idea is forced out of it', async () => {
  const real = { verdict: 'NONE', none_reason: 'Aucun détail visible dans la scène ne montre un besoin concret. '.repeat(7), benefit: '', need_shown: '', idea: '', setting: '', materials: '', atmosphere: '', light: '', text_reserve: { zone: 'TOP_RIGHT', description: 'Surface claire.' }, elements: [], headline: '', headline_lines: 'ONE', caption: '', palette_roles: [] };
  assert.ok(real.none_reason.length > 300); const m = seq([real]); const e = await runAdSinglePass(args(m.complete, { ceilingEur: 0.0932 })).then(() => null, (x) => x);
  assert.equal(e?.code, 'AD_NO_CONVINCING_IDEA', e?.message); assert.equal(m.sent.length, 1, 'one call, no correction'); assert.ok(e.detail.none_reason.length <= 300);
});
