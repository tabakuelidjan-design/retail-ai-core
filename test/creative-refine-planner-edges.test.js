import test from 'node:test';
import assert from 'node:assert/strict';

import { encodePng } from '../src/creative-intelligence/png-encode.js';
import {
  attributeDefect, buildLayerDependencyMap, createDefectRegion, createRefineMemory, DEFECT_KIND, DefectError, dependentsOfNodes, describeMaskedEditCapability, planRepair, protectedRegionsIntact, REFINE_POLICY, REPAIR_BLOCK, requestMaskedEdit,
  validateMaskedEditRequest,
} from '../src/creative-refine/index.js';
import { refineSample } from '../src/creative-refine/parity.js';

// THE EDGES OF THE PLANNER AND OF THE MASKED-EDIT CONTRACT (`// PE-N`): ordering, de-duplication, policy, exact boundaries. Pure, a few milliseconds each. These are the guards that the mutation sweep asked for.

const art = () => refineSample();
const d = (kind, extra = {}) => createDefectRegion({ kind, ...extra });
const plan = (defects, extra = {}) => planRepair({ artifact: art(), defects, ...extra });

test('PE-1 de-duplication, the typography override, sorted output, and the counting of repositions', () => {
  const mid = d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' }); const fg = d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_fg' });
  const both = plan([mid, fg]);
  assert.equal(both.steps.length, 2, 'two different steps of one scope are two steps'); assert.equal(both.cost.lines.length, 2); assert.equal(both.overrides.reject.length, 2); assert.deepEqual(both.overrides.allowance, { prk_mid: 2, prk_fg: 2 });
  assert.deepEqual(both.invalidated, ['COMPOSITE_BASE', 'COMPOSITE_STACK', 'PROP:lyr_fg', 'PROP:lyr_mid', 'RENDER', 'TEXT_STYLE:HEADLINE']);
  assert.deepEqual(plan([d(DEFECT_KIND.PLATE_UNSUITABLE), fg, d(DEFECT_KIND.TEXT_ILLEGIBLE)]).overrides.policy, { typography: { plate_behind_text: true } }, 'one typography step is enough');
  assert.deepEqual(plan([fg]).overrides.policy, {});
  assert.deepEqual(plan([d(DEFECT_KIND.UPSTREAM_LAYOUT), d(DEFECT_KIND.UPSTREAM_CONCEPT)]).invalidated, ['ART_DIRECTION', 'ASSET_PLAN', 'CONCEPT']);
  const tworoles = art(); tworoles.nodes.text.push({ node_id: 'TEXT:BODY', role: 'BODY', layer_id: 'lyr_b', text_sha256: 'f'.repeat(40), geometry: { x: 60, y: 1000, width: 900, height: 200 } });
  tworoles.nodes.text_style.push({ node_id: 'TEXT_STYLE:BODY', role: 'BODY', color: '#000', font_size: 40, plate: false, style_sha256: 'e'.repeat(40) });
  assert.deepEqual(planRepair({ artifact: tworoles, defects: [mid] }).protected, ['PRODUCT', 'TEXT:BODY', 'TEXT:HEADLINE']);
  const map = buildLayerDependencyMap(art());
  assert.deepEqual(dependentsOfNodes(map, ['TEXT:HEADLINE']), ['RENDER', 'TEXT_STYLE:HEADLINE']); assert.deepEqual(dependentsOfNodes(map, ['PRODUCT']), ['COMPOSITE_STACK', 'RENDER', 'TEXT_STYLE:HEADLINE']);
  // the repositions of a layer are counted over ALL the steps of an attempt, each layer on its own
  const memory = createRefineMemory();
  for (let i = 0; i < 2; i += 1) memory.record('scn_probe', { plan_id: `p${i}`, fingerprint: `f${i}`, outcome: 'NOT_REPAIRED', steps: [{ scope: 'LAYER_REMOVE_OR_REPOSITION', target: 'PROP:lyr_mid', action: 'REPOSITION' }, { scope: 'LAYER_REMOVE_OR_REPOSITION', target: 'PROP:lyr_fg', action: 'REPOSITION' }, { scope: 'PROP_REPAIR', target: 'PROP:lyr_fg', action: 'REPLACE_WITH_A_NEW_CANDIDATE' }] });
  const drops = plan([d(DEFECT_KIND.PROP_NO_ROOM, { layer_id: 'lyr_mid' }), d(DEFECT_KIND.PROP_NO_ROOM, { layer_id: 'lyr_fg' })], { memory });
  assert.deepEqual(drops.steps.map((s) => s.action.type), ['REMOVE', 'REMOVE']); assert.deepEqual(drops.overrides.policy, { drop_layers: ['lyr_fg', 'lyr_mid'] });
});

