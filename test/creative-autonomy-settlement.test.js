// F9 (independent review, 2026-11-01): the lane's SpendGuard reserves a call on an ESTIMATE (characters / 4) and settles it on the tokens the provider
// REPORTS, so a dense prompt could settle ABOVE the ceiling. The settlement guard (providers.js) refuses, before sending, any call whose PROVABLE maximum
// (UTF-8 bytes as tokens + template overhead, output at its cap, images by their pixel size) the ceiling cannot absorb. Fetch doubles only: no network, no cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendGuard } from '../src/marketing-creative/alibaba/budget.js';
import { createQwenBrainPort } from '../src/marketing-creative/alibaba/qwen-brain-port.js';
import { loadAlibabaCreativeConfig } from '../src/marketing-creative/alibaba/config.js';
import { connectProviders, guardSettlement, worstCaseCallEur, worstImageTokens, BUDGET_PRECHECK_REFUSED, TEMPLATE_OVERHEAD_TOKENS } from '../src/creative-autonomy/providers.js';
import { runAutonomous, RUN_STATUS } from '../src/creative-autonomy/run.js';
import { HABB_BRAND } from '../src/creative-autonomy/brief.js';
import { normalizeConceptSet } from '../src/creative-brain/concept.js';
import { frameAnswer, CONCEPTS, artDirectionAnswer, evaluationsAnswer } from './creative-brain-world.js';

const ENV = { ALIBABA_MODEL_STUDIO_API_KEY: 'sk-test-f9-0000000000', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-test-f9', ALIBABA_QWEN_TEXT_MODEL: 'qwen3-vl-plus', NORDLA_ALIBABA_SCOPE: 'EU' };
const bytesOf = (body) => body.messages.reduce((n, m) => n + Buffer.byteLength(typeof m.content === 'string' ? m.content : JSON.stringify(m.content), 'utf8'), 0);

/** A provider that reports the WORST tokenisation the guard allows for: one token per UTF-8 byte + the template overhead, and every output at its cap. */
function densestProvider({ answer = () => '{"ok":true}' } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); sent.push(body);
    return new Response(JSON.stringify({ id: `r${sent.length}`, model: body.model, choices: [{ message: { content: answer(body) } }], usage: { prompt_tokens: bytesOf(body) + TEMPLATE_OVERHEAD_TOKENS, completion_tokens: body.max_tokens } }), { status: 200 });
  };
  return { fetchImpl, sent };
}
const DENSE = `JSON. ${'é'.repeat(6000)}`; // 2 bytes per character: the reservation's chars/4 is 8x too low here

test('F9 characterised: the lane alone (no guard) settles ABOVE its ceiling on a dense prompt', async () => {
  const budget = new SpendGuard({ maxSpendEur: 0.11, maxImages: 0, maxVideoSeconds: 0 });
  const { fetchImpl } = densestProvider();
  const port = createQwenBrainPort({ config: loadAlibabaCreativeConfig(ENV), budget, maxCalls: 50, fetchImpl });
  for (let i = 0; i < 20; i += 1) { try { await port({ system: DENSE, user: '{}' }); } catch { break; } }
  assert.ok(budget.snapshot().settled_eur > 0.11, `settled ${budget.snapshot().settled_eur}: this is the weakness the guard closes`);
});

test('F9 closed: through connectProviders the same scenario never settles above the ceiling, and the refused call is NOT sent', async () => {
  for (const ceiling of [0.05, 0.11, 0.2, 1.5]) {
    const budget = new SpendGuard({ maxSpendEur: ceiling, maxImages: 0, maxVideoSeconds: 0 });
    const { fetchImpl, sent } = densestProvider();
    const { text } = connectProviders({ env: ENV, trialAuthorized: true, fetchImpl, budget, maxTextCalls: 200 });
    let refusal = null;
    for (let i = 0; i < 200; i += 1) { try { await text({ system: DENSE, user: '{}' }); } catch (e) { refusal = e; break; } }
    assert.ok(budget.snapshot().settled_eur <= ceiling + 1e-12, `ceiling ${ceiling}: settled ${budget.snapshot().settled_eur}`);
    assert.equal(refusal?.code, BUDGET_PRECHECK_REFUSED, `ceiling ${ceiling}: ${refusal?.code}`);
    const before = sent.length;
    await assert.rejects(() => text({ system: DENSE, user: '{}' }), (e) => e.code === BUDGET_PRECHECK_REFUSED);
    assert.equal(sent.length, before, 'a refused call never reaches the network');
  }
});

