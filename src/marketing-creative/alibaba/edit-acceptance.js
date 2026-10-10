import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';

import { evaluateHardFidelityGate, requiredChecksFromInvariants } from '../../creative-fidelity/fidelity-gates.js';
import { measureProductFidelity } from '../../creative-intelligence/production.js';
import { imageInfoOf } from './qwen-image-edit.js';

// A provider-edited image is NOT a candidate until the IDENTITY_PRESERVE fidelity gate has evaluated it. This is the only place that can create an accepted
// provider candidate: it runs the deterministic identity measurements itself (a caller cannot hand it a verdict) and the result is registered in a private set,
// so a hand-made object is never mistaken for an accepted one. A FAIL stops here with the exact failed observations; nothing is "improved" creatively.

export const PROVIDER_OUTPUT_STATUS = Object.freeze({
  PASS: 'PROVIDER_OUTPUT_FIDELITY_PASS',
  FAIL: 'PROVIDER_OUTPUT_FIDELITY_FAIL',
  BLOCKED: 'BLOCKED',
});

const REQUIRED = requiredChecksFromInvariants(['PRESERVE_PRODUCT_GEOMETRY', 'PRESERVE_PIECE_COUNT', 'PRESERVE_PRODUCT_COLOR', 'PRESERVE_TEXT_EXACTLY']);
const ACCEPTED = new WeakSet();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The measurements read PNG pixels: a JPEG output is converted by decoding it (no pixel is altered), never skipped. */
function asPng(bytes, info) {
  if (info.media_type === 'image/png') return new Uint8Array(bytes);
  const uri = `data:${info.media_type};base64,${Buffer.from(bytes).toString('base64')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}" viewBox="0 0 ${info.width} ${info.height}"><image width="${info.width}" height="${info.height}" preserveAspectRatio="none" href="${uri}"/></svg>`;
  return new Uint8Array(new Resvg(svg).render().asPng());
}

const failedObservations = (observations) => observations.flatMap((o) => (o.outcome === 'PASS' ? [] : (o.evidence.sub_observations ?? []).filter((s) => s.outcome !== 'PASS').map((s) => ({
  check: o.code, observation: s.id, outcome: s.outcome, evidence: s.evidence,
}))));

/**
 * @param {object} input
 *  provider  the editProductImage result (provenance)
 *  outputBytes  the stored provider output (read back from the private store)
 *  source    { bytes, sha256, origin, width_px, height_px }  the verified real asset
 *  source_asset_ref, derived_asset_ref  refs of the real asset and of the provider-derived asset
 *  annotations  the identity annotations (coordinates only)
 */
export function evaluateProviderEdit({ provider, outputBytes, source, source_asset_ref: sourceRef, derived_asset_ref: derivedRef, annotations } = {}) {
  const blocked = (reason) => Object.freeze({
    status: PROVIDER_OUTPUT_STATUS.BLOCKED, accepted: false, gate_outcome: 'NOT_MEASURABLE', reason, observations: Object.freeze([]), failed_observations: Object.freeze([]), candidate: null,
  });
  if (!provider || !outputBytes?.length || !source || !sourceRef || !derivedRef || !annotations) return blocked('INPUT_MISSING');
  const info = imageInfoOf(outputBytes);
  if (!info) return blocked('PROVIDER_OUTPUT_NOT_AN_IMAGE');
  if (sha256(outputBytes) !== provider.output?.sha256) return blocked('OUTPUT_BYTES_DO_NOT_MATCH_THE_RECORDED_OUTPUT');
  let png;
  try { png = asPng(outputBytes, info); } catch { return blocked('PROVIDER_OUTPUT_NOT_DECODABLE'); }
  const derivedSha = sha256(outputBytes);
  const observations = measureProductFidelity({
    source,
    derivation: {
      source_asset_ref: sourceRef,
      source_sha256: source.sha256,
      derived_asset_ref: derivedRef,
      derived_sha256: derivedSha,
      producer: { provider_id: provider.provider_id, model: provider.model, region: provider.region, request_id: provider.request_id },
    },
    candidate: { png_bytes: png },
    canvas: { width: info.width, height: info.height },
    product_layers: [{ preservation_mode: 'IDENTITY_PRESERVE' }],
    // the provider output IS the image: it is consumed once, as itself
    render_log: { resolutions: [{ ref: derivedRef, sha256: derivedSha }], image_draws: 1 },
    expected: { source_asset_ref: sourceRef, pinned_sha256: source.sha256, derived_asset_ref: derivedRef, piece_count: 1 },
    annotations,
  });
  const gate = evaluateHardFidelityGate({ observations, requiredChecks: REQUIRED });
  const status = gate.outcome === 'PASS' ? PROVIDER_OUTPUT_STATUS.PASS : (gate.outcome === 'FAIL' ? PROVIDER_OUTPUT_STATUS.FAIL : PROVIDER_OUTPUT_STATUS.BLOCKED);
  const accepted = gate.outcome === 'PASS';
  const result = Object.freeze({
    status,
    accepted,
    gate_outcome: gate.outcome,
    observations: Object.freeze(observations),
    failed_observations: Object.freeze(failedObservations(observations)),
    candidate: accepted ? Object.freeze({
      derived_asset_ref: derivedRef,
      sha256: derivedSha,
      width_px: info.width,
      height_px: info.height,
      preservation_mode: 'IDENTITY_PRESERVE',
      provider: Object.freeze({ provider_id: provider.provider_id, model: provider.model, region: provider.region, request_id: provider.request_id }),
    }) : null,
  });
  if (accepted) ACCEPTED.add(result);
  return result;
}

/** True only for a result produced by evaluateProviderEdit with a PASS gate. */
export const isAcceptedProviderCandidate = (value) => ACCEPTED.has(value);
