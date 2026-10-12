import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decodePng } from '../src/creative-intelligence/png-pixels.js';
import { encodePng } from '../src/creative-intelligence/png-encode.js';
import {
  createApprovedCopyAgent, createCreativeDirector, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst, createVisualProductionDirector, DIRECTOR_CONSTANTS, describeLayeredRuntime, runLayeredCreative, runProductPreservingCreative,
} from '../src/creative-runtime/index.js';
import { evaluateProviderGate, productionReadinessLevel, READINESS_LEVEL } from '../src/creative-production/index.js';
import {
  AT, BRAND, buildBrief, busyPlate, calmPlate, createLayerBudget, createLayerStore, emptyGround, fakeLayerPort, fonts, GUARDIAN_PASS, holedPlate, layeredHarness, layeredWorld, propOnBusyGround, propOnGround, propTouchingFrame, propTwoObjects, sha,
} from './creative-layered-runtime-world.js';
import { ANNOTATIONS, directorAnswer, fakeEnvironmentPort } from './runtime-world.js';

// THE LAYERED SCENE RUNTIME, END TO END (`// LR-N`). A planned and produced campaign, local image fixtures behind a fake layer port, the real segmenter, typography, gates and compositor.
// No provider, no network, no cost: every image is drawn by the test, and the port counts every call.

const WORLD = await layeredWorld();
const PROP_COLOUR = [122, 75, 42];
// the same product with a smaller protected artwork, so that a foreground prop may legally cover part of the rim
const SMALL_ART = { ...ANNOTATIONS, artwork_region: { ...ANNOTATIONS.artwork_region, width: ANNOTATIONS.artwork_region.width * 0.75, height: ANNOTATIONS.artwork_region.height * 0.8 } };
const FOREGROUND_SCENE = WORLD.result.scenes.findIndex((s) => s.layers.some((l) => l.kind === 'PROP_FOREGROUND'));
const HEADLINE_SCENE = WORLD.result.scenes.findIndex((s) => s.text_layers.some((t) => t.role === 'HEADLINE'));

const run = async ({
  world = WORLD, index = HEADLINE_SCENE, port = fakeLayerPort(), brief = world.brief, policy = {}, store, budget, gate = null, ports = null, production = world.result, guardian = GUARDIAN_PASS, sceneId = null,
} = {}) => {
  const h = layeredHarness({ layerPort: port });
  const result = await runLayeredCreative({
    at: AT, brief, fonts, agents: h.agents, ports: ports ?? h.ports, ledger: h.ledger, guardian, production, scene_id: sceneId ?? production.scenes[index].scene_id, gate, policy, ...(store ? { store } : {}), ...(budget ? { budget } : {}),
  });
  return { result, h, port };
};
const production0reserved = (production) => production.production.budget.rows.filter((r) => !r.label.startsWith('GENERATED_LAYER:')).reduce((n, r) => n + r.eur, 0);
const decisions = (r) => r.ledger.map((e) => e.decision);
const pixel = (img, x, y) => [...img.pixels.slice((Math.round(y) * img.width + Math.round(x)) * 4, (Math.round(y) * img.width + Math.round(x)) * 4 + 3)];

test('LR-1 a scene runs end to end: plate, prop, the real product and the planned text give one candidate image that passes every gate', async () => {
  const { result, port } = await run();
  assert.equal(result.status, 'READY_FOR_REVIEW', JSON.stringify([result.reason, result.detail, result.fidelity?.failed, result.preflight]));
  assert.equal(result.strategy, 'LAYERED_SCENE_PRODUCTION'); assert.equal(result.fallback_to_single_image, false);
  const image = decodePng(result.png_bytes);
  assert.deepEqual([image.width, image.height], [1080, 1350]); assert.equal(result.sha256_of, sha(result.png_bytes));
  assert.equal(result.fidelity.gate, 'PASS'); assert.equal(result.preflight.status, 'PASS'); assert.equal(result.guardian.outcome, 'PASS');
  assert.equal(result.render.typography_mode, 'REAL'); assert.equal(result.steering.manual_creative_steering, 'NONE'); assert.equal(result.steering.run_complete, true, String(result.steering.decisions_not_reached));
  assert.deepEqual(port.calls.map((c) => c.kind), ['PLATE', 'PROP']);
  assert.equal(result.provider_calls, 2);
  assert.ok(Object.isFrozen(result));
});

test('LR-2 the z-order is plate < background prop < real product < bounded foreground prop < text, in the composition and in the delivered document and pixels', async () => {
  const { result } = await run();
  const kinds = WORLD.result.scenes[HEADLINE_SCENE].layers.filter((l) => l.kind !== 'TEXT').map((l) => l.kind);
  assert.deepEqual(kinds, ['PLATE', 'PROP_BACKGROUND', 'PRODUCT']);
  assert.equal(result.composition.order.length, 3);
  assert.deepEqual(result.composition.order, WORLD.result.scenes[HEADLINE_SCENE].composite.order.slice(0, 3).map((id, i) => (i === 0 ? WORLD.result.scenes[HEADLINE_SCENE].layers[0].request_key : id)));
  const types = result.document.layers.map((l) => [l.type, l.z_index]);
  const z = (type) => types.filter(([t]) => t === type).map(([, v]) => v);
  assert.ok(Math.max(...z('BACKGROUND')) < Math.min(...z('PRODUCT')) && Math.max(...z('PRODUCT')) < Math.min(...z('TEXT')));
  // a foreground prop is drawn between the product and the text
  const fg = await run({ index: FOREGROUND_SCENE, brief: { ...WORLD.brief, identity_annotations: SMALL_ART }, policy: { placement: { foreground_inset: 0.8 } } });
  assert.equal(fg.result.status, 'READY_FOR_REVIEW', JSON.stringify([fg.result.reason, fg.result.detail, fg.result.fidelity?.failed]));
  const ft = fg.result.document.layers.map((l) => [l.type, l.z_index]);
  const product = ft.find(([t]) => t === 'PRODUCT')[1]; const image = ft.find(([t]) => t === 'IMAGE')[1]; const text = Math.min(...ft.filter(([t]) => t === 'TEXT').map(([, v]) => v));
  assert.ok(product < image && image < text, JSON.stringify(ft));
  // in the pixels: the foreground prop covers the product where they overlap (its centre lies over the product), the background prop is over the plate
  const img = decodePng(fg.result.png_bytes);
  const placed = fg.result.ledger.filter((e) => e.decision === 'LAYER_PLACEMENT').map((e) => e.outcome);
  const fgBox = placed.find((p) => p.kind === 'PROP_FOREGROUND').box; const bgBox = placed.find((p) => p.kind === 'PROP_BACKGROUND').box;
  const centre = (b) => [b.x + b.width / 2, b.y + b.height / 2];
  const rect = fg.result.product_rect;
  const [cx, cy] = centre(fgBox);
  assert.ok(cx >= rect.x && cx < rect.x + rect.width && cy >= rect.y && cy < rect.y + rect.height, 'the foreground centre lies over the product');
  assert.deepEqual(pixel(img, cx, cy), PROP_COLOUR, 'the foreground prop is above the product');
  assert.deepEqual(pixel(img, ...centre(bgBox)), PROP_COLOUR, 'the background prop is above the plate');
});

