// Reliability after the first real trial (trial-61e7eeb84a2de902, 2026-11-01): 5 real answers, then STAGE refused with BRAIN_TEXT_INVALID on stage.rationale
// (over the 300-character limit: the recorded text is 351 characters as the validator counts them; "361" was the figure first reported, never measured on
// the file), and the real ART_DIRECT answer contained leaves and foliage, which HABB forbids.
// The contract is NOT weakened: the limit stays 300. The prompt now asks for 180-220 characters, HABB's rules bind ART_DIRECT, and a bounded, AUTHORISED repair
// (one more call of the same stage, with the exact violation) can recover a well-formed answer that broke one rule. Without that authorisation: no extra call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAutonomous, RUN_STATUS, REPAIRABLE } from '../src/creative-autonomy/run.js';
import { normalizeStage, buildStageInstruction, STAGE_SPEC, assertArtDirectionHabbRules, hasForbidden, HABB_ART_DIRECTION_HINT, createStageDirector } from '../src/creative-autonomy/stage-contract.js';
import { HABB_BRAND } from '../src/creative-autonomy/brief.js';
import { normalizeConceptSet } from '../src/creative-brain/concept.js';
import { BRAIN_ERROR } from '../src/creative-brain/validation.js';
import { frameAnswer, CONCEPTS, artDirectionAnswer, evaluationsAnswer } from './creative-brain-world.js';

