// Shared, memoised helpers of the Phase 5 tests (kept apart from the drawing world so the world stays free of src imports).
import * as W from './creative-integration-world.js';
import { segmentProduct } from '../src/creative-integration/segmentation.js';

const memo = new Map();
const EXTRA = { lowContrast: W.lowContrast, metallicOnLightGround: W.metallicOnLightGround, multiObject: W.multiObject, handHoldingProduct: W.handHoldingProduct, clutteredGround: W.clutteredGround };

/** A fixture and its segmentation, computed once per process. */
export function segmented(name) {
  if (!memo.has(name)) {
    const f = (W.ALL[name] ?? EXTRA[name])();
    memo.set(name, { ...f, seg: segmentProduct({ rgba: f.rgba }) });
  }
  return memo.get(name);
}

/** Intersection over union of two alpha planes at the 50 % level. */
export function iou(a, b) {
  let i = 0; let u = 0;
  for (let k = 0; k < a.length; k += 1) { const x = a[k] >= 128; const y = b[k] >= 128; if (x && y) i += 1; if (x || y) u += 1; }
  return u ? i / u : 0;
}

export const STANDARD_LIGHT = Object.freeze({ angle_deg: 120, elevation_deg: 40, softness: 0.5 });
export function standardScene(over = {}) {
  return {
    plate: W.plate(), horizon_y: 360, support: { kind: 'HORIZONTAL_PLANE', polygon: [[40, 400], [860, 400], [880, 690], [20, 690]] }, light: STANDARD_LIGHT, ...over,
  };
}
export const STANDARD_PLACEMENT = Object.freeze({ x: 450, y: 600, scale: 0.7 });
