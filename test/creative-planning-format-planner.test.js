import test from 'node:test';
import assert from 'node:assert/strict';

import { createDecisionLedger } from '../src/creative-runtime/ledger.js';
import { BrainError } from '../src/creative-brain/validation.js';
import {
  briefForAsset, createContentFormatPlanner, createCopyAdapter, createCopyWriter, stripSpace,
} from '../src/creative-planning/index.js';
import { buildBrief } from './runtime-world.js';
import {
  copy, fact, longText, priceFact, request, scriptedCopyPort,
} from './creative-planning-world.js';

// THE CONTENT FORMAT PLANNER (`// FP-N` markers): what to create is decided before how; text is distributed, never lost or rewritten unless the copy policy allows it; asking is the exception.

const planner = (deps = {}) => createContentFormatPlanner(deps);
const filler = (chars) => { const w = ['alpha', 'bravo', 'delta', 'ecole', 'fruit', 'glace']; let t = ''; let i = 0; while (t.length < chars) { t += (t ? ' ' : '') + w[i % w.length]; i += 1; } return t.slice(0, chars).trim(); };
const placedPieces = (plan, ref) => [...plan.assets.flatMap((a) => a.slots.flatMap((s) => s.pieces)), ...(plan.caption?.pieces ?? [])].filter((p) => p.unit_ref === ref);
const lockedWords = (plan, ref) => stripSpace(placedPieces(plan, ref).filter((p) => p.origin === 'LOCKED').sort((a, b) => a.start - b.start).map((p) => p.text).join(''));
const codes = (plan) => plan.questions.map((q) => q.code);

test('FP-1 the existing single-image workflow stays the same: the bridge returns the identical brief', async () => {
  const { requestFromBrief } = await import('../src/creative-planning/index.js');
  const brief = buildBrief();
  const plan = await planner().plan(requestFromBrief(brief));
  assert.equal(plan.status, 'PLANNED'); assert.equal(plan.format.kind, 'SINGLE_IMAGE'); assert.equal(plan.executable, true);
  assert.equal(plan.assets.length, 1); assert.equal(plan.caption, null);
  assert.deepEqual(plan.assets[0].slots.map((s) => s.role), ['HEADLINE', 'SUBHEADLINE', 'PRICE']);
  assert.equal(plan.assets[0].canvas_source, 'CALLER_RESOURCE');
  assert.deepEqual(briefForAsset({ brief, plan }), brief);
});

test('FP-2 the format is decided BEFORE the canvas: the same words get another kind and another canvas for another channel', async () => {
  const p = planner();
  const text = 'Vos souvenirs. Votre création.';
  const base = { copy: [copy({ role: 'HEADLINE', text })] };
  const feed = await p.plan(request({ ...base, channel: 'SOCIAL_FEED' }));
  const story = await p.plan(request({ ...base, channel: 'STORY' }));
  const window = await p.plan(request({ ...base, channel: 'STORE_WINDOW' }));
  const print = await p.plan(request({ ...base, channel: 'PRINT' }));
  assert.deepEqual([feed, story, window, print].map((x) => x.format.kind), ['SINGLE_IMAGE', 'SINGLE_IMAGE', 'POSTER', 'FLYER']);
  assert.deepEqual([feed, story, window, print].map((x) => x.assets[0].aspect_ratio), ['4:5', '9:16', '181:256', '310:437']);
  assert.ok([feed, story, window, print].every((x) => x.assets[0].canvas_source === 'STANDARD_RESOURCE'), 'no canvas was supplied: it comes from the decided format');
  // a canvas supplied by the caller never changes the decision of the kind
  const withCanvas = await p.plan(request({ ...base, channel: 'SOCIAL_FEED', canvas: { format_ref: 'format://x/sq', canvas: { width: 1080, height: 1080, unit: 'px' }, medium: 'DIGITAL' } }));
  assert.equal(withCanvas.format.kind, feed.format.kind); assert.equal(withCanvas.assets[0].aspect_ratio, '1:1'); assert.equal(withCanvas.assets[0].canvas_source, 'CALLER_RESOURCE');
});

