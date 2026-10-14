import { createHash } from 'node:crypto';

import { encodePng } from '../creative-intelligence/png-encode.js';
import {
  STATE as IS, buildCutout, checkMatte, hasMeaningfulAlpha, segmentNativeAlpha, segmentProduct,
} from '../creative-integration/index.js';
import { flattenOnWhite } from './asset.js';
import { OPERATION, RUN_UNIT_COSTS } from './constants.js';

// THE SEGMENTATION STAGE of a run. It replaces the annotated-outline segmenter ONLY inside the end-to-end flow: the real product is cut out by the general segmentation of `creative-integration` (a pre-cut image keeps
// its validated alpha; a photograph on a plain ground is segmented and its matte is judged against the source pixels), BEFORE any billable layer call. Every stop is one of the explicit states of Phase 5 and
// names its reasons; there is no fallback to a generated or redrawn product.

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * @param {object} input { ctx, rgba (with alpha), mode: 'AUTO' | 'NATIVE_ALPHA' | 'PHOTO', selection, port? (segmentation provider: { id, segment({ rgba, selection }) }, may be async), cache? }
 * @returns {Promise<{ state, reasons, source_kind, seg?, matte?, cutout?, layered?, stage_evidence }>}  state is an integration STATE (READY_FOR_COMPOSITE when the product was cut out)
 */
export async function computeProductSegmentation({
  ctx, rgba, mode = 'AUTO', selection = { mode: 'AUTO' }, port = null, cache = null,
}) {
  const hasAlpha = hasMeaningfulAlpha(rgba);
  const kind = mode === 'AUTO' ? (hasAlpha ? 'NATIVE_ALPHA' : 'PHOTO') : mode;
  const stop = (state, reasons, extra = {}) => ({ state, reasons, source_kind: kind, ...extra });
  const op = ctx.operations.begin({ kind: OPERATION.LOCAL, key: `SEGMENT:${sha(rgba.pixels).slice(0, 24)}:${kind}:${JSON.stringify(selection)}`, executor: 'LOCAL', basis: ['product-segmentation'] });
  let seg; let matte = null; let source = rgba;
  if (kind === 'NATIVE_ALPHA') {
    if (!hasAlpha) { op.fail('NO_NATIVE_ALPHA'); return stop(IS.SEGMENTATION_FAILED, ['THE_IMAGE_HAS_NO_MEANINGFUL_ALPHA']); }
    seg = segmentNativeAlpha(rgba, selection);
    if (!seg.accepted) { op.fail(seg.failure_reason); return stop(IS.SEGMENTATION_FAILED, [seg.failure_reason, ...seg.native.findings.filter((f) => !f.ok).map((f) => f.code)], { seg }); }
  } else {
    source = hasAlpha || rgba.pixels.some((v, i) => i % 4 === 3 && v < 255) ? flattenOnWhite(rgba) : rgba;
    let provided = null;
    if (port) {
      const pop = ctx.operations.begin({ kind: OPERATION.SEGMENTATION_PROVIDER, key: `SEGPROV:${port.id}:${sha(source.pixels).slice(0, 24)}:${JSON.stringify(selection)}`, estimate_eur: RUN_UNIT_COSTS.segmentation_provider_eur, executor: 'PROVIDER', basis: [port.id] });
      if (pop.reused) provided = pop.result ? { ...pop.result, alpha: new Uint8Array(Buffer.from(pop.result.alpha_b64, 'base64')) } : null;
      else {
        try {
          const out = await port.segment({ rgba: source, selection });
          provided = out;
          pop.complete({ result: out?.alpha instanceof Uint8Array ? { ...out, alpha: undefined, alpha_b64: Buffer.from(out.alpha).toString('base64') } : undefined });
        } catch (e) { pop.fail(e?.code ?? e?.message); op.fail('SEGMENTATION_PROVIDER_FAILED'); return stop(IS.SEGMENTATION_FAILED, ['PORT_FAILED']); }
      }
    }
    seg = segmentProduct({ rgba: source, selection, ...(provided ? { port: { id: port.id, segment: () => provided } } : {}), cache });
    if (seg.status === 'FAILED') { op.fail(seg.failure_reason); return stop(IS.SEGMENTATION_FAILED, [seg.failure_reason], { seg }); }
    if (!seg.accepted) { op.fail('LOW_CONFIDENCE'); return stop(IS.SEGMENTATION_LOW_CONFIDENCE, [seg.failure_reason ?? 'CONFIDENCE_BELOW_THE_MINIMUM'], { seg }); }
    const selected = seg.components.filter((c) => c.selected).length || 1;
    matte = checkMatte({ rgba: source, alpha: seg.alpha, ground: seg.ground ?? null, declared: { components: selected }, ignore: seg.excluded ?? null });
    if (!matte.valid) { op.fail('MATTE_INVALID'); return stop(IS.MATTE_INVALID, matte.findings.filter((f) => !f.ok).map((f) => f.code), { seg, matte }); }
  }
  const cutout = buildCutout({ rgba: source, alpha: seg.alpha, bounds: seg.bounds });
  const cutoutPng = encodePng({ width: cutout.width, height: cutout.height, pixels: cutout.pixels });
  const layered = Object.freeze({
    component: 'CREATIVE_E2E_INTEGRATION_SEGMENTER', cutout_png: cutoutPng, cutout_sha256: sha(cutoutPng), width_px: cutout.width, height_px: cutout.height, crop: cutout.crop,
    quality: Object.freeze({ confident: true, source_kind: kind, confidence: seg.confidence, shape: { model: 'CREATIVE_INTEGRATION_MATTE' }, edge_step_positive_share: seg.edge_quality?.partial_share ?? null, median_residual_px: null }),
  });
  op.complete();
  const evidence = { source_kind: kind, mask_sha256: sha(seg.alpha), cutout_sha256: layered.cutout_sha256, bounds: seg.bounds, confidence: seg.confidence, decontaminated_pixels: cutout.decontaminated_pixels, matte_checks: matte ? matte.findings.length : null, native: seg.native ? { snapped_to_opaque: seg.native.snapped_to_opaque, soft_pixels: seg.native.soft_pixels } : null, components: seg.components?.length ?? null };
  return { state: IS.READY_FOR_COMPOSITE, reasons: [], source_kind: kind, seg, matte, cutout, layered, stage_evidence: evidence };
}

/** The `ports.segmenter` of the layered runtime for a product that was ALREADY cut out by the stage above: the runtime receives the cut-out, it does not segment again. */
export function precomputedSegmenter(layered) {
  return Object.freeze({ component: layered.component, async segment() { return layered; } });
}