// SYNTHETIC (labelled): a rationale of exactly 361 characters, a boundary case well over the limit. It is NOT the real text and NOT its length (the real
// recorded rationale is 351 characters); the REAL text is tested below, read-only, when its file is provided.
const R361 = 'Un décor sombre et calme où la lumière rasante dessine la gourde comme un objet de quartier que l’on croise sans le chercher, avec un socle mat qui la pose au niveau du regard, une lame de lumière froide qui découpe sa silhouette, un fond profond qui laisse respirer le titre à droite et une matière brute qui rappelle la ville, pour que l’envie de la découvrir naisse sur place.'.padEnd(361, '.').slice(0, 361);
const snap = JSON.parse(readFileSync(new URL('./fixtures/creative-autonomy/shopify-gourde-tyeso.json', import.meta.url), 'utf8'));
const [CONCEPT] = normalizeConceptSet(CONCEPTS);
const baseStage = (c, over = {}) => ({ backdrop: 'SEAMLESS_SWEEP', backdrop_tone: 'CHARCOAL', floor_finish: 'SATIN', key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'NEUTRAL', purpose: 'double' }, accent_lights: [], camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' }, props: [{ shape: 'BLOCK', material: 'CONCRETE', placement: 'BESIDE_RIGHT', scale: 'LOW', reason: c.visual_metaphor }], headline: 'Titre de test', text_placement: 'RIGHT_COLUMN', show_price: 'YES', rationale: 'double', ...over });

/** TEST_DOUBLE language port with per-call scripted deviations. */
function port({ stage = () => ({}), art = () => ({}), fail = () => null } = {}) {
  const calls = [];
  const complete = async ({ system, user }) => {
    const kind = system.includes('problem framer') ? 'FRAME' : system.includes('concept director') ? 'IDEATE' : system.includes('concept selector') ? 'SELECT' : system.includes('art director') ? 'ART_DIRECT' : 'STAGE';
    calls.push({ kind, system, user });
    const n = calls.filter((c) => c.kind === kind).length;
    const f = fail(kind, n); if (f) throw f;
    let body;
    if (kind === 'FRAME') body = frameAnswer();
    else if (kind === 'IDEATE') body = { concepts: CONCEPTS };
    else if (kind === 'SELECT') body = evaluationsAnswer(normalizeConceptSet(CONCEPTS), []);
    else if (kind === 'ART_DIRECT') { const c = JSON.parse(user).concept; body = artDirectionAnswer({ narrative_elements: [{ element: 'one element of the set', reason: c.visual_metaphor, zone: 'BACKGROUND' }, { element: 'a second element', reason: c.story, zone: 'FOREGROUND' }], ...art(c, n) }); }
    else { const c = JSON.parse(user).concept; body = baseStage(c, stage(c, n)); }
    return { text: JSON.stringify(body), model: 'TEST_DOUBLE', request_id: `td-${calls.length}`, cost_eur: 0 };
  };
  return { complete, calls };
}
const run = (p, maxRepairCalls = 0) => runAutonomous({ mode: 'IDEATION_ONLY', maxRepairCalls, input: { product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'Donner envie aux habitants de Namur de découvrir la gourde TYESO noire chez HABB', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath: null }, ports: { text: p.complete, visionFor: null, state: { text: 'TEST_DOUBLE', vision: 'NOT_CONNECTED' } }, engines: {}, workdir: mkdtempSync(join(tmpdir(), 'rel-')) });

// ---------------- 1. rationale: target in the prompt, hard limit unchanged
test('STAGE prompt asks for ONE concise rationale of 180 to 220 characters; the contract limit stays 300', () => {
  const { system } = buildStageInstruction({ frame: {}, concept: CONCEPT, artDirection: {}, facts: {} });
  assert.match(system, /rationale: ONE concise sentence of about 180 to 220 characters \(the contract refuses more than 300\)/);
  assert.equal(STAGE_SPEC.fields.rationale.max, 300);
});

test('a 361-character rationale is refused with BRAIN_TEXT_INVALID on stage.rationale (synthetic boundary case); 300 passes, 301 does not', () => {
  assert.equal(R361.length, 361);
  assert.throws(() => normalizeStage(baseStage(CONCEPT, { rationale: R361 }), { concept: CONCEPT, personalisation_offered: false }), (e) => e.code === BRAIN_ERROR.TEXT_INVALID && e.field === 'stage.rationale');
  assert.ok(normalizeStage(baseStage(CONCEPT, { rationale: 'x'.repeat(300) }), { concept: CONCEPT, personalisation_offered: false }));
  assert.throws(() => normalizeStage(baseStage(CONCEPT, { rationale: 'x'.repeat(301) }), { concept: CONCEPT, personalisation_offered: false }), /TEXT_INVALID|rationale/);
});

// the REAL answers of trial-61e7eeb84a2de902 stay PRIVATE: they are never copied into the repository. The two tests below read them, read-only, from the folder
// named by NORDLA_REAL_TRIAL_CALLS (for example the replay's copy: <diag>\\brain-calls-copy). Without it they are skipped.
const REAL = process.env.NORDLA_REAL_TRIAL_CALLS || '';
const realFile = (re) => (REAL && existsSync(REAL) ? readdirSync(REAL).find((f) => re.test(f)) : null);
const SKIP_REAL = 'set NORDLA_REAL_TRIAL_CALLS to a COPY of the real brain-calls folder (outside the repository)';
/**
 * The PRODUCTION path of a STAGE answer: createStageDirector -> askAndNormalize (near-miss normalisation of the closed contract, e.g. an empty optional
 * field removed) -> normalizeStage. The port is a replay that returns the recorded text unchanged: no network, one call, nothing rewritten.
 */
async function stageThroughTheBrain(recordedText, { concept, artDirection = {}, frame = {}, facts = {} }) {
  const calls = [];
  const complete = async (instruction) => { calls.push(instruction); return { text: recordedText, model: 'REPLAY_OF_RECORDED_ANSWER', request_id: null }; };
  try { const { stage } = await createStageDirector({ complete }).stage({ frame, concept, artDirection, facts }); return { stage, error: null, calls }; } catch (error) { return { stage: null, error, calls }; }
}
const validatorLength = (t) => t.normalize('NFC').trim().replace(/ {2,}/g, ' ').length; // exactly how oneLine() measures

test('REAL trial answer: the recorded STAGE response, through the Brain\'s own path, is refused on stage.rationale (over the contract limit)', { skip: !realFile(/^\d+-STAGE-.*\.response\.txt$/) && SKIP_REAL }, async () => {
  const recordedText = readFileSync(join(REAL, realFile(/^\d+-STAGE-.*\.response\.txt$/)), 'utf8'); // read-only, passed on byte for byte
  const req = JSON.parse(readFileSync(join(REAL, realFile(/^\d+-STAGE-.*\.request\.json$/)), 'utf8'));
  const user = JSON.parse(req.user);
  const max = STAGE_SPEC.fields.rationale.max;
  const measured = validatorLength(JSON.parse(recordedText).rationale);
  assert.ok(measured > max, `the real rationale (${measured} characters) is over the ${max}-character limit`);
  const { error, calls } = await stageThroughTheBrain(recordedText, { concept: user.concept, artDirection: user.art_direction, frame: user.problem_frame, facts: user.verified_facts ?? {} });
  assert.equal(calls.length, 1, 'one replayed answer, no protocol re-ask');
  assert.ok(error, 'the recorded answer is refused');
  assert.equal(error.code, BRAIN_ERROR.TEXT_INVALID);
  assert.equal(error.field, 'stage.rationale');
  assert.deepEqual({ length: error.detail?.length, limit: error.detail?.limit }, { length: measured, limit: max });
});

test('local fixture (synthetic): an EMPTY optional props[].word is removed by the Brain\'s path, as in production; normalizeStage alone would refuse it', async () => {
  const [concept] = normalizeConceptSet(CONCEPTS);
  const withEmptyWord = (rationale) => JSON.stringify(baseStage(concept, { rationale, props: [{ shape: 'BLOCK', material: 'CONCRETE', placement: 'BESIDE_RIGHT', scale: 'LOW', reason: concept.visual_metaphor, word: '' }] }));
  const long = `${'é'.repeat(10)}${'x'.repeat(341)}`; // 351 characters, like the recorded one; not its text
  // the shortcut the earlier test took: the empty optional field fails first
  assert.throws(() => normalizeStage(JSON.parse(withEmptyWord(long)), { concept, personalisation_offered: false }), (e) => e.code === BRAIN_ERROR.TEXT_INVALID && e.field === 'stage.props[0].word');
  // the production path: the empty optional field is normalised away, the real violation is reported
  const refused = await stageThroughTheBrain(withEmptyWord(long), { concept });
  assert.equal(refused.error?.code, BRAIN_ERROR.TEXT_INVALID);
  assert.equal(refused.error?.field, 'stage.rationale');
  assert.deepEqual({ length: refused.error.detail.length, limit: refused.error.detail.limit }, { length: 351, limit: STAGE_SPEC.fields.rationale.max });
  // and with a rationale within the limit the same answer is ACCEPTED, the empty optional word removed (not invented, not kept empty)
  const accepted = await stageThroughTheBrain(withEmptyWord('Un socle mat pour poser la gourde au niveau du regard.'), { concept });
  assert.equal(accepted.error, null, String(accepted.error));
  assert.equal('word' in accepted.stage.props[0], false);
  // a NON-empty word that breaks the contract is still refused (normalisation removes only EMPTY optional fields)
  const badWord = await stageThroughTheBrain(JSON.stringify(baseStage(concept, { props: [{ shape: 'BLOCK', material: 'CONCRETE', placement: 'BESIDE_RIGHT', scale: 'LOW', reason: concept.visual_metaphor, word: 'MOTBEAUCOUPTROPLONG' }] })), { concept });
  assert.equal(badWord.error?.code, BRAIN_ERROR.TEXT_INVALID);
  assert.equal(badWord.error?.field, 'stage.props[0].word');
});

test('REAL trial answer: the recorded ART_DIRECT response is refused by HABB\'s rules (leaves / foliage)', { skip: !realFile(/^\d+-ART_DIRECT-.*\.response\.txt$/) && SKIP_REAL }, () => {
  const raw = JSON.parse(readFileSync(join(REAL, realFile(/^\d+-ART_DIRECT-.*\.response\.txt$/)), 'utf8'));
  assert.throws(() => assertArtDirectionHabbRules(raw), (e) => e.code === BRAIN_ERROR.FORBIDDEN_CONTENT && /leaves|leaf|foliage|feuill/.test(e.message));
});
test('privacy: no recorded model answer and no brain-calls folder is inside the repository', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const found = [];
  const PRIVATE_DIRS = /^(brain-calls|brain-calls-copy|real-trial-.*|nordla-essais|nordla-diagnostics|\.nordla)$/;
  const PRIVATE_FILES = /(\.response\.txt|\.calls\.jsonl|^RAPPORT\.md|^REPLAY\.md|^replay\.json|^propositions\.json|^trace\.json|^trial-[0-9a-f]{16}\.(lock|plan\.json|result\.json))$/;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.git'].includes(e.name)) continue; const p = join(d, e.name); if (e.isDirectory()) { if (PRIVATE_DIRS.test(e.name)) found.push(p); else walk(p); } else if (PRIVATE_FILES.test(e.name) || (e.name.endsWith('.request.json') && /\d+-(FRAME|IDEATE|SELECT|ART_DIRECT|STAGE)/.test(e.name))) found.push(p); } };
  walk(root);
  assert.deepEqual(found, []);
});

