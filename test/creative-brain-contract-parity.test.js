import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  askAndNormalize, generateValid, mutations, rng, REPAIR_KIND, renderSpec,
} from '../src/creative-brain/index.js';
import {
  auditContractParity, auditCritic, auditSpecStage, CRITIC_CONTRACTS, DETERMINISTIC_STAGES, renderContractMatrix, SAMPLE_CONCEPT, SAMPLE_CONCEPTS, STAGE_CONTRACTS,
} from '../src/creative-brain/parity.js';
import { SCENE_FORBIDDEN } from '../src/creative-brain/index.js';

// CONTRACT / PROMPT PARITY AND PROPERTY TESTS (`// PF-N` markers). For every model-generated stage: the instruction states every rule the validator enforces; valid structures generated from the spec are
// accepted; the same structures broken one rule at a time are refused with the precise code and field; the syntactic near misses a model makes are repaired, journaled, or refused, deterministically.

const stage = (name) => STAGE_CONTRACTS.find((s) => s.stage === name);
const WORDS = ['amber', 'quiet', 'harbour', 'morning', 'weathered', 'linen', 'copper', 'orchard', 'ripple', 'lantern', 'meadow', 'velvet', 'granite', 'drift', 'ember', 'willow', 'compass', 'tide', 'ledger', 'mosaic'];
const window = (offset, n = 8) => Array.from({ length: n }, (_, i) => WORDS[(offset + i) % WORDS.length]).join(' ');
// invented words, disjoint between concepts (three concepts that share no content word), six per field
const SYL1 = ['ba', 'ke', 'mo', 'ri', 'tu', 'vel']; const SYL2 = ['dar', 'lin', 'sor', 'pek', 'nal', 'gor'];
const nonsense = (concept, field) => Array.from({ length: 6 }, (_, k) => { const n = (concept * 24) + (field * 6) + k; return `${SYL1[n % 6]}${SYL2[Math.floor(n / 6) % 6]}${'xyzw'[Math.floor(n / 36) % 4]}`; }).join(' ');
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// ---- generators: valid structures of each stage (the spec generates the fields; the cross-field relations are fixed up or rejection-sampled)
const textOf = {
  IDEATE: (spec, path) => { const m = /concepts\[(\d)\]\.(central_idea|visual_metaphor|story|emotional_intent)$/.exec(path); return m ? nonsense(Number(m[1]), ['central_idea', 'visual_metaphor', 'story', 'emotional_intent'].indexOf(m[2])) : null; },
  ART_DIRECT: (spec, path) => (path.endsWith('.reason') ? `${window(3, 4)} lantern harbour care` : null),
};
const FLOW_TEXT = ['HEADLINE', 'SUBHEADLINE', 'PRICE', 'CTA'];
function composeValid(random) {
  const pick = (a) => a[Math.floor(random() * a.length)];
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const textRoles = FLOW_TEXT.filter(() => random() < 0.7);
    if (!textRoles.length) continue;
    const flow = [...textRoles]; flow.splice(Math.floor(random() * (flow.length + 1)), 0, 'PRODUCT');
    const groups = []; for (const r of textRoles) { if (!groups.length || random() < 0.5) groups.push([r]); else groups.at(-1).push(r); }
    const W = ['QUIET', 'BALANCED', 'STRONG', 'DOMINANT'];
    const answer = {
      hero_relationship: pick(['PRODUCT_DOMINATES', 'PRODUCT_AND_HEADLINE_SHARE', 'HEADLINE_LEADS_PRODUCT_ANSWERS', 'PRODUCT_RECEDES_INTO_SCENE']),
      product_anchor: { horizontal: pick(['START', 'CENTER', 'END']), vertical: pick(['UPPER', 'MIDDLE', 'LOWER']) },
      text_adjacency: pick(['BESIDE', 'ABOVE', 'BELOW', 'STAGGERED']), alignment_family: pick(['START', 'CENTER', 'END']),
      visual_weight: Object.fromEntries(flow.map((r) => [r, pick(W)])), grouping: groups, overlap_permission: pick(['NONE', 'PRODUCT_OVERLAPS_TEXT_FRAME']),
      negative_space_reservation: Array.from({ length: Math.floor(random() * 4) }, () => ({ region: pick(['START', 'END', 'TOP', 'BOTTOM', 'SURROUNDING']), extent: pick(['SMALL', 'MEDIUM', 'LARGE']) })),
      narrative_flow: flow, rationale: window(5, 6),
    };
    if (!codeOf(() => stage('COMPOSE').normalize(answer))) return answer;
  }
  throw new Error('no valid composition found');
}
function selectValid(random) {
  const CRITERIA = ['CONCEPT_STRENGTH', 'RELEVANCE_TO_BRIEF', 'EMOTIONAL_RESONANCE', 'PRODUCT_RELATIONSHIP', 'DISTINCTIVENESS', 'FEASIBILITY', 'BRAND_COMPATIBILITY', 'COMMERCIAL_CLARITY', 'NARRATIVE_COHESION', 'GENERIC_RISK'];
  return {
    evaluations: SAMPLE_CONCEPTS.map((c) => ({
      concept_id: c.concept_id,
      criteria: CRITERIA.filter(() => random() < 0.8).map((criterion) => ({ criterion, outcome: ['MEETS', 'PARTIAL', 'FAILS'][Math.floor(random() * 3)], evidence: `${window(2, 5)} judged with care here`, ...(random() < 0.4 ? { refinement: `${window(9, 4)} could be stronger` } : {}) })),
    })).map((e) => (e.criteria.length ? e : { ...e, criteria: [{ criterion: 'CONCEPT_STRENGTH', outcome: 'MEETS', evidence: `${window(2, 5)} judged with care here` }] })),
  };
}
const validAnswer = (name, seed) => {
  const random = rng(seed);
  if (name === 'COMPOSE') return composeValid(random);
  if (name === 'SELECT_CONCEPT') return selectValid(random);
  return generateValid(stage(name).spec, random, { textOf: textOf[name] ?? null });
};
const fieldFor = (name, field, code) => {
  const root = stage(name).root;
  if (name === 'IDEATE' || name === 'SELECT_CONCEPT') {
    const prefix = `answer.${root}`;
    if (field === prefix) return code === 'BRAIN_MISSING_KEY' ? field : root;
    return field.startsWith(`${prefix}[`) ? `${root}${field.slice(prefix.length)}` : field;
  }
  return field.replace(/^answer/, root);
};
const SEEDS = Array.from({ length: 60 }, (_, i) => 1000 + (i * 7919));

