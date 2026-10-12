import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FORMAT_RESOURCES } from '../src/creative-planning/index.js';
import {
  assetChars, auditCampaignParity, auditDiversity, buildContinuityContract, CAMPAIGN_STAGE_CONTRACTS, classifyDensity, COMPOSITION_MAX_DENSITY, DENSITY_CLASS, DENSITY_ORDER, deriveObjectiveKind, densityRank,
  LOW_DENSITY_MAX_CHARS, planSequence, renderCampaignContractMatrix, ROLE_OPTIONS, TEXT_LED_FALLBACK,
} from '../src/creative-campaign/index.js';
import { auditSpecStage } from '../src/creative-brain/parity.js';

// THE DENSITY CLASSES, THE SEQUENCE AND THE CAMPAIGN PARITY (`// DS-N` markers).

const feed = FORMAT_RESOURCES[0];
const asset = (role, slots = [], chars = 0) => ({ asset_role: role, slots: slots.map((r) => ({ role: r, chars, text: 'x' })) });
const cover = asset('COVER', ['HEADLINE'], 60); const closing = (slots) => asset('CLOSING', slots, 10);
const body = (n = 1) => Array.from({ length: n }, () => asset('CONTENT', ['BODY'], 300));

test('DS-1 density classes follow the measured capacities of the format, never a bare character count', () => {
  const c = feed.slide_capacity;
  assert.deepEqual(DENSITY_ORDER, ['LOW', 'MEDIUM', 'HIGH', 'TEXT_LED']);
  assert.equal(classifyDensity(LOW_DENSITY_MAX_CHARS, feed).density_class, 'LOW');
  assert.equal(classifyDensity(LOW_DENSITY_MAX_CHARS + 1, feed).density_class, 'MEDIUM');
  assert.equal(classifyDensity(c.MEDIUM.chars, feed).density_class, 'MEDIUM'); assert.equal(classifyDensity(c.MEDIUM.chars + 1, feed).density_class, 'HIGH');
  assert.equal(classifyDensity(c.HIGH.chars, feed).density_class, 'HIGH'); assert.equal(classifyDensity(c.HIGH.chars + 1, feed).density_class, 'TEXT_LED');
  assert.equal(classifyDensity(c.TEXT_LED.chars, feed).over_ceiling, false); assert.equal(classifyDensity(c.TEXT_LED.chars + 1, feed).over_ceiling, true);
  const story = FORMAT_RESOURCES[2];
  assert.notEqual(classifyDensity(300, story).density_class, classifyDensity(300, feed).density_class, 'the same text is a different class on another canvas');
  assert.equal(assetChars({ slots: [{ chars: 10 }, { chars: 5 }] }), 16);
  assert.ok(densityRank('TEXT_LED') > densityRank('HIGH') && densityRank('LOW') === 0);
});

test('DS-2 position fixes the frame: the cover is the hook, a closing asset is the offer with a price and the call to action without', () => {
  const seq = planSequence({ assets: [cover, ...body(2), closing(['CTA', 'PRICE'])], densities: ['LOW', 'HIGH', 'HIGH', 'LOW'], objectiveKind: 'SELL' });
  assert.deepEqual(seq.map((s) => s.narrative_role), ['HOOK', 'DETAIL', 'PROGRESSION', 'OFFER']);
  assert.equal(planSequence({ assets: [cover, ...body(1), closing(['CTA'])], densities: ['LOW', 'HIGH', 'LOW'], objectiveKind: 'EDUCATE' }).at(-1).narrative_role, 'CTA');
  assert.equal(planSequence({ assets: [asset('SINGLE', ['HEADLINE'], 40)], densities: ['LOW'], objectiveKind: 'AWARENESS' })[0].narrative_role, 'HOOK');
  assert.equal(planSequence({ assets: [asset('SINGLE', ['HEADLINE', 'PRICE'], 40)], densities: ['LOW'], objectiveKind: 'SELL' })[0].narrative_role, 'OFFER');
});

