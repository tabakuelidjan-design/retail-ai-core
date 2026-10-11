import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import * as C from '../src/creative-critic/index.js';
import * as CI from '../src/creative-intelligence/index.js';
import {
  assessDirectionExecutable, computeLayoutCapabilityProfile, createApprovedCopyAgent, createCreativeDirector, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst,
  createRevisionDirector, createVisualProductionDirector, describeStop, DIRECTOR_CONSTANTS, executableSpatialIntents, normalizeLayoutCapabilityProfile, runProductPreservingCreative,
} from '../src/creative-runtime/index.js';
import {
  BRAND, buildBrief, directorAnswer, fakeEnvironmentPort, fonts, GUARDIAN_PASS, IDS,
} from './runtime-world.js';

// The layout capability profile (`// LC-N` markers): the Revision Director learns what the layout can EXECUTE before it chooses; the planner stays authoritative.

const AT = '2026-10-10T12:00:00.000Z';
const sha = (s) => createHash('sha256').update(s).digest('hex');
// approved supporting claims of three lengths: it fits wherever there is a wide slot / only in the widest slot / nowhere (the type rules allow a single line)
const SHORT = 'Coque personnalisée en 5 minutes';
const LONG = 'Coque personnalisée avec votre photo préférée imprimée en quelques minutes seulement dans notre atelier de Namur'.slice(0, 60).trim();
const TOO_LONG = 'Coque personnalisée avec votre photo préférée imprimée en quelques minutes seulement dans notre atelier de Namur'.slice(0, 70).trim();
const briefWith = (wording) => { const b = buildBrief(); b.claims[0] = { ...b.claims[0], wording }; return b; };
const profileOf = (wording) => computeLayoutCapabilityProfile({ at: AT, brief: briefWith(wording), fonts });
const BOTH = ['PRODUCT_HERO', 'PRODUCT_DOMINANT'];

// ---- a revision input without running the pipeline: a previous direction, a critique, a request
const previous = JSON.parse(directorAnswer());
const previousDirection = { ...previous };
const critiqueOf = () => C.normalizeCritique({
  dimensions: C.DIMENSIONS.map((dimension) => (dimension === 'PRICE_INTEGRATION'
    ? { dimension, outcome: 'FAIL', evidence: 'The price treatment competes with the product for attention.', revision_hint: 'Integrate the price more subtly into the composition.' }
    : { dimension, outcome: 'PASS', evidence: 'The image shows this clearly enough.' })),
}, { candidate_ref: 'candidate:test', candidate_sha256: sha('png') });
function revisionInput() {
  const critique = critiqueOf();
  return {
    previous_direction: previousDirection,
    candidate_evidence: { candidate_sha256: sha('png'), recipe_id: 'PRODUCT_HERO', spatial_intent: previous.spatial_intent, text_roles: ['HEADLINE', 'SUBHEADLINE', 'PRICE'], plate_used: false, preflight: 'PASS', fidelity: 'PASS', guardian: 'PASS' },
    critique,
    revision_request: C.buildRevisionRequest({ critique, iteration: 1 }),
  };
}
function directorOf(answer) {
  const ledger = createDecisionLedger(); const prompts = [];
  const agent = createRevisionDirector({ ledger, complete: async (p) => { prompts.push(p); return { text: answer }; }, constants: DIRECTOR_CONSTANTS });
  const invoke = (capability) => agent.invoke({
    brief: { public_facts: {}, approved_text_roles: ['HEADLINE', 'SUBHEADLINE', 'PRICE'], format: {}, expression: BRAND.expression },
    ids: { merchant_id: IDS.merchant_id, brand_id: IDS.brand_id, brief_ref: IDS.brief_ref, asset_refs: ['asset://test/runtime/real-case'], claim_refs: ['claim://test/promise', 'claim://test/price'], evidence_refs: [] },
    revision: revisionInput(), ...(capability === undefined ? {} : { capability }),
  }, { merchant_id: IDS.merchant_id, brand_id: IDS.brand_id, brief_ref: IDS.brief_ref, claim_refs: ['claim://test/promise', 'claim://test/price'] });
  return { invoke, prompts };
}
const REVISED = (over = {}) => directorAnswer({
  concept: 'The real case leads, with the approved message set quietly beneath it on a calm surface.', spatial_intent: 'PRODUCT_CENTER_TEXT_BELOW', negative_space_intent: 'TOP',
  hierarchy: ['PRODUCT', 'HEADLINE', 'SUBHEADLINE', 'PRICE'], visual_intent: 'a matte pale surface with a long soft raking light and a faint, believable contact shadow', ...over,
});

