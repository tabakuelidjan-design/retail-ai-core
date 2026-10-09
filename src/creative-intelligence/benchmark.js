// Campaign benchmark readiness - GENERIC. A benchmark is configuration data (benchmarks/creative-intelligence/*.json): what a real campaign
// needs bound to real, resolved, approved resources. Nothing about any campaign lives in this source.
//
//   NOT_RUN  -> the benchmark has never been run (the state of a configuration file)
//   BLOCKED  -> at least one required binding is missing, unresolved, unapproved or not real
//   RUNNABLE -> every binding resolves through the common resource resolver, with its evidence   (RUNNABLE is NOT run)
//   RUN      -> it was actually run and its gates passed (recordBenchmarkRun): the only state that closes the C2 blocker
//
// Nothing is substituted: a missing real asset is never replaced by a generated or synthetic one, an unapproved claim never counts as
// approved, an absent expression system is never invented.

import { createHash } from 'node:crypto';
import { isExpressionNonEmpty } from '../branding/expression-system.js';
import { CI_ERROR as E, PRE_C2_DEPENDENCY as D, RESOURCE_KIND } from './constants.js';
import { registerEvidence } from './readiness.js';
import { deepFreeze, fail, isPlainObject, ref } from './validation.js';

export const BENCHMARK_STATUS = Object.freeze({
  NOT_RUN: 'NOT_RUN', BLOCKED: 'BLOCKED', RUNNABLE: 'RUNNABLE', RUN: 'RUN',
});

const item = (id, kind, reference, status, reason) => ({
  id, kind, ref: reference ?? null, status, reason,
});
const BOUND = 'BOUND';
const MISSING = 'MISSING';
const BLOCKED = 'BLOCKED';

async function safeResolve(resolver, reference, tenant) {
  try {
    return { resolution: await resolver.resolve(reference, tenant) };
  } catch (error) {
    return { refused: error.code ?? 'REFUSED' };
  }
}

async function bindResource({ id, kind, reference, resolver, tenant, check }) {
  if (!reference) return item(id, kind, null, MISSING, 'BINDING_MISSING');
  const { resolution, refused } = await safeResolve(resolver, reference, tenant);
  if (refused) return item(id, kind, reference, BLOCKED, `RESOLVER_REFUSED:${refused}`);
  if (resolution.status !== 'ACTIVE') return item(id, kind, reference, BLOCKED, `RESOURCE_${resolution.status}`);
  if (resolution.kind !== kind) return item(id, kind, reference, BLOCKED, 'KIND_MISMATCH');
  if (!resolution.provenance?.evidence_ref) return item(id, kind, reference, BLOCKED, 'EVIDENCE_MISSING');
  const problem = await check?.(resolution);
  return problem ? item(id, kind, reference, BLOCKED, problem) : item(id, kind, reference, BOUND, 'RESOLVED_WITH_EVIDENCE');
}

/**
 * @param {object} config   the benchmark configuration data (see benchmarks/creative-intelligence)
 * @param {object} resolver the common resource resolver
 * @param {object} tenant   { merchantId }
 * @param {object|null} creativeInterface creativeBrandInterface(...) of the brand the benchmark runs for, or null
 */