test('LR-3 the pixels of the real product are not changed by the composition, and the identity gate measures the delivered image against the pinned asset', async () => {
  const { result } = await run();
  assert.ok(result.composition.product_pixels_checked > 100000); assert.equal(result.composition.product_pixels_changed, 0);
  assert.equal(result.fidelity.gate, 'PASS'); assert.deepEqual(result.fidelity.failed, []);
  assert.equal(result.segmentation.cutout_sha256.length, 64);
  // the only product pixels drawn are those of the segmenter's cut-out of the pinned asset; no layer asked of the provider carries one
  const decisionsOf = result.ledger.filter((e) => e.decision === 'PROVIDER_REQUEST_CONSTRUCTION');
  assert.ok(decisionsOf.length >= 2 && decisionsOf.every((e) => e.outcome.carries_input_asset === false));
  // a rasterizer that changes the product pixels is caught by the compositor, and the run stops with no image
  const real = (await import('../src/creative-intelligence/production-render.js')).rasterizeToPixels;
  const faulty = (svg) => { const px = real(svg); const copy = { ...px, pixels: new Uint8Array(px.pixels) }; for (let i = 0; i < copy.pixels.length; i += 4) { if (copy.pixels[i + 3] === 255 && i % 40 === 0) copy.pixels[i] ^= 0x10; } return copy; };
  const bad = await run({ policy: { rasterize: faulty } });
  assert.equal(bad.result.status, 'BLOCKED'); assert.equal(bad.result.reason, 'COMPOSITION_REFUSED'); assert.ok(bad.result.detail.problems.includes('THE_PRODUCT_PIXELS_CHANGED')); assert.equal(bad.result.png_bytes, undefined);
});

test('LR-4 the locked text reaches the image byte for byte: the document holds the planned text, its digest, and nothing is cut, rewritten or compressed to fit', async () => {
  const { result } = await run();
  const scene = WORLD.result.scenes[HEADLINE_SCENE];
  assert.ok(result.text.length > 0 && result.text.every((t) => t.exact && t.planned_sha256 === t.placed_sha256));
  for (const layer of scene.text_layers) {
    const placed = result.document.layers.find((l) => l.type === 'TEXT' && l.text_role === layer.role);
    assert.equal(placed.content, layer.text); assert.equal(sha(Buffer.from(placed.content, 'utf8')), sha(Buffer.from(layer.text, 'utf8')));
  }
  // every scene of the campaign: the delivered text is the planned text; a text the layout cannot carry blocks, it is never shortened
  for (const [i, s] of WORLD.result.scenes.slice(0, 2).entries()) {
    const { result: r } = await run({ index: i });
    if (r.status === 'READY_FOR_REVIEW') for (const layer of s.text_layers) assert.equal(r.document.layers.find((l) => l.type === 'TEXT' && l.text_role === layer.role).content, layer.text);
    else assert.ok(['BLOCKED'].includes(r.status) && r.reason, `${i}: ${r.status}`);
  }
  const long = 'Chaque coque est imprimée avec soin à partir de votre photo préférée, pour que le souvenir reste net, vif et solide au fil des jours, des voyages et des années. Nous contrôlons chaque détail à la main avant de la confier à celui ou celle qui la recevra, dans un emballage simple et propre. Un cadeau qui dure, pensé à Namur. ';
  const heavy = await layeredWorld({ assets: 1, copy: long.repeat(3).trim() });
  const over = await run({ world: heavy, index: 0 });
  assert.equal(over.result.status, 'BLOCKED'); assert.equal(over.result.reason, 'TEXT_ROLE_NOT_EXECUTABLE'); assert.equal(over.port.calls.length, 0, 'the text is refused before any provider work');
  const ok = await layeredWorld({ assets: 2, copy: long.repeat(2).trim() });
  const fits = await run({ world: ok, index: 0 });
  assert.equal(fits.result.status, 'READY_FOR_REVIEW'); assert.equal(fits.result.document.layers.find((l) => l.type === 'TEXT').content, ok.result.scenes[0].text_layers[0].text);
});

test('LR-5 a foreground prop covers the product only within its overlap rule, and never the protected artwork', async () => {
  for (const inset of [0.4, 0.8]) {
    const { result } = await run({ index: FOREGROUND_SCENE, brief: { ...WORLD.brief, identity_annotations: SMALL_ART }, policy: { placement: { foreground_inset: inset } } });
    assert.equal(result.status, 'READY_FOR_REVIEW', `${inset}: ${JSON.stringify([result.reason, result.detail?.problems])}`);
    const [f] = result.composition.foreground;
    assert.ok(f.covered_pixels > 0 && f.share_of_product > 0 && f.share_of_product <= f.limit, `${inset}: ${f.share_of_product}`); assert.equal(f.policy, 'EDGE_ONLY'); assert.equal(f.covered_protected_pixels, 0);
    assert.equal(result.fidelity.gate, 'PASS');
  }
  // the protected artwork is where the annotation says it is: a region at the bottom corner is covered, the same region at the top is not
  const region = (y) => ({ ...ANNOTATIONS, artwork_region: { x: 0.55, y, width: 0.2, height: 0.14 } });
  const atBottom = await run({ index: FOREGROUND_SCENE, brief: { ...WORLD.brief, identity_annotations: region(0.66) }, policy: { placement: { foreground_inset: 0.8 } } });
  assert.equal(atBottom.result.reason, 'COMPOSITION_REFUSED'); assert.ok(atBottom.result.detail.foreground[0].covered_protected_pixels > 0);
  // the default placement touches the corner without covering anything
  const { result: corner } = await run({ index: FOREGROUND_SCENE });
  assert.equal(corner.status, 'READY_FOR_REVIEW'); assert.equal(corner.composition.foreground[0].covered_pixels, 0);
});

