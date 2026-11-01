// After the real trial trial-40ce77ef0af9e1f3 (2026-11-01): 6 calls, three concepts, then STOPPED_ERROR "a plinth goes beneath, and only a plinth".
//   first STAGE : PLINTH/BENEATH, PANEL/BEHIND, BLOCK/FOREGROUND_LEFT   (refused on a rule this file does NOT assume: every plausible one is covered)
//   STAGE_REPAIR: BLOCK/BENEATH,  PANEL/BEHIND, SPHERE/FOREGROUND_LEFT  (refused: only a plinth may be BENEATH)
// The structures above are reproduced with SYNTHETIC texts (the real answers stay private). TEST_DOUBLE ports: no network, no cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAutonomous, RUN_STATUS, scopedMerge, fieldPath } from '../src/creative-autonomy/run.js';
import { normalizeStage } from '../src/creative-autonomy/stage-contract.js';
import { HABB_BRAND, verifiedFacts } from '../src/creative-autonomy/brief.js';
import { inventedCapabilities, verifiedTextOf, assertStageGuard } from '../src/creative-autonomy/habb-guard.js';
import { hasForbidden } from '../src/creative-autonomy/stage-contract.js';
import { normalizeConceptSet } from '../src/creative-brain/concept.js';
import { BRAIN_ERROR } from '../src/creative-brain/validation.js';
import { frameAnswer, CONCEPTS, artDirectionAnswer, evaluationsAnswer } from './creative-brain-world.js';

