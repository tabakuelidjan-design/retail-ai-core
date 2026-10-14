import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  AT, GUARDIAN_PASS, fakeLayerPort, fonts, layeredHarness, layeredWorld,
} from './creative-layered-runtime-world.js';
import { auditEndToEndParity, probeEntryPoint } from '../src/creative-e2e/parity.js';
import { HIGH_LEVEL, REQUIRED_PROVIDERS, checkCreativeReadiness, readinessLevels } from '../src/creative-readiness/index.js';
import { LAYERED_LOCAL_TOOLS, describeLayeredRuntime, runLayeredCreative } from '../src/creative-runtime/index.js';

// The end-to-end parity audit, the readiness LEVELS and the proof that the legacy runtimes are untouched (`// EP-N` markers).

const HIGH = { modulesReady: true, fullReady: true, endToEndParity: true };
const FIXTURE = { end_to_end: { provider_free_fixture: 'PASS' } };

test('The end-to-end parity audit passes on the real code, and so does the probe of the entry point', async () => {
  // EP-1 the synchronous audit (the gate calls it): ready, with the rows of its probes
  const a = auditEndToEndParity(); assert.deepEqual(a.failures, []); assert.equal(a.ready, true); assert.ok(a.checks.length >= 30); assert.equal(a.rows, a.checks);
  // EP-2 the entry point stops explicitly (no budget, no layer provider, no request, a bad run id)
  const p = await probeEntryPoint(); assert.deepEqual(p.failures, []); assert.equal(p.ready, true); assert.equal(p.checks.length, 4);
});

test('The four readiness levels are independent: none implies the next', () => {
  const lv = (over = {}) => readinessLevels({ ...HIGH, attestation: { ...FIXTURE }, ...over });
  // EP-3 modules only
  assert.deepEqual(readinessLevels({ modulesReady: true, fullReady: false, endToEndParity: true, attestation: null }), { levels: { MODULES_READY: true, END_TO_END_WIRED: false, REAL_PROVIDER_CONNECTED: false, LIVE_VALIDATED: false }, high_level_status: HIGH_LEVEL.MODULES });
  // EP-4 wired and attested with a provider-free fixture: END_TO_END, and still no provider, still not live
  assert.deepEqual(lv(), { levels: { MODULES_READY: true, END_TO_END_WIRED: true, REAL_PROVIDER_CONNECTED: false, LIVE_VALIDATED: false }, high_level_status: HIGH_LEVEL.END_TO_END });
  // EP-5 the end-to-end level needs all three: a ready verdict, the parity of the entry point, and a recorded PASS of the fixture
  assert.equal(lv({ endToEndParity: false }).levels.END_TO_END_WIRED, false); assert.equal(lv({ fullReady: false }).levels.END_TO_END_WIRED, false); assert.equal(lv({ attestation: { end_to_end: { provider_free_fixture: 'FAIL' } } }).levels.END_TO_END_WIRED, false); assert.equal(lv({ attestation: {} }).levels.END_TO_END_WIRED, false);
  // EP-6 providers: every required provider must be recorded; one is not enough; a record alone, without the end-to-end level, gives no provider level
  assert.deepEqual(REQUIRED_PROVIDERS, ['LAYER_GENERATOR', 'BRAIN_MODEL']);
  assert.equal(lv({ attestation: { ...FIXTURE, providers_connected: ['LAYER_GENERATOR'] } }).levels.REAL_PROVIDER_CONNECTED, false);
  assert.equal(lv({ attestation: { ...FIXTURE, providers_connected: REQUIRED_PROVIDERS } }).high_level_status, HIGH_LEVEL.PROVIDER);
  assert.equal(lv({ endToEndParity: false, attestation: { ...FIXTURE, providers_connected: REQUIRED_PROVIDERS } }).high_level_status, HIGH_LEVEL.MODULES);
  // EP-7 the live level needs the providers AND a recorded successful live run; a live record without providers gives nothing
  const live = { ...FIXTURE, providers_connected: REQUIRED_PROVIDERS, live_validation: { status: 'success' } };
  assert.equal(lv({ attestation: live }).high_level_status, HIGH_LEVEL.LIVE);
  assert.equal(lv({ attestation: { ...live, live_validation: { status: 'failed' } } }).high_level_status, HIGH_LEVEL.PROVIDER);
  assert.equal(lv({ attestation: { ...FIXTURE, live_validation: { status: 'success' } } }).levels.LIVE_VALIDATED, false);
  // EP-8 nothing ready: not ready at all
  assert.equal(readinessLevels({ modulesReady: false, fullReady: false, endToEndParity: false, attestation: null }).high_level_status, HIGH_LEVEL.NONE);
});