test('LR-6 an illegal overlap is refused, with the measurement and the replanning it needs, and no image is made', async () => {
  // (a) the foreground prop reaches the protected artwork
  const protectedHit = await run({ index: FOREGROUND_SCENE, policy: { placement: { foreground_inset: 0.8 } } });
  assert.equal(protectedHit.result.status, 'BLOCKED'); assert.equal(protectedHit.result.reason, 'COMPOSITION_REFUSED');
  assert.ok(protectedHit.result.detail.problems.some((p) => p.startsWith('COVERS_A_PROTECTED_REGION')));
  assert.ok(protectedHit.result.detail.foreground[0].covered_protected_pixels > 0);
  // (b) the foreground prop is far larger than the edge allowance
  const tooBig = await run({ index: FOREGROUND_SCENE, brief: { ...WORLD.brief, identity_annotations: SMALL_ART }, policy: { placement: { foreground_inset: 0.9, prop_height_share: { BACKGROUND: 0.16, MIDGROUND: 0.2, FOREGROUND: 0.45 } } } });
  assert.equal(tooBig.result.status, 'BLOCKED'); assert.ok(tooBig.result.detail.problems.some((p) => p.startsWith('OVERLAP_EXCEEDS_ITS_POLICY')), JSON.stringify(tooBig.result.detail));
  assert.ok(tooBig.result.detail.foreground[0].share_of_product > tooBig.result.detail.foreground[0].limit);
  for (const r of [protectedHit.result, tooBig.result]) {
    assert.equal(r.png_bytes, undefined); assert.equal(r.replan, 'REPLAN_THE_COMPOSITION_OR_THE_FOREGROUND_PROP'); assert.equal(r.fallback_to_single_image, false);
    const replan = r.ledger.filter((e) => e.decision === 'LAYERED_REPLAN'); assert.equal(replan.length, 1); assert.equal(replan[0].outcome.fallback_to_single_image, false);
    assert.ok(!decisions(r).includes('FIDELITY') && !decisions(r).includes('PREFLIGHT'), 'nothing after the refused composition ran');
  }
});

test('LR-7 a generated layer is untrusted: a bad plate or a bad prop is refused by its own gate before any composition', async () => {
  const badProps = {
    'busy ground': propOnBusyGround, 'two objects': propTwoObjects, 'object off the frame': propTouchingFrame, 'nothing on the ground': emptyGround, 'not a png': () => new Uint8Array([1, 2, 3, 4]),
  };
  for (const [name, make] of Object.entries(badProps)) {
    const { result, port } = await run({ port: fakeLayerPort({ prop: () => make() }) });
    assert.equal(result.status, 'BLOCKED', name); assert.equal(result.reason, 'GENERATED_LAYER_REJECTED', name); assert.equal(result.detail.kind, 'PROP');
    assert.equal(result.detail.candidates.length, 2, `${name}: the bounded set, no more`); assert.ok(result.detail.candidates.every((c) => c.ok === false && c.rejection));
    assert.equal(port.calls.filter((c) => c.kind === 'PROP').length, 2, name); assert.equal(result.provider_calls, port.calls.length, `${name}: the calls are counted`);
    assert.ok(!decisions(result).includes('LAYER_COMPOSITION') && !decisions(result).includes('PREFLIGHT') && result.png_bytes === undefined, `${name}: nothing was composed`);
  }
  const badPlates = { 'an object where the product stands': busyPlate, 'not opaque': holedPlate, 'wrong size': () => calmPlate({ width: 100, height: 100 }), 'not a png': () => new Uint8Array([9, 9, 9]) };
  for (const [name, make] of Object.entries(badPlates)) {
    const { result, port } = await run({ port: fakeLayerPort({ plate: (size) => make(size) }) });
    assert.equal(result.status, 'BLOCKED', name); assert.equal(result.reason, 'GENERATED_LAYER_REJECTED', name); assert.equal(result.detail.kind, 'PLATE');
    assert.equal(port.calls.length, 2, `${name}: two plate candidates, and no prop is paid for after a refused plate`);
    assert.ok(!decisions(result).includes('LAYER_COMPOSITION'), name);
  }
  // a layer whose size is not the size that was asked for, or a plate whose size is not the canvas, is refused
  const resized = (kind, size) => ({ ...WORLD.result, shared_layers: WORLD.result.shared_layers.map((r) => (r.kind === kind ? { ...r, size } : r)) });
  const plateSmall = await run({ production: resized('PLATE', { width: 540, height: 675, unit: 'px' }), port: fakeLayerPort({ plate: (size) => calmPlate(size) }) });
  assert.equal(plateSmall.result.reason, 'GENERATED_LAYER_REJECTED'); assert.ok(plateSmall.result.detail.candidates.every((c) => c.rejection === 'THE_PLATE_SIZE_DIFFERS_FROM_THE_CANVAS'), JSON.stringify(plateSmall.result.detail.candidates));
  const propSmall = await run({ production: resized('PROP', { width: 512, height: 512, unit: 'px' }) });
  assert.equal(propSmall.result.reason, 'GENERATED_LAYER_REJECTED'); assert.ok(propSmall.result.detail.candidates.every((c) => c.rejection === 'THE_PROP_SIZE_DIFFERS_FROM_THE_REQUEST'), JSON.stringify(propSmall.result.detail.candidates));
  const plateAsked = await run({ port: fakeLayerPort({ plate: () => calmPlate({ width: 540, height: 675 }) }) });
  assert.ok(plateAsked.result.detail.candidates.every((c) => c.rejection === 'THE_PLATE_SIZE_DIFFERS_FROM_THE_REQUEST'), JSON.stringify(plateAsked.result.detail.candidates));
  // the first candidate is bad and the second good: the FIRST that passes wins, with no ranking
  const rescued = await run({ port: fakeLayerPort({ prop: ({ candidate_index: i }) => (i === 1 ? propTwoObjects() : propOnGround()) }) });
  assert.equal(rescued.result.status, 'READY_FOR_REVIEW'); assert.equal(rescued.port.calls.filter((c) => c.kind === 'PROP').length, 2);
  const props = rescued.result.ledger.filter((e) => e.decision === 'LAYER_GENERATION' && e.outcome.kind === 'PROP');
  assert.deepEqual(props.map((e) => e.outcome.accepted), [false, true]);
  // a prop that passes at the first candidate costs one call, not the whole set
  const first = await run(); assert.equal(first.port.calls.filter((c) => c.kind === 'PROP').length, 1);
});

