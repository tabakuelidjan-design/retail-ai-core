// HABB's guard from the concept on, the code fingerprint of a plan, the secrets-file guard on every platform. Offline; TEST_DOUBLE answers are generic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventedCapabilities, assertConceptsHabbRules, assertArtDirectionGuard, assertStageGuard, habbBriefFacts, verifiedTextOf } from '../src/creative-autonomy/habb-guard.js';
import { buildAutonomousBrief, HABB_BRAND, verifiedFacts } from '../src/creative-autonomy/brief.js';
import { codeFingerprint, secretsFileProblems, REPO_ROOT, moduleGraph, fingerprintFiles, runtimeInjections } from '../src/creative-autonomy/trial.js';
import { observeBrief } from '../src/creative-brain/problem-frame.js';
import { runAutonomous, RUN_STATUS } from '../src/creative-autonomy/run.js';
import { normalizeConceptSet } from '../src/creative-brain/concept.js';
import { BRAIN_ERROR } from '../src/creative-brain/validation.js';
import { frameAnswer, CONCEPTS, artDirectionAnswer, evaluationsAnswer } from './creative-brain-world.js';

const snap = JSON.parse(readFileSync(new URL('./fixtures/creative-autonomy/shopify-gourde-tyeso.json', import.meta.url), 'utf8'));
const FACTS = verifiedFacts({ product: snap.product, variantTitle: 'Noir', readAt: snap.read_at });

// ---------------- the Brain knows HABB from the FRAME on
test('the observation given to FRAME carries HABB\'s identity, its visual prohibitions and the facts rule (not only section names)', () => {
  const { brief } = buildAutonomousBrief({ product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'o', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photo: { bytes: Buffer.alloc(0), media_type: 'none', origin: 'x', rights_class: 'UNKNOWN' } });
  const pf = observeBrief({ brief }).public_facts;
  assert.match(pf.merchant_identity, /HABB/);
  assert.match(pf.visual_prohibitions, /beige/); assert.match(pf.visual_prohibitions, /foliage/); assert.match(pf.visual_prohibitions, /feuillage/);
  assert.match(pf.facts_rule, /Seuls les faits vérifiés/);
  assert.deepEqual(Object.keys(habbBriefFacts(HABB_BRAND)).sort(), ['facts_rule', 'merchant_identity', 'merchant_voice', 'visual_prohibitions']);
});

// ---------------- invented capabilities, against the real verified text of the bottle
test('capabilities: what the Shopify sheet does not state is refused; what it states, and staging words, are not', () => {
  const v = verifiedTextOf(FACTS);
  for (const [t, id] of [['keeps your water cold all day', 'KEEPS_TEMPERATURE'], ['votre eau reste fraîche dans la gourde', 'KEEPS_TEMPERATURE'], ['ice-cold all day long', 'KEEPS_TEMPERATURE'], ['ne fuit jamais', 'LEAK_PROOF'], ['100% hermétique', 'LEAK_PROOF'], ['spill-resistant lid', 'LEAK_PROOF'], ['une gourde fabriquée en Belgique', 'MADE_IN'], ['cold for 24 hours', 'DURATION_HOURS'], ['a leak-proof lid', 'LEAK_PROOF'], ['étanche', 'LEAK_PROOF'], ['incassable', 'UNBREAKABLE'], ['BPA-free steel', 'BPA_FREE'], ['une gourde zéro déchet', 'ECO_CLAIM'], ['garantie à vie', 'GUARANTEE'], ['the best bottle in Namur', 'SUPERLATIVE']]) assert.deepEqual(inventedCapabilities(t, v), [id], t);
  for (const t of ['a lockable lid for the commute', 'a straw to drink easily on the move', 'the light keeps the scene cool', 'the city stays cold in November', 'rendez-vous à 7h du matin', 'À 7h du matin, un café chaud', 'the coffee shop stays cool', 'le café reste frais à l\'ombre', 'recycled kraft paper backdrop', 'made in Namur by HABB', 'zero waste mornings', 'la lumière garantit le calme', 'couvercle verrouillable', 'la gourde n\'est pas isotherme']) assert.deepEqual(inventedCapabilities(t, v), [], t);
  // invisible characters and decomposed accents do not hide a claim
  assert.deepEqual(inventedCapabilities('e\u0301tanche', v), ['LEAK_PROOF']); assert.deepEqual(inventedCapabilities('incas\u200Bsable', v), ['UNBREAKABLE']);
  // a capability the sheet DOES state, affirmatively, is allowed; a NEGATED one or another FIGURE is not
  assert.deepEqual(inventedCapabilities('keeps your water cold', 'Gourde isotherme qui garde votre eau froide, keeps water cold'), []);
  assert.deepEqual(inventedCapabilities('gourde isotherme qui garde l\'eau froide', 'Gourde non isotherme, ne garde pas l\'eau froide').sort(), ['INSULATION', 'KEEPS_TEMPERATURE']);
  assert.deepEqual(inventedCapabilities('24h de fraîcheur', 'Gourde isotherme : garde au froid pendant 12 heures'), ['DURATION_HOURS']);
  assert.deepEqual(inventedCapabilities('12h de fraîcheur', 'Gourde isotherme : garde au froid pendant 12 heures'), []);
});

