// Fixtures of the Phase 5 tests: product photographs DRAWN here (no photo, no provider, no network), anti-aliased from signed distances, with a deterministic sensor noise.
// A fixture returns { rgba, truth } where truth.alpha is the exact coverage of the drawn product(s), so a matte can be compared with the ground truth.

export function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

export function blank(width, height, bg = [236, 233, 228], { noise = 1.2, seed = 7 } = {}) {
  const pixels = new Uint8Array(width * height * 4); const rnd = lcg(seed);
  for (let i = 0; i < width * height; i += 1) {
    const n = (rnd() - 0.5) * 2 * noise;
    pixels[i * 4] = Math.round(bg[0] + n); pixels[i * 4 + 1] = Math.round(bg[1] + n); pixels[i * 4 + 2] = Math.round(bg[2] + n); pixels[i * 4 + 3] = 255;
  }
  return { width, height, pixels };
}

// signed distances (negative inside)
export const sdRoundRect = (cx, cy, hw, hh, r) => (x, y) => { const qx = Math.abs(x - cx) - hw + r; const qy = Math.abs(y - cy) - hh + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };
export const sdEllipse = (cx, cy, rx, ry) => (x, y) => { const k = Math.hypot((x - cx) / rx, (y - cy) / ry); return (k - 1) * Math.min(rx, ry); };
export const sdCapsule = (ax, ay, bx, by, r) => (x, y) => { const pax = x - ax; const pay = y - ay; const bax = bx - ax; const bay = by - ay; const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay))); return Math.hypot(pax - bax * h, pay - bay * h) - r; };
export const sdRing = (cx, cy, r, t) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) - t;

/** Paint a shape: coverage from the signed distance (1 px anti-aliasing), colour from a function, onto `img`, and accumulate the exact coverage in `truth`. */
export function paint(img, truth, sd, colour, { opacity = 1, solid = true } = {}) {
  const { width, height, pixels } = img;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cov = Math.max(0, Math.min(1, 0.5 - sd(x + 0.5, y + 0.5))) * opacity;
      if (cov <= 0) continue;
      const c = colour(x, y); const i = (y * width + x) * 4;
      for (let k = 0; k < 3; k += 1) pixels[i + k] = Math.round(pixels[i + k] * (1 - cov) + c[k] * cov);
      if (truth && solid) truth[y * width + x] = Math.min(255, Math.round(truth[y * width + x] + (255 - truth[y * width + x]) * cov));
    }
  }
}
export const flat = (c) => () => c;
export const vgrad = (y0, y1, a, b) => (x, y) => { const t = Math.max(0, Math.min(1, (y - y0) / (y1 - y0))); return a.map((v, k) => Math.round(v + (b[k] - v) * t)); };
export const hbands = (x0, x1, stops) => (x) => { const t = Math.max(0, Math.min(0.999, (x - x0) / (x1 - x0))); const f = t * (stops.length - 1); const k = Math.floor(f); const u = f - k; return stops[k].map((v, j) => Math.round(v + (stops[k + 1][j] - v) * u)); };

const NAVY = [24, 42, 84]; const RED = [192, 57, 43]; const CREAM = [251, 248, 243];

function fixture(width, height, build, opts) {
  const rgba = blank(width, height, opts?.bg, opts); const truth = new Uint8Array(width * height);
  build(rgba, truth);
  const rnd = lcg(31); const grain = opts?.grain ?? 1.2; // the grain of a real photograph lies over the product as well as the ground
  for (let i = 0; i < width * height; i += 1) { const n = (rnd() - 0.5) * 2 * grain; for (let c = 0; c < 3; c += 1) rgba.pixels[i * 4 + c] = Math.max(0, Math.min(255, Math.round(rgba.pixels[i * 4 + c] + n))); }
  return { rgba, truth: { alpha: truth } };
}