test('FP-3 a 300-word input never ends in TEXT_DOES_NOT_FIT: it becomes a sequence, or a single asset with a caption', async () => {
  const p = planner();
  const sectioned = longText(300, 5); const block = longText(300, 1);
  const a = await p.plan(request({ channel: 'SOCIAL_FEED', copy: [copy({ text: sectioned })] }));
  assert.equal(a.status, 'PLANNED'); assert.equal(a.format.kind, 'CAROUSEL'); assert.equal(a.format.rule, 'SECTIONED_LONG_TEXT_BECOMES_A_SEQUENCE'); assert.ok(a.assets.length >= 4 && a.assets.length <= 10);
  assert.equal(a.caption, null); assert.deepEqual(codes(a), []);
  assert.equal(lockedWords(a, 'copy://main'), stripSpace(sectioned), 'every word is on an asset, in order');
  const b = await p.plan(request({ channel: 'SOCIAL_FEED', copy: [copy({ text: block })] }));
  assert.equal(b.format.kind, 'SINGLE_IMAGE'); assert.ok(b.caption && b.caption.chars > 1000); assert.equal(b.executable, true);
  assert.equal(b.assets[0].slots[0].role, 'HEADLINE', 'the first whole sentence is the headline');
  assert.equal(lockedWords(b, 'copy://main'), stripSpace(block));
  const c = await p.plan(request({ channel: 'SOCIAL_FEED', constraints: [{ kind: 'ALL_TEXT_ON_ASSET' }], copy: [copy({ text: block })] }));
  assert.equal(c.format.kind, 'CAROUSEL'); assert.equal(c.caption, null); assert.equal(lockedWords(c, 'copy://main'), stripSpace(block));
  const d = await p.plan(request({ channel: 'STORE_WINDOW', constraints: [{ kind: 'ALL_TEXT_ON_ASSET' }], copy: [copy({ text: block })] }));
  assert.equal(d.format.kind, 'MULTI_VISUAL_SERIES'); assert.ok(d.assets.every((x) => x.aspect_ratio === '181:256'));
  assert.equal(lockedWords(d, 'copy://main'), stripSpace(block));
  for (const plan of [a, b, c, d]) assert.ok(!JSON.stringify(plan).includes('TEXT_DOES_NOT_FIT'));
});

test('FP-4 locked copy is distributed over assets and caption without a single altered word, for every length', async () => {
  const p = planner();
  for (const words of [1, 8, 40, 120, 300, 600, 1200]) {
    for (const paragraphs of [1, 3, 6]) {
      for (const channel of ['SOCIAL_FEED', 'STORY', 'STORE_WINDOW']) {
        const text = longText(words, paragraphs);
        const plan = await p.plan(request({ channel, copy: [copy({ text })] }));
        if (plan.status !== 'PLANNED') { assert.deepEqual(codes(plan), ['TEXT_CANNOT_BE_PLACED_WITHOUT_ALTERING_IT'], `${words}/${paragraphs}/${channel}`); continue; }
        assert.equal(lockedWords(plan, 'copy://main'), stripSpace(text), `${words}/${paragraphs}/${channel}`);
        assert.ok(plan.assets.length >= 1);
      }
    }
  }
});

test('FP-5 an impossible request asks — only then, and with a precise code', async () => {
  const p = planner();
  const huge = longText(3000, 12);
  const noCaption = await p.plan(request({ channel: 'STORE_WINDOW', copy: [copy({ text: huge })] }));
  assert.equal(noCaption.status, 'NEEDS_USER_DECISION'); assert.deepEqual(codes(noCaption), ['TEXT_CANNOT_BE_PLACED_WITHOUT_ALTERING_IT']);
  assert.ok(noCaption.questions[0].blocking && noCaption.questions[0].options.includes('ALLOW_CONDENSING'));
  const fixed = await p.plan(request({ channel: 'SOCIAL_FEED', requested_format: 'SINGLE_IMAGE', constraints: [{ kind: 'FORMAT_IS_FIXED' }, { kind: 'ALL_TEXT_ON_ASSET' }], copy: [copy({ text: longText(300, 1) })] }));
  assert.deepEqual(codes(fixed), ['REQUESTED_FORMAT_CANNOT_HOLD_THE_LOCKED_TEXT']);
  const same = await p.plan(request({ channel: 'SOCIAL_FEED', requested_format: 'SINGLE_IMAGE', copy: [copy({ text: longText(300, 1) })] }));
  assert.equal(same.status, 'PLANNED', 'a requested format that is not fixed gives way when it cannot hold the text');
  assert.equal(same.format.requested_format_not_applicable, undefined, 'a single asset with a caption holds it, so the request is honoured');
  const contradictory = await p.plan(request({ requested_format: 'CAROUSEL', constraints: [{ kind: 'SINGLE_ASSET_ONLY' }] }));
  assert.deepEqual(codes(contradictory), ['CONSTRAINTS_CONTRADICT_EACH_OTHER']);
  const tooMany = await p.plan(request({ requested_asset_count: 6, constraints: [{ kind: 'MAX_ASSETS', value: 3 }] }));
  assert.deepEqual(codes(tooMany), ['CONSTRAINTS_CONTRADICT_EACH_OTHER']);
  const nothing = await p.plan({ request_ref: 'r', copy: [] });
  assert.deepEqual(codes(nothing), ['NOTHING_TO_SAY']);
  assert.equal(nothing.format, null); assert.equal(nothing.executable, false); assert.deepEqual(nothing.assets, []);
});