test('PF-1 every model stage: the instruction states every key, vocabulary word, limit, count, lexicon word and rule the validator enforces; every instruction rule is enforced or declared', () => {
  const audit = auditContractParity();
  assert.deepEqual(audit.failures, []);
  assert.equal(audit.ready, true);
  assert.deepEqual(audit.stages.map((s) => s.stage), ['FRAME', 'IDEATE', 'SELECT_CONCEPT', 'ART_DIRECT', 'COMPOSE', 'EXECUTION_CRITIC', 'CONCEPT_CRITIC', 'SCENE', 'PRODUCTION_STRATEGY', 'RECOVERY']);
  for (const s of audit.stages.filter((x) => x.model)) assert.ok(s.rows >= 12, `${s.stage} has ${s.rows} rows`);
  assert.ok(audit.stages.filter((x) => !x.model).every((s) => s.derivation));
  assert.deepEqual(DETERMINISTIC_STAGES.map((d) => d.model), [false, false, false]);
  // the matrix document is generated from the audit and is current
  const doc = renderContractMatrix(audit);
  assert.match(doc, /PARITY: every validator rule is stated/);
});

test('PF-2 the audit is mechanical: it detects an instruction that forgets a field, a vocabulary word, a limit, a lexicon word or a rule, and a rule nobody enforces', () => {
  const real = stage('ART_DIRECT');
  const without = (re) => ({ ...real, instruction: () => { const i = real.instruction(); return { ...i, system: i.system.split('\n').filter((l) => !re.test(l)).join('\n') }; } });
  assert.ok(auditSpecStage(without(/^answer\.atmosphere:/)).failures.some((f) => /answer\.atmosphere/.test(f)));
  assert.ok(auditSpecStage(without(/^answer\.narrative_elements\[\]\.reason:/)).failures.some((f) => /reason/.test(f)));
  assert.ok(auditSpecStage(without(/^Nordla REFUSES/)).failures.some((f) => /refused word/.test(f)));
  assert.ok(auditSpecStage(without(/^RULE REASON_IN_THE_CONCEPT/)).failures.some((f) => /REASON_IN_THE_CONCEPT/.test(f)));
  const hidden = { ...real, instruction: () => { const i = real.instruction(); return { ...i, system: `${i.system}\nRULE INVENTED_RULE: a rule nobody checks` }; } };
  assert.ok(auditSpecStage(hidden).failures.some((f) => /undeclared rule/.test(f)));
  const unenforced = { ...real, rules: [...real.rules, { id: 'GHOST_RULE', statement: 'a rule with no check' }] };
  assert.ok(auditSpecStage(unenforced).failures.some((f) => /neither a check nor a declared enforcement/.test(f)));
  for (const c of CRITIC_CONTRACTS) assert.ok(auditCritic({ ...c, instruction: () => ({ system: 'You are a critic.' }) }).failures.length >= 10, c.stage);
  const critic = CRITIC_CONTRACTS[0];
  assert.ok(auditCritic({ ...critic, instruction: () => ({ system: critic.instruction().system.replace('no URL and no control character', '') }) }).failures.some((f) => /NO_URL_OR_CONTROL/.test(f)));
});

