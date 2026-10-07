import { BENCHMARK_TASK } from './constants.js';
import { createBenchmarkCase } from './benchmark.js';

const REQUIRED_KINDS = new Set(['REAL_PRODUCT_PHOTO']);
const OPAQUE_REF = /^(private-asset|asset):\/\/[A-Za-z0-9._:/-]+$/;

function assertOpaqueSourceRef(value) {
  if (typeof value !== 'string' || !value) {
    throw new TypeError('asset.source_ref is required');
  }
  if (!OPAQUE_REF.test(value) || value.includes('?') || value.includes('#')) {
    throw new Error(
      'asset.source_ref must be an opaque private-asset:// or asset:// reference',
    );
  }
  return value;
}

export function normalizeBenchmarkAsset(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('asset must be an object');
  }
  if (typeof input.id !== 'string' || !input.id) {
    throw new TypeError('asset.id is required');
  }
  if (typeof input.product_id !== 'string' || !input.product_id) {
    throw new TypeError('asset.product_id is required');
  }
  if (!REQUIRED_KINDS.has(input.kind)) {
    throw new Error('benchmark source must be a REAL_PRODUCT_PHOTO');
  }
  if (input.model_generated === true) {
    throw new Error(
      'generated images are not allowed as benchmark source truth',
    );
  }
  if (input.screenshot === true) {
    throw new Error('screenshots are not allowed as benchmark source truth');
  }
  if (input.rights_confirmed !== true) {
    throw new Error('rights_confirmed must be true');
  }

  return Object.freeze({
    id: input.id,
    product_id: input.product_id,
    source_ref: assertOpaqueSourceRef(input.source_ref),
    kind: input.kind,
    model_generated: false,
    screenshot: false,
    rights_confirmed: true,
    category: input.category ?? null,
    material: input.material ?? null,
    contains_face_artwork: Boolean(input.contains_face_artwork),
    contains_logo: Boolean(input.contains_logo),
    contains_text: Boolean(input.contains_text),
    identity_colors: Object.freeze([...(input.identity_colors ?? [])]),
    notes: Object.freeze([...(input.notes ?? [])]),
  });
}

export function assetInvariants(asset) {
  const normalized = normalizeBenchmarkAsset(asset);
  const invariants = [
    'PRESERVE_PRODUCT_GEOMETRY',
    'PRESERVE_PIECE_COUNT',
    'PRESERVE_PRODUCT_COLOR',
  ];

  if (normalized.contains_logo) {
    invariants.push('PRESERVE_LOGO_EXACTLY');
  }
  if (normalized.contains_text) {
    invariants.push('PRESERVE_TEXT_EXACTLY');
  }
  if (normalized.contains_face_artwork) {
    invariants.push('PRESERVE_FACE_PIXELS_EXACTLY');
  }

  return Object.freeze(invariants);
}

export function createStandardCasesForAsset(asset) {
  const normalized = normalizeBenchmarkAsset(asset);
  const expected_invariants = assetInvariants(normalized);
  const shared = {
    product_id: normalized.product_id,
    source_refs: [normalized.source_ref],
    expected_invariants,
    metadata: {
      asset_id: normalized.id,
      category: normalized.category,
      material: normalized.material,
    },
  };

  return Object.freeze([
    createBenchmarkCase({
      id: `${normalized.id}:background`,
      task: BENCHMARK_TASK.BACKGROUND_SWAP,
      instruction: (
        'Replace only the environment/background. Preserve the commercial '
        + 'product exactly.'
      ),
      ...shared,
    }),
    createBenchmarkCase({
      id: `${normalized.id}:premium-ad`,
      task: BENCHMARK_TASK.PREMIUM_AD,
      instruction: (
        'Create a premium advertising composition while preserving the '
        + 'product exactly.'
      ),
      ...shared,
    }),
    createBenchmarkCase({
      id: `${normalized.id}:in-context`,
      task: BENCHMARK_TASK.IN_CONTEXT,
      instruction: (
        'Place the product in a realistic use/context scene while preserving '
        + 'the product exactly.'
      ),
      ...shared,
    }),
    createBenchmarkCase({
      id: `${normalized.id}:external-edit`,
      task: BENCHMARK_TASK.EXTERNAL_EDIT,
      instruction: (
        'Edit only elements outside the product. Preserve all product pixels '
        + 'that define identity.'
      ),
      ...shared,
    }),
    createBenchmarkCase({
      id: `${normalized.id}:coherent-set`,
      task: BENCHMARK_TASK.COHERENT_SET,
      instruction: (
        'Create a coherent campaign set with the same product identity across '
        + 'outputs.'
      ),
      ...shared,
    }),
  ]);
}

export function buildManifestFromAssets({
  benchmark_id,
  merchant_id,
  assets,
  created_at = null,
}) {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new TypeError('assets must contain at least one product');
  }

  const normalized = assets.map(normalizeBenchmarkAsset);
  const ids = new Set();

  for (const item of normalized) {
    if (ids.has(item.id)) {
      throw new Error(`duplicate asset id: ${item.id}`);
    }
    ids.add(item.id);
  }

  return Object.freeze({
    benchmark_id,
    merchant_id,
    created_at,
    cases: Object.freeze(
      normalized.flatMap(createStandardCasesForAsset),
    ),
  });
}