test('FP-6 what is not material is never asked: no format, no channel, no objective, no audience, no price', async () => {
  const plan = await planner().plan({ request_ref: 'r', copy: [copy({ text: 'Une coque à votre image' })] });
  assert.equal(plan.status, 'PLANNED'); assert.deepEqual(plan.questions, []);
  assert.equal(plan.format.kind, 'SINGLE_IMAGE'); assert.equal(plan.format.basis, 'DEFAULTED'); assert.equal(plan.format.rule, 'NO_CHANNEL_MEANS_A_GENERIC_DIGITAL_FEED');
  assert.equal(plan.assets[0].aspect_ratio, '4:5');
  const unknownChannel = await planner().plan(request({ channel: 'MY_NEWSLETTER' }));
  assert.equal(unknownChannel.status, 'PLANNED'); assert.equal(unknownChannel.format.channel_profile, 'GENERIC_DIGITAL');
});

test('FP-7 a carousel can be selected as a format plan although its production does not exist yet', async () => {
  const plan = await planner().plan(request({ channel: 'SOCIAL_FEED', requested_format: 'CAROUSEL', requested_asset_count: 7, copy: [copy({ text: longText(150, 4) })] }));
  assert.equal(plan.format.kind, 'CAROUSEL'); assert.equal(plan.assets.length, 7); assert.equal(plan.executable, false);
  assert.ok(plan.assets.every((a) => a.execution.status === 'PLANNED_NOT_EXECUTABLE' && a.execution.reasons.includes('MULTI_ASSET_PRODUCTION_NOT_AVAILABLE')));
  assert.equal(plan.assets[0].asset_role, 'COVER');
  const texts = plan.assets.map((a) => a.slots.map((s) => s.text).join('|'));
  assert.equal(new Set(texts.filter(Boolean)).size, texts.filter(Boolean).length, 'a different text on each slide');
  assert.throws(() => briefForAsset({ brief: buildBrief(), plan, assetIndex: 0 }), (e) => e instanceof BrainError && e.detail.problem === 'ASSET_NOT_EXECUTABLE');
});

test('FP-8 video can be selected and is honestly PLANNED_NOT_EXECUTABLE, with a still alternative as a plan of its own', async () => {
  const explicit = await planner().plan(request({ channel: 'SOCIAL_FEED', requested_format: 'PROMOTIONAL_VIDEO' }));
  assert.equal(explicit.format.kind, 'PROMOTIONAL_VIDEO'); assert.equal(explicit.status, 'PLANNED'); assert.equal(explicit.executable, false);
  assert.deepEqual(explicit.execution, { status: 'PLANNED_NOT_EXECUTABLE', reasons: ['VIDEO_PRODUCTION_NOT_AVAILABLE'] });
  assert.deepEqual(explicit.assets, []);
  assert.equal(explicit.alternative.format.kind, 'SINGLE_IMAGE'); assert.equal(explicit.alternative.executable, true);
  assert.deepEqual(codes(explicit), ['VIDEO_NOT_PRODUCIBLE_CHOOSE_ALTERNATIVE']); assert.equal(explicit.questions[0].blocking, false);
  const tiktok = await planner().plan(request({ channel: 'TIKTOK' }));
  assert.equal(tiktok.format.kind, 'SHORT_VIDEO'); assert.equal(tiktok.format.basis, 'CHANNEL'); assert.equal(tiktok.alternative.assets[0].aspect_ratio, '9:16');
  assert.equal(tiktok.executable, false);
});

