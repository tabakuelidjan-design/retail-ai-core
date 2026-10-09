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
export {
  assessBenchmarkReadiness, recordBenchmarkRun, BENCHMARK_STATUS, PRODUCT_PROOF_KINDS,
} from './benchmark.js';
