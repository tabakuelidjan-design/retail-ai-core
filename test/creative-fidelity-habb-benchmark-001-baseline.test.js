import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { assetInvariants } from '../src/creative-fidelity/asset-intake.js';
import { FIDELITY_CHECK } from '../src/creative-fidelity/constants.js';

// The real Benchmark 001 product photo is the fidelity reference of this benchmark (`// FB-N` markers follow the numbered test list of the asset mandate).
// The baseline is DATA in the benchmark configuration; Creative Fidelity evaluates it later. The raw photograph is not committed (public repository).

const config = JSON.parse(await readFile(new URL('../benchmarks/creative-intelligence/habb-creative-benchmark-001.json', import.meta.url), 'utf8'));
const expression = JSON.parse(await readFile(new URL('../benchmarks/creative-intelligence/habb-expression-system-benchmark-001.json', import.meta.url), 'utf8')).expression_system;
const baseline = config.asset_evidence.fidelity_baseline;

test('Benchmark 001 real asset: the fidelity baseline preserves silhouette, camera geometry and printed artwork', () => {
  const keep = baseline.must_remain_unchanged;
  // FB-17 the case outer silhouette (and the overall proportions) must remain unchanged
  assert.match(keep.silhouette, /outer silhouette/);
  assert.match(keep.proportions, /overall product proportions/);
  // FB-18 the camera / cutout geometry must remain unchanged
  assert.match(keep.camera_geometry, /camera \/ cutout geometry/);
  assert.match(keep.camera_geometry, /vertical three-lens module/);
  assert.match(keep.camera_geometry, /separate circular cutout/);
  // FB-19 the printed artwork is product content, preserved as pixels; the border / material appearance is never fabricated
  assert.match(keep.printed_artwork, /as pixels and content/);
  assert.match(keep.border_material, /nothing is fabricated/);
  // the baseline speaks the Creative Fidelity vocabulary: its checks exist, and its invariants are exactly what the fidelity intake derives for an asset
  // with printed text, no logo and no face (the placeholder product id below is a label for the evaluation only, never a catalogue binding)
  for (const check of baseline.fidelity_checks) assert.ok(Object.values(FIDELITY_CHECK).includes(check), check);
  const derived = assetInvariants({
    id: 'benchmark-001-real-asset', product_id: 'unresolved-product-placeholder-not-a-catalogue-id', source_ref: 'asset://habb/benchmark-001/real-personalised-case-001',
    kind: 'REAL_PRODUCT_PHOTO', model_generated: false, screenshot: false, rights_confirmed: true, contains_text: true, contains_logo: false, contains_face_artwork: false,
  });
  assert.deepEqual([...baseline.invariants].sort(), [...derived].sort());
  assert.ok(baseline.invariants.includes('PRESERVE_PRODUCT_GEOMETRY'));
  assert.equal(baseline.piece_count, 1);
  // the printed text is product content: never rewritten, never OCR-reinterpreted, never promoted to a marketing claim
  // FB-20 (the book text is deliberately NOT transcribed anywhere in the repository data)
  assert.match(keep.printed_text, /never rewritten, never OCR-reinterpreted and never promoted to a marketing claim/);
  assert.doesNotMatch(JSON.stringify(config), /bonheur|d.appr.cier|que l.on a/i);
  assert.deepEqual(config.owned_records.filter((r) => r.kind === 'CLAIM').map((r) => r.metadata.approved_wording), ['25 €', '5 minutes', 'Coque personnalisée en 5 minutes']);
  // the printed-text region of the real photograph is annotated (coordinates only) and carried by the baseline
  assert.deepEqual(baseline.protected_regions, ['printed-text']);
  const region = config.asset_evidence.protected_regions[0];
  assert.equal(region.kind, 'TEXT');
  assert.deepEqual(region.source_dimensions, { width_px: 1152, height_px: 1536 });
  assert.ok(region.source_pixels.x >= 0 && region.source_pixels.y >= 0 && region.source_pixels.x + region.source_pixels.width <= 1152 && region.source_pixels.y + region.source_pixels.height <= 1536);
});

test('Benchmark 001 real asset: the face gate is a fact about this asset only', () => {
  // FB-21 no visible human face in this photograph: the identity gate does not apply to THIS asset
  assert.equal(baseline.face_identity_gate, 'NOT_APPLICABLE_FOR_THIS_ASSET');
  assert.match(baseline.face_gate_note, /only/);
  // FB-22 the global HABB face-preservation rules are unchanged (expression system and Brand Memory)
  const product = expression.product_presentation;
  assert.ok(product.dont.some((t) => /modify a face appearing in a customer's personalisation/.test(t)));
  assert.ok(product.dont.some((t) => /distort a person's face, body or identity/.test(t)));
  assert.ok(!JSON.stringify(baseline).includes('FACE'));
});
