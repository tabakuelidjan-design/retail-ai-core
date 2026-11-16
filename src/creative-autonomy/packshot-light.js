// From which side is the REAL packshot lit? The scene's key light must agree with it, or the product looks pasted: a front-lit photograph in a back-lit room. Measured, not judged:
// the luminance of the opaque pixels on the left of the product's centre against the right (the same formula as scripts/creative-autonomy/scene_check.py, "LUMIÈRE":
// lr = (mean_left - mean_right) / (mean_left + mean_right), positive = the left side is brighter). Remax FC-02 (archived cut-out): lr = +0.105, i.e. lit from the LEFT.
// Below the threshold the packshot is evenly lit: there is no side to respect and the rule does not apply.

export const PACKSHOT_LIT_THRESHOLD = 0.05;
const OPAQUE = 250;

/** @param {{ width: number, height: number, pixels: Uint8Array }} rgba the cut-out (RGBA, alpha = the matte) @returns {{ lr: number|null, side: 'LEFT'|'RIGHT'|null }} */
export function litSideOfRgba({ width, height, pixels }) {
  let x0 = width; let x1 = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (pixels[(y * width + x) * 4 + 3] >= OPAQUE) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
  if (x1 < x0) return { lr: null, side: null };
  const centre = (x0 + x1 + 1) / 2;
  let l = 0; let nl = 0; let r = 0; let nr = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * width + x) * 4; if (pixels[i + 3] < OPAQUE) continue;
      const lum = (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]) / 255;
      if (x < centre) { l += lum; nl += 1; } else { r += lum; nr += 1; }
    }
  }
  if (!nl || !nr) return { lr: null, side: null };
  const ml = l / nl; const mr = r / nr; const lr = (ml - mr) / (ml + mr + 1e-6);
  return { lr: Math.round(lr * 10000) / 10000, side: Math.abs(lr) <= PACKSHOT_LIT_THRESHOLD ? null : (lr > 0 ? 'LEFT' : 'RIGHT') };
}
