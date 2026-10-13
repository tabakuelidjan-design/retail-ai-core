import { encodePng } from '../creative-intelligence/png-encode.js';
import { resizeRgba } from './pixels.js';

// VISUAL ACCEPTANCE OUTPUT. A number is not an acceptance: for each candidate the pipeline emits the seven views a person must LOOK at — SOURCE, MASK, COMPOSITE (the cut-out on a split dark / light backdrop, where a halo
// shows), EDGE CLOSE-UP (the most difficult piece of the boundary, magnified, nearest-neighbour), CONTACT SHADOW CLOSE-UP, PRODUCT FIDELITY DIFF (|source - graded product|, amplified), FINAL SCENE — as separate PNGs and
// as one labelled sheet. Pure and deterministic; the labels use a tiny built-in bitmap font so the sheet is identical on every platform (no system font).

const FONT = {
  A: [14, 17, 17, 31, 17, 17, 17], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14], W: [17, 17, 17, 21, 21, 27, 17], Y: [17, 17, 10, 4, 4, 4, 4], '-': [0, 0, 0, 31, 0, 0, 0], ' ': [0, 0, 0, 0, 0, 0, 0],
};

const solid = (w, h, c) => { const p = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i += 1) { p[i * 4] = c[0]; p[i * 4 + 1] = c[1]; p[i * 4 + 2] = c[2]; p[i * 4 + 3] = 255; } return { width: w, height: h, pixels: p }; };

function drawText(img, text, x, y, scale, color) {
  let cx = x;
  for (const ch of text) {
    const g = FONT[ch] ?? FONT[' '];
    for (let r = 0; r < 7; r += 1) for (let c = 0; c < 5; c += 1) if (g[r] & (1 << (4 - c))) for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) {
      const px = cx + c * scale + dx; const py = y + r * scale + dy; if (px >= 0 && py >= 0 && px < img.width && py < img.height) { const i = (py * img.width + px) * 4; img.pixels[i] = color[0]; img.pixels[i + 1] = color[1]; img.pixels[i + 2] = color[2]; img.pixels[i + 3] = 255; }
    }
    cx += 6 * scale;
  }
}

function over(dst, src, ox, oy) {
  for (let y = 0; y < src.height; y += 1) for (let x = 0; x < src.width; x += 1) {
    const dx = ox + x; const dy = oy + y; if (dx < 0 || dy < 0 || dx >= dst.width || dy >= dst.height) continue;
    const s = (y * src.width + x) * 4; const a = src.pixels[s + 3] / 255; if (!a) continue; const d = (dy * dst.width + dx) * 4;
    for (let c = 0; c < 3; c += 1) dst.pixels[d + c] = Math.round(dst.pixels[d + c] * (1 - a) + src.pixels[s + c] * a);
  }
}

const crop = (img, x0, y0, w, h) => { const out = solid(w, h, [0, 0, 0]); for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const sx = x0 + x; const sy = y0 + y; if (sx >= 0 && sy >= 0 && sx < img.width && sy < img.height) { const s = (sy * img.width + sx) * 4; const d = (y * w + x) * 4; for (let c = 0; c < 4; c += 1) out.pixels[d + c] = img.pixels[s + c]; } } return out; };
const magnify = (img, k) => { const out = solid(img.width * k, img.height * k, [0, 0, 0]); for (let y = 0; y < out.height; y += 1) for (let x = 0; x < out.width; x += 1) { const s = ((y / k | 0) * img.width + (x / k | 0)) * 4; const d = (y * out.width + x) * 4; for (let c = 0; c < 4; c += 1) out.pixels[d + c] = img.pixels[s + c]; } return out; };
const fit = (img, w, h) => { const k = Math.min(w / img.width, h / img.height); return resizeRgba(img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k))); };

/** A split backdrop (dark left, light right) with the RGBA over it: a halo of either colour shows on one of the two halves. */
function onSplit(rgba) {
  const bg = solid(rgba.width, rgba.height, [210, 205, 196]);
  for (let y = 0; y < rgba.height; y += 1) for (let x = 0; x < rgba.width / 2; x += 1) { const i = (y * rgba.width + x) * 4; bg.pixels[i] = 28; bg.pixels[i + 1] = 52; bg.pixels[i + 2] = 64; }
  over(bg, rgba, 0, 0); return bg;
}