test('LC-1 the Director cannot choose a spatial intent with no executable recipe, nor drop an approved message', async () => {
  const profile = profileOf(SHORT);
  // the profile says what is executable for the approved copy
  assert.deepEqual(executableSpatialIntents(profile), ['PRODUCT_CENTER_TEXT_BELOW', 'PRODUCT_CENTER_TEXT_ABOVE', 'TEXT_DOMINANT', 'PRODUCT_AND_PRICE']);
  assert.deepEqual(profile.spatial_intents.find((s) => s.spatial_intent === 'PRODUCT_END_TEXT_START').recipes, []); // no recipe at all
  assert.equal(profile.spatial_intents.find((s) => s.spatial_intent === 'PRODUCT_START_TEXT_END').executable, false); // a recipe exists, but it cannot carry every approved text
  // a valid choice is accepted
  const ok = directorOf(REVISED());
  const accepted = await ok.invoke(profile);
  assert.equal(accepted.directions[0].spatial_intent, 'PRODUCT_CENTER_TEXT_BELOW');
  // the Director is told the capabilities before it chooses
  const wire = JSON.parse(ok.prompts[0].user);
  assert.deepEqual(wire.layout_capabilities, JSON.parse(JSON.stringify(profile)));
  assert.match(ok.prompts[0].system, /EXECUTABLE by the layout capabilities/);
  // refused: no recipe for the intent / a recipe that cannot carry the approved texts / an approved role dropped from the hierarchy
  for (const [answer, reason] of [
    [REVISED({ spatial_intent: 'PRODUCT_END_TEXT_START' }), 'NO_RECIPE_FOR_THE_SPATIAL_INTENT'],
    [REVISED({ spatial_intent: 'PRODUCT_START_TEXT_END' }), 'NO_RECIPE_CARRIES_EVERY_APPROVED_TEXT'],
    [REVISED({ hierarchy: ['PRODUCT', 'HEADLINE', 'PRICE'] }), 'MISSING_APPROVED_ROLE:SUBHEADLINE'],
  ]) {
    const error = await directorOf(answer).invoke(profile).catch((e) => e);
    assert.equal(error.code, CI.CI_ERROR.AGENT_FAILED);
    assert.equal(error.detail.cause.code, 'REVISION_DIRECTION_NOT_EXECUTABLE', reason);
    const verdict = assessDirectionExecutable(profile, JSON.parse(answer));
    assert.equal(verdict.executable, false);
    assert.ok(verdict.reasons.includes(reason), `${reason} in ${verdict.reasons}`);
  }
});

test('LC-2 long supporting copy excludes the recipes that only support one line, monotonically (never the other way round)', () => {
  const fits = (wording) => profileOf(wording).recipes.filter((r) => r.role_fit.SUBHEADLINE === 'FITS').map((r) => r.recipe_id);
  const short = fits(SHORT); const long = fits(LONG); const tooLong = fits(TOO_LONG);
  assert.ok(short.length > long.length && long.length > tooLong.length, JSON.stringify([short, long, tooLong]));
  assert.ok(long.every((id) => short.includes(id)) && tooLong.every((id) => long.includes(id)));
  assert.deepEqual(tooLong, []);
  // the type rules make the supporting text a single line; the headline may take several
  assert.deepEqual(profileOf(SHORT).text_roles, [{ role: 'HEADLINE', line_policy: 'MULTI_LINE' }, { role: 'SUBHEADLINE', line_policy: 'SINGLE_LINE' }, { role: 'PRICE', line_policy: 'SINGLE_LINE' }]);
  // the executable spatial intents shrink with it, down to none
  assert.deepEqual(executableSpatialIntents(profileOf(LONG)), ['PRODUCT_CENTER_TEXT_ABOVE']);
  assert.deepEqual(executableSpatialIntents(profileOf(TOO_LONG)), []);
  // a role with no slot is NO_SLOT (not a silent pass)
  const noSlot = profileOf(SHORT);
  assert.ok(noSlot.recipes.every((r) => Object.values(r.role_fit).every((f) => ['FITS', 'DOES_NOT_FIT', 'NO_SLOT'].includes(f))));
});

