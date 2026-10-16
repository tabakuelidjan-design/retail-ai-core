// Deterministic composition of a HABB creative from a declarative spec: rectangles, locked text, and real product images placed WITHOUT cropping or distortion.
// No model, no provider, no network. The composition is measured after it is drawn: copy exactness, product aspect ratio, product pixels, overlap, safe zone, contrast, palette, fonts.
// A failed hard check means the creative is not returned as deliverable (`deliverable: false`); nothing is "fixed" silently.

import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import { encodePng } from '../creative-intelligence/png-encode.js';
import { decodePng } from '../creative-intelligence/png-pixels.js';
import { resizePng } from '../creative-production/raster-ops.js';
import { encodeJpeg } from './jpeg.js';

export const FONT_FAMILIES = Object.freeze(['Playfair Display', 'Montserrat']);
const nbsp = (s) => s.replace(/ | /g, ' ');
const hex = (c) => { const m = /^#([0-9a-f]{6})$/i.exec(c); if (!m) throw new TypeError(`color ${c} must be #rrggbb`); return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)); };
const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (c) => { const [r, g, b] = hex(c).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrastRatio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
const sha = (b) => createHash('sha256').update(b).digest('hex');

export function loadFonts(dir) {
  return ['PlayfairDisplay[wght].ttf', 'Montserrat[wght].ttf'].map((f) => `${dir.replace(/\\/g, '/').replace(/\/$/, '')}/${f}`);
}

const textSvg = (l) => l.lines.map((t, i) => {
  const mont = l.family === 'Montserrat';
  return `<text x="${l.x}" y="${l.y + i * l.lineHeight}" font-family="${l.family}" font-weight="${l.weight ?? 400}" font-size="${l.size}" fill="${l.fill}" stroke="${l.fill}" stroke-width="${l.stroke ?? (mont ? ((l.weight ?? 400) >= 600 ? 1.8 : 0.9) : 0)}" text-anchor="${l.anchor ?? 'start'}" letter-spacing="${l.spacing ?? 0}">${esc(t)}</text>`;
}).join('');

const render = (svg, fontFiles, width) => new Resvg(svg, { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Montserrat' }, fitTo: { mode: 'width', value: width } }).render();

function inkBox(pixels, width, height, bg, tol = 24) {
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      if (Math.abs(pixels[p] - bg[0]) + Math.abs(pixels[p + 1] - bg[1]) + Math.abs(pixels[p + 2] - bg[2]) > tol) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
/** Lossless crop of a PNG to its visible content: alpha > 0 when it has transparency, else the pixels that differ from the corner colour. No resampling. */
export function cropToInk(png) {
  const { width, height, pixels } = decodePng(png);
  const hasAlpha = pixels.some((v, i) => i % 4 === 3 && v < 255);
  const corner = [pixels[0], pixels[1], pixels[2]];
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const ink = hasAlpha ? pixels[p + 3] > 0 : Math.abs(pixels[p] - corner[0]) + Math.abs(pixels[p + 1] - corner[1]) + Math.abs(pixels[p + 2] - corner[2]) > 24;
      if (ink) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) throw new Error('nothing to crop to');
  const w = x1 - x0 + 1; const h = y1 - y0 + 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) out.set(pixels.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4), y * w * 4);
  return encodePng({ width: w, height: h, pixels: out });
}

const overlap = (a, b, gap = 0) => a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
const SLACK = 2; // ink may overhang its anchor by a pixel or two (serif T, stroke)
const inside = (b, c, s) => b.x >= s.left - SLACK && b.y >= s.top - SLACK && b.x + b.width <= c.width - s.right + SLACK && b.y + b.height <= c.height - s.bottom + SLACK;

/**
 * @param {object} p
 * @param {object} p.spec { id, canvas:{width,height,background}, safe:{top,right,bottom,left}, locked_copy:[string], layers:[...] }
 * @param {Map<string, Uint8Array>} p.images PNG bytes by key
 * @param {string[]} p.fontFiles
 * @param {string[]} p.palette allowed #rrggbb colors
 * @param {{ jpegQuality?: number }} [p.options]
 */
export function composeCreative({ spec, images, fontFiles, palette, options = {} }) {
  const { canvas, safe, layers } = spec;
  const checks = [];
  const add = (id, ok, detail, hard = true) => checks.push({ id, outcome: ok ? 'PASS' : (hard ? 'FAIL' : 'WARN'), detail });
  const bg = hex(canvas.background);
  const used = new Set([canvas.background.toLowerCase()]);
  const body = [`<rect width="${canvas.width}" height="${canvas.height}" fill="${canvas.background}"/>`];
  const placed = []; // product boxes with expected pixels
  const textBoxes = [];
  const surfaces = []; // rects, in drawing order

  for (const l of layers) {
    if (l.type === 'rect') {
      body.push(`<rect x="${l.x}" y="${l.y}" width="${l.width}" height="${l.height}" fill="${l.fill}"/>`);
      used.add(l.fill.toLowerCase());
      surfaces.push(l);
    } else if (l.type === 'image') {
      let src = images.get(l.key);
      if (!src) throw new Error(`image ${l.key} is not supplied`);
      if (l.crop === 'ink') src = cropToInk(src);
      const dims = decodePng(src);
      const ratio = dims.width / dims.height;
      let w = l.box.width; let h = Math.round(w / ratio);
      if (h > l.box.height) { h = l.box.height; w = Math.round(h * ratio); }
      w = Math.round(w); h = Math.round(h);
      const x = Math.round(l.box.x + (l.box.width - w) / 2); const y = Math.round(l.box.y + (l.box.height - h) / 2);
      const resized = resizePng({ png: src, width: w, height: h });
      const uri = `data:image/png;base64,${Buffer.from(resized.png).toString('base64')}`;
      body.push(`<image x="${x}" y="${y}" width="${w}" height="${h}" href="${uri}"/>`);
      const surface = [...surfaces].reverse().find((r) => x >= r.x && y >= r.y && x + w <= r.x + r.width && y + h <= r.y + r.height);
      placed.push({ layer: l, x, y, width: w, height: h, source: dims, resizedPixels: decodePng(resized.png).pixels, surface: surface?.fill ?? canvas.background, source_sha256: sha(src) });
    } else if (l.type === 'text') {
      body.push(textSvg(l));
      used.add(l.fill.toLowerCase());
    } else throw new Error(`unknown layer type ${l.type}`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">${body.join('')}</svg>`;
  const composite = render(svg, fontFiles, canvas.width);
  const pixels = new Uint8Array(composite.pixels);

  // -- copy: every text layer is a locked string, every locked string is shown exactly once ---------------------------------------
  const locked = spec.locked_copy.map(nbsp);
  const shown = layers.filter((l) => l.type === 'text').map((l) => nbsp(l.lines.join(' ')));
  const unknown = shown.filter((t) => !locked.includes(t));
  const missing = locked.filter((t) => !shown.includes(t));
  add('COPY_EXACT', unknown.length === 0 && missing.length === 0, { unknown, missing });

  // -- fonts / palette -----------------------------------------------------------------------------------------------------------
  const families = new Set(layers.filter((l) => l.type === 'text').map((l) => l.family));
  add('FONTS_ALLOWED', [...families].every((f) => FONT_FAMILIES.includes(f)), { families: [...families] });
  const allowed = new Set(palette.map((c) => c.toLowerCase()));
  add('PALETTE_ONLY', [...used].every((c) => allowed.has(c)), { outside: [...used].filter((c) => !allowed.has(c)) });

  // -- true ink boxes of each text layer (drawn alone on its own background) -----------------------------------------------------
  for (const l of layers.filter((x) => x.type === 'text')) {
    const solo = render(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}"><rect width="${canvas.width}" height="${canvas.height}" fill="#ffffff"/>${textSvg({ ...l, fill: '#000000' })}</svg>`, fontFiles, canvas.width);
    const box = inkBox(new Uint8Array(solo.pixels), solo.width, solo.height, [255, 255, 255]);
    textBoxes.push({ id: l.id, box, layer: l });
  }
  add('TEXT_PRESENT', textBoxes.every((t) => t.box), { empty: textBoxes.filter((t) => !t.box).map((t) => t.id) });
  const outOfZone = textBoxes.filter((t) => t.box && !inside(t.box, canvas, safe)).map((t) => t.id);
  add('TEXT_IN_SAFE_ZONE', outOfZone.length === 0, { outside: outOfZone, safe });
  const weak = [];
  for (const t of textBoxes.filter((x) => x.box)) {
    const cx = t.box.x + t.box.width / 2; const cy = t.box.y + t.box.height / 2;
    const surface = [...surfaces].reverse().find((r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height)?.fill ?? canvas.background;
    const need = t.layer.size >= 48 ? 3 : 4.5;
    const got = contrastRatio(t.layer.fill, surface);
    if (got < need) weak.push({ id: t.id, contrast: Math.round(got * 100) / 100, need });
  }
  add('TEXT_CONTRAST', weak.length === 0, { weak });
  const straddle = [];
  for (const t of textBoxes.filter((x) => x.box)) {
    for (const r of surfaces) {
      const rb = { x: r.x, y: r.y, width: r.width, height: r.height };
      const touches = overlap(t.box, rb, 0);
      const within = t.box.x >= rb.x && t.box.y >= rb.y && t.box.x + t.box.width <= rb.x + rb.width && t.box.y + t.box.height <= rb.y + rb.height;
      if (touches && !within && r.id !== 'rule') straddle.push({ text: t.id, surface: r.id });
    }
  }
  add('TEXT_NOT_STRADDLING_SURFACES', straddle.length === 0, straddle);
  const tiny = layers.filter((l) => l.type === 'text' && l.size < (spec.min_text_px ?? 30)).map((l) => l.id);
  add('TEXT_LEGIBLE_SIZE', tiny.length === 0, { below_min: tiny, min_px: spec.min_text_px ?? 30 });

  // -- the product: aspect ratio, no overlap, pixels untouched -------------------------------------------------------------------
  const productChecks = { aspect: [], overlap: [], pixels: [] };
  for (const p of placed) {
    const err = Math.abs(p.width / p.height - p.source.width / p.source.height) / (p.source.width / p.source.height);
    if (err > Math.max(0.004, 0.5 / p.width + 0.5 / p.height)) productChecks.aspect.push({ layer: p.layer.id, error: err });
    const box = { x: p.x, y: p.y, width: p.width, height: p.height };
    for (const t of textBoxes) if (t.box && overlap(box, t.box, 0)) productChecks.overlap.push({ layer: p.layer.id, with: t.id });
    for (const q of placed) if (q !== p && overlap(box, { x: q.x, y: q.y, width: q.width, height: q.height }, 0)) productChecks.overlap.push({ layer: p.layer.id, with: q.layer.id });
    const s = hex(p.surface);
    let worst = 0; let counted = 0;
    for (let y = 0; y < p.height; y += 1) {
      for (let x = 0; x < p.width; x += 1) {
        const o = ((p.y + y) * canvas.width + p.x + x) * 4; const r = (y * p.width + x) * 4; const a = p.resizedPixels[r + 3] / 255;
        for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(pixels[o + c] - Math.round(p.resizedPixels[r + c] * a + s[c] * (1 - a))));
        counted += 1;
      }
    }
    if (worst > 2) productChecks.pixels.push({ layer: p.layer.id, max_channel_difference: worst });
    p.measure = { counted, worst };
  }
  add('PRODUCT_ASPECT_PRESERVED', productChecks.aspect.length === 0, productChecks.aspect);
  add('PRODUCT_NOT_OVERLAPPED', productChecks.overlap.length === 0, productChecks.overlap);
  add('PRODUCT_PIXELS_UNCHANGED', productChecks.pixels.length === 0, { products: placed.map((p) => ({ layer: p.layer.id, pixels_compared: p.measure.counted, max_channel_difference: p.measure.worst })) });
  const inZone = placed.filter((p) => !inside({ x: p.x, y: p.y, width: p.width, height: p.height }, canvas, { top: 0, right: 0, bottom: 0, left: 0 })).map((p) => p.layer.id);
  add('PRODUCT_INSIDE_CANVAS', inZone.length === 0, { outside: inZone });

  const png = encodePng({ width: composite.width, height: composite.height, pixels });
  const jpeg = encodeJpeg({ width: composite.width, height: composite.height, pixels }, { quality: options.jpegQuality ?? 92 });
  const record = {
    spec_id: spec.id,
    width: composite.width,
    height: composite.height,
    spec_hash: sha(canonical({ spec, images: [...images.entries()].map(([k, v]) => [k, sha(v)]).sort() })),
    products: placed.map((p) => ({ layer: p.layer.id, source_sha256: p.source_sha256, source_size: { width: p.source.width, height: p.source.height }, placed: { x: p.x, y: p.y, width: p.width, height: p.height } })),
    checks,
    deliverable: checks.every((c) => c.outcome !== 'FAIL'),
  };
  return { png, jpeg, png_sha256: sha(png), jpeg_sha256: sha(jpeg), record };
}
