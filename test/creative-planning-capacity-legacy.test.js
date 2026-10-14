import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import * as CI from '../src/creative-intelligence/index.js';
import { createCreativeBrain } from '../src/creative-brain/index.js';
import { assessBrief, BRIEF_STATUS } from '../src/creative-brain/brief-assessment.js';
import { computeLayoutCapabilityProfile } from '../src/creative-runtime/index.js';
import { createDecisionLedger } from '../src/creative-runtime/ledger.js';
import {
  briefForAsset, CAPACITY_BASIS, createContentFormatPlanner, EXECUTABLE_ROLES, FORMAT_RESOURCES, fitsSlide, LIMITS, measureSlideCapacity, ratioOf, requestFromBrief, TEXT_LED_SPEC,
} from '../src/creative-planning/index.js';
import { buildBrief, fonts } from './runtime-world.js';
import {
  artDirectionAnswer, compositionAnswer, CONCEPTS, evaluationsAnswer, frameAnswer, scriptedPort,
} from './creative-brain-world.js';

// CAPACITY AGAINST THE REAL LAYOUT, AND THE SINGLE-IMAGE GOLDEN PATH (`// CL-N` markers).

const AT = '2026-10-10T12:00:00.000Z';
const filler = (chars) => { const w = ['alpha', 'bravo', 'delta', 'ecole', 'fruit', 'glace']; let t = ''; let i = 0; while (t.length < chars) { t += (t ? ' ' : '') + w[i % w.length]; i += 1; } return t.slice(0, chars).trim(); };
const fits = (resource, role, text) => {
  const b = buildBrief();
  b.format = { ...b.format, ref: resource.format_ref, canvas: { ...resource.canvas }, aspect_ratio: resource.aspect_ratio };
  if (role === 'HEADLINE') b.approved_copy = [{ ref: 'copy://t/h', role, content: text }];
  else b.claims = [{ ref: 'claim://t/c', role, wording: text }];
  const profile = computeLayoutCapabilityProfile({ at: AT, brief: b, fonts });
  return profile.recipes.some((r) => r.role_fit[role] === 'FITS');
};

test('CL-1 every MEASURED capacity is re-measured against the real layout engine on every canvas: a text of exactly that size fits', () => {
  for (const resource of FORMAT_RESOURCES) {
    for (const role of EXECUTABLE_ROLES) {
      const cap = resource.text_capacity[role];
      assert.equal(cap.basis, CAPACITY_BASIS.MEASURED, `${role} is measured`);
      assert.ok(fits(resource, role, filler(cap.chars)), `${resource.format_ref}: ${role} of ${cap.chars} characters fits a slot`);
    }
  }
});

test('CL-2 the capacity is honest about its own limit: a text far beyond it does not fit', () => {
  const feed = FORMAT_RESOURCES[0];
  for (const role of EXECUTABLE_ROLES) assert.ok(!fits(feed, role, filler(feed.text_capacity[role].chars * 3)), `${role} three times the capacity does not fit`);
});

test('CL-3 the roles the planner treats as executable are exactly the roles the layout recipes have a slot for', () => {
  const slotRoles = new Set(CI.LAYOUT_RECIPE_IDS.flatMap((id) => CI.getLayoutRecipe(id).slots.map((s) => s.role)));
  slotRoles.delete('PRODUCT'); slotRoles.delete('LOGO');
  assert.deepEqual([...slotRoles].sort(), [...EXECUTABLE_ROLES].sort());
});

test('CL-4 format resources are well formed and the executable capacities are the same on every canvas', () => {
  for (const r of FORMAT_RESOURCES) {
    assert.equal(r.aspect_ratio, ratioOf(r.canvas.width, r.canvas.height), r.format_ref);
    assert.equal(r.canvas.unit, 'px'); assert.ok(r.within_current_production_limit === (r.canvas.width * r.canvas.height <= LIMITS.max_production_pixels));
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.canvas) && Object.isFrozen(r.text_capacity));
    for (const role of EXECUTABLE_ROLES) assert.deepEqual(r.text_capacity[role], FORMAT_RESOURCES[0].text_capacity[role]);
    assert.equal(r.text_capacity.BODY.basis, CAPACITY_BASIS.MEASURED_LED, 'a role with no layout recipe is measured against the text-led spec, and its asset stays planned');
  }
  assert.equal(new Set(FORMAT_RESOURCES.map((r) => r.format_ref)).size, FORMAT_RESOURCES.length);
  for (const kind of ['SINGLE_IMAGE', 'CAROUSEL', 'MULTI_VISUAL_SERIES', 'STORY_SEQUENCE', 'POSTER', 'FLYER']) assert.ok(FORMAT_RESOURCES.some((r) => r.kinds.includes(kind)), `a resource serves ${kind}`);
});