test('The real gate reports the levels honestly: modules and the wiring may be ready, the providers and the live validation are not', () => {
  const real = checkCreativeReadiness();
  // EP-9 the levels are present and the two that no evidence supports are false
  assert.deepEqual(Object.keys(real.levels), ['MODULES_READY', 'END_TO_END_WIRED', 'REAL_PROVIDER_CONNECTED', 'LIVE_VALIDATED']);
  assert.equal(real.levels.REAL_PROVIDER_CONNECTED, false); assert.equal(real.levels.LIVE_VALIDATED, false);
  assert.ok([HIGH_LEVEL.MODULES, HIGH_LEVEL.END_TO_END, HIGH_LEVEL.NONE].includes(real.high_level_status)); assert.notEqual(real.high_level_status, HIGH_LEVEL.PROVIDER); assert.notEqual(real.high_level_status, HIGH_LEVEL.LIVE);
  assert.ok('END_TO_END' in real.parity && real.parity.END_TO_END.ready === true);
});

test('Legacy non-regression: the layered runtime called directly gives the same image it gave before this phase, and the new hooks are inert by default', async () => {
  // EP-10 the layered runtime's own description and tool table are unchanged
  assert.deepEqual(LAYERED_LOCAL_TOOLS, { PROP_CUTOUT: 'cutout/plain-ground-matte', LOCAL_SEGMENTATION: 'segmentation/annotated-outline', PRODUCT_CUTOUT: 'cutout/exact-source-pixels', DETERMINISTIC_COMPOSITE: 'composite/z-ordered-layers', DETERMINISTIC_TEXT: 'typography/real-fonts' });
  const d = describeLayeredRuntime(); assert.equal(d.wired, true); assert.equal(d.opt_in, true); assert.equal(d.single_image_fallback, false);
  // EP-11 GOLDEN: the delivered PNG of a fixed direct call, computed on the commit BEFORE the end-to-end work (8def488, runtime untouched), is byte for byte the same now; with an empty policy and with the new hooks
  // explicitly undefined it is the same again, and the result carries no shadow
  const GOLDEN = 'ffd299a4450aedc3f69eaed817f5120fb9b0ed9d04dad96aa8c322e588484102';
  const world = await layeredWorld({ assets: 2 });
  const direct = async (policy) => { const h = layeredHarness({ layerPort: fakeLayerPort() }); return runLayeredCreative({ at: AT, brief: world.brief, fonts, agents: h.agents, ports: h.ports, ledger: h.ledger, guardian: GUARDIAN_PASS, production: world.result, scene_id: world.result.scenes[0].scene_id, gate: null, policy }); };
  const plain = await direct({}); assert.equal(plain.status, 'READY_FOR_REVIEW'); assert.equal(createHash('sha256').update(plain.png_bytes).digest('hex'), GOLDEN); assert.equal('integration_shadow' in plain, false);
  const inert = await direct({ contact_shadow: undefined, product_shadow_effect: undefined }); assert.equal(inert.sha256_of, plain.sha256_of);
  // EP-12 the single-image runtime is not reached by the end-to-end module (its source names neither the function nor the file)
  for (const f of ['e2e', 'run-context', 'asset', 'segmentation-stage', 'integration-stage', 'constants', 'parity']) { const src = readFileSync(new URL(`../src/creative-e2e/${f}.js`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, ''); assert.ok(!/runProductPreservingCreative|creative-runtime\/runtime\.js/.test(src), f); }
});