test('PF-3 valid structures generated from each spec are accepted by the real validator of the stage (property: no valid structure is refused)', () => {
  for (const { stage: name, normalize } of STAGE_CONTRACTS) {
    let accepted = 0;
    for (const seed of SEEDS) {
      const answer = validAnswer(name, seed);
      const error = codeOf(() => normalize(structuredClone(answer)));
      assert.equal(error, null, `${name} seed ${seed}: ${error?.code} ${error?.field} ${error?.message}`);
      accepted += 1;
    }
    assert.equal(accepted, SEEDS.length, name);
  }
  // the generators really vary: many different answers, not one
  for (const name of ['FRAME', 'ART_DIRECT', 'COMPOSE', 'SELECT_CONCEPT']) assert.ok(new Set(SEEDS.map((s) => JSON.stringify(validAnswer(name, s)))).size > 40, name);
});

test('PF-4 every single-rule mutation of a valid structure is refused with the precise code and field (property: no rule is silent)', () => {
  let total = 0;
  for (const c of STAGE_CONTRACTS) {
    const seen = new Set();
    for (const seed of SEEDS.slice(0, 12)) {
      const valid = validAnswer(c.stage, seed);
      for (const m of mutations(c.spec, valid, 'answer')) {
        const error = codeOf(() => c.normalize(structuredClone(m.value)));
        assert.ok(error, `${c.stage}: "${m.label}" was accepted (seed ${seed})`);
        assert.equal(error.code, m.code, `${c.stage}: "${m.label}" -> ${error.code} ${error.field}`);
        const root = fieldFor(c.stage, m.field, m.code);
        assert.equal(error.field, root, `${c.stage}: "${m.label}" names ${error.field}, expected ${root}`);
        seen.add(m.label.replace(/\[\d+\]/g, '[]')); total += 1;
      }
    }
    assert.ok(seen.size >= 15, `${c.stage} has ${seen.size} distinct mutations`);
  }
  assert.ok(total > 3000, `${total} mutations`);
});

test('PF-5 cross-field rules: each is refused precisely when broken, and accepted when kept', () => {
  const art = stage('ART_DIRECT'); const concept = stage('IDEATE');
  const a = validAnswer('ART_DIRECT', 1);
  a.narrative_elements = [{ element: 'worn tools laid aside', reason: 'an unrelated spotless tray', zone: 'FOREGROUND' }];
  assert.equal(codeOf(() => art.normalize(a)).detail.problem, 'ELEMENT_WITHOUT_REASON_IN_THE_CONCEPT');
  a.narrative_elements[0].reason = 'it shows the lantern carried with care';
  assert.equal(codeOf(() => art.normalize(a)), null);
  assert.deepEqual(art.normalize({ ...a, forbidden_decorative_noise: ['confetti'] }).forbidden_decorative_noise, ['confetti', ...SCENE_FORBIDDEN]);
  assert.equal(codeOf(() => art.normalize({ ...a, art_direction_id: 'art_x' })).code, 'BRAIN_UNKNOWN_KEY');
  // IDEATE
  const c = validAnswer('IDEATE', 2);
  assert.equal(codeOf(() => concept.normalize({ concepts: [{ ...c.concepts[0], central_idea: 'background colour layout alignment', visual_metaphor: 'camera angle grid' }, c.concepts[1], c.concepts[2]] })).detail.problem, 'CONCEPT_IS_A_LAYOUT_VARIANT');
  assert.equal(codeOf(() => concept.normalize({ concepts: [c.concepts[0], c.concepts[0], c.concepts[2]] })).detail.problem, 'CONCEPTS_NOT_DISTINCT');
  assert.equal(codeOf(() => concept.normalize({ concepts: [{ ...c.concepts[0], concept_id: 'cnc_forged' }, c.concepts[1], c.concepts[2]] })).code, 'BRAIN_RULE_VIOLATION');
  // SELECT
  const s = validAnswer('SELECT_CONCEPT', 3); const sel = stage('SELECT_CONCEPT');
  assert.equal(codeOf(() => sel.normalize({ evaluations: s.evaluations.slice(0, 2) })).code, 'BRAIN_RULE_VIOLATION');
  assert.equal(codeOf(() => sel.normalize({ evaluations: [s.evaluations[0], s.evaluations[1], { ...s.evaluations[2], concept_id: 'cnc_unknown' }] })).code, 'BRAIN_RULE_VIOLATION');
  const dup = structuredClone(s); dup.evaluations[0].criteria = [dup.evaluations[0].criteria[0], dup.evaluations[0].criteria[0]];
  assert.equal(codeOf(() => sel.normalize(dup)).code, 'BRAIN_RULE_VIOLATION');
  const short = structuredClone(s); short.evaluations[0].criteria[0] = { criterion: 'FEASIBILITY', outcome: 'MEETS', evidence: 'too short' };
  assert.equal(codeOf(() => sel.normalize(short)).code, 'BRAIN_TEXT_INVALID');
  const noEvidence = structuredClone(s); noEvidence.evaluations[0].criteria[0] = { criterion: 'FEASIBILITY', outcome: 'NOT_ASSESSED' };
  assert.equal(codeOf(() => sel.normalize(noEvidence)), null);
  assert.equal(codeOf(() => sel.normalize({ ...s, winner: 'x' })).code, 'BRAIN_UNKNOWN_KEY');
  // COMPOSE flow rules
  const p = validAnswer('COMPOSE', 4); const comp = stage('COMPOSE');
  assert.equal(codeOf(() => comp.normalize({ ...p, narrative_flow: [...p.narrative_flow, p.narrative_flow[0]] })).field, 'composition.narrative_flow');
  assert.equal(codeOf(() => comp.normalize({ ...p, narrative_flow: p.narrative_flow.filter((r) => r !== 'PRODUCT') })).field, 'composition.narrative_flow');
  assert.equal(codeOf(() => comp.normalize({ ...p, visual_weight: Object.fromEntries(Object.entries(p.visual_weight).slice(1)) })).field, 'composition.visual_weight');
  assert.equal(codeOf(() => comp.normalize({ ...p, grouping: [[...p.grouping[0], 'PRODUCT'], ...p.grouping.slice(1)] })).field, 'composition.grouping');
  assert.equal(codeOf(() => comp.normalize({ ...p, composition_id: 'cmp_forged' })).code, 'BRAIN_RULE_VIOLATION');
});