// ---- the single-image golden path
const script = async () => {
  const { normalizeConceptSet } = await import('../src/creative-brain/index.js');
  const ids = normalizeConceptSet(CONCEPTS);
  return scriptedPort({
    frame: [frameAnswer()], ideate: [{ concepts: CONCEPTS }], select: [evaluationsAnswer(ids, [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }])], art_direct: [artDirectionAnswer()], compose: [compositionAnswer()],
  });
};

test('CL-5 GOLDEN: a single-image brief goes through the planner and comes back identical, so the Brain makes the same plan, ids and ledger', async () => {
  const brief = buildBrief();
  const plan = await createContentFormatPlanner().plan(requestFromBrief(brief));
  const bridged = briefForAsset({ brief, plan });
  assert.deepEqual(bridged, brief);
  const direct = await script(); const through = await script();
  const ledgerA = createDecisionLedger(); const ledgerB = createDecisionLedger();
  const a = await createCreativeBrain({ complete: direct.complete, ledger: ledgerA }).plan({ brief });
  const b = await createCreativeBrain({ complete: through.complete, ledger: ledgerB }).plan({ brief: bridged });
  assert.equal(a.status, 'PLANNED'); assert.equal(a.plan.plan_id, b.plan.plan_id);
  assert.deepEqual(ledgerA.entries(), ledgerB.entries());
  assert.deepEqual(direct.calls.map((c) => c.instruction), through.calls.map((c) => c.instruction), 'the model sees exactly the same instructions');
});

test('CL-6 a brief with no format is no longer a dead end on the planned path: the format is decided, then the canvas is given', async () => {
  const brief = buildBrief();
  const noFormat = { ...brief, format: { locale: 'fr-BE' } };
  assert.equal(assessBrief({ brief: noFormat }).status, BRIEF_STATUS.NEEDS_CLARIFICATION, 'the Brain alone still asks');
  const plan = await createContentFormatPlanner().plan({ ...requestFromBrief(brief), canvas: null });
  assert.equal(plan.status, 'PLANNED'); assert.deepEqual(plan.questions, []);
  const planned = briefForAsset({ brief: noFormat, plan });
  assert.equal(assessBrief({ brief: planned }).status, BRIEF_STATUS.PROCEED);
  assert.equal(planned.format.aspect_ratio, '4:5'); assert.deepEqual(planned.format.canvas, { width: 1080, height: 1350, unit: 'px' });
});

test('CL-7 the planner is additive: nothing in the existing source imports it except the campaign planner, the layered production, the layered runtime and the readiness gate built on it', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]));
  const offenders = walk(new URL('../src/', import.meta.url)).filter((f) => f.pathname.endsWith('.js') && !f.pathname.includes('/creative-planning/') && readFileSync(f, 'utf8').includes('creative-planning/')).map((f) => f.pathname.split('/src/')[1]);
  assert.deepEqual(offenders.filter((f) => !f.startsWith('creative-campaign/') && !f.startsWith('creative-readiness/') && !f.startsWith('creative-production/') && !f.startsWith('creative-e2e/') && f !== 'creative-runtime/layered-runtime.js'), []);
});

test('CL-8 the slide capacities are measured with the real typography engine in the text-led spec, on every canvas and every density class', () => {
  assert.equal(TEXT_LED_SPEC.safety_factor, 0.8, 'the safety factor behind every stated capacity');
  const font = fonts.get('font:runtime-fixture-sans');
  for (const resource of FORMAT_RESOURCES) {
    const caps = resource.slide_capacity;
    assert.ok(caps.MEDIUM.chars < caps.HIGH.chars && caps.HIGH.chars < caps.TEXT_LED.chars, `${resource.format_ref}: the classes grow`);
    for (const density of ['MEDIUM', 'HIGH', 'TEXT_LED']) {
      const { chars, basis } = caps[density];
      assert.equal(basis, CAPACITY_BASIS.MEASURED_LED);
      assert.ok(fitsSlide({ font, canvas: resource.canvas, density, chars }), `${resource.format_ref}/${density}: ${chars} characters fit`);
      assert.ok(chars <= Math.floor(measureSlideCapacity({ font, canvas: resource.canvas, density }) * 0.8), `${resource.format_ref}/${density}: the capacity keeps the safety factor`);
      assert.ok(!fitsSlide({ font, canvas: resource.canvas, density, chars: Math.ceil(chars * 1.6) }), `${resource.format_ref}/${density}: far beyond it does not fit`);
    }
    assert.equal(resource.text_capacity.BODY.chars, caps.HIGH.chars, 'a text shared with an image on one canvas is a HIGH slide');
  }
});