test('LR-8 the budget is reserved before the first provider call, and a reservation past the ceiling blocks the run with no provider work', async () => {
  const ledgerSeen = [];
  const inner = fakeLayerPort();
  let h;
  const watching = { ...inner, executes: inner.executes, live: false, async generate(args) { ledgerSeen.push(h.ledger.entries().map((e) => e.decision)); return inner.generate(args); } };
  h = layeredHarness({ layerPort: watching });
  const result = await runLayeredCreative({ at: AT, brief: WORLD.brief, fonts, agents: h.agents, ports: h.ports, ledger: h.ledger, guardian: GUARDIAN_PASS, production: WORLD.result, scene_id: WORLD.result.scenes[HEADLINE_SCENE].scene_id });
  assert.equal(result.status, 'READY_FOR_REVIEW');
  assert.ok(ledgerSeen.length === 2 && ledgerSeen.every((seen) => seen.includes('LAYER_BUDGET_RESERVATION')), 'every provider call happened after the reservation');
  const entries = result.ledger; const reservation = entries.find((e) => e.decision === 'LAYER_BUDGET_RESERVATION'); const firstGeneration = entries.find((e) => e.decision === 'PROVIDER_REQUEST_CONSTRUCTION');
  assert.ok(reservation.seq < firstGeneration.seq); assert.equal(reservation.outcome.reserved, true);
  assert.ok(result.budget.spent_eur > 0 && result.budget.spent_eur <= result.budget.reserved_eur && result.budget.reserved_eur <= result.budget.ceiling_eur);
  const reserved = reservation.outcome.layers;
  assert.equal(reserved.length, 2); for (const r of reserved) { assert.equal(r.candidates, 2); assert.ok(Math.abs(r.eur - r.candidates * r.unit_eur) < 1e-9 && r.unit_eur > 0); }
  assert.equal(reservation.outcome.reused_layers, 0); assert.ok(Math.abs(result.budget.reserved_eur - production0reserved(WORLD.result) - reserved.reduce((n, r) => n + r.eur, 0)) < 1e-9, 'the budget holds exactly what was reserved');
  assert.ok(Math.abs(result.budget.spent_eur - result.provider_calls * 0.0345) < 0.05 && result.budget.provider_calls === 2);
  // the ceiling: what is left does not hold the layers of the scene
  const production = WORLD.result;
  const budget = createLayerBudget({ production });
  budget.reserve('SOMETHING_ELSE', budget.snapshot().ceiling_eur - budget.snapshot().reserved_eur - 0.01);
  const blocked = await run({ budget });
  assert.equal(blocked.result.status, 'BLOCKED'); assert.equal(blocked.result.reason, 'PRODUCTION_BLOCKED_BY_BUDGET'); assert.equal(blocked.port.calls.length, 0); assert.equal(blocked.result.provider_calls, 0);
  assert.equal(blocked.result.ledger.find((e) => e.decision === 'LAYER_BUDGET_RESERVATION').outcome.reserved, false);
  assert.ok(!decisions(blocked.result).includes('PROVIDER_REQUEST_CONSTRUCTION'));
});

test('LR-9 shared layers are produced once: a scene that reuses a plate or a prop makes no provider call for it', async () => {
  const store = createLayerStore(); const budget = createLayerBudget({ production: WORLD.result });
  const port = fakeLayerPort();
  const results = [];
  for (const [i] of WORLD.result.scenes.entries()) results.push((await run({ index: i, store, budget, port })).result);
  assert.ok(results.every((r) => r.status === 'READY_FOR_REVIEW'), results.map((r) => r.status).join());
  const needed = new Set(WORLD.result.scenes.flatMap((s) => s.layers.filter((l) => l.source === 'GENERATED').map((l) => l.request_key)));
  const asked = WORLD.result.scenes.reduce((n, s) => n + s.layers.filter((l) => l.source === 'GENERATED').length, 0);
  assert.equal(port.calls.length, needed.size, 'one call per distinct generated layer'); assert.ok(needed.size < asked, 'the scenes do share layers');
  assert.equal(new Set(port.calls.map((c) => c.request_key)).size, port.calls.length, 'no request is made twice');
  assert.ok(results.flatMap((r) => r.ledger).some((e) => e.decision === 'LAYER_REUSE' && e.outcome.provider_calls === 0));
  // running a scene again costs nothing
  const before = port.calls.length; const spent = budget.snapshot().spent_eur;
  const again = await run({ index: 0, store, budget, port });
  assert.equal(again.result.status, 'READY_FOR_REVIEW'); assert.equal(port.calls.length, before); assert.equal(budget.snapshot().spent_eur, spent);
  const reservation = again.result.ledger.find((e) => e.decision === 'LAYER_BUDGET_RESERVATION').outcome;
  assert.deepEqual(reservation.layers, [], 'nothing is reserved for a layer that is already produced'); assert.equal(reservation.reused_layers, 2); assert.equal(budget.snapshot().reserved_eur, results.at(-1).budget.reserved_eur);
  assert.equal(again.result.provider_calls, results.at(-1).provider_calls, 'the shared budget counts calls once');
  // the reused plate is judged again for the new scene, free of charge
  assert.ok(again.result.ledger.some((e) => e.decision === 'LAYER_GENERATION' && e.outcome.origin === 'SHARED_STORE'));
});

test('LR-10 no tool or strategy switches silently: only the selected tool runs, every refusal is a classified stop that names its replanning', async () => {
  const wrongTool = fakeLayerPort({ executes: { ENVIRONMENT_PLATE_GENERATION: 'text-to-image/secondary', PROP_ON_PLAIN_GROUND_GENERATION: 'text-to-image/primary' } });
  const a = await run({ port: wrongTool });
  assert.equal(a.result.status, 'BLOCKED'); assert.equal(a.result.reason, 'TOOL_DIFFERS_FROM_THE_SELECTED_TOOL'); assert.equal(wrongTool.calls.length, 0);
  assert.deepEqual(a.result.detail.map((d) => [d.capability, d.selected, d.executed]), [['ENVIRONMENT_PLATE_GENERATION', 'text-to-image/primary', 'text-to-image/secondary']]);
  assert.equal(a.result.fallback_to_single_image, false); assert.match(a.result.replan, /REPLAN/);
  // a live port needs the open provider gate
  const live = fakeLayerPort({ live: true });
  const closed = await run({ port: live, gate: { status: 'READY_PENDING_OWNER_GO', reasons: ['OWNER_GO_PENDING'] } });
  assert.equal(closed.result.reason, 'PROVIDER_GATE_NOT_OPEN'); assert.equal(live.calls.length, 0);
  const none = await run({ port: fakeLayerPort({ live: true }), gate: null }); assert.equal(none.result.reason, 'PROVIDER_GATE_NOT_OPEN');
  const open = await run({ port: fakeLayerPort({ live: true }), gate: { status: 'OPEN_BY_OWNER', reasons: [] } }); assert.equal(open.result.status, 'READY_FOR_REVIEW');
  // when every candidate of a layer is refused the run stops: no other tool, no other capability, no single-image generator is tried
  const rejected = await run({ port: fakeLayerPort({ plate: (s) => busyPlate(s) }) });
  assert.equal(rejected.result.reason, 'GENERATED_LAYER_REJECTED'); assert.equal(rejected.port.calls.length, 2); assert.ok(rejected.port.calls.every((c) => c.kind === 'PLATE'));
  assert.equal(rejected.result.replan, 'REPLAN_THE_PLATE_OR_THE_COMPOSITION'); assert.equal(rejected.result.fallback_to_single_image, false);
  assert.ok(rejected.result.ledger.some((e) => e.decision === 'LAYERED_REPLAN' && e.outcome.reason === 'GENERATED_LAYER_REJECTED'));
  assert.ok(rejected.result.ledger.some((e) => e.decision === 'LAYER_TOOL' && e.outcome.execution_policy === 'ONLY_THE_SELECTED_TOOL'));
  // the layered runtime has no environment port to fall back on, and a single-image run is a different function
  const h = layeredHarness(); assert.equal(h.ports.environment, undefined);
  const source = readFileSync(new URL('../src/creative-runtime/layered-runtime.js', import.meta.url), 'utf8');
  assert.ok(!/runProductPreservingCreative|ports\.environment/.test(source.replace(/\/\/.*$/gm, '')), 'the layered runtime never calls the single-image generator');
});

