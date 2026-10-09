// Creative Intelligence production stack: real typography + deterministic rasterization. Separate from the C1 index on purpose, because
// importing it loads the HarfBuzz WASM module and the resvg native binding.
export {
  createRealFont, createRealFontRegistry, combineFontRegistries, loadRealFont, lineInkBounds, PARITY_TOLERANCE_PX,
} from './production-typography.js';
export {
  createResvgRasterizer, renderProductionPng, stripPngMetadata, PNG_COLOR_CHUNKS, pngDimensions, pngChunkTypes, rasterizeToPixels, inkBoundsOfPixels, RASTERIZER_ENGINE,
} from './production-render.js';
export {
  verifyResourceResolver, verifyFontMetrics, verifyShaping, verifyArabicBidi, verifyRasterizer, verifyPngPath, assessExpressionReadiness,
} from './pre-c2-probes.js';
export { measureProductFidelity, createRenderLog, containFit, renderReference, TOLERANCES as FIDELITY_TOLERANCES, FIDELITY_MEASUREMENT_SOURCE } from './fidelity-measurements.js';
export { decodePng } from './png-pixels.js';
export { measureIdentityPreserve, IDENTITY_TOLERANCES, IDENTITY_MEASUREMENT_SOURCE } from './identity-preserve-measurements.js';
export { buildCandidateManifest, MANIFEST_SUBJECTS } from './candidate-manifest-from-document.js';
export {
  assessBenchmarkReadiness, recordBenchmarkRun, BENCHMARK_STATUS, PRODUCT_PROOF_KINDS,
} from './benchmark.js';