test('FP-9 several channels make a campaign plan whose members are decided per channel', async () => {
  const plan = await planner().plan(request({ channels: ['INSTAGRAM', 'TIKTOK', 'STORE_WINDOW'], copy: [copy({ role: 'HEADLINE', text: 'Vos souvenirs. Votre création.' })] }));
  assert.equal(plan.format.kind, 'MULTI_ASSET_CAMPAIGN'); assert.equal(plan.executable, false);
  assert.deepEqual(plan.members.map((m) => [m.channel_profile, m.kind]), [['SOCIAL_FEED', 'SINGLE_IMAGE'], ['VIDEO_FEED', 'SHORT_VIDEO'], ['STORE_WINDOW', 'POSTER']]);
  assert.deepEqual(plan.execution, { status: 'PLANNED_NOT_EXECUTABLE', reasons: ['CAMPAIGN_PRODUCTION_NOT_AVAILABLE'] });
});

test('FP-10 "five different images" and "a 7-slide carousel" are honoured as asked', async () => {
  const five = await planner().plan(request({ channel: 'SOCIAL_FEED', requested_asset_count: 5, copy: [copy({ text: longText(60, 3) })] }));
  assert.equal(five.format.kind, 'MULTI_VISUAL_SERIES'); assert.equal(five.assets.length, 5); assert.ok(five.assets.every((a) => a.asset_role === 'ITEM'));
  const seven = await planner().plan(request({ channel: 'SOCIAL_FEED', requested_format: 'CAROUSEL', requested_asset_count: 7, copy: [copy({ role: 'HEADLINE', text: 'Sept idées' }), copy({ copy_ref: 'copy://b', text: longText(100, 3) })] }));
  assert.equal(seven.assets.length, 7);
  const tooShort = await planner().plan(request({ requested_format: 'CAROUSEL', requested_asset_count: 6 }));
  assert.equal(tooShort.assets.length, 6, 'a requested count larger than the text needs gives assets without text');
  assert.ok(tooShort.assets.some((a) => a.execution.reasons.includes('ASSET_HAS_NO_TEXT')));
});

test('FP-11 a plan is deterministic, frozen, and ledger-attributed to Nordla components in the order of the stages', async () => {
  const ledger = createDecisionLedger();
  const req = request({ channel: 'SOCIAL_FEED', copy: [copy({ text: longText(100, 2) })] });
  const a = await planner({ ledger }).plan(req);
  const b = await planner().plan(JSON.parse(JSON.stringify(req)));
  assert.equal(a.content_plan_id, b.content_plan_id); assert.match(a.content_plan_id, /^cpl_/);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.assets) && Object.isFrozen(a.assets[0].slots[0].pieces[0]));
  assert.deepEqual(ledger.entries().map((e) => e.decision), ['INPUT_UNDERSTANDING', 'CONTENT_ANALYSIS', 'FORMAT_PLAN']);
  assert.ok(ledger.entries().every((e) => e.decided_by.startsWith('nordla:')));
  assert.equal(ledger.of('FORMAT_PLAN')[0].outcome.kind, a.format.kind);
  assert.ok(!JSON.stringify(ledger.entries()).includes('Phrase numéro'), 'the ledger holds no copy');
});

test('FP-12 the plan is provider-independent: no provider, model or vendor name appears in a plan or in the planning source', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const plan = await planner().plan(request({ channel: 'SOCIAL_FEED', copy: [copy({ text: longText(80, 2) })] }));
  const NAMES = /qwen|alibaba|dashscope|openai|gpt|gemini|nano-?banana|minimax|wan3|anthropic|claude/i;
  assert.ok(!NAMES.test(JSON.stringify(plan)));
  const dir = new URL('../src/creative-planning/', import.meta.url);
  for (const f of readdirSync(dir)) assert.ok(!NAMES.test(readFileSync(new URL(f, dir), 'utf8')), `${f} names no provider`);
});