test('DS-3 the objective shapes the body, and no role is forced where the content does not need it', () => {
  const run = (objectiveKind, n) => planSequence({ assets: [cover, ...body(n)], densities: ['LOW', ...Array(n).fill('HIGH')], objectiveKind }).map((s) => s.narrative_role);
  assert.deepEqual(run('EDUCATE', 3), ['HOOK', 'CONTEXT', 'PROGRESSION', 'PROGRESSION']);
  assert.deepEqual(run('SELL', 3), ['HOOK', 'DETAIL', 'PROGRESSION', 'PROGRESSION']);
  assert.deepEqual(run('AWARENESS', 3), ['HOOK', 'CONTEXT', 'DETAIL', 'PROGRESSION']);
  assert.deepEqual(run('ANNOUNCE', 2), ['HOOK', 'DETAIL', 'PROGRESSION']);
  assert.ok(!run('EDUCATE', 4).includes('PROOF') && !run('EDUCATE', 4).includes('OFFER') && !run('EDUCATE', 4).includes('PROBLEM'), 'a role the content does not need is not invented');
  assert.equal(planSequence({ assets: [cover, ...body(4)], densities: ['LOW', ...Array(4).fill('HIGH')], objectiveKind: 'EDUCATE', proofAvailable: true }).at(-1).narrative_role, 'PROOF');
  assert.ok(!planSequence({ assets: [cover, ...body(2)], densities: ['LOW', 'HIGH', 'HIGH'], objectiveKind: 'EDUCATE', proofAvailable: true }).some((s) => s.narrative_role === 'PROOF'), 'proof needs three body assets to be a step of its own');
  assert.equal(deriveObjectiveKind({ assets: [asset('SINGLE', ['PRICE'], 5)], bodyChars: 0 }), 'SELL');
  assert.equal(deriveObjectiveKind({ assets: [cover], bodyChars: 700 }), 'EDUCATE'); assert.equal(deriveObjectiveKind({ assets: [cover], bodyChars: 100 }), 'AWARENESS');
});

test('DS-4 the density bounds the role: a role that should say little is replaced when its locked copy is long, but a position is kept', () => {
  const seq = planSequence({ assets: [cover, ...body(3)], densities: ['LOW', 'MEDIUM', 'TEXT_LED', 'TEXT_LED'], objectiveKind: 'SELL' });
  assert.deepEqual(seq.map((s) => s.narrative_role), ['HOOK', 'DETAIL', 'PROGRESSION', 'PROGRESSION']);
  const heavy = planSequence({ assets: [cover, ...body(2)], densities: ['LOW', 'TEXT_LED', 'TEXT_LED'], objectiveKind: 'SELL' });
  assert.equal(heavy[1].narrative_role, 'PROGRESSION'); assert.equal(heavy[1].role_rule, 'DENSITY_BOUNDS_THE_ROLE');
  const longHook = planSequence({ assets: [cover, ...body(1)], densities: ['TEXT_LED', 'HIGH'], objectiveKind: 'EDUCATE' });
  assert.equal(longHook[0].narrative_role, 'HOOK', 'a cover stays the hook, its copy is not cut');
  const bodyFirst = planSequence({ assets: [...body(3)], densities: ['HIGH', 'HIGH', 'HIGH'], objectiveKind: 'EDUCATE' });
  assert.notEqual(bodyFirst[0].narrative_role, 'HOOK', 'a heavy first asset is not a hook');
  const lightFirst = planSequence({ assets: [...body(3)], densities: ['MEDIUM', 'HIGH', 'HIGH'], objectiveKind: 'EDUCATE' });
  assert.equal(lightFirst[0].narrative_role, 'HOOK');
});

test('DS-5 a person can name the role of an asset, and the name is kept', () => {
  const seq = planSequence({ assets: [cover, ...body(3)], densities: ['LOW', 'HIGH', 'HIGH', 'HIGH'], objectiveKind: 'EDUCATE', hints: new Map([[2, { narrative_role: 'PROBLEM' }], [1, { narrative_role: 'PROOF' }]]) });
  assert.deepEqual(seq.map((s) => [s.narrative_role, s.role_rule]).slice(1, 3), [['PROOF', 'HINT_OVERRIDES'], ['PROBLEM', 'HINT_OVERRIDES']]);
});