// ---- near misses: the shared normalization layer, through the real askAndNormalize
const run = (c, answerText) => askAndNormalize({ complete: async () => ({ text: answerText, model: 'fake', request_id: 'r1' }), instruction: { system: 's', user: 'u' }, stage: c.stage, spec: c.spec, normalize: c.normalize });
const rootObject = (v) => v;

test('PF-6 near misses a model makes: one misspelled key is repaired and journaled; line breaks and another casing are repaired and journaled; everything ambiguous or meaning-changing is refused', async () => {
  for (const c of STAGE_CONTRACTS) {
    const random = rng(77);
    for (const seed of SEEDS.slice(0, 10)) {
      const valid = validAnswer(c.stage, seed);
      const expected = c.normalize(structuredClone(valid));
      // (a) one misspelled top-level key (deletion of one letter): repaired, journaled, same result
      const keys = Object.keys(valid).filter((k) => k.length > 4);
      const key = keys[Math.floor(random() * keys.length)];
      const typo = Object.fromEntries(Object.entries(valid).map(([k, v]) => [k === key ? `${k.slice(0, 2)}${k.slice(3)}` : k, v]));
      const fixed = await run(c, JSON.stringify(typo));
      assert.deepEqual(fixed.value, expected, `${c.stage} ${key}`);
      assert.deepEqual(fixed.meta.key_repairs, [{ path: c.stage, from: `${key.slice(0, 2)}${key.slice(3)}`, to: key }]);
      assert.equal(fixed.meta.repairs.every((r) => r.kind === REPAIR_KIND.KEY_NEAR_MISS), true);
      // (b) two misspelled keys in the same object: ambiguous, refused
      if (keys.length >= 2) {
        const two = Object.fromEntries(Object.entries(valid).map(([k, v]) => [keys.slice(0, 2).includes(k) ? `${k.slice(0, 2)}${k.slice(3)}` : k, v]));
        const refused = await run(c, JSON.stringify(two)).catch((e) => e);
        assert.match(refused.code, /BRAIN_UNKNOWN_KEY/, `${c.stage} two typos`);
        assert.equal(refused.evidence.key_repairs.length, 0);
      }
      // (c) a key too far from anything, and a missing key with nothing misspelled: refused, no repair
      const far = { ...valid }; far.qqqqqqqq = far[key]; delete far[key];
      assert.match((await run(c, JSON.stringify(far)).catch((e) => e)).code, /BRAIN_UNKNOWN_KEY/);
      const missing = { ...valid }; delete missing[key];
      assert.equal((await run(c, JSON.stringify(missing)).catch((e) => e)).code, 'BRAIN_MISSING_KEY');
      // (d) the same answer in a markdown fence, with a leading sentence: parsed, nothing to repair
      assert.deepEqual((await run(c, `Here is the answer:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)).value, expected);
    }
  }
  // line breaks, tabs and a lower-case word of a closed vocabulary
  const art = stage('ART_DIRECT');
  const v = validAnswer('ART_DIRECT', 5);
  const messy = { ...v, atmosphere: 'a quiet room\nwith warm light', material_language: `linen${String.fromCharCode(9)}and wood`, depth_model: v.depth_model.toLowerCase() };
  const ok = await run(art, JSON.stringify(messy));
  assert.equal(ok.value.atmosphere, 'a quiet room with warm light');
  assert.equal(ok.value.material_language, 'linen and wood');
  assert.equal(ok.value.depth_model, v.depth_model);
  assert.deepEqual(ok.meta.repairs.map((r) => [r.kind, r.path]).sort(), [[REPAIR_KIND.WHITESPACE, 'ART_DIRECT.atmosphere'], [REPAIR_KIND.WHITESPACE, 'ART_DIRECT.material_language'], [REPAIR_KIND.WORD_CASE, 'ART_DIRECT.depth_model']].sort());
  // a map key (a role of a composition) in another casing, and an optional key given as null
  const comp = stage('COMPOSE'); const p = validAnswer('COMPOSE', 6);
  const lower = { ...p, visual_weight: Object.fromEntries(Object.entries(p.visual_weight).map(([k, w], i) => [i === 0 ? k.toLowerCase() : k, w])) };
  assert.deepEqual((await run(comp, JSON.stringify(lower))).value, comp.normalize(p));
  const sel = stage('SELECT_CONCEPT'); const s = validAnswer('SELECT_CONCEPT', 7);
  const nulled = structuredClone(s); nulled.evaluations[0].criteria[0] = { ...nulled.evaluations[0].criteria[0], refinement: null };
  const out = await run(sel, JSON.stringify(nulled));
  assert.ok(out.meta.repairs.some((r) => r.kind === REPAIR_KIND.OPTIONAL_EMPTY));
  void rootObject;
});

test('PF-7 the normalization layer NEVER makes a creative decision: a different word is not turned into another, a wrong value is not replaced, a missing value is not invented, a relation is not dropped', async () => {
  const art = stage('ART_DIRECT'); const comp = stage('COMPOSE'); const v = validAnswer('ART_DIRECT', 8);
  // an unknown word stays unknown, whatever it resembles
  for (const wrong of ['MEASURED_', 'MEASURE', 'FLOW', 'STILL_', 'MEASURED STILL']) assert.equal((await run(art, JSON.stringify({ ...v, visual_rhythm: wrong })).catch((e) => e)).code, 'BRAIN_ENUM_INVALID', wrong);
  // another casing of a word of the vocabulary IS the word, and it is journaled
  const cased = await run(art, JSON.stringify({ ...v, visual_rhythm: 'still' }));
  assert.equal(cased.value.visual_rhythm, 'STILL');
  assert.deepEqual(cased.meta.repairs, [{ path: 'ART_DIRECT.visual_rhythm', kind: REPAIR_KIND.WORD_CASE, from: 'still', to: 'STILL' }]);
  // a contradictory plan stays contradictory, and the repair layer does not pick a side
  const p = validAnswer('COMPOSE', 9);
  const contradictory = { ...p, hero_relationship: 'PRODUCT_DOMINATES', visual_weight: { ...p.visual_weight, PRODUCT: 'QUIET' } };
  const refused = await run(comp, JSON.stringify(contradictory)).catch((e) => e);
  assert.equal(refused.detail.problem, 'PRODUCT_DOMINATES_NEEDS_A_DOMINANT_PRODUCT');
  assert.deepEqual(refused.evidence.repairs, []);
  // a forbidden word is not removed, an over-long text is not cut, a missing text is not invented, a number is not turned into a word
  assert.equal((await run(art, JSON.stringify({ ...v, narrative_elements: [{ element: 'a phone', reason: 'it shows the lantern carried with care', zone: 'FOREGROUND' }] })).catch((e) => e)).code, 'BRAIN_FORBIDDEN_CONTENT');
  assert.equal((await run(art, JSON.stringify({ ...v, atmosphere: 'a'.repeat(301) })).catch((e) => e)).code, 'BRAIN_TEXT_INVALID');
  assert.equal((await run(art, JSON.stringify({ ...v, atmosphere: '' })).catch((e) => e)).code, 'BRAIN_TEXT_INVALID');
  assert.equal((await run(art, JSON.stringify({ ...v, visual_tension: 3 })).catch((e) => e)).code, 'BRAIN_NUMERIC_VALUE');
  // a text that is only line breaks stays empty (refused), not "repaired" into content
  assert.equal((await run(art, JSON.stringify({ ...v, atmosphere: '\n\n' })).catch((e) => e)).code, 'BRAIN_TEXT_INVALID');
  // a repaired key must not collide with a key already present (no value is overwritten)
  const collide = { ...v, atmospher: 'another line', atmosphere_: 'x' };
  assert.match((await run(art, JSON.stringify(collide)).catch((e) => e)).code, /BRAIN_UNKNOWN_KEY/);
});

test('PF-8 the critics: every rule their instruction states is enforced by their validators; valid critiques are accepted', () => {
  const ctx = { candidate_ref: 'c1', candidate_sha256: 'a'.repeat(64) };
  const dims = (list) => ({ dimensions: list });
  const good = (d, over = {}) => ({ dimension: d, outcome: 'PASS', evidence: 'A concrete visible fact in the image.', ...over });
  const exec = ['PRODUCT_PROMINENCE', 'PRODUCT_INTEGRATION', 'VISUAL_HIERARCHY', 'TEXT_HIERARCHY', 'TYPOGRAPHY_COMPOSITION', 'CLAIM_VISIBILITY', 'PRICE_INTEGRATION', 'WHITESPACE_BALANCE', 'COMPOSITION_BALANCE', 'BRAND_EXPRESSION', 'PREMIUM_RETAIL_FEEL', 'TEMPLATE_LIKE_APPEARANCE', 'AI_ARTIFACTS', 'OVERALL_SHIPPABILITY'];
  const conc = ['CONCEPT_STRENGTH', 'NARRATIVE_COHESION', 'EMOTIONAL_RESONANCE', 'EDITORIAL_SOPHISTICATION', 'DISTINCTIVENESS', 'WOW_FACTOR'];
  const kinds = [
    { name: 'execution', normalize: (raw) => stageCritique('exec')(raw), names: exec, evidenceMax: 500, forbiddenKeys: true },
    { name: 'concept', normalize: (raw) => stageCritique('concept')(raw), names: conc, evidenceMax: 400, forbiddenKeys: false },
  ];
  function stageCritique(kind) { return (raw) => (kind === 'exec' ? NORMALIZE.exec(raw, ctx) : NORMALIZE.concept(raw, ctx)); }
  for (const k of kinds) {
    const d = k.names[0];
    const refused = (raw, label) => assert.ok(codeOf(() => k.normalize(raw)), `${k.name}: ${label} was accepted`);
    const accepted = (raw, label) => assert.equal(codeOf(() => k.normalize(raw))?.message ?? null, null, `${k.name}: ${label} was refused`);
    accepted(dims(k.names.map((n) => good(n))), 'a complete critique');
    accepted(dims([good(d)]), 'a partial critique (the rest is NOT_MEASURABLE)');
    accepted(dims([good(d, { outcome: 'FAIL', revision_hint: 'Give the subject more presence in plain words.' })]), 'FAIL with a hint');
    accepted(dims([{ dimension: d, outcome: 'NOT_MEASURABLE' }]), 'NOT_MEASURABLE without evidence');
    refused({ dimensions: [], extra: 'x' }, 'a second top-level key');
    refused(dims([...k.names.map((n) => good(n)), good(d)]), 'more dimensions than exist');
    refused(dims([good(d), good(d)]), 'a repeated dimension');
    refused(dims([good('NOT_A_DIMENSION')]), 'an unknown dimension');
    refused(dims([{ ...good(d), extra: 'x' }]), 'an extra key in an entry');
    refused(dims([good(d, { outcome: 'GREAT' })]), 'an unknown outcome');
    refused(dims([good(d, { evidence: 'too short' })]), 'evidence below its minimum');
    refused(dims([good(d, { evidence: 'a'.repeat(k.evidenceMax + 1) })]), 'evidence above its maximum');
    refused(dims([good(d, { evidence: 'see https://example.com for details' })]), 'a URL');
    refused(dims([good(d, { evidence: `a visible fact${String.fromCharCode(7)} here` })]), 'a control character');
    refused(dims([good(d, { evidence: 'This image deserves 8/10 overall.' })]), 'a score in words');
    refused(dims([good(d, { evidence: 'Rated 4 out of 5 for impact.' })]), 'a rating in words');
    refused(dims([good(d, { evidence: 3 })]), 'a JSON number');
    refused(dims([good(d, { revision_hint: 'Give the subject more presence in plain words.' })]), 'a hint on a PASS');
    refused(dims([good(d, { outcome: 'FAIL', revision_hint: 'short' })]), 'a hint below its minimum');
    refused(dims([good(d, { outcome: 'FAIL', revision_hint: 'a'.repeat(301) })]), 'a hint above its maximum');
    for (const bad of ['Make it 20% larger on the page', 'Move it to x = 40 on the canvas', 'Change the font-size of the title', 'Use the colour #ff8800 for the text', 'Resize to 1080 by 1350 pixels']) refused(dims([good(d, { outcome: 'FAIL', revision_hint: bad })]), `a non-semantic hint (${bad})`);
    if (k.forbiddenKeys) for (const key of FORBIDDEN_KEYS_LIST) refused({ dimensions: [], [key]: 'x' }, `the forbidden key ${key}`);
  }
});

const NORMALIZE = {};
let FORBIDDEN_KEYS_LIST = [];
test.before(async () => {
  const { normalizeCritique } = await import('../src/creative-critic/critique.js');
  const { normalizeConceptCritique } = await import('../src/creative-brain/concept-critic.js');
  const { FORBIDDEN_KEYS } = await import('../src/creative-critic/critique.js');
  NORMALIZE.exec = normalizeCritique; NORMALIZE.concept = normalizeConceptCritique; FORBIDDEN_KEYS_LIST = [...FORBIDDEN_KEYS];
});

// ---- PF-10: REAL MODEL FAILURE PATTERNS. Not "does a valid structure pass", but "what does a language model actually do wrong, and does the system recover it SAFELY or refuse it PRECISELY":
// A = recoverable by a deterministic, journaled normalization (one call); B = unparseable text, recovered by the ONE protocol re-ask (two calls); C = refused with a precise code, never repaired, never re-asked (one call).
const runSeq = (c, replies) => {
  let n = 0;
  return askAndNormalize({ complete: async () => { const text = replies[n]; n += 1; if (text === undefined) throw new Error('no reply'); return { text, model: 'fake', request_id: `r${n}` }; }, instruction: { system: 's', user: 'u' }, stage: c.stage, spec: c.spec, normalize: c.normalize }).then((r) => ({ ...r, calls: n }));
};
const FAILURES_A = {
  fence: (t) => `\`\`\`json\n${t}\n\`\`\``,
  prose_around: (t) => `Here is the answer you asked for:\n\n${t}\n\nI hope this helps, let me know if you want changes.`,
  bom: (t) => `﻿${t}`,
  pretty_tabs: (t) => JSON.stringify(JSON.parse(t), null, '\t'),
  envelope_answer: (t) => JSON.stringify({ answer: JSON.parse(t) }),
  envelope_response_cased: (t) => JSON.stringify({ Response: JSON.parse(t) }),
  envelope_stage_name: (t) => JSON.stringify({ the_result_object: JSON.parse(t) }),
};
const FAILURES_B = {
  trailing_comma: (t) => t.replace(/\}$/, ',}'),
  truncated: (t) => t.slice(0, Math.max(10, t.length - 25)),
  missing_closing_brace: (t) => t.slice(0, -1),
  smart_quoted_keys: (t) => t.replace(/"([a-z_]+)":/, '“$1”:'),
  single_quoted: (t) => t.replace(/"([a-z_]+)":/g, "'$1':"),
  comment_inside: (t) => t.replace('{', '{ // the answer\n'),
  unquoted_first_key: (t) => t.replace(/^\{"([a-z_]+)":/, '{$1:'),
};

test('PF-10 real model failure patterns, every spec stage: A is recovered in one call with a journal and the same value; B gets exactly one re-ask and is recovered; C is refused precisely, with no repair and no re-ask', async () => {
  const specStages = STAGE_CONTRACTS.filter((c) => c.normalize);
  const collapsedChecked = new Set();
  assert.equal(specStages.length, 5);
  for (const c of specStages) {
    for (const seed of SEEDS.slice(0, 8)) {
      const valid = validAnswer(c.stage, seed);
      const expected = c.normalize(structuredClone(valid));
      const text = JSON.stringify(valid);
      for (const [name, damage] of Object.entries(FAILURES_A)) {
        const r = await runSeq(c, [damage(text)]);
        assert.deepEqual(r.value, expected, `${c.stage} A ${name}`);
        assert.equal(r.calls, 1, `${c.stage} A ${name}`);
        if (name.startsWith('envelope')) assert.deepEqual(r.meta.repairs.map((x) => x.kind), [REPAIR_KIND.ENVELOPE], `${c.stage} ${name}`);
      }
      for (const [name, damage] of Object.entries(FAILURES_B)) {
        const broken = damage(text);
        assert.throws(() => JSON.parse(broken.slice(broken.indexOf('{'), broken.lastIndexOf('}') + 1) || broken), `${c.stage} B ${name} must really be unparseable`);
        const r = await runSeq(c, [broken, text]);
        assert.deepEqual(r.value, expected, `${c.stage} B ${name}`);
        assert.equal(r.calls, 2, `${c.stage} B ${name}`);
        assert.equal(r.meta.protocol_repair.outcome, 'PARSED');
        const twice = await runSeq(c, [broken, broken, text]).catch((e) => e);
        assert.equal(twice.code, 'BRAIN_MALFORMED', `${c.stage} B ${name} twice`);
        assert.equal(twice.evidence.protocol_repair.outcome, 'STILL_MALFORMED');
      }
      // D: a list written WITHOUT its brackets that still parses ("a", "b" : "next" is a pair whose key is a sentence): a collapsed structure, repaired by the ONE re-ask, never silently accepted
      const validKeys = Object.keys(valid);
      const listKey = validKeys.find((k) => Array.isArray(valid[k]) && valid[k].length >= 2 && valid[k].every((v) => typeof v === 'string') && /\s/.test(valid[k][1]));
      if (listKey) {
        collapsedChecked.add(c.stage);
        const nextKey = validKeys[validKeys.indexOf(listKey) + 1] ?? validKeys[0];
        const parts = Object.entries(valid).map(([k, v]) => (k === listKey ? `${JSON.stringify(k)}:${JSON.stringify(v[0])},${JSON.stringify(v[1])} : ${JSON.stringify(nextKey)}` : `${JSON.stringify(k)}:${JSON.stringify(v)}`));
        const collapsed = `{${parts.join(',')}}`;
        JSON.parse(collapsed); // it really IS valid JSON: that is the point
        const fixed = await runSeq(c, [collapsed, text]);
        assert.deepEqual(fixed.value, expected, `${c.stage} D collapsed list`);
        assert.equal(fixed.calls, 2, `${c.stage} D collapsed list`);
        assert.equal(fixed.meta.protocol_repair.outcome, 'PARSED');
        const again = await runSeq(c, [collapsed, collapsed, text]).catch((e) => e);
        assert.equal(again.code, 'BRAIN_MALFORMED', `${c.stage} D twice`);
        assert.equal(again.detail.problem, 'STRUCTURE_COLLAPSED');
      }
      // C: refused precisely, in ONE call
      const keys = Object.keys(valid);
      const first = keys[0];
      const refusals = [
        ['duplicate key', text.replace('{', `{"${first}":${JSON.stringify(valid[first])},`), 'BRAIN_RULE_VIOLATION', /twice/],
        ['extra key', JSON.stringify({ ...valid, explanation: 'because' }), 'BRAIN_UNKNOWN_KEY', /explanation/],
        ['wrapper plus a sibling', JSON.stringify({ answer: valid, note: 'x' }), 'BRAIN_UNKNOWN_KEY', /answer|note/],
        ['a key replaced by a number', JSON.stringify({ ...valid, [first]: 7 }), ['BRAIN_NUMERIC_VALUE', 'BRAIN_LIST_INVALID', 'BRAIN_TEXT_INVALID', 'BRAIN_ENUM_INVALID', 'BRAIN_MALFORMED'], /./], // refused as a wrong TYPE, whichever check sees it first
        ['a key replaced by null', JSON.stringify({ ...valid, [first]: null }), null, /./],
        ['a key dropped, nothing misspelled', JSON.stringify(Object.fromEntries(Object.entries(valid).filter(([k]) => k !== first))), 'BRAIN_MISSING_KEY', /./],
        ['a list given as one string', JSON.stringify({ ...valid, ...Object.fromEntries(Object.entries(valid).filter(([, v]) => Array.isArray(v)).slice(0, 1).map(([k, v]) => [k, v.join('; ')])) }), null, /./],
      ];
      for (const [name, damaged, code, message] of refusals) {
        if (name === 'a list given as one string' && !Object.values(valid).some(Array.isArray)) continue;
        const e = await runSeq(c, [damaged, text]).then(() => null, (error) => error);
        assert.ok(e, `${c.stage} C ${name} must be refused`);
        if (code) assert.ok([].concat(code).includes(e.code), `${c.stage} C ${name}: ${e.code} ${e.message}`);
        assert.match(e.message, message, `${c.stage} C ${name}`);
        assert.equal(e.evidence.protocol_repair, undefined, `${c.stage} C ${name}: no re-ask for a parseable answer`);
        assert.equal(e.evidence.raw_answer, damaged.slice(0, 8000), `${c.stage} C ${name}`); // the evidence is bounded
      }
    }
  }
  assert.ok(collapsedChecked.has('FRAME'), `the collapsed-list class was exercised on ${[...collapsedChecked]}`);
});

test('PF-9 the generated matrix document is current (it is regenerated from the audit, never edited by hand)', async () => {
  const committed = await readFile(new URL('../docs/architecture/creative-brain-contract-matrix.md', import.meta.url), 'utf8').catch(() => null);
  assert.ok(committed, 'run: node scripts/check-creative-brain-parity.mjs --write-matrix');
  assert.equal(committed.replace(/\r\n/g, '\n'), renderContractMatrix());
  void renderSpec;
});