test('FP-13 multilingual and extreme inputs: very short, very long, Chinese, Arabic, Dutch, emoji', async () => {
  const p = planner();
  const cases = ['A', 'Oui', '我们的工坊位于那慕尔。我们把您的照片印在定制手机壳上。每件产品都经过人工检查。'.repeat(40), 'ورشتنا في نامور تطبع صورك على أغطية الهواتف المخصصة. '.repeat(60), 'Ons atelier in Namen drukt uw foto’s op hoesjes. '.repeat(50), 'Offrez un souvenir 🎁✨ à ceux que vous aimez 👨‍👩‍👧‍👦. '.repeat(30)];
  for (const text of cases) {
    const plan = await p.plan(request({ channel: 'SOCIAL_FEED', copy: [copy({ text })] }));
    assert.equal(plan.status, 'PLANNED', text.slice(0, 20));
    assert.equal(lockedWords(plan, 'copy://main'), stripSpace(text), text.slice(0, 20));
  }
  const one = await p.plan(request({ copy: [copy({ text: 'A' })] }));
  assert.equal(one.assets[0].slots[0].role, 'HEADLINE'); assert.equal(one.density.band, 'LOW');
});

test('FP-14 density is measured, not guessed', async () => {
  const plan = await planner().plan(request({ channel: 'SOCIAL_FEED', copy: [copy({ text: longText(300, 5) })] }));
  assert.ok(plan.density.words >= 280 && plan.density.words <= 330); assert.equal(plan.density.band, 'MEDIUM'); assert.ok(plan.density.sections >= 4);
  const short = await planner().plan(request());
  assert.equal(short.density.band, 'LOW'); assert.equal(short.density.body_chars, 0);
});

test('FP-15 copy ports are optional and degrade honestly: an adaptable text with no adapter stays exactly as written', async () => {
  const long = 'Un titre très long qui dépasse largement l’espace prévu pour un titre sur une image, parce qu’il raconte presque toute l’histoire de l’atelier et de ses créations.';
  const plan = await planner().plan(request({ channel: 'SOCIAL_FEED', copy: [copy({ mode: 'COPY_ADAPTABLE', role: 'HEADLINE', text: long })] }));
  assert.equal(plan.status, 'PLANNED'); assert.equal(lockedWords(plan, 'copy://main'), stripSpace(long));
  assert.ok(plan.notes.some((n) => n.note === 'ADAPTER_NOT_CONNECTED_TEXT_STAYS_UNCHANGED'));
  assert.deepEqual(plan.events, []);
});

test('FP-16 the adapter is used only when the policy allows and the text does not fit; a refused adaptation leaves the text untouched', async () => {
  const long = 'Un titre très long qui dépasse largement l’espace prévu pour un titre sur une image, parce qu’il raconte presque toute l’histoire de l’atelier.';
  const short = 'Un titre court';
  const ok = scriptedCopyPort('adapt', [{ text: 'L’histoire de l’atelier en un titre', rationale: 'Shortened, same meaning.' }]);
  const adapter = createCopyAdapter({ complete: ok.complete });
  const fits = await planner({ copyAdapter: adapter }).plan(request({ copy: [copy({ mode: 'COPY_ADAPTABLE', role: 'HEADLINE', text: short })] }));
  assert.equal(ok.calls.length, 0, 'an adaptable text that fits is never touched');
  assert.equal(fits.assets[0].slots[0].pieces[0].origin, 'LOCKED');
  const adapted = await planner({ copyAdapter: adapter }).plan(request({ copy: [copy({ mode: 'COPY_ADAPTABLE', role: 'HEADLINE', text: long })] }));
  assert.equal(ok.calls.length, 1);
  assert.equal(adapted.assets[0].slots[0].pieces[0].origin, 'ADAPTED'); assert.equal(adapted.assets[0].slots[0].text, 'L’histoire de l’atelier en un titre');
  assert.equal(adapted.executable, true); assert.equal(adapted.events[0].kind, 'ADAPTED');
  const locked = scriptedCopyPort('adapt', [{ text: 'x', rationale: 'y' }]);
  const lockedPlan = await planner({ copyAdapter: createCopyAdapter({ complete: locked.complete }) }).plan(request({ copy: [copy({ mode: 'COPY_LOCKED', role: 'HEADLINE', text: long })] }));
  assert.equal(locked.calls.length, 0, 'a locked text is never sent to an adapter'); assert.equal(lockedWords(lockedPlan, 'copy://main'), stripSpace(long));
  const changesFigure = scriptedCopyPort('adapt', [{ text: 'Coque à 30 € seulement', rationale: 'Shorter.' }]);
  const priced = 'Notre coque personnalisée à 25 € est imprimée avec votre photo préférée dans notre atelier de Namur, prête en cinq minutes chrono.';
  const refused = await planner({ copyAdapter: createCopyAdapter({ complete: changesFigure.complete }) }).plan(request({ copy: [copy({ mode: 'COPY_ADAPTABLE', role: 'HEADLINE', text: priced })] }));
  assert.equal(lockedWords(refused, 'copy://main'), stripSpace(priced), 'the text stays as written');
  assert.equal(refused.events[0].kind, 'ADAPTATION_REFUSED'); assert.equal(refused.events[0].problem, 'FIGURE_CHANGED');
  assert.ok(refused.notes.some((n) => n.note === 'ADAPTATION_REFUSED_TEXT_STAYS_UNCHANGED'));
});