test('LR-11 a single-image run that does not opt in is unchanged: the same inputs give the same image, with no layered field, and the legacy runtime knows nothing of the layered one', async () => {
  const once = async () => {
    const ledger = createDecisionLedger();
    const environment = fakeEnvironmentPort();
    const r = await runProductPreservingCreative({
      at: AT, brief: buildBrief(), fonts,
      agents: {
        analyst: createProductAssetAnalyst({ ledger, expression: BRAND.expression }),
        director: createCreativeDirector({ ledger, complete: async () => ({ text: directorAnswer(), model: 'fixture', request_id: 'fixture' }), constants: DIRECTOR_CONSTANTS }),
        copy: createApprovedCopyAgent({ ledger }),
        visual_director: createVisualProductionDirector({ ledger, expression: BRAND.expression }),
      },
      ports: { segmenter: createLocalProductSegmenter({ ledger }), environment }, ledger, guardian: GUARDIAN_PASS,
    });
    return { r, environment, ledger };
  };
  const a = await once(); const b = await once();
  assert.equal(a.r.status, 'READY_FOR_REVIEW', JSON.stringify([a.r.reason, a.r.fidelity?.failed]));
  assert.equal(a.r.sha256_of, b.r.sha256_of); assert.equal(a.environment.calls.length, 1);
  assert.equal(a.r.strategy, undefined); assert.equal(a.r.fallback_to_single_image, undefined); assert.equal(a.r.provider_calls, undefined);
  assert.ok(!a.r.ledger.some((e) => /^LAYER/.test(e.decision)), 'a single-image run records no layered decision');
  assert.deepEqual(a.r.render, { render_mode: 'RESOLVED', typography_mode: 'REAL', resolutions: 2, image_draws: 2 });
  const legacy = readFileSync(new URL('../src/creative-runtime/runtime.js', import.meta.url), 'utf8');
  assert.ok(!/layered|creative-production/i.test(legacy), 'the single-image runtime does not reference the layered path');
});

test('LR-12 the runtime no longer reports COMPOSITOR_NOT_WIRED: readiness distinguishes contract, implementation and an executable runtime, read from what the runtime really calls', async () => {
  const d = describeLayeredRuntime();
  assert.equal(d.wired, true); assert.equal(d.entry, 'runLayeredCreative'); assert.equal(d.single_image_fallback, false); assert.equal(d.opt_in, true);
  assert.deepEqual(Object.keys(d.stages).sort(), ['budget_reservation', 'compositor', 'deterministic_text', 'identity_fidelity_gate', 'plate_suitability_gate', 'prop_matte', 'shared_layer_store']);
  assert.ok(Object.values(d.stages).every(Boolean));
  const gate = evaluateProviderGate({ production: WORLD.result, readiness: { ready: true, status: 'CREATIVE_PIPELINE_READY' } });
  assert.ok(!gate.reasons.includes('COMPOSITOR_NOT_WIRED_TO_THE_RUNTIME')); assert.deepEqual(gate.reasons, ['OWNER_GO_PENDING']);
  assert.equal(productionReadinessLevel({ parityOk: true }).level, READINESS_LEVEL.RUNTIME_EXECUTABLE);
  assert.deepEqual(productionReadinessLevel({ parityOk: true }), { level: 'RUNTIME_EXECUTABLE', contract_ready: true, implementation_ready: true, runtime_executable: true });
  assert.equal(productionReadinessLevel({ parityOk: false }).level, READINESS_LEVEL.NOT_READY);
  assert.deepEqual(productionReadinessLevel({ parityOk: false }), { level: 'NOT_READY', contract_ready: false, implementation_ready: false, runtime_executable: false });
  assert.equal(productionReadinessLevel({ parityOk: true, runtime: { ...d, wired: false } }).level, READINESS_LEVEL.IMPLEMENTATION_READY);
  assert.equal(productionReadinessLevel({ parityOk: true, runtime: { ...d, stages: { ...d.stages, compositor: false } } }).level, READINESS_LEVEL.CONTRACT_READY);
  assert.equal(productionReadinessLevel({ parityOk: true, runtime: { ...d, single_image_fallback: true } }).level, READINESS_LEVEL.IMPLEMENTATION_READY);
  assert.equal(productionReadinessLevel({ parityOk: true, runtime: { ...d, entry: null } }).level, READINESS_LEVEL.IMPLEMENTATION_READY);
  assert.equal(productionReadinessLevel({ parityOk: true, runtime: { stages: {}, wired: false, entry: null } }).level, READINESS_LEVEL.CONTRACT_READY);
  assert.equal(evaluateProviderGate({ production: WORLD.result, readiness: { ready: true, status: 'CREATIVE_PIPELINE_READY' }, runtime: { ...d, wired: false } }).status, 'NOT_READY');
});