// ---------------- 2. bounded, authorised repair
test('no repair authorised (default): a 361-character rationale stops the run at STAGE, with no extra call', async () => {
  const p = port({ stage: (c, n) => (n === 1 ? { rationale: R361 } : {}) });
  const r = await run(p, 0);
  assert.equal(r.status, RUN_STATUS.STOPPED_ERROR);
  assert.equal(r.error.code, BRAIN_ERROR.TEXT_INVALID);
  assert.equal(p.calls.filter((c) => c.kind === 'STAGE').length, 1);
  assert.deepEqual(r.repairs, { used: 0, allowed: 0 });
});

test('one repair authorised: STAGE is asked ONCE more with the exact violation, the run completes, the refused answer stays in the trace', async () => {
  const p = port({ stage: (c, n) => (n === 1 ? { rationale: R361 } : {}) });
  const r = await run(p, 1);
  assert.equal(r.status, RUN_STATUS.IDEATION_ONLY_NOT_A_VISUAL, JSON.stringify(r.error ?? null));
  const steps = r.trace.map((t) => `${t.step}:${t.outcome}`);
  assert.ok(steps.includes('STAGE:ERROR') && steps.includes('STAGE_REPAIR:STAGED'));
  const failed = r.trace.find((t) => t.step === 'STAGE' && t.outcome === 'ERROR');
  assert.equal(failed.detail.code, BRAIN_ERROR.TEXT_INVALID);
  const repairCall = p.calls.filter((c) => c.kind === 'STAGE')[1];
  assert.match(repairCall.system, /REFUSED by Nordla's contract: BRAIN_TEXT_INVALID at stage\.rationale/);
  assert.deepEqual(r.repairs, { used: 1, allowed: 1 });
  assert.equal(p.calls.length, 10, '9 planned calls + 1 authorised repair');
});

test('the repair budget is for the whole run: a second violation stops the run (no unbounded retry)', async () => {
  const p = port({ stage: (c, n) => (n === 1 || n === 3 ? { rationale: R361 } : {}) });
  const r = await run(p, 1);
  assert.equal(r.status, RUN_STATUS.STOPPED_ERROR);
  assert.deepEqual(r.repairs, { used: 1, allowed: 1 });
});

test('a repair that fails again stops the run (never two repairs for one stage call)', async () => {
  const p = port({ stage: (c, n) => (n <= 2 ? { rationale: R361 } : {}) });
  const r = await run(p, 5);
  assert.equal(r.status, RUN_STATUS.STOPPED_ERROR);
  assert.equal(p.calls.filter((c) => c.kind === 'STAGE').length, 2);
});

test('a provider failure is never "repaired" (no retry policy): only contract violations are repairable', async () => {
  const portFailure = Object.assign(new Error('HTTP 500'), { code: 'HTTP_500' });
  const p = port({ fail: (kind, n) => (kind === 'STAGE' && n === 1 ? portFailure : null) });
  const r = await run(p, 3);
  assert.equal(r.status, RUN_STATUS.STOPPED_ERROR);
  assert.equal(r.error.code, BRAIN_ERROR.PORT_FAILED);
  assert.equal(p.calls.filter((c) => c.kind === 'STAGE').length, 1);
  assert.equal(REPAIRABLE.has(BRAIN_ERROR.PORT_FAILED), false);
  assert.equal(REPAIRABLE.has(BRAIN_ERROR.MALFORMED), false, 'malformed JSON keeps its own single protocol repair inside the port');
});

// ---------------- 3. HABB's forbidden visual elements from ART_DIRECT on
test('ART_DIRECT receives HABB\'s hard rules from its FIRST call', async () => {
  const p = port();
  await run(p, 0);
  const firstArt = p.calls.find((c) => c.kind === 'ART_DIRECT');
  assert.ok(firstArt.system.includes(HABB_ART_DIRECTION_HINT));
});

test('foliage in the art direction is refused (no repair authorised: the run stops before STAGE)', async () => {
  const p = port({ art: () => ({ material_language: 'Matte stone, soft foliage shadows and brushed metal.' }) });
  const r = await run(p, 0);
  assert.equal(r.status, RUN_STATUS.STOPPED_ERROR);
  assert.equal(r.error.code, BRAIN_ERROR.FORBIDDEN_CONTENT);
  assert.match(r.error.message, /art_direction\.material_language.*foliage/);
  assert.equal(p.calls.filter((c) => c.kind === 'STAGE').length, 0);
});

test('foliage with one authorised repair: ART_DIRECT is asked again with the exact violation and the run completes', async () => {
  const p = port({ art: (c, n) => (n === 1 ? { narrative_elements: [{ element: 'dry leaves on the stone', reason: c.visual_metaphor, zone: 'FOREGROUND' }] } : {}) });
  const r = await run(p, 1);
  assert.equal(r.status, RUN_STATUS.IDEATION_ONLY_NOT_A_VISUAL, JSON.stringify(r.error ?? null));
  assert.match(p.calls.filter((c) => c.kind === 'ART_DIRECT')[1].system, /HABB forbids: leaves/);
});

test('HABB rules: naming them in forbidden_decorative_noise is allowed; the verb "leaves" and "feuille de papier" are not foliage', () => {
  const ok = { atmosphere: 'calm', material_language: 'une feuille de papier blanc, acier brossé', lighting_intent: 'the light leaves the frame on the right', rationale: 'r', narrative_elements: [{ element: 'a step', reason: 'it leaves room for the product' }], permitted_secondary_elements: [], forbidden_decorative_noise: ['leaves', 'foliage', 'beige', 'gold'] };
  assert.doesNotThrow(() => assertArtDirectionHabbRules(ok));
  for (const bad of ['green leaves on the table', 'des feuilles mortes', 'soft foliage', 'a golden glow', 'beige linen', 'botanical shadows']) assert.ok(hasForbidden(bad), bad);
  assert.throws(() => assertArtDirectionHabbRules({ ...ok, permitted_secondary_elements: ['eucalyptus sprig'] }), /permitted_secondary_elements\[0\].*eucalyptus/);
});

// ---------------- 4. offline replay of recorded answers: read-only on the trial folder, lock untouched, no network
test('replay: the recorded answers are judged against the current contracts offline; the trial folder and its lock are untouched', { timeout: 60_000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  // a trial folder shaped like the real one: FRAME, IDEATE, SELECT, ART_DIRECT (with foliage, accepted at the time), STAGE (rationale over the limit: the synthetic 361-character text)
  const trial = mkdtempSync(join(tmpdir(), 'trial-copy-'));
  const p = port({ stage: (c, n) => (n === 1 ? { rationale: R361 } : {}) });
  await runAutonomous({ mode: 'IDEATION_ONLY', input: { product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'o', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath: null }, ports: { text: p.complete, visionFor: null, state: { text: 'TEST_DOUBLE', vision: 'NOT_CONNECTED' } }, engines: {}, workdir: join(trial, 'gourde-noire') });
  const calls = join(trial, 'gourde-noire', 'brain-calls');
  const artFile = readdirSync(calls).find((f) => /-ART_DIRECT-.*\.response\.txt$/.test(f));
  const art = JSON.parse(readFileSync(join(calls, artFile), 'utf8')); art.material_language = 'Wet stone, soft foliage and brushed steel.';
  writeFileSync(join(calls, artFile), JSON.stringify(art));
  writeFileSync(join(trial, 'trial-test.lock'), '{"started_at":"x"}');
  writeFileSync(join(trial, 'trial-test.calls.jsonl'), '{"event":"SUCCEEDED"}\n');
  assert.equal(readdirSync(calls).filter((f) => f.endsWith('.response.txt')).length, 5);

  const diag = join(mkdtempSync(join(tmpdir(), 'diag-')), 'replay');
  const script = fileURLToPath(new URL('../scripts/creative-autonomy-replay.mjs', import.meta.url));
  const res = spawnSync(process.execPath, [script, '--trial', trial, '--product', 'gourde-noire', '--diag', diag]);
  assert.equal(res.status, 0, res.stderr.toString());
  const report = JSON.parse(readFileSync(join(diag, 'replay.json'), 'utf8'));
  assert.equal(report.network_calls, 0); assert.equal(report.trial_dir_read_only.read_only_respected, true);
  assert.deepEqual(report.trial_dir_read_only.locks_found, ['trial-test.lock']);
  assert.ok(existsSync(join(trial, 'trial-test.lock')));
  const by = Object.fromEntries(report.results.map((r) => [r.stage, r]));
  assert.equal(by.FRAME.current_contract, 'ACCEPTED'); assert.equal(by.IDEATE.current_contract, 'ACCEPTED'); assert.equal(by.SELECT.current_contract, 'ACCEPTED');
  assert.equal(by.ART_DIRECT.current_contract, 'REFUSED'); assert.equal(by.ART_DIRECT.refusal.code, BRAIN_ERROR.FORBIDDEN_CONTENT);
  assert.equal(by.STAGE.current_contract, 'REFUSED'); assert.equal(by.STAGE.refusal.field, 'stage.rationale'); assert.equal(by.STAGE.rationale_chars, 361);
  assert.match(readFileSync(join(diag, 'REPLAY.md'), 'utf8'), /intact : \*\*oui\*\*/);
  assert.ok(!res.stdout.toString().includes(R361.slice(0, 40)) && !res.stdout.toString().includes('foliage'), 'the console shows statuses, never the model\'s text');
  // refused: a diagnostic folder inside the trial folder
  assert.notEqual(spawnSync(process.execPath, [script, '--trial', trial, '--product', 'gourde-noire', '--diag', join(trial, 'diag')]).status, 0);
});

test('replay: an authorised repair answer (STAGE_REPAIR) is judged by its stage\'s contract', { timeout: 60_000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  const trial = mkdtempSync(join(tmpdir(), 'trial-rep-'));
  const p = port({ stage: (c, n) => (n === 1 ? { rationale: R361 } : {}) });
  await runAutonomous({ mode: 'IDEATION_ONLY', maxRepairCalls: 1, input: { product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'o', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath: null }, ports: { text: p.complete, visionFor: null, state: { text: 'TEST_DOUBLE', vision: 'NOT_CONNECTED' } }, engines: {}, workdir: join(trial, 'gourde-noire') });
  const diag = join(mkdtempSync(join(tmpdir(), 'diag-')), 'r');
  const res = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/creative-autonomy-replay.mjs', import.meta.url)), '--trial', trial, '--product', 'gourde-noire', '--diag', diag]);
  assert.equal(res.status, 0, res.stderr.toString());
  const rows = JSON.parse(readFileSync(join(diag, 'replay.json'), 'utf8')).results;
  const repair = rows.find((r) => r.repair);
  assert.equal(repair.stage, 'STAGE'); assert.equal(repair.current_contract, 'ACCEPTED');
  assert.equal(rows.filter((r) => r.stage === 'STAGE' && r.current_contract === 'REFUSED').length, 1);
});

// ---------------- hard limits on the REAL lane objects (Qwen port, SpendGuard), with a fetch double: no network
import { connectProviders } from '../src/creative-autonomy/providers.js';
import { SpendGuard } from '../src/marketing-creative/alibaba/budget.js';
const LANE_ENV = { ALIBABA_MODEL_STUDIO_API_KEY: 'sk-test-limits-00000000', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-test-limits', ALIBABA_QWEN_TEXT_MODEL: 'qwen3-vl-plus', NORDLA_ALIBABA_SCOPE: 'EU' };
function laneFetch({ stageRationale = () => 'double' } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); const system = body.messages[0].content; const user = body.messages[1].content;
    const kind = system.includes('problem framer') ? 'FRAME' : system.includes('concept director') ? 'IDEATE' : system.includes('concept selector') ? 'SELECT' : system.includes('art director') ? 'ART_DIRECT' : 'STAGE';
    sent.push(kind); const n = sent.filter((k) => k === kind).length;
    let a;
    if (kind === 'FRAME') a = frameAnswer(); else if (kind === 'IDEATE') a = { concepts: CONCEPTS }; else if (kind === 'SELECT') a = evaluationsAnswer(normalizeConceptSet(CONCEPTS), []);
    else if (kind === 'ART_DIRECT') { const c = JSON.parse(user).concept; a = artDirectionAnswer({ narrative_elements: [{ element: 'one element of the set', reason: c.visual_metaphor, zone: 'BACKGROUND' }, { element: 'a second element', reason: c.story, zone: 'FOREGROUND' }] }); }
    else { const c = JSON.parse(user).concept; a = baseStage(c, { rationale: stageRationale(n) }); }
    return new Response(JSON.stringify({ id: `r${sent.length}`, model: body.model, choices: [{ message: { content: JSON.stringify(a) } }], usage: { prompt_tokens: 3000, completion_tokens: 800 } }), { status: 200 });
  };
  return { fetchImpl, sent };
}
const runLane = (ports, maxRepairCalls) => runAutonomous({ mode: 'IDEATION_ONLY', maxRepairCalls, input: { product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'o', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath: null }, ports: { ...ports, visionFor: null }, engines: {}, workdir: mkdtempSync(join(tmpdir(), 'lane-')) });