test('FP-17 an adaptable body is condensed only when nothing else can hold it', async () => {
  const body = Array(20).fill('Notre atelier de Namur imprime vos photos sur des coques personnalisées avec soin.').join(' '); // no figure in it: an adaptation may not change one
  const answer = { text: 'Résumé fidèle de l’atelier de Namur et de ses coques personnalisées.', rationale: 'Condensed.' };
  const port = scriptedCopyPort('adapt', [answer, answer, answer]);
  const adapter = createCopyAdapter({ complete: port.complete });
  const caption = await planner({ copyAdapter: adapter }).plan(request({ channel: 'SOCIAL_FEED', copy: [copy({ mode: 'COPY_ADAPTABLE', text: body })] }));
  assert.equal(port.calls.length, 0, 'a caption can hold it, so nothing is condensed');
  assert.equal(caption.format.kind, 'SINGLE_IMAGE');
  const window = await planner({ copyAdapter: adapter }).plan(request({ channel: 'STORE_WINDOW', constraints: [{ kind: 'ALL_TEXT_ON_ASSET' }, { kind: 'SINGLE_ASSET_ONLY' }], copy: [copy({ mode: 'COPY_ADAPTABLE', text: body })] }));
  assert.equal(port.calls.length, 1); assert.equal(window.status, 'PLANNED'); assert.equal(window.format.kind, 'POSTER');
  const pieces = placedPieces(window, 'copy://main');
  assert.ok(pieces.some((p) => p.origin === 'ADAPTED'), 'the body was condensed');
  assert.ok(pieces.filter((p) => p.origin === 'LOCKED').every((p) => body.includes(p.text)), 'the first sentence promoted to the headline is still verbatim');
});

test('FP-18 generatable copy is written from verified facts only; it never invents a fact', async () => {
  const good = scriptedCopyPort('write', [{ text: 'Coques personnalisées, prêtes en cinq minutes', uses_fact_refs: ['fact://descr'], rationale: 'From the descriptive fact.' }]);
  const plan = await planner({ copyWriter: createCopyWriter({ complete: good.complete }) }).plan(request({
    channel: 'SOCIAL_FEED', copy: [{ copy_ref: 'copy://gen', mode: 'COPY_GENERATABLE', purpose: 'HEADLINE' }], facts: [fact(), fact({ fact_ref: 'fact://est', status: 'ESTIMATE', statement: 'Environ 200 clients par mois' }), fact({ fact_ref: 'fact://unk', status: 'UNKNOWN', statement: 'Certifié ISO' })],
  }));
  assert.equal(plan.assets[0].slots[0].pieces[0].origin, 'GENERATED'); assert.equal(plan.executable, true);
  const facts = JSON.parse(good.calls[0].instruction.user).facts.map((f) => f.fact_ref);
  assert.deepEqual(facts, ['fact://descr'], 'an estimate and an unknown are never offered to the writer');
  assert.equal(plan.events[0].kind, 'GENERATED'); assert.deepEqual(plan.events[0].uses_fact_refs, ['fact://descr']);
});