test('PE-2 the policy is a parameter, an unknown kind has no owner, and the allowed scopes must allow every planned scope', () => {
  const mid = d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' }); const fg = d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_fg' });
  const ladder = createRefineMemory();
  for (let i = 0; i < 2; i += 1) ladder.record('scn_probe', { plan_id: `p${i}`, fingerprint: `f${i}`, outcome: 'NOT_REPAIRED', steps: [{ scope: 'LAYER_REMOVE_OR_REPOSITION', target: 'PROP:lyr_mid', action: 'REPOSITION' }] });
  const refused = plan([d(DEFECT_KIND.PROP_NO_ROOM, { layer_id: 'lyr_mid' })], { memory: ladder, policy: { ...REFINE_POLICY, allow_drop_of_a_prop: false } });
  assert.deepEqual(refused.block, { code: REPAIR_BLOCK.LAYER_CANNOT_BE_DROPPED, detail: { defect: refused.block.detail.defect, layer: 'lyr_mid' }, replan: 'REPLAN_THE_COMPOSITION' });
  const one = plan([mid], { policy: { ...REFINE_POLICY, repair_candidates_per_layer: 1 } });
  assert.deepEqual(one.overrides.allowance, { prk_mid: 1 }); assert.equal(one.cost.max_provider_calls, 1); assert.equal(one.cost.lines[0].max_candidates, 1);
  assert.equal(plan([mid, fg], { policy: { ...REFINE_POLICY, max_regenerated_layers: 1 } }).block.code, REPAIR_BLOCK.REPAIR_SCOPE_TOO_BROAD);
  assert.equal(plan([mid], { memory: ladder, policy: { ...REFINE_POLICY, max_attempts_per_scene: 2 } }).block.code, REPAIR_BLOCK.REFINE_ATTEMPTS_EXHAUSTED);
  const raw = { defect_id: 'def-raw', kind: 'WHATEVER', source: 'GATE', region: null, node_id: null, layer_id: null, severity: 'LOW', evidence: { observed_in: 'x', rule: null, measurement: null } };
  assert.deepEqual(plan([raw]).block, { code: REPAIR_BLOCK.DEFECT_NOT_ATTRIBUTABLE, detail: { defect: 'def-raw', kind: 'WHATEVER' }, replan: 'NAME_THE_LAYER_OR_THE_REGION_OF_THE_DEFECT' });
  assert.equal(plan([d(DEFECT_KIND.PLATE_UNSUITABLE), mid], { allowedScopes: ['PLATE_REPAIR'] }).block.code, REPAIR_BLOCK.REPAIR_SCOPE_INVALID);
  assert.equal(plan([d(DEFECT_KIND.PLATE_UNSUITABLE), mid], { allowedScopes: ['PLATE_REPAIR', 'PROP_REPAIR'] }).status, 'PLANNED'); assert.equal(plan([d(DEFECT_KIND.PLATE_UNSUITABLE), mid], { allowedScopes: null }).status, 'PLANNED');
  assert.throws(() => createDefectRegion({ kind: DEFECT_KIND.PROP_UNUSABLE, region: { x: 0, y: 0, width: 0, height: 1 } }), DefectError);
});