export const phoneCase = () => fixture(300, 440, (img, t) => {
  paint(img, t, sdRoundRect(150, 220, 85, 170, 24), vgrad(50, 390, [28, 48, 96], [20, 36, 76]));
  paint(img, null, sdRoundRect(150, 220, 78, 163, 19), flat([236, 140, 120])); // a printed photo area
  paint(img, null, sdRoundRect(150, 140, 42, 14, 6), flat(CREAM)); // a logo bar
  paint(img, null, sdRoundRect(150, 300, 30, 4, 2), flat(NAVY));
  paint(img, t, sdRoundRect(112, 82, 24, 24, 9), flat([14, 14, 18])); // camera bump
});

export const tumbler = () => fixture(300, 460, (img, t) => {
  paint(img, t, sdRoundRect(130, 250, 52, 150, 16), hbands(78, 182, [[70, 96, 112], [150, 176, 196], [96, 122, 140], [44, 62, 76]]));
  paint(img, t, sdRoundRect(130, 92, 56, 16, 8), flat([34, 34, 40])); // lid
  paint(img, t, sdRing(212, 240, 34, 8), flat([34, 34, 40])); // a handle: a real hole
  paint(img, null, sdRoundRect(130, 260, 30, 6, 3), flat(RED));
});

export const magnet = () => fixture(220, 220, (img, t) => {
  paint(img, t, sdRoundRect(110, 110, 70, 70, 10), flat(CREAM));
  paint(img, null, sdRoundRect(110, 110, 62, 62, 6), vgrad(48, 172, [120, 160, 200], [230, 200, 160]));
  paint(img, null, sdEllipse(110, 120, 18, 18), flat(RED));
}, { bg: [200, 205, 210] });

export const framedPrint = () => fixture(320, 400, (img, t) => {
  paint(img, t, sdRoundRect(160, 200, 110, 150, 2), flat([92, 66, 44]));
  paint(img, null, sdRoundRect(160, 200, 92, 132, 1), flat([246, 244, 238]));
  paint(img, null, sdRoundRect(160, 170, 60, 60, 1), vgrad(110, 230, [40, 90, 140], [220, 120, 60]));
  paint(img, null, sdRoundRect(160, 270, 50, 4, 1), flat([70, 70, 70]));
});

export const giftBox = () => fixture(360, 320, (img, t) => {
  paint(img, t, sdRoundRect(180, 170, 130, 100, 4), flat([196, 110, 84]));
  paint(img, null, sdRoundRect(180, 170, 12, 100, 0), flat([176, 138, 78]));
  paint(img, null, sdRoundRect(180, 170, 130, 12, 0), flat([176, 138, 78]));
  paint(img, t, sdEllipse(180, 70, 28, 18), flat([176, 138, 78])); // a bow: thin protrusion on top
  paint(img, t, sdCapsule(150, 66, 120, 40, 3), flat([176, 138, 78]));
});

export const smallTech = () => fixture(280, 300, (img, t) => {
  paint(img, t, sdRoundRect(140, 150, 70, 100, 16), flat([232, 232, 236]));
  paint(img, null, sdRoundRect(140, 130, 52, 62, 6), flat([22, 24, 30])); // a screen
  paint(img, null, sdEllipse(140, 214, 14, 14), flat([120, 124, 132])); // a button
  paint(img, null, sdRoundRect(140, 246, 16, 4, 2), flat([30, 30, 34])); // a port
  paint(img, t, sdCapsule(140, 250, 140, 286, 4), flat([40, 40, 44])); // a thin cable stub
}, { bg: [204, 196, 182] });

/** A white product on a near-white ground: the edge is barely there. A plain-ground segmenter must not claim a clean cut-out. */
export const lowContrast = () => fixture(280, 300, (img, t) => {
  paint(img, t, sdRoundRect(140, 150, 70, 100, 16), flat([236, 238, 240]));
}, { bg: [226, 222, 216] });