test('FP-19 generation that invents a price, a number, a name or a claim is refused and the asset stays not executable', async () => {
  const bad = [
    { text: 'Coque à 19 € seulement', uses_fact_refs: ['fact://descr'] },
    { text: 'La meilleure coque garantie', uses_fact_refs: ['fact://descr'] },
    { text: 'Coque de la marque Acme', uses_fact_refs: ['fact://descr'] },
    { text: 'Coque prête en 5 minutes', uses_fact_refs: ['fact://descr'] },
    { text: 'Coque personnalisée', uses_fact_refs: ['fact://invented'] },
    { text: 'Coque personnalisée', uses_fact_refs: [] },
  ];
  for (const answer of bad) {
    const port = scriptedCopyPort('write', [{ ...answer, rationale: 'x' }]);
    const plan = await planner({ copyWriter: createCopyWriter({ complete: port.complete }) }).plan(request({ copy: [{ copy_ref: 'copy://gen', mode: 'COPY_GENERATABLE', purpose: 'HEADLINE' }], facts: [fact()] }));
    assert.equal(plan.events[0].kind, 'GENERATION_FAILED', JSON.stringify(answer));
    assert.equal(plan.executable, false); assert.ok(plan.assets[0].execution.reasons.includes('COPY_NOT_YET_GENERATED'));
    assert.equal(plan.assets[0].slots[0].pieces[0].origin, 'PENDING_GENERATION');
  }
});

test('FP-20 a price is generated only from a price fact; no verified fact means a question, not an invention', async () => {
  const port = scriptedCopyPort('write', [{ text: 'Votre coque à 25 €', uses_fact_refs: ['fact://price'], rationale: 'From the price fact.' }]);
  const writer = createCopyWriter({ complete: port.complete });
  const withPrice = await planner({ copyWriter: writer }).plan(request({ copy: [{ copy_ref: 'copy://gen', mode: 'COPY_GENERATABLE', purpose: 'SUBHEADLINE', fact_refs: ['fact://price'] }], facts: [priceFact()] }));
  assert.equal(withPrice.assets[0].slots[0].text, 'Votre coque à 25 €');
  const none = await planner({ copyWriter: writer }).plan(request({ copy: [{ copy_ref: 'copy://gen', mode: 'COPY_GENERATABLE', purpose: 'HEADLINE' }], facts: [fact({ status: 'ESTIMATE' })] }));
  assert.deepEqual(codes(none), ['NOTHING_VERIFIED_TO_GENERATE_FROM']); assert.equal(none.status, 'NEEDS_USER_DECISION');
  const cta = scriptedCopyPort('write', [{ text: 'Découvrez-la', uses_fact_refs: [], rationale: 'A call to action needs no fact.' }]);
  const ctaPlan = await planner({ copyWriter: createCopyWriter({ complete: cta.complete }) }).plan(request({ copy: [{ copy_ref: 'copy://gen', mode: 'COPY_GENERATABLE', purpose: 'CTA' }] }));
  assert.equal(ctaPlan.assets[0].slots[0].role, 'CTA'); assert.equal(ctaPlan.assets[0].slots[0].pieces[0].origin, 'GENERATED');
});

test('FP-21 without a writer the generated copy is pending, never faked; generation forbidden contradicts a generatable text', async () => {
  const pending = await planner().plan(request({ copy: [{ copy_ref: 'copy://gen', mode: 'COPY_GENERATABLE', purpose: 'HEADLINE' }], facts: [fact()] }));
  assert.equal(pending.executable, false); assert.equal(pending.assets[0].slots[0].pieces[0].origin, 'PENDING_GENERATION');
  assert.ok(pending.notes.some((n) => n.note === 'COPY_WRITER_NOT_CONNECTED'));
  const forbidden = await planner().plan(request({ constraints: [{ kind: 'NO_GENERATED_COPY' }], copy: [{ copy_ref: 'copy://gen', mode: 'COPY_GENERATABLE', purpose: 'HEADLINE' }], facts: [fact()] }));
  assert.deepEqual(codes(forbidden), ['CONSTRAINTS_CONTRADICT_EACH_OTHER']);
});