test('DS-6 an asset never repeats the look of its predecessor and a repeated role does not repeat its look; every look carries its density', () => {
  const n = 10;
  const seq = planSequence({ assets: [cover, ...body(n - 1)], densities: ['LOW', ...Array(n - 1).fill('HIGH')], objectiveKind: 'EDUCATE' });
  for (let i = 1; i < n; i += 1) assert.notDeepEqual([seq[i].composition_intent, seq[i].imagery_intent], [seq[i - 1].composition_intent, seq[i - 1].imagery_intent]);
  for (const s of seq) assert.ok(densityRank(COMPOSITION_MAX_DENSITY[s.composition_intent]) >= densityRank('HIGH') || s.index === 0, `${s.composition_intent} can carry a HIGH slide`);
  const heavy = planSequence({ assets: Array.from({ length: 8 }, () => asset('CONTENT', ['BODY'], 500)), densities: Array(8).fill('TEXT_LED'), objectiveKind: 'EDUCATE' });
  assert.ok(new Set(heavy.map((s) => `${s.composition_intent}/${s.imagery_intent}`)).size >= 4, 'even eight text-led slides do not share one template');
  assert.ok(heavy.every((s) => densityRank(COMPOSITION_MAX_DENSITY[s.composition_intent]) === densityRank('TEXT_LED')));
  assert.ok(TEXT_LED_FALLBACK.length >= 5 && Object.values(ROLE_OPTIONS).every((o) => o.length >= 2));
});