test('PE-3 geometry: the edges of a box, of a region and of the product are exact, and the topmost layer owns the pixels', () => {
  const owner = (region) => attributeDefect(art(), d(DEFECT_KIND.PROP_UNUSABLE, { region })).node_id; // the foreground prop: x 700..840, y 900..1090
  assert.equal(owner({ x: 698, y: 990, width: 4, height: 2 }), 'PROP:lyr_fg', 'the left edge is inside'); assert.equal(owner({ x: 697, y: 990, width: 4, height: 2 }), 'PRODUCT', 'outside the prop, but over the product');
  assert.equal(owner({ x: 838, y: 990, width: 4, height: 2 }), 'PLATE:plk_probe', 'the right edge is outside'); assert.equal(owner({ x: 836, y: 990, width: 4, height: 2 }), 'PROP:lyr_fg');
  assert.equal(owner({ x: 760, y: 898, width: 2, height: 4 }), 'PROP:lyr_fg', 'the top edge is inside'); assert.equal(owner({ x: 760, y: 897, width: 2, height: 4 }), 'PRODUCT');
  assert.equal(owner({ x: 760, y: 1088, width: 2, height: 4 }), 'PRODUCT', 'the bottom edge is outside the prop'); assert.equal(owner({ x: 760, y: 1086, width: 2, height: 4 }), 'PROP:lyr_fg');
  assert.equal(owner({ x: 4, y: 8, width: 3, height: 5 }), 'PLATE:plk_probe'); assert.equal(owner({ x: 837, y: 990, width: 4, height: 2 }), 'PROP:lyr_fg', 'a centre at 839 is inside');
  const touches = (region) => attributeDefect(art(), d(DEFECT_KIND.PROP_UNUSABLE, { node_id: 'RENDER', region })).touches_product; // the product: x 300..780, y 400..1100
  assert.equal(touches({ x: 780, y: 700, width: 10, height: 10 }), false); assert.equal(touches({ x: 779, y: 700, width: 10, height: 10 }), true);
  assert.equal(touches({ x: 290, y: 700, width: 10, height: 10 }), false); assert.equal(touches({ x: 291, y: 700, width: 10, height: 10 }), true);
  assert.equal(touches({ x: 500, y: 1100, width: 10, height: 10 }), false); assert.equal(touches({ x: 500, y: 1099, width: 10, height: 10 }), true);
  assert.equal(touches({ x: 500, y: 390, width: 10, height: 10 }), false); assert.equal(touches({ x: 500, y: 391, width: 10, height: 10 }), true);
  const props = (list) => { const a = art(); a.nodes.props = list.map(([id, kind, box]) => ({ node_id: `PROP:${id}`, layer_id: id, kind, request_key: `prk_${id}`, candidate_sha256: '2'.repeat(40), placed_sha256: '3'.repeat(40), box, z: 20 })); return a; };
  const at = (a) => attributeDefect(a, d(DEFECT_KIND.PROP_UNUSABLE, { region: { x: 98, y: 998, width: 4, height: 4 } })).node_id; const box = { x: 50, y: 950, width: 100, height: 100 }; const away = { x: 1000, y: 10, width: 10, height: 10 };
  assert.equal(at(props([['bg', 'PROP_BACKGROUND', box]])), 'PROP:bg'); assert.equal(at(props([['bg', 'PROP_BACKGROUND', box], ['md', 'PROP_MIDGROUND', box]])), 'PROP:md');
  assert.equal(at(props([['m1', 'PROP_MIDGROUND', box], ['m2', 'PROP_MIDGROUND', box]])), 'PROP:m2', 'the later layer owns the pixels'); assert.equal(at(props([['m1', 'PROP_MIDGROUND', box], ['bg', 'PROP_BACKGROUND', away]])), 'PROP:m1');
  assert.equal(at(props([['f1', 'PROP_FOREGROUND', box], ['f2', 'PROP_FOREGROUND', box]])), 'PROP:f2'); assert.equal(at(props([['m1', 'PROP_MIDGROUND', away]])), 'PLATE:plk_probe');
  assert.equal(at(props([['bg1', 'PROP_BACKGROUND', box], ['bg2', 'PROP_BACKGROUND', box]])), 'PROP:bg2'); assert.equal(at(props([['m1', 'PROP_MIDGROUND', away], ['bg', 'PROP_BACKGROUND', box]])), 'PROP:bg');
});