test('concepts are guarded on what they show and tell, not on the risks the model lists', () => {
  const [c] = normalizeConceptSet(CONCEPTS);
  assert.doesNotThrow(() => assertConceptsHabbRules([{ ...c, risks: ['could look beige and generic'] }], FACTS));
  assert.throws(() => assertConceptsHabbRules([{ ...c, visual_metaphor: 'Autumn leaves falling around a quiet bench' }], FACTS), (e) => e.code === BRAIN_ERROR.FORBIDDEN_CONTENT && e.field === 'concepts[0].visual_metaphor');
  assert.throws(() => assertConceptsHabbRules([{ ...c, story: 'The bottle keeps your water cold from the Citadelle to the Meuse.' }], FACTS), (e) => e.code === BRAIN_ERROR.RULE_VIOLATION && e.field === 'concepts[0].story' && /KEEPS_TEMPERATURE/.test(e.message));
});

test('art direction and stage are guarded against invented capabilities too', () => {
  const art = artDirectionAnswer({ forbidden_decorative_noise: ['leaves', 'beige'] });
  assert.doesNotThrow(() => assertArtDirectionGuard(art, FACTS));
  assert.throws(() => assertArtDirectionGuard({ ...art, atmosphere: 'An icy morning where the bottle keeps the water cold for hours' }, FACTS), /KEEPS_TEMPERATURE|capability/);
  const stage = { headline: 'Prends-la partout', rationale: 'Le couvercle verrouillable suit chaque trajet.', key_light: { purpose: 'découper la silhouette' }, accent_lights: [], props: [{ reason: 'un socle pour la ville' }] };
  assert.doesNotThrow(() => assertStageGuard(stage, FACTS));
  assert.throws(() => assertStageGuard({ ...stage, rationale: 'Une gourde étanche pour les pluies de Namur.' }, FACTS), (e) => e.field === 'stage.rationale' && /LEAK_PROOF/.test(e.message));
});