export async function assessBenchmarkReadiness({
  config, resolver, tenant, creativeInterface = null,
} = {}) {
  if (!isPlainObject(config) || !isPlainObject(config.bindings) || !isPlainObject(config.expected)) fail(E.BENCHMARK_INVALID, 'a benchmark configuration states its expected facts and its bindings', { field: 'config' });
  const { bindings, expected } = config;
  const items = [];

  items.push(await bindResource({ id: 'product', kind: RESOURCE_KIND.PRODUCT, reference: bindings.product?.ref, resolver, tenant }));

  items.push(await bindResource({
    id: 'asset', kind: RESOURCE_KIND.ASSET, reference: bindings.asset?.ref, resolver, tenant,
    check: async (r) => {
      // a REAL, approved merchant asset: never generated, never synthetic, never unapproved - and its bytes must really be there
      if (r.metadata.origin !== 'MERCHANT_PROVIDED') return 'ASSET_NOT_REAL_MERCHANT_ASSET';
      if (!r.metadata.approval_ref) return 'ASSET_NOT_APPROVED';
      try { await resolver.loadPayload(r.ref, tenant); } catch { return 'ASSET_PAYLOAD_UNAVAILABLE'; }
      return null;
    },
  }));

  for (const claim of bindings.claims ?? []) {
    items.push(await bindResource({
      id: `claim:${claim.id}`, kind: RESOURCE_KIND.CLAIM, reference: claim.ref, resolver, tenant,
      // the approved wording must be EXACTLY the wording the benchmark expects: not close, not reworded
      check: (r) => (r.metadata.approved_wording === claim.expected_wording ? null : 'CLAIM_WORDING_DIFFERS_FROM_EXPECTED'),
    }));
  }

  items.push(await bindResource({
    id: 'format', kind: RESOURCE_KIND.FORMAT, reference: bindings.format?.ref, resolver, tenant,
    check: (r) => {
      const c = r.metadata.canvas;
      if (c.width !== expected.canvas.width || c.height !== expected.canvas.height || c.unit !== expected.canvas.unit) return 'FORMAT_CANVAS_DIFFERS_FROM_EXPECTED';
      if (expected.medium && r.metadata.medium !== expected.medium) return 'FORMAT_MEDIUM_DIFFERS_FROM_EXPECTED';
      return null;
    },
  }));

  const fontBindings = bindings.fonts ?? [];
  if (fontBindings.length === 0) items.push(item('fonts', RESOURCE_KIND.FONT, null, MISSING, 'BINDING_MISSING'));
  for (const font of fontBindings) {
    items.push(await bindResource({
      id: `font:${font.ref ?? 'unbound'}`, kind: RESOURCE_KIND.FONT, reference: font.ref, resolver, tenant,
      check: async (r) => {
        if (!r.metadata.license_ref) return 'FONT_LICENSE_UNKNOWN';
        try { await resolver.loadPayload(r.ref, tenant); } catch { return 'FONT_PAYLOAD_UNAVAILABLE'; }
        return null;
      },
    }));
  }

  if (!creativeInterface || creativeInterface.expression_system == null) items.push(item('expression_system', 'BRAND_MEMORY', null, MISSING, 'EXPRESSION_SYSTEM_ABSENT'));
  else if (!isExpressionNonEmpty(creativeInterface.expression_system)) items.push(item('expression_system', 'BRAND_MEMORY', null, MISSING, 'EXPRESSION_SYSTEM_EMPTY'));
  else items.push(item('expression_system', 'BRAND_MEMORY', creativeInterface.memory_ref ? `${creativeInterface.memory_ref.id}@${creativeInterface.memory_ref.version}` : null, BOUND, 'APPROVED_NON_EMPTY'));

  const blockers = items.filter((i) => i.status !== BOUND).map((i) => ({ id: i.id, reason: i.reason }));
  return deepFreeze({
    benchmark_id: config.benchmark_id,
    status: blockers.length === 0 ? BENCHMARK_STATUS.RUNNABLE : BENCHMARK_STATUS.BLOCKED,
    runnable_is_not_run: true,
    bindings: items,
    blockers,
  });
}

/**
 * Records that the benchmark was ACTUALLY RUN and passed its gates; only then is the evidence that closes the C2 blocker issued.
 * A BLOCKED or merely RUNNABLE report is refused. The gate results come from the real gates (preflight, Creative Fidelity, Brand Guardian).
 */
export function recordBenchmarkRun({ readiness, results, ran_at: ranAt } = {}) {
  if (readiness?.status !== BENCHMARK_STATUS.RUNNABLE) fail(E.BENCHMARK_INVALID, 'only a RUNNABLE benchmark can be run', { status: readiness?.status ?? null });
  if (!isPlainObject(results)) fail(E.BENCHMARK_INVALID, 'the run states its results', { field: 'results' });
  for (const gate of ['preflight_status', 'fidelity_status', 'guardian_status']) {
    if (results[gate] !== 'PASS') fail(E.BENCHMARK_INVALID, `${gate} must be PASS for the benchmark to count as run`, { gate });
  }
  if (typeof results.png_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(results.png_sha256)) fail(E.BENCHMARK_INVALID, 'a run produces a real PNG (its sha-256)', { field: 'png_sha256' });
  const at = new Date(Date.parse(ranAt));
  if (Number.isNaN(at.getTime())) fail(E.BENCHMARK_INVALID, 'ran_at must be an ISO timestamp', { field: 'ran_at' });
  const details = {
    benchmark_id: readiness.benchmark_id, ran_at: at.toISOString(), png_sha256: results.png_sha256, bindings: readiness.bindings.map((b) => `${b.id}=${b.ref}`),
  };
  const digest = createHash('sha256').update(JSON.stringify(details)).digest('hex').slice(0, 16);
  return registerEvidence(deepFreeze({
    dependency: D.REAL_CAMPAIGN_BENCHMARK,
    status: 'VERIFIED',
    verified_by: 'benchmark-run',
    evidence_ref: ref(`benchmark-run://${readiness.benchmark_id.toLowerCase()}/${digest}`, 'evidence_ref'),
    benchmark_status: BENCHMARK_STATUS.RUN,
    details,
  }));
}
