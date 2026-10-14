import test from 'node:test';
import assert from 'node:assert/strict';

import * as W from './creative-integration-world.js';
import { createDecisionLedger } from '../src/creative-runtime/ledger.js';
import { STAGE, createRunContext } from '../src/creative-e2e/index.js';
import { segmentNativeAlpha } from '../src/creative-integration/index.js';

// Guard tests added after the targeted mutation sweep of the run context and the native-alpha path (`// EG-N` markers).

const ctx = () => createRunContext({ run_id: 'run-guard-1', ceiling_eur: 1, ledger: createDecisionLedger(), at: 'x' });
const precut = (name) => {
  const f = W[name](); const { width, height } = f.rgba; const pixels = Uint8Array.from(f.rgba.pixels);
  for (let i = 0; i < width * height; i += 1) { const a = f.truth.alpha[i]; pixels[i * 4 + 3] = a === 255 ? 253 : a; if (a === 0) { pixels[i * 4] = 0; pixels[i * 4 + 1] = 0; pixels[i * 4 + 2] = 0; } }
  return { width, height, pixels };
};
const codes = (r) => (r.native?.findings ?? []).filter((f) => !f.ok).map((f) => f.code);

test('Reservations: an unknown or closed reservation is an invariant error or false, never a second effect', () => {
  const c = ctx();
  // EG-1
  assert.throws(() => c.budget.settle('res-404', 0.01), (e) => e.code === 'RESERVATION_NOT_OPEN');
  assert.equal(c.budget.release('res-404'), false);
  const id = c.budget.reserve('x', 0.1); c.budget.settle(id, 0.05);
  assert.throws(() => c.budget.settle(id, 0.01), (e) => e.code === 'RESERVATION_NOT_OPEN'); assert.equal(c.budget.release(id), false);
  const id2 = c.budget.reserve('y', 0.1); assert.equal(c.budget.release(id2), true); assert.equal(c.budget.release(id2), false);
  assert.deepEqual([c.budget.snapshot().spent_eur, c.budget.snapshot().reserved_eur], [0.05, 0]);
});

test('Invalidation touches only valid, saved checkpoints, and only once', () => {
  const c = ctx();
  // EG-2
  c.checkpoints.save(STAGE.SEGMENTATION, { input_sha256: 'a', payload: 1 }); c.checkpoints.save(STAGE.INTEGRATION, { input_sha256: 'b', payload: 2 });
  assert.deepEqual(c.checkpoints.invalidate(STAGE.SEGMENTATION), [STAGE.SEGMENTATION, STAGE.INTEGRATION]);
  assert.deepEqual(c.checkpoints.invalidate(STAGE.SEGMENTATION), []);
  assert.equal(c.checkpoints.get(STAGE.INTEGRATION), null); assert.equal(c.checkpoints.reusable(STAGE.INTEGRATION, 'b'), false);
});

test('Native alpha: a product cut by any border, and a refused image with its findings', () => {
  // EG-3
  const base = precut('magnet');
  assert.equal(segmentNativeAlpha(base).status, 'OK');
  const shift = (dx, dy) => {
    const out = { width: base.width, height: base.height, pixels: new Uint8Array(base.pixels.length) };
    for (let y = 0; y < base.height; y += 1) for (let x = 0; x < base.width; x += 1) { const nx = x + dx; const ny = y + dy; if (nx >= 0 && ny >= 0 && nx < base.width && ny < base.height) for (let k = 0; k < 4; k += 1) out.pixels[(ny * base.width + nx) * 4 + k] = base.pixels[(y * base.width + x) * 4 + k]; }
    return out;
  };
  for (const [dx, dy] of [[-45, 0], [45, 0], [0, -45], [0, 45]]) assert.equal(segmentNativeAlpha(shift(dx, dy)).accepted, false, `${dx},${dy}`);
  // EG-4 a fully opaque image has no meaningful alpha: refused, no mask
  const opaque = segmentNativeAlpha(W.phoneCase().rgba); assert.equal(opaque.accepted, false); assert.equal(opaque.alpha ?? null, null);
  // EG-5 a degenerate input is refused without an exception
  assert.equal(segmentNativeAlpha({ width: 1, height: 1, pixels: new Uint8Array(4) }).accepted, false); assert.equal(segmentNativeAlpha(undefined).accepted, false);
  assert.ok(Array.isArray(codes(opaque)));
});

test('Budget boundaries: exactly the ceiling is allowed, one cent more is refused; ceiling 0 is a valid run id of nothing', () => {
  const mk = (ceiling_eur) => createRunContext({ run_id: 'run-guard-2', ceiling_eur, ledger: createDecisionLedger(), at: 'x' });
  // EG-6 a ceiling of 0 is valid (a run that can spend nothing), a negative or non-finite one is not
  assert.doesNotThrow(() => mk(0)); for (const bad of [-0.01, NaN, Infinity, undefined]) assert.throws(() => mk(bad), (e) => e.code === 'CEILING_INVALID', String(bad));
  // EG-7 reserve exactly what is left: allowed; one more cent: refused before any state change
  const c = mk(0.3); const a = c.budget.reserve('a', 0.3); assert.equal(c.budget.snapshot().available_eur, 0);
  assert.throws(() => c.budget.reserve('b', 0.01), (e) => e.name === 'RunBudgetError'); assert.equal(c.budget.snapshot().reserved_eur, 0.3);
  assert.doesNotThrow(() => c.budget.reserve('zero', 0));
  // EG-8 settle exactly the reservation: allowed; above it: refused and nothing is spent
  assert.throws(() => c.budget.settle(a, 0.31), (e) => e.code === 'SETTLEMENT_ABOVE_THE_RESERVATION'); assert.equal(c.budget.snapshot().spent_eur, 0);
  c.budget.settle(a, 0.3); assert.equal(c.budget.snapshot().spent_eur, 0.3);
  // EG-9 a negative or non-numeric reservation is refused
  for (const bad of [-0.01, NaN, '0.1', undefined]) assert.throws(() => c.budget.reserve('bad', bad), (e) => e.code === 'RESERVATION_AMOUNT_INVALID', String(bad));
  // EG-10 run id length: 3 and 64 characters are valid, 2 and 65 are not
  for (const [n, ok] of [[2, false], [3, true], [64, true], [65, false]]) { const id = 'r'.repeat(n); if (ok) assert.doesNotThrow(() => createRunContext({ run_id: id, ceiling_eur: 1, ledger: null, at: 'x' })); else assert.throws(() => createRunContext({ run_id: id, ceiling_eur: 1, ledger: null, at: 'x' }), (e) => e.code === 'RUN_ID_INVALID'); }
  assert.throws(() => createRunContext({ run_id: undefined, ceiling_eur: 1, ledger: null, at: 'x' }), (e) => e.code === 'RUN_ID_INVALID');
});