test('call cap: the Qwen port refuses the call past its cap BEFORE sending it; an invalid answer cannot loop', async () => {
  const f = laneFetch({ stageRationale: () => R361 }); // every STAGE answer is invalid
  const ports = connectProviders({ env: LANE_ENV, trialAuthorized: true, fetchImpl: f.fetchImpl, maxTextCalls: 6 });
  const r = await runLane(ports, 2);
  assert.equal(r.status, RUN_STATUS.STOPPED_ERROR);
  assert.ok(f.sent.length <= 6, `sent ${f.sent.length}`);
  assert.equal(f.sent.filter((k) => k === 'STAGE').length, 2, 'one STAGE + exactly one repair, then stop');
});

test('two-repair limit for the whole run: three invalid answers end the run after exactly 2 repairs', async () => {
  const f = laneFetch({ stageRationale: (n) => ([1, 3, 5].includes(n) ? R361 : 'double') }); // concept 1: bad, repaired; concept 2: bad, repaired; concept 3: bad, no repair left
  const ports = connectProviders({ env: LANE_ENV, trialAuthorized: true, fetchImpl: f.fetchImpl, maxTextCalls: 14 });
  const r = await runLane(ports, 2);
  assert.deepEqual(r.repairs, { used: 2, allowed: 2 });
  assert.equal(r.status, RUN_STATUS.STOPPED_ERROR);
  assert.equal(f.sent.filter((k) => k === 'STAGE').length, 5, '3 STAGE calls + 2 repairs, none more');
});

test('budget: when the next call\'s worst case would cross the ceiling, it is refused before being sent', async () => {
  const f = laneFetch();
  const budget = new SpendGuard({ maxSpendEur: 0.03, maxImages: 0, maxVideoSeconds: 0 });
  const ports = connectProviders({ env: LANE_ENV, trialAuthorized: true, fetchImpl: f.fetchImpl, maxTextCalls: 14, budget });
  const r = await runLane(ports, 2);
  assert.equal(r.status, RUN_STATUS.STOPPED_ERROR);
  const snapBudget = budget.snapshot();
  assert.ok(snapBudget.settled_eur + snapBudget.reserved_eur <= 0.03 + 1e-9, JSON.stringify(snapBudget));
  assert.ok(f.sent.length < 9, `only ${f.sent.length} calls fitted under the ceiling`);
});

test('no authorisation, no call: a configured key without the trial authorisation sends nothing', async () => {
  const f = laneFetch();
  const ports = connectProviders({ env: LANE_ENV, fetchImpl: f.fetchImpl });
  const r = await runLane(ports, 2);
  assert.equal(r.status, RUN_STATUS.STOPPED_PROVIDER_NOT_CONNECTED);
  assert.equal(f.sent.length, 0);
});