test('DS-7 FUZZ: any sequence of roles and densities gives no repeated neighbour and a look that carries its density', () => {
  const mulberry = (seed) => () => { let t = (seed += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = mulberry(5);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  for (let k = 0; k < 400; k += 1) {
    const n = 1 + Math.floor(r() * 10);
    const assets = Array.from({ length: n }, (_, i) => asset(i === 0 && r() > 0.3 ? 'COVER' : (i === n - 1 && n > 1 && r() > 0.5 ? 'CLOSING' : 'CONTENT'), pick([['HEADLINE'], ['BODY'], ['CTA', 'PRICE'], ['BODY', 'SUBHEADLINE']]), 100));
    const densities = assets.map(() => pick(DENSITY_ORDER));
    const seq = planSequence({ assets, densities, objectiveKind: pick(['EDUCATE', 'SELL', 'AWARENESS', 'ANNOUNCE']), proofAvailable: r() > 0.5 });
    assert.equal(seq.length, n);
    for (let i = 0; i < n; i += 1) {
      assert.ok(densityRank(COMPOSITION_MAX_DENSITY[seq[i].composition_intent]) >= densityRank(densities[i]) || densities[i] === 'LOW', `fuzz ${k}/${i}: the look carries its density`);
      if (i > 0 && n > 1) assert.notEqual(`${seq[i].composition_intent}/${seq[i].imagery_intent}`, `${seq[i - 1].composition_intent}/${seq[i - 1].imagery_intent}`, `fuzz ${k}/${i}`);
    }
  }
});

test('DS-8 diversity needs real variation: identical looks, roles and copy fail, and the report counts what it measures', () => {
  const mk = (role, comp, img, text, cls = 'HIGH') => ({ narrative_role: role, composition_intent: comp, imagery_intent: img, density: { density_class: cls }, copy: text ? [{ text }] : [] });
  const good = auditDiversity([mk('HOOK', 'PRODUCT_CENTERED', 'PRODUCT_HERO', 'a', 'LOW'), mk('CONTEXT', 'WIDE_ESTABLISHING', 'PRODUCT_IN_CONTEXT', 'b'), mk('PROGRESSION', 'SPLIT_PANEL', 'PRODUCT_DETAIL', 'c'), mk('CTA', 'TEXT_FIRST', 'TYPOGRAPHIC_PANEL', 'd', 'LOW')]);
  assert.equal(good.passed, true); assert.equal(good.assets, 4); assert.equal(good.distinct_roles, 4); assert.equal(good.distinct_pairs, 4); assert.deepEqual(good.density_classes, { LOW: 2, MEDIUM: 0, HIGH: 2, TEXT_LED: 0 });
  assert.equal(auditDiversity([mk('HOOK', 'PRODUCT_CENTERED', 'PRODUCT_HERO', 'a'), mk('CONTEXT', 'PRODUCT_CENTERED', 'PRODUCT_HERO', 'b')]).rules[0].passed, false);
  assert.equal(auditDiversity([mk('A', 'X', 'Y', 'same'), mk('B', 'Z', 'Y', 'same'), mk('C', 'X', 'Y', 'other')]).rules.find((r) => r.id === 'NO_COPY_IS_REPEATED_ON_TWO_ASSETS').passed, false);
  assert.equal(auditDiversity([mk('A', 'X', 'Y', ''), mk('B', 'Z', 'Y', '')]).rules.find((r) => r.id === 'NO_COPY_IS_REPEATED_ON_TWO_ASSETS').passed, true, 'assets without text do not repeat any');
  assert.ok(Object.isFrozen(good));
});

test('DS-9 the campaign parity: the imagery brief stage agrees with its validator, the audit is not decorative, the matrix is committed', () => {
  const audit = auditCampaignParity();
  assert.deepEqual(audit.failures, []); assert.deepEqual(audit.stages.map((s) => s.stage), ['ASSET_BRIEF', 'SEQUENCE', 'CONTINUITY', 'DIVERSITY', 'CAMPAIGN_BUDGET', 'CAMPAIGN_STATE']);
  for (const c of CAMPAIGN_STAGE_CONTRACTS) {
    const real = c.instruction().system;
    for (const r of c.rules) assert.ok(auditSpecStage({ ...c, instruction: () => ({ system: real.replace(r.statement, 'omitted') }) }).failures.some((f) => f.includes(r.id)), r.id);
    assert.ok(auditSpecStage({ ...c, instruction: () => ({ system: 'You are a writer.' }) }).failures.length >= 8);
  }
  const committed = readFileSync(new URL('../docs/architecture/creative-campaign-contract-matrix.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, renderCampaignContractMatrix()); assert.ok(!/\b[0-9a-f]{64}\b/.test(committed));
});

test('DS-10 the continuity contract is content-derived: the same inputs give the same id, another concept another id', () => {
  const frame = { frame_id: 'cpf_1' }; const art = { art_direction_id: 'cad_1', atmosphere: 'quiet', material_language: 'wood', lighting_intent: 'soft', depth_model: 'SHALLOW_LAYERS', visual_rhythm: 'STILL', product_relationship: 'GROUNDED_IN_SCENE', realism: 'PHOTOREALISTIC', emotional_temperature: 'WARM', visual_tension: 'LOW', text_image_relationship: 'TEXT_IN_CALM_ZONES' };
  const brief = { ids: { brand_id: 'b', product_ref: 'p' }, asset: { ref: 'a' }, brand: { expression: { photography: {} } } };
  const make = (conceptId) => buildContinuityContract({ frame, concept: { concept_id: conceptId, central_idea: 'idea' }, artDirection: art, brief, factRefs: ['f2', 'f1'], copyRefs: ['c1'] });
  assert.equal(make('cnc_1').continuity_id, make('cnc_1').continuity_id); assert.notEqual(make('cnc_1').continuity_id, make('cnc_2').continuity_id);
  assert.deepEqual(make('cnc_1').must_stay_consistent[4].refs, ['c1', 'f1', 'f2'], 'the refs are sorted and unique');
  assert.deepEqual(make('cnc_1').must_stay_consistent[2].refs, ['b', 'expression:photography']);
  assert.ok(Object.values(COMPOSITION_MAX_DENSITY).every((d) => Object.values(DENSITY_CLASS).includes(d)));
});