test('LR-13 a scene that cannot honestly be produced is stopped before any provider work, with its reason and the replanning it needs', async () => {
  // product identity not verified
  const ambiguous = await WORLD.planner.plan({ campaignResult: WORLD.campaign, brief: { ...WORLD.brief, identity_annotations: {} }, request: WORLD.request });
  const a = await run({ production: ambiguous, index: 0 });
  assert.equal(a.result.status, 'BLOCKED'); assert.equal(a.result.reason, 'SCENE_NOT_SPECIFIED'); assert.equal(a.port.calls.length, 0);
  // an asset that is not the identity's
  const other = buildBrief({ asset: { ...WORLD.brief.asset, bytes: new Uint8Array([...WORLD.brief.asset.bytes.slice(0, -1), 7]) } });
  const b = await run({ brief: other }); assert.equal(b.result.reason, 'PRODUCT_ASSET_DOES_NOT_MATCH_THE_IDENTITY'); assert.equal(b.port.calls.length, 0);
  // an unknown scene
  const c = await run({ sceneId: 'scn_missing' }); assert.equal(c.result.reason, 'SCENE_NOT_SPECIFIED');
  // a mask that cannot be trusted stops the run before any billable call
  const h = layeredHarness();
  const lowConfidence = { segment: async () => ({ quality: { confident: false } }) };
  const d = await run({ ports: { ...h.ports, segmenter: lowConfidence }, port: h.layerPort });
  assert.equal(d.result.reason, 'SEGMENTATION_LOW_CONFIDENCE'); assert.equal(h.layerPort.calls.length, 0);
  // a body text with another role has no recipe; a price with no approved claim is not typeset; none of them is squeezed in
  const tampered = { ...WORLD.result, scenes: WORLD.result.scenes.map((s, i) => (i === HEADLINE_SCENE ? { ...s, text_layers: [...s.text_layers, { ...s.text_layers[0], role: 'BODY', layer_id: 'lyr_x', text: 'Autre texte.' }] } : s)) };
  const e = await run({ production: tampered }); assert.equal(e.result.reason, 'NO_EXECUTABLE_LAYOUT'); assert.equal(e.port.calls.length, 0);
  const price = { ...WORLD.result, scenes: WORLD.result.scenes.map((s, i) => (i === HEADLINE_SCENE ? { ...s, text_layers: [{ ...s.text_layers[0], role: 'PRICE', text: '30 €' }] } : s)) };
  const f = await run({ production: price }); assert.equal(f.result.reason, 'TEXT_ROLE_NOT_EXECUTABLE'); assert.equal(f.port.calls.length, 0); assert.match(f.result.detail.reason, /APPROVED_CLAIM/);
  // a production whose identity is not verified (though its scenes say specified), an asset that differs from the identity in its hash, its reference or its bytes
  const unverified = await run({ production: { ...WORLD.result, product_identity: { ...WORLD.result.product_identity, status: 'AMBIGUOUS' } } });
  assert.equal(unverified.result.reason, 'PRODUCT_IDENTITY_NOT_VERIFIED'); assert.equal(unverified.port.calls.length, 0);
  const hashOnly = await run({ brief: buildBrief({ asset: { ...WORLD.brief.asset, sha256: 'f'.repeat(64) } }) });
  const refOnly = await run({ brief: buildBrief({ asset: { ...WORLD.brief.asset, ref: 'asset://test/runtime/another' } }) });
  for (const x of [hashOnly, refOnly]) { assert.equal(x.result.reason, 'PRODUCT_ASSET_DOES_NOT_MATCH_THE_IDENTITY'); assert.equal(x.port.calls.length, 0); }
  // a local tool that is not the one the runtime executes, a provider capability with no selected tool, a role the typography has no scale for, a role twice, a planned text whose digest is not its text
  const withTools = (fn) => ({ ...WORLD.result, scenes: WORLD.result.scenes.map((s, i) => (i === HEADLINE_SCENE ? { ...s, tools: s.tools.map(fn) } : s)) });
  const wrongLocal = await run({ production: withTools((t) => (t.capability === 'PROP_CUTOUT' ? { ...t, selected: { ...t.selected, tool_id: 'cutout/another' } } : t)) });
  assert.equal(wrongLocal.result.reason, 'TOOL_DIFFERS_FROM_THE_SELECTED_TOOL'); assert.equal(wrongLocal.result.detail[0].capability, 'PROP_CUTOUT');
  const noPlateTool = await run({ production: withTools((t) => (t.capability === 'ENVIRONMENT_PLATE_GENERATION' ? { ...t, selected: null } : t)) });
  assert.equal(noPlateTool.result.reason, 'TOOL_DIFFERS_FROM_THE_SELECTED_TOOL'); assert.equal(noPlateTool.port.calls.length, 0);
  const withText = (texts) => ({ ...WORLD.result, scenes: WORLD.result.scenes.map((s, i) => (i === HEADLINE_SCENE ? { ...s, text_layers: texts(s.text_layers) } : s)) });
  const decorative = await run({ production: withText((t) => [{ ...t[0], role: 'DECORATIVE' }]) });
  const twice = await run({ production: withText((t) => [t[0], { ...t[0], layer_id: 'lyr_again' }]) });
  for (const x of [decorative, twice]) { assert.equal(x.result.reason, 'TEXT_ROLE_NOT_EXECUTABLE'); assert.equal(x.port.calls.length, 0); }
  assert.equal(decorative.result.detail.role, 'DECORATIVE'); assert.equal(twice.result.detail.duplicate, true);
  const digest = await run({ production: withText((t) => [{ ...t[0], text_sha256: 'e'.repeat(64) }]) });
  assert.equal(digest.result.reason, 'LOCKED_TEXT_ALTERED'); assert.equal(digest.port.calls.length, 0, 'the text is checked before any provider work'); assert.equal(digest.result.detail[0].exact, false);
  // a production or a scene that says it is not specified, though the other says it is
  const prodBlocked = await run({ production: { ...WORLD.result, status: 'BLOCKED' } });
  const sceneBlocked = await run({ production: { ...WORLD.result, scenes: WORLD.result.scenes.map((s, i) => (i === HEADLINE_SCENE ? { ...s, status: 'BLOCKED' } : s)) } });
  for (const x of [prodBlocked, sceneBlocked]) { assert.equal(x.result.reason, 'SCENE_NOT_SPECIFIED'); assert.equal(x.port.calls.length, 0); }
  assert.equal(prodBlocked.result.production_status, 'BLOCKED');
  // a legal text that is not an approved claim, and a word that no line can hold: refused before any provider work, never shortened
  const legal = await run({ production: withText((t) => [{ ...t[0], role: 'LEGAL', text: 'Mentions légales.' }]) });
  assert.equal(legal.result.reason, 'TEXT_ROLE_NOT_EXECUTABLE'); assert.equal(legal.port.calls.length, 0); assert.equal(legal.result.detail.role, 'LEGAL');
  const word = 'Extraordinairement'.repeat(5);
  const wide = await run({ production: withText((t) => [{ ...t[0], text: word, text_sha256: sha(Buffer.from(word, 'utf8')), chars: word.length }]) });
  assert.equal(wide.result.reason, 'THE_LAYOUT_COULD_NOT_BE_SOLVED'); assert.equal(wide.port.calls.length, 0); assert.equal(wide.result.before_provider_work, true); assert.ok(wide.result.detail.violations.some((v) => v.code === 'TEXT_DOES_NOT_FIT'));
  // a scene whose layer has no request in the production
  const noRequest = await run({ production: { ...WORLD.result, shared_layers: [] } });
  assert.equal(noRequest.result.reason, 'SCENE_NOT_SPECIFIED'); assert.equal(noRequest.result.detail, 'A_GENERATED_LAYER_HAS_NO_REQUEST'); assert.equal(noRequest.port.calls.length, 0);
  // a preservation mode that is not a composite
  const hh = layeredHarness();
  const analystNo = { invoke: async () => ({ product_understanding: { transformation_policy: { mode: 'IDENTITY_PRESERVE' } } }) };
  const modeResult = await runLayeredCreative({ at: AT, brief: WORLD.brief, fonts, agents: { ...hh.agents, analyst: analystNo }, ports: hh.ports, ledger: hh.ledger, guardian: GUARDIAN_PASS, production: WORLD.result, scene_id: WORLD.result.scenes[HEADLINE_SCENE].scene_id });
  assert.equal(modeResult.reason, 'THE_PRODUCT_PRESERVING_RUNTIME_NEEDS_A_COMPOSITE_STRATEGY'); assert.equal(hh.layerPort.calls.length, 0);
  for (const r of [a, b, c, d, e, f, unverified, hashOnly, refOnly, wrongLocal, noPlateTool, decorative, twice, digest, noRequest, prodBlocked, sceneBlocked, legal, wide]) { assert.equal(r.result.fallback_to_single_image, false); assert.ok(r.result.ledger.some((x) => x.decision === 'LAYERED_REPLAN')); assert.equal(r.result.png_bytes, undefined); }
  assert.equal(modeResult.png_bytes, undefined);
});