test('F9 property: whatever the script (ASCII, accents, emoji, CJK) the ledger never crosses the ceiling under the densest tokenisation', async () => {
  const alphabets = ['abcdefghij ', 'éèàçœ ', '🙂🌍🧭 ', '漢字仮名交じり ', '{"k":"v"} '];
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 40; round += 1) {
    const ceiling = 0.02 + rnd() * 0.3;
    const budget = new SpendGuard({ maxSpendEur: ceiling, maxImages: 0, maxVideoSeconds: 0 });
    const { fetchImpl } = densestProvider();
    const { text } = connectProviders({ env: ENV, trialAuthorized: true, fetchImpl, budget, maxTextCalls: 500 });
    for (let i = 0; i < 500; i += 1) {
      const a = alphabets[Math.floor(rnd() * alphabets.length)];
      const prompt = `JSON ${Array.from({ length: Math.floor(rnd() * 9000) }, () => a[Math.floor(rnd() * a.length)]).join('')}`;
      try { await text({ system: prompt, user: '{}' }); } catch (e) { if (e.code === BUDGET_PRECHECK_REFUSED || e.code === 'BRAIN_INPUT_TOO_LARGE') continue; throw e; }
    }
    assert.ok(budget.snapshot().settled_eur <= ceiling + 1e-12, `round ${round}: settled ${budget.snapshot().settled_eur} > ${ceiling}`);
  }
});

test('worst case of one call: bytes, not characters; images by their pixel size, never below 3 000 tokens', () => {
  const ascii = worstCaseCallEur({ texts: ['a'.repeat(1000)], maxOutputTokens: 4000, usdToEur: 1 });
  const accented = worstCaseCallEur({ texts: ['é'.repeat(1000)], maxOutputTokens: 4000, usdToEur: 1 });
  assert.equal(ascii.inputTokens, 1000 + TEMPLATE_OVERHEAD_TOKENS);
  assert.equal(accented.inputTokens, 2000 + TEMPLATE_OVERHEAD_TOKENS);
  const png = (w, h) => { const b = Buffer.alloc(24); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  assert.equal(worstImageTokens(png(540, 675)), 3000);
  assert.equal(worstImageTokens(png(4000, 4000)), Math.ceil(4000 / 28) ** 2 + 64);
  assert.equal(worstImageTokens(Buffer.from('not a png at all, really')), 16384, 'unknown image: the largest documented budget');
  const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('/tmp/some/path/without/an/IHDR/chunk')]);
  assert.equal(worstImageTokens(fake), 16384, 'a PNG signature without an IHDR chunk is not trusted for its size');
});

test('latch: once the ledger is above the ceiling (by any path), every further call is refused', () => {
  const budget = new SpendGuard({ maxSpendEur: 0.1, maxImages: 0, maxVideoSeconds: 0 });
  const precheck = guardSettlement(budget);
  const r = budget.reserveCost({ id: 'x', eur: 0.01 }); budget.settle(r, 0.2); // a settlement above the ceiling, simulated
  assert.throws(() => precheck({ texts: ['a'], maxOutputTokens: 1 }), (e) => e.code === BUDGET_PRECHECK_REFUSED);
  assert.throws(() => precheck({ texts: ['a'], maxOutputTokens: 1 }), (e) => e.code === BUDGET_PRECHECK_REFUSED);
});

test('in a run: the guard stops Nordla cleanly (STOPPED_ERROR), the ledger stays under the ceiling, the refusal is in the trace', async () => {
  const snap = JSON.parse(readFileSync(new URL('./fixtures/creative-autonomy/shopify-gourde-tyeso.json', import.meta.url), 'utf8'));
  const answer = (body) => {
    const system = body.messages[0].content; const user = body.messages[1].content;
    if (system.includes('problem framer')) return JSON.stringify(frameAnswer());
    if (system.includes('concept director')) return JSON.stringify({ concepts: CONCEPTS });
    if (system.includes('concept selector')) return JSON.stringify(evaluationsAnswer(normalizeConceptSet(CONCEPTS), []));
    const c = JSON.parse(user).concept;
    if (system.includes('art director')) return JSON.stringify(artDirectionAnswer({ narrative_elements: [{ element: 'one element of the set', reason: c.visual_metaphor, zone: 'BACKGROUND' }, { element: 'a second element', reason: c.story, zone: 'FOREGROUND' }] }));
    return JSON.stringify({ backdrop: 'SEAMLESS_SWEEP', backdrop_tone: 'CHARCOAL', floor_finish: 'SATIN', key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'NEUTRAL', purpose: 'double' }, accent_lights: [], camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' }, props: [], headline: 'Titre', text_placement: 'RIGHT_COLUMN', show_price: 'YES', rationale: 'double' });
  };
  const budget = new SpendGuard({ maxSpendEur: 0.12, maxImages: 0, maxVideoSeconds: 0 });
  const { fetchImpl, sent } = densestProvider({ answer });
  const ports = connectProviders({ env: ENV, trialAuthorized: true, fetchImpl, budget, maxTextCalls: 11 });
  const r = await runAutonomous({ mode: 'IDEATION_ONLY', maxRepairCalls: 2, input: { product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'o', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath: null }, ports: { ...ports, visionFor: null }, engines: {}, workdir: mkdtempSync(join(tmpdir(), 'f9-')) });
  assert.equal(r.status, RUN_STATUS.STOPPED_ERROR);
  assert.ok(budget.snapshot().settled_eur <= 0.12 + 1e-12, JSON.stringify(budget.snapshot()));
  assert.ok(sent.length < 9, `${sent.length} calls fitted`);
  assert.match(JSON.stringify(r.trace.at(-1).detail ?? r.error), /BUDGET_PRECHECK_REFUSED|PORT_FAILED/);
});