test('PE-4 the masked-edit contract at its edges: rectangles, masks as images, the threshold of an editable pixel, the pixels of a protected region', () => {
  const good = { source_image: { sha256: 'a'.repeat(40), width: 10, height: 10 }, mask: { width: 10, height: 10, regions: [{ x: 0, y: 0, width: 2, height: 2 }] }, instruction: 'x', protected_regions: [{ x: 5, y: 5, width: 3, height: 3 }], expected_output_class: 'PLATE', provenance: { requested_by: 'r' }, cost_estimate_eur: 0.01 };
  const bad = (over) => validateMaskedEditRequest({ ...good, ...over }).problems;
  for (const r of [{ x: 1, y: 1, width: NaN, height: 1 }, { x: 1, y: 1, width: 0, height: 1 }, { x: 1, y: 1, width: 1, height: 0 }, { x: Infinity, y: 1, width: 1, height: 1 }, { x: 1, y: 'a', width: 1, height: 1 }, { x: 1, y: 1, width: 1, height: NaN }]) assert.deepEqual(bad({ protected_regions: [r] }), ['PROTECTED_REGIONS_MUST_BE_RECTANGLES'], JSON.stringify(r));
  assert.deepEqual(bad({ protected_regions: [{ x: 5, y: 5, width: 3, height: 3 }, { x: 1, y: 1, width: 0, height: 3 }] }), ['PROTECTED_REGIONS_MUST_BE_RECTANGLES'], 'ONE bad rectangle is enough');
  assert.deepEqual(bad({ protected_regions: [] }), []);
  assert.deepEqual(bad({ mask: { width: 10, height: 10, regions: [{ x: 0, y: 0, width: 2, height: 2 }, { x: 6, y: 6, width: 1, height: 1 }] } }), ['MASK_TOUCHES_A_PROTECTED_REGION'], 'one touching region of several is enough');
  assert.deepEqual(bad({ protected_regions: [{ x: 8, y: 8, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }] }), ['MASK_TOUCHES_A_PROTECTED_REGION'], 'one touched protected region of several is enough');
  assert.deepEqual(bad({ mask: { width: 10, height: 10, regions: [{ x: 8, y: 5, width: 2, height: 2 }] } }), [], 'a mask that only touches the edge is outside'); assert.deepEqual(bad({ mask: { width: 10, height: 10, regions: [{ x: 7, y: 5, width: 2, height: 2 }] } }), ['MASK_TOUCHES_A_PROTECTED_REGION']);
  assert.deepEqual(bad({ mask: { width: 10, height: 10, regions: [{ x: 5, y: 8, width: 2, height: 2 }] } }), []); assert.deepEqual(bad({ mask: { width: 10, height: 10, regions: [{ x: 5, y: 3, width: 2, height: 2 }] } }), []); assert.deepEqual(bad({ mask: { width: 10, height: 10, regions: [{ x: 5, y: 4, width: 2, height: 2 }] } }), ['MASK_TOUCHES_A_PROTECTED_REGION']);
  assert.deepEqual(bad({ mask: { width: 10, height: 10, regions: [{ x: 3, y: 5, width: 2, height: 2 }] } }), []); assert.deepEqual(bad({ mask: { width: 10, height: 10, regions: [{ x: 4, y: 5, width: 2, height: 2 }] } }), ['MASK_TOUCHES_A_PROTECTED_REGION']);
  const mask = (cells) => { const px = new Uint8Array(10 * 10 * 4); for (let i = 0; i < 100; i += 1) px.set([0, 0, 0, 255], i * 4); for (const [x, y, v, a = 255] of cells) px.set([v, v, v, a], (y * 10 + x) * 4); return encodePng({ width: 10, height: 10, pixels: px }); };
  const touched = (png, regions) => validateMaskedEditRequest({ ...good, mask: { width: 10, height: 10, png }, protected_regions: regions }).problems.includes('MASK_TOUCHES_A_PROTECTED_REGION');
  const cell = (x, y) => [{ x, y, width: 1, height: 1 }];
  assert.equal(touched(mask([[9, 4, 255]]), cell(9, 4)), true, 'a run that ends at the right edge of the image is read'); assert.equal(touched(mask([[0, 4, 255]]), cell(0, 4)), true, 'a run that starts at the left edge is read');
  assert.equal(touched(mask([[3, 9, 255]]), cell(3, 9)), true, 'the last row is read'); assert.equal(touched(mask([[3, 0, 255]]), cell(3, 0)), true, 'the first row is read');
  assert.equal(touched(mask([[4, 4, 128]]), cell(4, 4)), true); assert.equal(touched(mask([[4, 4, 127]]), cell(4, 4)), false, '127 is not editable'); assert.equal(touched(mask([[4, 4, 255, 1]]), cell(4, 4)), true, 'any opacity above 0 counts'); assert.equal(touched(mask([[4, 4, 255, 0]]), cell(4, 4)), false);
  assert.equal(touched(mask([[2, 4, 255], [3, 4, 255], [4, 4, 0], [5, 4, 255], [6, 4, 255]]), cell(4, 4)), false, 'a gap between two runs is not editable'); assert.equal(touched(mask([[2, 4, 255], [3, 4, 255], [4, 4, 0], [5, 4, 255]]), cell(5, 4)), true);
  assert.equal(touched(mask([[2, 4, 255], [3, 4, 255]]), cell(3, 4)), true); assert.equal(touched(mask([[2, 4, 255], [3, 4, 255]]), cell(4, 4)), false, 'the run ends where its last pixel ends'); assert.equal(touched(mask([[2, 4, 255]]), cell(2, 5)), false, 'rows are independent');
  assert.equal(describeMaskedEditCapability({ maskedEdit: { edit() {}, tool_id: '' } }).executable, false); assert.equal(describeMaskedEditCapability({ maskedEdit: { edit() {}, tool_id: 'x' } }).executable, true); assert.equal(describeMaskedEditCapability({ maskedEdit: { edit: 5, tool_id: 'x' } }).executable, false); assert.equal(describeMaskedEditCapability({ maskedEdit: { edit() {}, tool_id: 5 } }).executable, false);
  const base = new Uint8Array(10 * 10 * 4); for (let i = 0; i < 100; i += 1) base.set([10, 20, 30, 255], i * 4);
  const png = (px) => encodePng({ width: 10, height: 10, pixels: px }); const src = png(base);
  const alter = (x, y) => { const px = new Uint8Array(base); px.set([99, 20, 30, 255], (y * 10 + x) * 4); return png(px); };
  const intact = (x, y, region) => protectedRegionsIntact({ source: src, output: alter(x, y), protectedRegions: [region] }).intact;
  assert.equal(intact(0, 0, { x: 0, y: 0, width: 2, height: 2 }), false, 'the first pixel is read'); assert.equal(intact(1, 1, { x: 0, y: 0, width: 2, height: 2 }), false, 'the last pixel is read'); assert.equal(intact(2, 1, { x: 0, y: 0, width: 2, height: 2 }), true, 'one past the right edge is outside'); assert.equal(intact(1, 2, { x: 0, y: 0, width: 2, height: 2 }), true, 'one past the bottom edge is outside');
  assert.equal(intact(4, 5, { x: 5, y: 5, width: 2, height: 2 }), true, 'one before the left edge is outside'); assert.equal(intact(5, 4, { x: 5, y: 5, width: 2, height: 2 }), true, 'one before the top edge is outside'); assert.equal(intact(5, 5, { x: 5, y: 5, width: 2, height: 2 }), false);
  assert.equal(intact(9, 9, { x: 8, y: 8, width: 50, height: 50 }), false, 'a region past the image is clipped to it'); assert.equal(intact(0, 0, { x: -5, y: -5, width: 6, height: 6 }), false, 'a region before the image is clipped to it');
  assert.equal(intact(8, 5, { x: 6.5, y: 5, width: 2, height: 2 }), false, 'a fractional region is widened to whole pixels (6 to 8)'); assert.equal(intact(9, 5, { x: 6.5, y: 5, width: 2, height: 2 }), true);
  assert.equal(intact(6, 5, { x: 6.5, y: 5, width: 2, height: 2 }), false, 'the start is rounded down'); assert.equal(intact(5, 5, { x: 6.5, y: 5, width: 2, height: 2 }), true);
  assert.deepEqual(protectedRegionsIntact({ source: src, output: src, protectedRegions: [] }), { intact: true });
});

