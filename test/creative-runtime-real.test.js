import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import {
  createApprovedCopyAgent, createCreativeDirector, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst, createVisualProductionDirector, DIRECTOR_CONSTANTS, runProductPreservingCreative,
} from '../src/creative-runtime/index.js';
import {
  BRAND, buildBrief, directorAnswer, fakeEnvironmentPort, fonts,
} from './runtime-world.js';

// TECHNICAL VERIFICATION on the REAL HABB asset (`// RR-N` markers), local only (the photograph is private and absent from a clean clone). It answers one question before any
// money is spent: do the local segmentation and the identity gate hold on the real photograph through the real runtime? The model and the environment are FIXTURES of the test
// world (a fixed answer and a plain gradient): nothing here is a candidate, no image is written or shown, and nothing creative is decided or evaluated.

const root = new URL('../', import.meta.url);
const bench = JSON.parse(await readFile(new URL('benchmarks/creative-intelligence/habb-creative-benchmark-001.json', root), 'utf8'));
const payload = bench.private_payloads[0];
const HERE = existsSync(new URL(payload.path, root));

test('On the real asset: the local mask is confident and the identity gate passes through the real runtime', { skip: !HERE && 'the private asset payload is not available here' }, async () => {
  const bytes = new Uint8Array(await readFile(new URL(payload.path, root)));
  const record = bench.owned_records.find((r) => r.ref === payload.ref);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), payload.sha256);
  const brief = buildBrief({
    ids: { merchant_id: bench.merchant.merchant_id, brand_id: '4c487848-8d41-4e30-8f3f-66afd09b4be4', brief_ref: 'brief:technical-verification', product_ref: bench.bindings.product.ref },
    asset: { ref: payload.ref, bytes, media_type: record.metadata.media_type, width_px: record.metadata.width_px, height_px: record.metadata.height_px, origin: record.metadata.origin, sha256: payload.sha256, rights_class: 'OWNED', privacy_class: 'BUSINESS' },
    identity_annotations: bench.asset_evidence.identity_annotations,
  });
  const ledger = createDecisionLedger();
  const environment = fakeEnvironmentPort();
  const result = await runProductPreservingCreative({
    at: '2026-10-10T12:00:00.000Z',
    brief,
    fonts,
    agents: {
      analyst: createProductAssetAnalyst({ ledger, expression: BRAND.expression }),
      director: createCreativeDirector({ ledger, complete: async () => ({ text: directorAnswer(), model: 'fixture', request_id: 'fixture' }), constants: DIRECTOR_CONSTANTS }),
      copy: createApprovedCopyAgent({ ledger }),
      visual_director: createVisualProductionDirector({ ledger, expression: BRAND.expression }),
    },
    ports: { segmenter: createLocalProductSegmenter({ ledger }), environment },
    ledger,
  });
  // RR-1 the mask of the real photograph is confident, fitted by the rounded-quadrilateral model, with a small residual
  const segmentation = result.ledger.find((e) => e.decision === 'SEGMENTATION');
  assert.equal(segmentation.outcome.confident, true);
  assert.equal(segmentation.outcome.shape_model, 'ROUNDED_QUAD');
  assert.ok(segmentation.outcome.median_residual_px < 3, String(segmentation.outcome.median_residual_px));
  // RR-2 the identity gate on the delivered PNG passes every check (the real pixels, scaled and placed by the layout engine), with the exact observations reported if it does not
  assert.equal(result.status, 'READY_FOR_REVIEW', JSON.stringify([result.reason, result.fidelity?.failed, result.preflight?.status]));
  assert.equal(result.fidelity.gate, 'PASS');
  assert.equal(result.steering.manual_creative_steering, 'NONE');
});