// ---------------- the guard in the run, with the bounded repair
function port({ ideate = () => CONCEPTS } = {}) {
  const calls = [];
  const complete = async ({ system, user }) => {
    const kind = system.includes('problem framer') ? 'FRAME' : system.includes('concept director') ? 'IDEATE' : system.includes('concept selector') ? 'SELECT' : system.includes('art director') ? 'ART_DIRECT' : 'STAGE';
    calls.push({ kind, system, user }); const n = calls.filter((c) => c.kind === kind).length;
    let body;
    if (kind === 'FRAME') body = frameAnswer();
    else if (kind === 'IDEATE') body = { concepts: ideate(n) };
    else if (kind === 'SELECT') body = evaluationsAnswer(normalizeConceptSet(CONCEPTS), []);
    else if (kind === 'ART_DIRECT') { const c = JSON.parse(user).concept; body = artDirectionAnswer({ narrative_elements: [{ element: 'one element of the set', reason: c.visual_metaphor, zone: 'BACKGROUND' }, { element: 'a second element', reason: c.story, zone: 'FOREGROUND' }] }); }
    else { const c = JSON.parse(user).concept; body = { backdrop: 'SEAMLESS_SWEEP', backdrop_tone: 'CHARCOAL', floor_finish: 'SATIN', key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'NEUTRAL', purpose: 'double' }, accent_lights: [], camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' }, props: [{ shape: 'BLOCK', material: 'CONCRETE', placement: 'BESIDE_RIGHT', scale: 'LOW', reason: c.visual_metaphor }], headline: 'Titre de test', text_placement: 'RIGHT_COLUMN', show_price: 'YES', rationale: 'double' }; }
    return { text: JSON.stringify(body), model: 'TEST_DOUBLE', request_id: `td-${calls.length}`, cost_eur: 0 };
  };
  return { complete, calls };
}
const run = (p, maxRepairCalls) => runAutonomous({ mode: 'IDEATION_ONLY', maxRepairCalls, input: { product: snap.product, variantTitle: 'Noir', readAt: snap.read_at, objective: 'o', brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath: null }, ports: { text: p.complete, visionFor: null, state: { text: 'TEST_DOUBLE', vision: 'NOT_CONNECTED' } }, engines: {}, workdir: mkdtempSync(join(tmpdir(), 'guard-')) });
const withInvented = () => CONCEPTS.map((c, i) => (i === 1 ? { ...c, story: `${c.story} It keeps your water cold all day.` } : c));

test('IDEATE: a concept that invents a capability stops the run when no repair is authorised', async () => {
  const p = port({ ideate: withInvented });
  const r = await run(p, 0);
  assert.equal(r.status, RUN_STATUS.STOPPED_ERROR);
  assert.equal(r.error.code, BRAIN_ERROR.RULE_VIOLATION);
  assert.equal(p.calls.filter((c) => c.kind === 'ART_DIRECT').length, 0, 'nothing is art-directed from a refused concept');
});

test('IDEATE: with one authorised repair, the concept director is asked again with the exact violation, appended to its own instruction', async () => {
  const p = port({ ideate: (n) => (n === 1 ? withInvented() : CONCEPTS) });
  const r = await run(p, 1);
  assert.equal(r.status, RUN_STATUS.IDEATION_ONLY_NOT_A_VISUAL, JSON.stringify(r.error ?? null));
  const second = p.calls.filter((c) => c.kind === 'IDEATE')[1];
  assert.match(second.system, /REFUSED by Nordla's contract: BRAIN_RULE_VIOLATION at concepts\[1\]\.story/);
  assert.ok(second.system.startsWith(p.calls.filter((c) => c.kind === 'IDEATE')[0].system), 'the original instruction is kept whole; the note is appended');
  assert.ok(r.trace.some((t) => t.step === 'IDEATE_REPAIR' && t.outcome === 'THREE_DISTINCT_CONCEPTS'));
  // the note does not leak into the next stage
  assert.ok(!p.calls.find((c) => c.kind === 'SELECT').system.includes('REFUSED by Nordla'));
});

// ---------------- the code fingerprint of a plan
test('code fingerprint covers what really runs: the traced module graph (critic, intelligence, branding...), the Python engines, the dependency lock', () => {
  const { modules } = codeFingerprint();
  for (const m of ['scripts/creative-autonomy-trial.mjs', 'scripts/creative-autonomy-report.mjs', 'src/creative-autonomy/run.js', 'src/creative-autonomy/habb-guard.js', 'src/creative-brain/concept.js',
    'src/marketing-creative/alibaba/qwen-brain-port.js', 'src/creative-critic/critique.js', 'test/creative-brain-world.js', 'scripts/creative-autonomy/render_stage.py', 'package-lock.json']) assert.ok(modules.includes(m), m);
});

test('code fingerprint: the same files give the same fingerprint with LF or CRLF line endings; one more character gives another', () => {
  const root = mkdtempSync(join(tmpdir(), 'code-'));
  const files = moduleGraph().slice(0, 12).map((f) => { const rel = f.slice(REPO_ROOT.length + 1); const dst = join(root, rel); mkdirSync(join(dst, '..'), { recursive: true }); writeFileSync(dst, readFileSync(f)); return dst; });
  const base = fingerprintFiles(root, files);
  writeFileSync(files[0], readFileSync(files[0], 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(fingerprintFiles(root, files), base, 'a Windows checkout (CRLF) has the same fingerprint');
  writeFileSync(files[0], `${readFileSync(files[0], 'utf8')} `);
  assert.notEqual(fingerprintFiles(root, files), base);
});

test('runtime injections (--import, --require, NODE_OPTIONS) are detected: they change the plan', () => {
  assert.deepEqual(runtimeInjections([], ''), []);
  assert.equal(runtimeInjections(['--import', 'file:///x/pre.mjs'], '').length, 1);
  assert.equal(runtimeInjections(['--import=./pre.mjs'], '').length, 1);
  assert.equal(runtimeInjections([], '--require ./hook.cjs --max-old-space-size=4096').length, 1);
  assert.equal(runtimeInjections(['--experimental-loader', './l.mjs', '-r', './x.cjs'], '').length, 2);
});

// ---------------- secrets file, on every platform
test('secrets file: refused on Windows (NTFS rights cannot be proven), refused in a repo, refused if readable by others on POSIX', () => {
  assert.match(secretsFileProblems({ exists: true, platform: 'win32', mode: 0o100666, insideGitRepo: false }).join(), /Windows/);
  assert.match(secretsFileProblems({ exists: true, platform: 'linux', mode: 0o100644, insideGitRepo: false }).join(), /chmod 600/);
  assert.match(secretsFileProblems({ exists: true, platform: 'linux', mode: 0o100600, insideGitRepo: true }).join(), /dépôt git/);
  assert.deepEqual(secretsFileProblems({ exists: true, platform: 'linux', mode: 0o100600, insideGitRepo: false }), []);
  assert.deepEqual(secretsFileProblems({ exists: false, platform: 'linux', mode: 0, insideGitRepo: false }), ['fichier de secrets introuvable']);
});

test('forbidden decor: whole words, idioms, negations and the sense of "leaves" (findings of the independent review)', async () => {
  const { hasForbidden } = await import('../src/creative-autonomy/stage-contract.js');
  for (const t of ['au cœur de Namur', 'coup de cœur', 'Luxembourg', 'sandwich', 'Sandrine', 'la sandale', 'heartfelt', 'leaflet', 'crèmerie', 'goldfish', 'sans cœur ni dorure', 'pas de beige', 'no leaves, only stone', 'the light leaves the frame', 'makes the gift and leaves it ready', 'une feuille de papier']) assert.equal(hasForbidden(t), null, t);
  for (const [t, w] of [['dry leaves the size of hands', 'leaves'], ['autumn leaves the colour of rust', 'leaves'], ['une dorure', 'dorure'], ['les dorures', 'dorure'], ['be\u200Bige', 'beige'], ['cre\u0300me', 'crème'], ['ivoire', 'ivoire'], ['gilded frame', 'gilded'], ['un cœur rouge', 'cœur'], ['des feuilles mortes', 'feuille'], ['un fond beige', 'beige'], ['végétaux', 'végétaux']]) assert.equal(hasForbidden(t), w, t);
});

test('protocol re-ask (invalid JSON) spends the SAME repair budget: refused before sending when none is left', async () => {
  const mk = () => { const calls = []; let stageN = 0; let firstStageUser = null; const complete = async ({ system, user }) => {
    const kind = system.includes('problem framer') ? 'FRAME' : system.includes('concept director') ? 'IDEATE' : system.includes('concept selector') ? 'SELECT' : system.includes('art director') ? 'ART_DIRECT' : 'STAGE';
    calls.push(kind);
    if (kind === 'STAGE') { stageN += 1; if (stageN === 1) { firstStageUser = user; return { text: '{"backdrop": "SEAMLESS_SWEEP", oops', model: 'TEST_DOUBLE' }; } }
    // the protocol re-ask carries the malformed text, not the original request: answer it for the concept of the first STAGE request
    if (kind === 'STAGE' && stageN === 2) return port().complete({ system, user: firstStageUser });
    return port().complete({ system, user });
  }; return { complete, calls }; };
  const zero = mk(); const r0 = await run(zero, 0);
  assert.equal(r0.status, RUN_STATUS.STOPPED_ERROR);
  assert.equal(zero.calls.filter((k) => k === 'STAGE').length, 1, 'the re-ask was NOT sent: no budget');
  const one = mk(); const r1 = await run(one, 1);
  assert.equal(r1.status, RUN_STATUS.IDEATION_ONLY_NOT_A_VISUAL, JSON.stringify(r1.error ?? null));
  assert.deepEqual(r1.repairs, { used: 1, allowed: 1 });
  assert.equal(one.calls.length, 10, '9 planned + 1 repair (the protocol re-ask), never more');
});

test('second review: negations stop at the clause; "not only" is not a negation; claims phrased with "sans"/"never"/"without" are claims', async () => {
  const { hasForbidden } = await import('../src/creative-autonomy/stage-contract.js');
  assert.equal(hasForbidden('no gold, only golden light'), 'golden');
  assert.equal(hasForbidden('not beige but sand-coloured'), 'sand');
  assert.equal(hasForbidden('un fond sans aucun beige mais très beige'), 'beige');
  for (const t of ['sans cœur ni dorure', 'no leaves, only stone', 'pas de beige']) assert.equal(hasForbidden(t), null, t);
  const v = verifiedTextOf(FACTS);
  for (const t of ['never spills, never leaks', 'non seulement étanche, mais aussi légère', 'not only leak-proof', 'sans jamais fuir', 'sans fuite, même renversée', 'without a single leak']) assert.deepEqual(inventedCapabilities(t, v), ['LEAK_PROOF'], t);
  assert.deepEqual(inventedCapabilities('tient au frais 12 heures', v), ['DURATION_HOURS']);
  assert.deepEqual(inventedCapabilities("ton eau reste froide jusqu'au soir", v), ['KEEPS_TEMPERATURE']);
  assert.deepEqual(inventedCapabilities('made from recycled steel', v), ['ECO_CLAIM']);
  assert.deepEqual(inventedCapabilities('la gourde n\'est pas isotherme', v), []);
  assert.deepEqual(inventedCapabilities('it doesn\'t keep your drinks cold', v), []);
  assert.deepEqual(inventedCapabilities('gourde isotherme qui garde l\'eau froide', 'Gourde non isotherme, ne garde pas l\'eau froide').sort(), ['INSULATION', 'KEEPS_TEMPERATURE']);
});