/** A mirror-finish bottle: bright reflections reach the ground colour (the hard case for a ground-colour segmenter). */
export const metallic = () => fixture(260, 440, (img, t) => {
  paint(img, t, sdRoundRect(130, 240, 56, 170, 22), hbands(74, 186, [[40, 42, 48], [250, 250, 248], [200, 204, 210], [252, 252, 250], [36, 38, 44]]));
  paint(img, t, sdRoundRect(130, 62, 28, 18, 6), hbands(102, 158, [[50, 52, 58], [244, 244, 242], [44, 46, 52]]));
}, { bg: [96, 142, 176] });

/** The same bottle photographed on a LIGHT ground: its mirror highlights are the ground colour, so a plain-ground segmenter must not pretend (the test expects a fail-closed result). */
export const metallicOnLightGround = () => fixture(260, 440, (img, t) => {
  paint(img, t, sdRoundRect(130, 240, 56, 170, 22), hbands(74, 186, [[60, 62, 68], [228, 226, 222], [140, 144, 150], [226, 224, 220], [48, 50, 56]]));
}, { bg: [226, 224, 220] });

/** Three objects in one photograph: two apart, one touching the second. */
export const multiObject = () => fixture(560, 360, (img, t) => {
  paint(img, t, sdRoundRect(90, 180, 50, 110, 14), flat(NAVY));
  paint(img, t, sdRoundRect(290, 200, 60, 70, 10), flat(RED));
  paint(img, t, sdEllipse(398, 215, 48, 48), flat([46, 120, 88])); // touches the red box at a short contact
});

/** A product with a hand holding it (must not become part of the product when only the product is selected). */
export const handHoldingProduct = () => fixture(360, 420, (img, t) => {
  paint(img, t, sdRoundRect(180, 170, 70, 120, 14), flat(NAVY));
  paint(img, null, sdCapsule(180, 330, 180, 420, 36), flat([226, 178, 150])); // a wrist and hand, partly
  paint(img, null, sdEllipse(180, 300, 62, 40), flat([226, 178, 150]));
});

export const clutteredGround = () => {
  const rgba = blank(300, 300); const rnd = lcg(3);
  for (let i = 0; i < 300 * 300; i += 1) { const v = Math.round(rnd() * 255); rgba.pixels[i * 4] = v; rgba.pixels[i * 4 + 1] = (v * 3) & 255; rgba.pixels[i * 4 + 2] = (v * 7) & 255; }
  return { rgba, truth: { alpha: new Uint8Array(300 * 300) } };
};

export const ALL = { phoneCase, tumbler, magnet, framedPrint, giftBox, smallTech, metallic };

/** The scene (a plate) the product is integrated into: a table in the lower half, a wall above, with a slight vertical gradient. */
export function plate(width = 900, height = 700, { horizon = 360 } = {}) {
  const img = blank(width, height, [210, 204, 196], { noise: 1 });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4; const wall = y < horizon;
      const base = wall ? [226 - y * 0.03, 222 - y * 0.03, 216 - y * 0.03] : [176 + (y - horizon) * 0.04, 150 + (y - horizon) * 0.03, 122 + (y - horizon) * 0.02];
      for (let k = 0; k < 3; k += 1) img.pixels[i + k] = Math.round(base[k] + (img.pixels[i + k] - 210));
    }
  }
  return img;
}

/** The cut-out of a fixture as the layered pipeline would carry it: RGBA = source pixels inside the matte, alpha = the matte. */
export function cutoutOf(rgba, alpha, bounds) {
  const w = bounds.x1 - bounds.x0 + 1; const h = bounds.y1 - bounds.y0 + 1; const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const si = (bounds.y0 + y) * rgba.width + bounds.x0 + x; const q = (y * w + x) * 4;
      pixels[q] = rgba.pixels[si * 4]; pixels[q + 1] = rgba.pixels[si * 4 + 1]; pixels[q + 2] = rgba.pixels[si * 4 + 2]; pixels[q + 3] = alpha[si];
    }
  }
  return { width: w, height: h, pixels };
}