test('LC-3 several valid recipes remain available when possible (the profile does not collapse choices)', () => {
  const profile = profileOf(SHORT);
  const above = profile.spatial_intents.find((s) => s.spatial_intent === 'PRODUCT_CENTER_TEXT_ABOVE');
  assert.deepEqual([...above.recipes].sort(), [...BOTH].sort());
  assert.ok(above.recipes.every((id) => profile.recipes.find((r) => r.recipe_id === id).complete));
  assert.ok(executableSpatialIntents(profile).length >= 3);
  assert.equal(profile.recipes.filter((r) => r.complete).length, 4);
  // every executable direction names the recipes that can realize it
  const verdict = assessDirectionExecutable(profile, { spatial_intent: 'PRODUCT_CENTER_TEXT_ABOVE', hierarchy: ['HEADLINE', 'SUBHEADLINE', 'PRODUCT', 'PRICE'], product_role: 'HERO' });
  assert.equal(verdict.executable, true);
  assert.deepEqual([...verdict.recipes].sort(), [...BOTH].sort());
});

test('LC-4 the profile holds no pixel coordinate, size, count, font, colour, copy or brand value, and a validator refuses any', () => {
  const profile = profileOf(SHORT);
  const walk = (v, path = 'profile') => {
    if (typeof v === 'number') assert.fail(`${path} is a number`);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.doesNotMatch(k, /^(x|y|w|h|width|height|size|font[a-z_]*|colou?r|px|top|left|box|geometry)$/i, `${path}.${k}`); walk(x, `${path}.${k}`); }
  };
  walk(profile);
  const text = JSON.stringify(profile);
  assert.doesNotMatch(text, /\d+\s*(px|pt|%)|#[0-9a-f]{3,8}\b|font|DejaVu|Montserrat|Playfair|HABB|Namur|Samsung|phone|coque|5 minutes|25 €/i);
  assert.ok(!text.includes(IDS.merchant_id) && !text.includes(IDS.brand_id));
  assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.recipes[0]));
  // the validator: unknown keys, numbers and unknown words are refused
  const bad = (mutate, code) => assert.throws(() => normalizeLayoutCapabilityProfile(mutate(structuredClone(JSON.parse(JSON.stringify(profile))))), (e) => e.code === code, code);
  bad((p) => { p.recipes[0].x = 3; return p; }, 'LAYOUT_CAPABILITY_NUMERIC_VALUE');
  bad((p) => { p.recipes[0].geometry = {}; return p; }, 'LAYOUT_CAPABILITY_KEY_NOT_ALLOWED');
  bad((p) => { p.text_roles[0].font_size = 30; return p; }, 'LAYOUT_CAPABILITY_NUMERIC_VALUE');
  bad((p) => { p.text_roles[0].font_name = 'Some Font'; return p; }, 'LAYOUT_CAPABILITY_KEY_NOT_ALLOWED');
  bad((p) => { p.recipes[0].brand_colour = 'navy'; return p; }, 'LAYOUT_CAPABILITY_KEY_NOT_ALLOWED');
  bad((p) => { p.spatial_intents[0].usable_roles = [1]; return p; }, 'LAYOUT_CAPABILITY_NUMERIC_VALUE');
  bad((p) => { p.recipes[0].role_fit.HEADLINE = 'MAYBE'; return p; }, 'LAYOUT_CAPABILITY_MALFORMED');
  bad((p) => { p.schema_version = 'x'; return p; }, 'LAYOUT_CAPABILITY_MALFORMED');
});

function runtimeWith({ brief, direction, answer }) {
  const ledger = createDecisionLedger(); const environment = fakeEnvironmentPort(); const prompts = [];
  const agents = {
    analyst: createProductAssetAnalyst({ ledger, expression: BRAND.expression }),
    director: createCreativeDirector({ ledger, complete: async () => ({ text: direction ?? directorAnswer() }), constants: DIRECTOR_CONSTANTS }),
    revision_director: createRevisionDirector({ ledger, complete: async (p) => { prompts.push(p); return { text: answer ?? REVISED() }; }, constants: DIRECTOR_CONSTANTS }),
    copy: createApprovedCopyAgent({ ledger }),
    visual_director: createVisualProductionDirector({ ledger, expression: BRAND.expression }),
  };
  return { ledger, environment, prompts, agents, run: (extra = {}) => runProductPreservingCreative({ at: AT, brief, fonts, ledger, guardian: GUARDIAN_PASS, agents, ports: { segmenter: createLocalProductSegmenter({ ledger }), environment }, ...extra }) };
}