/** The 40 x 40 window of the cut-out with the most partial-alpha (soft edge) pixels: the hardest piece of the boundary to look at. */
function hardestEdge(cutout, win = 40) {
  let best = { n: -1, x: 0, y: 0 }; const step = 8;
  for (let y = 0; y + win <= cutout.height; y += step) for (let x = 0; x + win <= cutout.width; x += step) {
    let n = 0; for (let yy = 0; yy < win; yy += 2) for (let xx = 0; xx < win; xx += 2) { const a = cutout.pixels[((y + yy) * cutout.width + x + xx) * 4 + 3]; if (a > 8 && a < 247) n += 1; }
    if (n > best.n) best = { n, x, y };
  }
  return best;
}

/**
 * @param {object} input { source: RGBA photograph, result: a READY_FOR_COMPOSITE integrateProduct result, title?: string }
 * @returns {{ sheet: Uint8Array (PNG), panels: { [name]: Uint8Array (PNG) } }}
 */
export function renderAcceptance({ source, result }) {
  const { cutout, graded_cutout: graded, product: placed, shadow } = result.layers; const T = 300;
  const maskImg = solid(source.width, source.height, [0, 0, 0]);
  for (let i = 0; i < source.width * source.height; i += 1) { const a = result.segmentation.alpha[i]; maskImg.pixels[i * 4] = a; maskImg.pixels[i * 4 + 1] = a; maskImg.pixels[i * 4 + 2] = a; }
  const composite = onSplit(graded);
  const e = hardestEdge(cutout); const win = crop(cutout, e.x, e.y, 40, 40); const edge = magnify(onSplit(win), 7);
  // contact shadow: the scene around the contact line, magnified, beside the shadow layer on white
  const o = placed.opaque; const cx0 = Math.max(0, o.x0 - 20); const cy0 = Math.max(0, placed.contact_y - 50); const cw = Math.min(result.composite.width - cx0, o.x1 - o.x0 + 80); const contact = magnify(crop(result.composite, cx0, cy0, Math.min(cw, 120), 90), 3);
  const diff = solid(cutout.width, cutout.height, [0, 0, 0]);
  for (let i = 0; i < cutout.width * cutout.height; i += 1) if (cutout.pixels[i * 4 + 3] > 0) {
    const d = (Math.abs(cutout.pixels[i * 4] - graded.pixels[i * 4]) + Math.abs(cutout.pixels[i * 4 + 1] - graded.pixels[i * 4 + 1]) + Math.abs(cutout.pixels[i * 4 + 2] - graded.pixels[i * 4 + 2])) / 3;
    diff.pixels[i * 4] = Math.min(255, 40 + d * 8); diff.pixels[i * 4 + 1] = 40; diff.pixels[i * 4 + 2] = 40;
  }
  const shadowOnWhite = solid(shadow.width, shadow.height, [255, 255, 255]); over(shadowOnWhite, shadow, 0, 0);
  const named = [
    ['SOURCE', source], ['MASK', maskImg], ['COMPOSITE', composite], ['EDGE CLOSE-UP', edge],
    ['CONTACT SHADOW CLOSE-UP', contact], ['PRODUCT FIDELITY DIFF', diff], ['FINAL SCENE', result.composite], ['SHADOW LAYER', shadowOnWhite],
  ];
  const label = 22; const cols = 4; const rows = 2; const gap = 8;
  const sheet = solid(cols * (T + gap) + gap, rows * (T + label + gap) + gap, [244, 242, 238]); const panels = {};
  named.forEach(([name, img], k) => {
    const cx = gap + (k % cols) * (T + gap); const cy = gap + Math.floor(k / cols) * (T + label + gap);
    const tile = solid(T, T, [236, 233, 228]); const f = fit(img, T, T); over(tile, f, Math.floor((T - f.width) / 2), Math.floor((T - f.height) / 2));
    over(sheet, tile, cx, cy + label);
    drawText(sheet, name, cx + 2, cy + 4, 2, [24, 40, 80]);
    panels[name] = encodePng({ width: img.width, height: img.height, pixels: img.pixels });
  });
  return { sheet: encodePng({ width: sheet.width, height: sheet.height, pixels: sheet.pixels }), panels };
}