test('FP-22 the multimodal input contract feeds the planner: observations are recorded in the plan, and a port can supply facts', async () => {
  const ports = { STRUCTURED_FACTS: { async understand() { return { descriptors: [] }; } }, PRODUCT_IMAGE: { async understand() { return { descriptors: ['a phone case, upright, plain background'] }; } } };
  const port = scriptedCopyPort('write', [{ text: 'Coque personnalisée à Namur', uses_fact_refs: ['fact://from-source'], rationale: 'x' }]);
  const plan = await planner({ understanding: ports, copyWriter: createCopyWriter({ complete: port.complete }) }).plan(request({
    copy: [{ copy_ref: 'copy://gen', mode: 'COPY_GENERATABLE', purpose: 'HEADLINE' }],
    sources: [
      { source_kind: 'STRUCTURED_FACTS', ref: 'facts://f', facts: [fact({ fact_ref: 'fact://from-source', statement: 'Coque personnalisée à Namur' })] },
      { source_kind: 'PRODUCT_IMAGE', ref: 'asset://p', width_px: 600, height_px: 800 },
      { source_kind: 'REFERENCE_IMAGE', ref: 'asset://r', role: 'STYLE' },
    ],
  }));
  assert.equal(plan.observation_ids.length, 3); assert.equal(plan.assets[0].slots[0].pieces[0].origin, 'GENERATED');
});

test('FP-23 FUZZ: whatever the request, a plan is valid, frozen, within the declared limits, and never alters a locked word', async () => {
  const mulberry = (seed) => () => { let t = (seed += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = mulberry(7);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const p = planner();
  for (let n = 0; n < 120; n += 1) {
    const words = pick([0, 3, 12, 40, 90, 200, 300, 700]);
    const text = words ? longText(words, pick([1, 2, 4, 8])) : null;
    const constraints = [pick([null, { kind: 'ALL_TEXT_ON_ASSET' }]), pick([null, null, { kind: 'SINGLE_ASSET_ONLY' }]), pick([null, null, { kind: 'MAX_ASSETS', value: 4 }])].filter(Boolean);
    const req = request({
      channel: pick([null, 'SOCIAL_FEED', 'STORY', 'STORE_WINDOW', 'PRINT', 'TIKTOK', 'NEWSLETTER']),
      requested_format: pick([null, null, 'SINGLE_IMAGE', 'CAROUSEL', 'POSTER', 'MULTI_VISUAL_SERIES']),
      constraints, copy: text ? [copy({ text, role: pick([null, 'BODY', 'HEADLINE']) })] : [],
    });
    if (!text) req.facts = [fact()];
    let plan;
    try { plan = await p.plan(req); } catch (error) { assert.ok(error instanceof BrainError, `unexpected failure ${error?.message}`); continue; }
    assert.ok(['PLANNED', 'NEEDS_USER_DECISION'].includes(plan.status));
    assert.ok(Object.isFrozen(plan));
    if (plan.status === 'PLANNED' && plan.assets.length) {
      assert.ok(plan.assets.length <= 10);
      if (text) assert.equal(lockedWords(plan, 'copy://main'), stripSpace(text), `fuzz ${n}`);
      for (const a of plan.assets) for (const s of a.slots) if (['HEADLINE', 'SUBHEADLINE', 'PRICE', 'CTA'].includes(s.role)) assert.ok(s.chars <= { HEADLINE: 100, SUBHEADLINE: 50, PRICE: 28, CTA: 24 }[s.role], `fuzz ${n}: ${s.role} within its capacity`);
      if (plan.caption) assert.ok(plan.caption.chars <= 2200 + 2 * plan.caption.pieces.length);
    }
    if (plan.status === 'NEEDS_USER_DECISION') assert.ok(plan.questions.some((q) => q.blocking));
  }
});

test('FP-24 the role capacity is exact: a headline of exactly the capacity stays a headline, one character more is demoted to the body (unchanged)', async () => {
  const exact = filler(100); const over = filler(101);
  const a = await planner().plan(request({ channel: 'SOCIAL_FEED', copy: [copy({ role: 'HEADLINE', text: exact })] }));
  assert.equal(a.assets[0].slots[0].role, 'HEADLINE'); assert.equal(a.executable, true);
  const b = await planner().plan(request({ channel: 'SOCIAL_FEED', copy: [copy({ role: 'HEADLINE', text: over })] }));
  assert.equal(b.assets[0].slots.length, 0, 'a demoted body goes to the caption'); assert.equal(b.caption.text, over);
  const price = await planner().plan(request({ channel: 'STORE_WINDOW', constraints: [{ kind: 'ALL_TEXT_ON_ASSET' }], copy: [copy({ role: 'HEADLINE', text: over })] }));
  assert.equal(price.assets[0].slots[0].role, 'BODY'); assert.equal(price.executable, false);
  assert.ok(price.assets[0].execution.reasons.includes('ROLE_HAS_NO_LAYOUT_SLOT:BODY'));
});