test('LC-5 the planner stays authoritative: a direction that gets past the capabilities is still caught by the layout solver, before any provider call', async () => {
  // a revision Director that does not look at the capabilities at all (the profile is advice, not the check): it returns a direction the recipes cannot carry
  const s = runtimeWith({ brief: buildBrief(), direction: directorAnswer({ spatial_intent: 'PRODUCT_START_TEXT_END', negative_space_intent: 'SURROUNDING', hierarchy: ['PRODUCT', 'HEADLINE', 'SUBHEADLINE', 'PRICE'] }) });
  s.agents.revision_director = s.agents.director;
  const revision = { ...revisionInput(), previous_direction: previousDirection };
  const result = await s.run({ revision });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'THE_LAYOUT_COULD_NOT_BE_SOLVED');
  assert.equal(result.before_environment_call, true);
  assert.equal(s.environment.calls.length, 0);
  assert.equal(describeStop({ result }).cause, 'LAYOUT_CAPABILITY_LIMIT');
});

test('LC-6 when no valid layout capability exists, no provider call is made at all (neither the Director nor the environment image)', async () => {
  const s = runtimeWith({ brief: briefWith(TOO_LONG) });
  const result = await s.run({ revision: revisionInput() });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'NO_EXECUTABLE_LAYOUT_CAPABILITY');
  assert.equal(s.prompts.length, 0, 'the revision Director is not consulted');
  assert.equal(s.environment.calls.length, 0, 'no environment image is requested');
  assert.deepEqual(result.ledger.map((e) => e.decision), ['PRODUCT_PRESERVATION_MODE']);
  assert.equal(result.steering.manual_creative_steering, 'NONE');
  const stop = describeStop({ result });
  assert.equal(stop.cause, 'LAYOUT_CAPABILITY_LIMIT');
  assert.equal(stop.stage, 'LAYOUT_PLAN');
  // the Director itself also refuses to consult the model with an empty capability
  const director = directorOf(REVISED());
  const error = await director.invoke(profileOf(TOO_LONG)).catch((e) => e);
  assert.equal(error.detail.cause.code, 'NO_EXECUTABLE_LAYOUT_CAPABILITY');
  assert.equal(director.prompts.length, 0);
  // a profile that cannot even be computed (the brand has no typography for a text role) stops the run the same way, before any call
  const noType = runtimeWith({ brief: buildBrief({ brand: { ...BRAND, typography_roles: {} } }) });
  const stopped = await noType.run({ revision: revisionInput() });
  assert.equal(stopped.reason, 'NO_EXECUTABLE_LAYOUT_CAPABILITY');
  assert.equal(stopped.message, 'NO_TYPOGRAPHY_ROLE_FOR_TEXT_ROLE');
  assert.equal(noType.prompts.length + noType.environment.calls.length, 0);
  // and a revision without any capability profile is refused
  const missing = await directorOf(REVISED()).invoke(undefined).catch((e) => e);
  assert.equal(missing.detail.cause.code, 'REVISION_CAPABILITY_REQUIRED');
});

test('LC-7 the profile is derived from the planner itself and from the type rules, not declared; the modules hold no provider or brand name', async () => {
  const layoutPlan = await readFile(new URL('../src/creative-runtime/layout-plan.js', import.meta.url), 'utf8');
  const capability = await readFile(new URL('../src/creative-runtime/layout-capability.js', import.meta.url), 'utf8');
  assert.match(capability, /solveRecipeLayout/); // the same solver as the runtime
  assert.match(capability, /TYPE_SCALE\.max_lines/); // the type rules
  assert.match(layoutPlan, /export function solveRecipeLayout/);
  const runtime = await readFile(new URL('../src/creative-runtime/runtime.js', import.meta.url), 'utf8');
  assert.match(runtime, /solveRecipeLayout\(/); // the runtime solves with it too
  assert.doesNotMatch(capability.replace(/\/\/.*$/gm, ''), /HABB|qwen|alibaba|Namur|Samsung/i);
});