test('LR-14 a prop with no free place around the product and the text is refused, not squeezed in', async () => {
  const crowded = await run({ policy: { placement: { margin_of_width: 0.45, clearance_of_width: 0.2, prop_height_share: { BACKGROUND: 0.6, MIDGROUND: 0.6, FOREGROUND: 0.14 } } } });
  assert.equal(crowded.result.status, 'BLOCKED'); assert.equal(crowded.result.reason, 'NO_ROOM_FOR_A_PROP'); assert.equal(crowded.result.png_bytes, undefined);
  const offCanvas = await run({ index: FOREGROUND_SCENE, policy: { placement: { foreground_inset: -3 } } });
  assert.equal(offCanvas.result.reason, 'NO_ROOM_FOR_A_PROP');
});

test('LR-15 a scene without text is produced too: the layers and the real product, nothing written on them', async () => {
  const world = await layeredWorld({ assets: 6 });
  const index = world.result.scenes.findIndex((s) => s.text_layers.length === 0);
  assert.ok(index >= 0, 'this campaign has a scene without text');
  const { result } = await run({ world, index });
  assert.equal(result.status, 'READY_FOR_REVIEW', JSON.stringify([result.reason, result.detail]));
  assert.deepEqual(result.text, []); assert.equal(result.document.layers.filter((l) => l.type === 'TEXT').length, 0);
});

test('LR-16 a scene with no prop asks nothing of the prop tool, and a tool the specification does not use is not required', async () => {
  const index = WORLD.result.scenes.findIndex((s) => !s.layers.some((l) => l.kind.startsWith('PROP_')) && s.text_layers.length > 0);
  assert.ok(index >= 0, 'this campaign has a scene without props');
  const port = fakeLayerPort({ executes: { ENVIRONMENT_PLATE_GENERATION: 'text-to-image/primary' } });
  const { result } = await run({ index, port });
  assert.equal(result.status, 'READY_FOR_REVIEW', JSON.stringify([result.reason, result.detail])); assert.deepEqual(port.calls.map((c) => c.kind), ['PLATE']);
});

test('LR-17 two props around the product do not overlap each other, the product or the text', async () => {
  const art = { narrative_elements: [
    { element: 'a soft window glow far behind the bench', reason: 'it places the finished piece at dusk, the quiet end of the work', zone: 'BACKGROUND' },
    { element: 'a brass scale beside the finished piece', reason: 'it shows the care taken in the making of the piece', zone: 'MIDGROUND' },
  ] };
  const world = await layeredWorld({ assets: 6, art });
  const index = world.result.scenes.findIndex((s) => s.layers.filter((l) => l.kind.startsWith('PROP_')).length === 2);
  assert.ok(index >= 0);
  for (const placement of [{}, { prop_height_share: { BACKGROUND: 0.1, MIDGROUND: 0.1, FOREGROUND: 0.14 } }]) {
  const { result } = await run({ world, index, policy: { placement } });
  assert.equal(result.status, 'READY_FOR_REVIEW', JSON.stringify([result.reason, result.detail]));
  const boxes = result.ledger.filter((e) => e.decision === 'LAYER_PLACEMENT').map((e) => e.outcome);
  assert.deepEqual(boxes.map((b) => b.kind), ['PROP_BACKGROUND', 'PROP_MIDGROUND']);
  const meet = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  assert.ok(!meet(boxes[0].box, boxes[1].box), 'the two props do not overlap');
  const texts = result.ledger.find((e) => e.decision === 'TYPOGRAPHY_PLACEMENT').outcome.texts;
  for (const { box } of boxes) { assert.ok(!meet(box, result.product_rect), 'a prop does not overlap the product'); for (const t of texts) assert.ok(!meet(box, t.box), 'a prop does not overlap the text'); }
  assert.equal(result.fidelity.gate, 'PASS');
  }
});

test('LR-18 the gates after the composition are the single-image gates: a second instance of the product is a FIDELITY_FAIL, the Guardian decides, and an unconfigured Guardian blocks', async () => {
  const base = 'Chaque coque est imprimée avec soin à partir de votre photo préférée, pour que le souvenir reste net, vif et solide au fil des jours, des voyages et des années. Nous contrôlons chaque détail à la main avant de la confier à celui ou celle qui la recevra, dans un emballage simple et propre. Un cadeau qui dure, pensé à Namur. ';
  const world = await layeredWorld({ assets: 2, copy: base.repeat(3).trim() });
  const fail = await run({ world, index: 1 });
  assert.equal(fail.result.status, 'FIDELITY_FAIL'); assert.equal(fail.result.fidelity.gate, 'FAIL'); assert.ok(fail.result.fidelity.failed.some((f) => f.check === 'PIECE_COUNT'), JSON.stringify(fail.result.fidelity.failed));
  assert.ok(fail.result.png_bytes, 'the image is returned with its refusal, for diagnosis, and is not a candidate'); assert.ok(fail.result.ledger.some((e) => e.decision === 'FIDELITY' && e.outcome.gate === 'FAIL'));
  const guardianFail = await run({ guardian: { evaluate: () => ({ report_id: 'gr_stub', outcome: 'FAIL', hard_outcome: 'FAIL', rule_results: [] }) } });
  assert.equal(guardianFail.result.status, 'GUARDIAN_FAIL'); assert.equal(guardianFail.result.fidelity.gate, 'PASS');
  const noGuardian = await run({ guardian: null });
  assert.equal(noGuardian.result.status, 'BLOCKED'); assert.equal(noGuardian.result.reason, 'BRAND_GUARDIAN_NOT_CONFIGURED');
});