const snap = JSON.parse(readFileSync(new URL('./fixtures/creative-autonomy/shopify-gourde-tyeso.json', import.meta.url), 'utf8'));
const [C0] = normalizeConceptSet(CONCEPTS);
const prop = (shape, placement, reason, extra = {}) => ({ shape, material: 'CONCRETE', placement, scale: 'MEDIUM', reason, ...extra });
const stageOf = (c, props, over = {}) => ({ backdrop: 'SEAMLESS_SWEEP', backdrop_tone: 'CHARCOAL', floor_finish: 'SATIN', key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'NEUTRAL', purpose: 'découper la silhouette' }, accent_lights: [], camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' }, props, headline: 'Prends-la avec toi', text_placement: 'RIGHT_COLUMN', show_price: 'YES', rationale: 'Un socle et un panneau tiennent la gourde au centre du récit.', ...over });
const OK = (c) => c.visual_metaphor; // a reason argued in the concept
const FIRST = (c, broken = {}) => stageOf(c, [prop('PLINTH', 'BENEATH', OK(c)), prop('PANEL', 'BEHIND', OK(c)), prop('BLOCK', 'FOREGROUND_LEFT', OK(c))], broken);
const REPAIR = (c, fixed = {}) => stageOf(c, [prop('BLOCK', 'BENEATH', OK(c)), prop('PANEL', 'BEHIND', OK(c)), prop('SPHERE', 'FOREGROUND_LEFT', OK(c))], fixed);

// every plausible cause of the FIRST refusal that leaves the observed structure (PLINTH/BENEATH, PANEL/BEHIND, BLOCK/FOREGROUND_LEFT)
const CAUSES = [
  { name: 'rationale too long', field: 'stage.rationale', breakFirst: { rationale: `${'é'.repeat(10)}${'x'.repeat(341)}` } },
  { name: 'reason of the BLOCK not in the concept', field: 'stage.props[2].reason', breakProps: (p) => { p[2].reason = 'joli'; } },
  { name: 'reason of the PLINTH not in the concept', field: 'stage.props[0].reason', breakProps: (p) => { p[0].reason = 'joli'; } },
  { name: 'a word on the PANEL (not an extruded word)', field: 'stage.props[1].word', breakProps: (p) => { p[1].word = 'NAMUR'; } },
  { name: 'forbidden decor word in a prop reason', field: 'stage.props[2].reason', breakProps: (p, c) => { p[2].reason = `${OK(c)} sur un fond beige`; } },
  { name: 'text over the product', field: 'stage.text_placement', breakFirst: { text_placement: 'LEFT_COLUMN' } },
  { name: 'headline with an unverified claim', field: 'stage.headline', breakFirst: { headline: 'La meilleure gourde' } },
  { name: 'invented capability in the rationale (HABB guard, after the contract)', field: 'stage.rationale', guard: true, breakFirst: { rationale: 'Une gourde étanche pour les pluies de Namur.' } },
];
const firstFor = (cause, c) => { const s = FIRST(c, cause.breakFirst ?? {}); if (cause.breakProps) cause.breakProps(s.props, c); return s; };

function port(stageAnswers) {
  const calls = []; let stageN = 0;
  const complete = async ({ system, user }) => {
    const kind = system.includes('problem framer') ? 'FRAME' : system.includes('concept director') ? 'IDEATE' : system.includes('concept selector') ? 'SELECT' : system.includes('art director') ? 'ART_DIRECT' : 'STAGE';
    calls.push({ kind, system, user });
    let body;
    if (kind === 'FRAME') body = frameAnswer();
    else if (kind === 'IDEATE') body = { concepts: CONCEPTS };
    else if (kind === 'SELECT') body = evaluationsAnswer(normalizeConceptSet(CONCEPTS), []);
    else if (kind === 'ART_DIRECT') { const c = JSON.parse(user).concept; body = artDirectionAnswer({ narrative_elements: [{ element: 'one element of the set', reason: c.visual_metaphor, zone: 'BACKGROUND' }, { element: 'a second element', reason: c.story, zone: 'FOREGROUND' }] }); }
    else { const c = JSON.parse(user).concept; stageN += 1; body = (stageAnswers[stageN - 1] ?? ((x) => stageOf(x, [prop('PLINTH', 'BENEATH', OK(x))])))(c); }
    return { text: JSON.stringify(body), model: 'TEST_DOUBLE', request_id: `td-${calls.length}`, cost_eur: 0 };
  };
  return { complete, calls };
}
const run = (p, maxRepairCalls, workdir = mkdtempSync(join(tmpdir(), 't2-'))) => runAutonomous({ mode: 'IDEATION_ONLY', maxRepairCalls, input: { product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'Donner envie aux habitants de Namur de découvrir la gourde TYESO noire chez HABB', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath: null }, ports: { text: p.complete, visionFor: null, state: { text: 'TEST_DOUBLE', vision: 'NOT_CONNECTED' } }, engines: {}, workdir });

// ======================= Mission 1
test('the observed STAGE_REPAIR structure is refused exactly as in the trial: "a plinth goes beneath, and only a plinth", on the precise prop', () => {
  assert.throws(() => normalizeStage(REPAIR(C0), { concept: C0, personalisation_offered: false }), (e) => e.code === BRAIN_ERROR.RULE_VIOLATION && /a plinth goes beneath, and only a plinth/.test(e.message) && e.field === 'stage.props[0]');
  assert.ok(normalizeStage(FIRST(C0), { concept: C0, personalisation_offered: false }), 'the observed FIRST structure itself satisfies the plinth rule');
});

for (const cause of CAUSES) {
  test(`scoped repair, cause "${cause.name}": the first refusal names ${cause.field}; the repair can only change that field, the valid PLINTH/BENEATH structure is kept`, async () => {
    // the first answer is refused on the precise field
    const facts = verifiedFacts({ product: snap.product, variantTitle: 'Noir', readAt: snap.read_at });
    assert.throws(() => { const s = normalizeStage(firstFor(cause, C0), { concept: C0, personalisation_offered: false }); if (cause.guard) assertStageGuard(s, facts); }, (e) => e.field === cause.field, cause.name);
    // the model's repair: the observed structure (BLOCK/BENEATH...) with the field fixed
    const p = port([(c) => firstFor(cause, c), (c) => REPAIR(c)]);
    const r = await run(p, 1);
    assert.equal(r.status, RUN_STATUS.IDEATION_ONLY_NOT_A_VISUAL, JSON.stringify(r.error ?? null));
    const accepted = r.stages[r.concepts[0].concept_id];
    assert.deepEqual(accepted.props.map((x) => `${x.shape}/${x.placement}`), ['PLINTH/BENEATH', 'PANEL/BEHIND', 'BLOCK/FOREGROUND_LEFT'], 'the valid structure of the first answer is kept');
    const repairStep = r.trace.find((t) => t.step === 'STAGE_REPAIR');
    assert.equal(repairStep.repair_scope, cause.field);
    assert.ok(repairStep.repair_merge.applied);
    assert.ok(repairStep.repair_merge.discarded_outside_scope.includes('props[0].shape') && repairStep.repair_merge.discarded_outside_scope.includes('props[2].shape'), 'the model\'s structural changes are recorded as discarded');
    assert.match(p.calls.filter((c) => c.kind === 'STAGE')[1].system, new RegExp(`ONLY ${cause.field.replace(/[[\]().]/g, '\\$&')} will be taken from your new answer`));
  });
}

test('a repair that does not fix the refused field is still refused (scoping never relaxes a rule)', async () => {
  const cause = CAUSES[1];
  const p = port([(c) => firstFor(cause, c), (c) => firstFor(cause, c)]);
  const r = await run(p, 1);
  assert.equal(r.status, RUN_STATUS.STOPPED_ERROR);
  assert.equal(r.error.field, cause.field);
});

test('merge mechanics: path parsing, envelopes, removal of an optional field, unparseable and whole-answer cases', () => {
  assert.deepEqual(fieldPath('stage.props[2].reason', { props: [] }), ['props', 2, 'reason']);
  assert.deepEqual(fieldPath('concepts[1].story', { concepts: [] }), ['concepts', 1, 'story']);
  assert.deepEqual(fieldPath('art_direction.narrative_elements[0].reason', {}), ['narrative_elements', 0, 'reason']);
  const a = JSON.stringify({ props: [{ shape: 'PANEL', word: 'NAMUR' }], x: 1 }); const b = JSON.stringify({ props: [{ shape: 'SPHERE' }], x: 2 });
  const m = scopedMerge(a, b, 'stage.props[0].word');
  assert.deepEqual(JSON.parse(m.text), { props: [{ shape: 'PANEL' }], x: 1 }, 'the word removed, nothing else changed');
  assert.deepEqual(m.discarded.sort(), ['props[0].shape', 'x']);
  assert.equal(scopedMerge('{bad', b, 'stage.x').applied, false);
  assert.equal(scopedMerge(a, b, 'stage').reason, 'NO_PRECISE_FIELD');
});

test('every STAGE rule now names its exact field (so a repair can be scoped to it)', () => {
  const props = [prop('PLINTH', 'BENEATH', OK(C0)), prop('PANEL', 'BEHIND', OK(C0)), prop('BLOCK', 'FOREGROUND_LEFT', `${OK(C0)} gravé à ton nom`)];
  assert.throws(() => normalizeStage(stageOf(C0, props), { concept: C0, personalisation_offered: false }), (e) => e.field === 'stage.props[2].reason');
  assert.throws(() => normalizeStage(stageOf(C0, [prop('BLOCK', 'BEHIND', OK(C0)), prop('PLINTH', 'BEHIND', OK(C0))]), { concept: C0, personalisation_offered: false }), (e) => e.field === 'stage.props[1]');
  assert.throws(() => normalizeStage(stageOf(C0, [prop('PANEL', 'BEHIND', OK(C0), { word: 'NAMUR' })]), { concept: C0, personalisation_offered: false }), (e) => e.field === 'stage.props[0].word');
});

// ======================= Mission 2
test('interrupted run: the trace keeps the mode, the three concepts, the evaluations, the accepted art direction, the stop point and the exact error', async () => {
  const p = port([(c) => FIRST(c, { rationale: `${'é'.repeat(10)}${'x'.repeat(341)}` })]);
  const r = await run(p, 0);
  assert.equal(r.status, RUN_STATUS.STOPPED_ERROR);
  assert.equal(r.mode, 'IDEATION_ONLY');
  assert.equal(r.concepts.length, 3);
  assert.equal(r.selection.evaluations.length, 3);
  assert.ok(r.art_directions[r.concepts[0].concept_id], 'the art direction accepted before the stop is kept');
  assert.deepEqual(r.stopped_at, { step: 'STAGE', concept_id: r.concepts[0].concept_id });
  assert.deepEqual({ code: r.error.code, field: r.error.field }, { code: BRAIN_ERROR.TEXT_INVALID, field: 'stage.rationale' });
});

test('interrupted run report: mode, concepts, evaluations, attempted stage with its exact refusal and discarded changes; nothing "undefined", nothing invented', async () => {
  const out = mkdtempSync(join(tmpdir(), 't2-rep-'));
  const cause = CAUSES[1];
  // concept 1: refused, repaired (scoped); concept 2: refused again with no repair left -> STOPPED_ERROR
  const p = port([(c) => firstFor(cause, c), (c) => REPAIR(c), (c) => FIRST(c, { rationale: `${'é'.repeat(10)}${'x'.repeat(341)}` })]);
  await run(p, 1, join(out, 'gourde-noire'));
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/creative-autonomy-report.mjs', import.meta.url)), out, 'gourde-noire', 'none']);
  const md = readFileSync(join(out, 'gourde-noire', 'RAPPORT.md'), 'utf8');
  assert.ok(!/undefined/.test(md), md.split('\n').filter((l) => /undefined/.test(l)).join('\n'));
  assert.match(md, /IDÉATION SEULE/);
  assert.match(md, /Arrêt : \*\*STOPPED_ERROR\*\* à l'étape STAGE/);
  for (const c of CONCEPTS) assert.ok(md.includes(c.central_idea), 'each concept is quoted');
  assert.match(md, /### `cnc_[0-9a-f]+`\n- \*\*DISTINCTIVENESS\*\*/, 'the evaluations are present');
  assert.match(md, /Tentative STAGE : REFUSÉE : BRAIN_RULE_VIOLATION sur `stage\.props\[2\]\.reason`/);
  assert.match(md, /Tentative STAGE_REPAIR \(réparation limitée à `stage\.props\[2\]\.reason`\) : ACCEPTÉE/);
  assert.match(md, /HORS du champ réparé, écartés : .*`props\[0\]\.shape`/);
  assert.match(md, /Tentative STAGE : REFUSÉE : BRAIN_TEXT_INVALID sur `stage\.rationale`/);
  assert.match(md, /Mise en scène tentée \(réponse brute\) : .*justification : 351 caractères/);
  assert.match(md, /Réparations : 1 utilisée\(s\) sur 1 autorisée\(s\)/);
  assert.match(md, /Mise en scène : aucune acceptée\./, 'the third concept is reported as not staged, not invented');
});

// ======================= Mission 3
test('commercial brief: FRAME sees it in the public facts; IDEATE, SELECT and ART_DIRECT receive it; STAGE keeps its own contract', async () => {
  const p = port([]);
  await run(p, 0);
  const frameReq = p.calls.find((c) => c.kind === 'FRAME');
  const pf = JSON.parse(frameReq.user).observation.public_facts;
  assert.ok(Array.isArray(pf.creative_requirements) && pf.creative_requirements.length === 5);
  for (const kind of ['IDEATE', 'SELECT', 'ART_DIRECT']) {
    const sys = p.calls.find((c) => c.kind === kind).system;
    assert.match(sys, /HABB's commercial brief for this product/, kind);
    assert.match(sys, /protagoniste/, kind);
    assert.match(sys, /Coloris existants \(fiche Shopify\) : Gris, Rose, Bleu, Blanc, Jaune, Vert, Noir, Rouge Cramoisi\./, kind);
  }
  assert.ok(!p.calls.find((c) => c.kind === 'STAGE').system.includes("HABB's commercial brief"));
});

test('commercial brief invents nothing: every selling point comes from the snapshot; no capability claim; no forbidden decor in what is asked', () => {
  const facts = verifiedFacts({ product: snap.product, variantTitle: 'Noir', readAt: snap.read_at });
  assert.deepEqual(facts.colours_available, snap.product.variants.nodes.map((v) => v.title));
  const pf = { ...facts };
  const { commercialBrief } = require_();
  const b = commercialBrief(pf, 'HABB, Namur');
  const all = [...b.verified_selling_points, ...b.creative_requirements].join(' ');
  assert.deepEqual(inventedCapabilities(b.verified_selling_points.join(' '), verifiedTextOf(facts)), []);
  assert.equal(hasForbidden(b.creative_requirements.join(' ')), null, 'the requirements name fake luxury only to exclude it');
  for (const fact of ['29,90 €', '750 ml', 'paille', 'couvercle verrouillable']) assert.ok(all.includes(fact), fact);
  for (const invented of ['isotherme', 'étanche', 'garantie', 'livraison', 'atelier', 'gravure']) assert.ok(!b.verified_selling_points.join(' ').toLowerCase().includes(invented), invented);
});
import * as guard from '../src/creative-autonomy/habb-guard.js';
function require_() { return guard; }

test('replay of a run with a scoped repair judges what production judged (the merged answer), read-only', async () => {
  const { spawnSync } = await import('node:child_process');
  const trial = mkdtempSync(join(tmpdir(), 't2-replay-'));
  const p = port([(c) => firstFor(CAUSES[1], c), (c) => REPAIR(c)]);
  await run(p, 1, join(trial, 'gourde-noire'));
  const diag = join(mkdtempSync(join(tmpdir(), 't2-diag-')), 'r');
  const res = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/creative-autonomy-replay.mjs', import.meta.url)), '--trial', trial, '--product', 'gourde-noire', '--diag', diag]);
  assert.equal(res.status, 0, res.stderr.toString());
  const rows = JSON.parse(readFileSync(join(diag, 'replay.json'), 'utf8')).results;
  const repair = rows.find((r) => r.repair && r.stage === 'STAGE');
  assert.equal(repair.judged, 'MERGED_ANSWER (scoped repair)');
  assert.equal(repair.current_contract, 'ACCEPTED');
  assert.equal(JSON.parse(readFileSync(join(diag, 'replay.json'), 'utf8')).trial_dir_read_only.read_only_respected, true);
});