test('PE-5 the last guards: a free layer is priced at zero, each operand of a request is checked alone, a run of a mask is read whole, a size mismatch on either axis is seen', async () => {
  const mid = d(DEFECT_KIND.PROP_UNUSABLE, { layer_id: 'lyr_mid' });
  assert.deepEqual(plan([mid], { pricing: { prk_mid: 0 } }).cost.lines[0], { request_key: 'prk_mid', max_candidates: 2, unit_eur: 0, max_eur: 0 }, 'a tool that costs nothing costs nothing; it is not unknown');
  const props = (list) => { const a = art(); a.nodes.props = list.map(([id, kind, box]) => ({ node_id: `PROP:${id}`, layer_id: id, kind, request_key: `prk_${id}`, candidate_sha256: '2'.repeat(40), placed_sha256: '3'.repeat(40), box, z: 20 })); return a; };
  const at = (a) => attributeDefect(a, d(DEFECT_KIND.PROP_UNUSABLE, { region: { x: 98, y: 998, width: 4, height: 4 } })).node_id; const away = { x: 1000, y: 10, width: 10, height: 10 };
  assert.equal(at(props([['bg', 'PROP_BACKGROUND', away]])), 'PLATE:plk_probe', 'a background prop that is not at the place does not own it');
  assert.equal(at(props([['bg', 'PROP_BACKGROUND', away], ['m1', 'PROP_MIDGROUND', away]])), 'PLATE:plk_probe');
  const good = { source_image: { sha256: 'a'.repeat(40), width: 10, height: 10 }, mask: { width: 10, height: 10, regions: [{ x: 0, y: 0, width: 2, height: 2 }] }, instruction: 'x', protected_regions: [{ x: 5, y: 5, width: 3, height: 3 }], expected_output_class: 'PLATE', provenance: { requested_by: 'r' }, cost_estimate_eur: 0.01 };
  const problems = (over) => validateMaskedEditRequest({ ...good, ...over }).problems; const SRC = 'SOURCE_IMAGE_NEEDS_SHA256_WIDTH_HEIGHT'; const PROV = 'PROVENANCE_REQUIRED';
  for (const source_image of [undefined, null, { sha256: 1, width: 10, height: 10 }, { sha256: 'a', width: 'x', height: 10 }, { sha256: 'a', width: 10, height: NaN }, { sha256: 'a', width: 10 }, { width: 10, height: 10 }]) assert.ok(problems({ source_image }).includes(SRC), JSON.stringify(source_image));
  for (const provenance of [undefined, null, 'by me', 7, {}, { requested_by: '' }, { requested_by: null }]) assert.ok(problems({ provenance }).includes(PROV), JSON.stringify(provenance));
  assert.ok(!problems({ provenance: { requested_by: 'someone', extra: 1 } }).includes(PROV));
  // a PNG mask: a run is read from its first pixel (even at the left edge), to the end of the row, and the next row's first pixel never extends it
  const mask = (cells) => { const px = new Uint8Array(10 * 10 * 4); for (let i = 0; i < 100; i += 1) px.set([0, 0, 0, 255], i * 4); for (const [x, y] of cells) px.set([255, 255, 255, 255], (y * 10 + x) * 4); return encodePng({ width: 10, height: 10, pixels: px }); };
  const touched = (cells, cell) => validateMaskedEditRequest({ ...good, mask: { width: 10, height: 10, png: mask(cells) }, protected_regions: [{ ...cell, width: 1, height: 1 }] }).problems.includes('MASK_TOUCHES_A_PROTECTED_REGION');
  assert.equal(touched([[0, 4], [1, 4], [2, 4]], { x: 0, y: 4 }), true, 'the first pixel of a run that starts at the left edge');
  assert.equal(touched([[0, 4], [1, 4], [2, 4]], { x: 1, y: 4 }), true); assert.equal(touched([[0, 4], [1, 4], [2, 4]], { x: 2, y: 4 }), true); assert.equal(touched([[0, 4], [1, 4], [2, 4]], { x: 3, y: 4 }), false);
  assert.equal(touched([[9, 4], [0, 5]], { x: 9, y: 4 }), true, 'a run that ends at the right edge is closed there, whatever the first pixel of the next row is');
  assert.equal(touched([[8, 4], [9, 4], [0, 5], [1, 5]], { x: 8, y: 4 }), true); assert.equal(touched([[8, 4], [9, 4], [0, 5], [1, 5]], { x: 1, y: 5 }), true);
  // the size of an output is compared on BOTH axes
  const base = new Uint8Array(10 * 10 * 4); const src = encodePng({ width: 10, height: 10, pixels: base });
  assert.deepEqual(protectedRegionsIntact({ source: src, output: encodePng({ width: 20, height: 10, pixels: new Uint8Array(20 * 10 * 4) }), protectedRegions: [] }), { intact: false, reason: 'OUTPUT_SIZE_DIFFERS' });
  assert.deepEqual(protectedRegionsIntact({ source: src, output: encodePng({ width: 10, height: 20, pixels: new Uint8Array(10 * 20 * 4) }), protectedRegions: [] }), { intact: false, reason: 'OUTPUT_SIZE_DIFFERS' });
  // an output that changed a protected pixel was produced (executed) and is refused
  const request = { ...good, source_image: { sha256: 'a'.repeat(40), width: 10, height: 10 } }; const tampered = new Uint8Array(base); tampered.set([9, 9, 9, 255], (5 * 10 + 5) * 4);
  const out = await requestMaskedEdit({ ports: { maskedEdit: { tool_id: 't', async edit() { return { output_bytes: encodePng({ width: 10, height: 10, pixels: tampered }) }; } } }, request, sourcePng: src, gate: { status: 'OPEN_BY_OWNER' } });
  assert.deepEqual([out.status, out.executed, out.reason, out.output], ['REJECTED', true, 'OUTPUT_CHANGED_A_PROTECTED_REGION', null]);
});