test('LR-19 the survivors of the first sweep: a claim is typeset as a claim, a body with the measured typography, foreground bounds, band heights, the base without the product, the preflight and the colour pairs', async () => {
  const withText = (texts) => ({ ...WORLD.result, scenes: WORLD.result.scenes.map((s, i) => (i === HEADLINE_SCENE ? { ...s, text_layers: texts(s.text_layers) } : s)) });
  // a price that is an approved claim is typeset as that claim
  const price = await run({ production: withText((t) => [{ ...t[0], role: 'PRICE', text: '25 €', text_sha256: sha(Buffer.from('25 €', 'utf8')), chars: 4 }]) });
  assert.equal(price.result.status, 'READY_FOR_REVIEW', JSON.stringify([price.result.reason, price.result.detail]));
  const priceLayer = price.result.document.layers.find((l) => l.type === 'TEXT');
  assert.equal(priceLayer.text_kind, 'CLAIM_BEARING'); assert.equal(priceLayer.claim_ref, 'claim://test/price'); assert.equal(priceLayer.content, '25 €');
  // a body is typeset with the typography its capacity was measured with
  const body = await run({ index: 2 });
  const bodyLayer = body.result.document.layers.find((l) => l.type === 'TEXT');
  assert.equal(bodyLayer.text_role, 'BODY'); assert.equal(bodyLayer.font_size, Math.round(1080 * 0.035)); assert.equal(bodyLayer.line_height, 1.3); assert.equal(bodyLayer.max_lines, 12);
  // the render consumes the base WITHOUT the product, the cut-out, and nothing else
  const ok = (await run()).result;
  const baseRef = ok.render.resolved.find((r) => r.ref.endsWith('/layered-base')); const cutRef = ok.render.resolved.find((r) => r.ref.endsWith('/product-cutout'));
  assert.equal(baseRef.sha256, ok.composition.base_sha256); assert.notEqual(ok.composition.base_sha256, ok.composition.stack_sha256); assert.equal(cutRef.sha256, ok.segmentation.cutout_sha256);
  assert.deepEqual(ok.document.provenance.producer_refs, ['engine:creative-runtime.layered-production']);
  // a request given to the provider carries no input asset
  const a = await run(); assert.ok(a.port.calls.every((c) => Array.isArray(c.input_asset_refs) && c.input_asset_refs.length === 0 && c.carries_input_asset === false));
  // a plate whose very first pixel is transparent is refused
  const firstPixel = (size) => { const img = decodePng(calmPlate(size)); const px = new Uint8Array(img.pixels); px[3] = 0; return encodePng({ width: img.width, height: img.height, pixels: px }); };
  const clipped = await run({ port: fakeLayerPort({ plate: (size) => firstPixel(size) }) });
  assert.equal(clipped.result.reason, 'GENERATED_LAYER_REJECTED'); assert.ok(clipped.result.detail.candidates.every((c) => c.rejection === 'THE_PLATE_IS_NOT_OPAQUE'));
  // the rejection of a plate with an object where the product stands says so
  const busy = await run({ port: fakeLayerPort({ plate: (size) => busyPlate(size) }) });
  assert.ok(busy.result.detail.candidates.every((c) => c.rejection === 'ENVIRONMENT_NOT_EMPTY'));
  // props keep a margin to the edge of the canvas
  const margin = Math.round(1080 * 0.04);
  for (const e of ok.ledger.filter((x) => x.decision === 'LAYER_PLACEMENT')) { const b = e.outcome.box; assert.ok(b.x >= margin && b.y >= margin && b.x + b.width <= 1080 - margin && b.y + b.height <= 1350 - margin, JSON.stringify(b)); }
  // a foreground prop that would leave the canvas on the left only
  const wide = fakeLayerPort({ prop: ({ request }) => propOnGround({ shape: request.zone === 'FOREGROUND' ? 'stick' : 'ellipse' }) });
  const left = await run({ index: FOREGROUND_SCENE, port: wide, policy: { placement: { foreground_inset: 1.5 } } });
  assert.equal(left.result.reason, 'NO_ROOM_FOR_A_PROP', JSON.stringify([left.result.reason, left.result.detail]));
  // a budget that fails for another reason than the ceiling is not a budget block
  const broken = createLayerBudget({ production: WORLD.result });
  const boom = { ...broken, reserve: () => { throw new Error('boom'); } };
  const h = layeredHarness();
  await assert.rejects(() => runLayeredCreative({ at: AT, brief: WORLD.brief, fonts, agents: h.agents, ports: h.ports, ledger: h.ledger, guardian: GUARDIAN_PASS, production: WORLD.result, scene_id: WORLD.result.scenes[HEADLINE_SCENE].scene_id, budget: boom }), /boom/);
  assert.equal(h.layerPort.calls.length, 0);
  // brand colours of which none reads, with no plate to put behind the text
  const grey = { ...WORLD.brief, brand: { ...WORLD.brief.brand, colors: { a: '#808080', b: '#7a7a7a' } } };
  const noPair = await run({ brief: grey, port: fakeLayerPort({ plate: (size) => calmPlate(size, ['#808080', '#808080']) }) });
  assert.equal(noPair.result.reason, 'NO_BRAND_COLOUR_PAIR_READS'); assert.equal(noPair.result.png_bytes, undefined);
});

test('LR-20 a reused layer that fails for the new scene is topped up with one more candidate within a reservation, and the ceiling still holds', async () => {
  // a layer paid for earlier that fails the geometry of this scene is topped up with one more candidate, reserved first
  const plateKey = WORLD.result.scenes[HEADLINE_SCENE].layers[0].request_key;
  const store = createLayerStore(); const budget = createLayerBudget({ production: WORLD.result });
  const bad = busyPlate({ width: 1080, height: 1350 });
  store.add(plateKey, { index: 1, bytes: bad, provenance: { request_id: 'earlier' } });
  const port = fakeLayerPort();
  const topped = await run({ port, store, budget });
  assert.equal(topped.result.status, 'READY_FOR_REVIEW', JSON.stringify([topped.result.reason, topped.result.detail]));
  assert.deepEqual(port.calls.filter((c) => c.kind === 'PLATE').map((c) => c.candidate_index), [2], 'one more candidate, the second of the bounded set');
  assert.ok(budget.snapshot().rows.some((r) => r.label === `GENERATED_LAYER:${plateKey}:MORE`), 'the extra candidate was reserved first');
  assert.ok(topped.result.ledger.some((e) => e.decision === 'LAYER_GENERATION' && e.outcome.origin === 'SHARED_STORE' && e.outcome.accepted === false));
  // and when the ceiling does not hold it, the run stops with no call
  const tight = createLayerBudget({ production: WORLD.result }); tight.reserve('SOMETHING_ELSE', tight.snapshot().ceiling_eur - tight.snapshot().reserved_eur - 0.01);
  const store2 = createLayerStore(); store2.add(plateKey, { index: 1, bytes: bad, provenance: { request_id: 'earlier' } });
  const port2 = fakeLayerPort();
  const stopped = await run({ port: port2, store: store2, budget: tight });
  assert.equal(stopped.result.reason, 'PRODUCTION_BLOCKED_BY_BUDGET'); assert.equal(port2.calls.length, 0);
});
