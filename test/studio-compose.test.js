import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeCreative, cropToInk, encodeJpeg, loadFonts, productPost, storyPromo, knowHowTriptych, HABB_PALETTE } from '../src/studio-compose/index.js';
import { encodePng } from '../src/creative-intelligence/png-encode.js';
import { readImageInfo } from '../src/asset-library/index.js';

// Synthetic images only (the repository is public): a tall "product" with a visible pattern and a plain wordmark-like plate.
const FONTS = loadFonts(new URL('../resources/fonts/habb-benchmark', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
function tall(w, h, seed = 1) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; px[o] = (x * 3 + seed * 40) & 255; px[o + 1] = (y * 2) & 255; px[o + 2] = ((x + y) * seed) & 255; px[o + 3] = 255; }
  return encodePng({ width: w, height: h, pixels: px });
}
function plate(w, h, bg, ink) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; const on = x > w * 0.3 && x < w * 0.6 && y > h * 0.3 && y < h * 0.6; px.set(on ? ink : bg, o); }
  return encodePng({ width: w, height: h, pixels: px });
}
const images = () => new Map([
  ['p1', tall(200, 400, 1)], ['p2', tall(210, 420, 2)], ['p3', tall(190, 400, 3)],
  ['wm_d', plate(480, 120, [24, 50, 71, 255], [255, 255, 255, 255])], ['wm_a', plate(480, 120, [255, 255, 255, 255], [15, 42, 82, 255])],
]);
const post = () => productPost({ id: 'T1', productKey: 'p1', wordmarkKey: 'wm_d', copy: { headline: ['Ta photo,', 'ta coque.'], price: ['25 €'], note: ['Prête en environ', '5 minutes, selon le', 'modèle et la', 'disponibilité.'], example: ['Exemple de rendu.'], cta: ['Viens en boutique', 'à Namur.'], address: ['RUE DE BRUXELLES 18', '5000 NAMUR'] } });
const compose = (spec, imgs = images()) => composeCreative({ spec, images: imgs, fonts: FONTS, palette: HABB_PALETTE });
const failed = (r) => r.record.checks.filter((c) => c.outcome === 'FAIL').map((c) => c.id);

test('SC-1 JPEG encoder: valid headers, deterministic, size read back, decodes close to the source when Pillow is available', () => {
  const w = 40; const h = 24; const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([i % 256, (i * 7) % 256, 90, 255], i * 4);
  const a = encodeJpeg({ width: w, height: h, pixels: px }, { quality: 90 });
  const b = encodeJpeg({ width: w, height: h, pixels: px }, { quality: 90 });
  assert.deepEqual(a, b);
  assert.deepEqual([a[0], a[1], a.at(-2), a.at(-1)], [0xff, 0xd8, 0xff, 0xd9]);
  assert.deepEqual(readImageInfo(a), { media_type: 'image/jpeg', width_px: w, height_px: h, has_alpha: false });
  assert.throws(() => encodeJpeg({ width: 0, height: 1, pixels: new Uint8Array(0) }), RangeError);
  assert.throws(() => encodeJpeg({ width: 2, height: 2, pixels: new Uint8Array(3) }), TypeError);
  const dir = mkdtempSync(join(tmpdir(), 'jpg-'));
  writeFileSync(join(dir, 'a.jpg'), a);
  const py = spawnSync('python3', ['-c', `import sys\ntry:\n  from PIL import Image\nexcept Exception:\n  print('NOPIL'); sys.exit(0)\nim=Image.open(sys.argv[1]); print(im.format, im.size)`, join(dir, 'a.jpg')], { encoding: 'utf8' });
  if (py.status === 0 && !/NOPIL/.test(py.stdout)) assert.match(py.stdout, /JPEG \(40, 24\)/);
});

test('SC-2 product post: every hard check passes, the product is placed whole and its pixels are untouched', () => {
  const r = compose(post());
  assert.equal(r.record.deliverable, true, JSON.stringify(failed(r)));
  const px = r.record.checks.find((c) => c.id === 'PRODUCT_PIXELS_UNCHANGED').detail.products;
  assert.ok(px.every((p) => p.pixels_compared > 0 && p.max_channel_difference <= 2));
  const product = r.record.products.find((p) => p.layer === 'product');
  assert.ok(Math.abs(product.placed.width / product.placed.height - 200 / 400) < 0.005);
  assert.equal(readImageInfo(r.jpeg).width_px, 1080);
  assert.equal(readImageInfo(r.jpeg).height_px, 1350);
});

test('SC-3 deterministic: same spec and images give the same bytes and hash', () => {
  const a = compose(post()); const b = compose(post());
  assert.equal(a.png_sha256, b.png_sha256);
  assert.equal(a.jpeg_sha256, b.jpeg_sha256);
  assert.equal(a.record.spec_hash, b.record.spec_hash);
});

test('SC-4 the three HABB templates compose at their formats with all checks passing', () => {
  const s = storyPromo({ id: 'T2', productKey: 'p2', wordmarkKey: 'wm_a', copy: { headline: ['Prête en environ', '5 minutes.'], product_line: ['Coque personnalisée · 25 €'], caveat: ['Exemple de rendu. Selon le modèle', 'et la disponibilité.'], cta: ['Viens en boutique à Namur.'] } });
  const t = knowHowTriptych({ id: 'T3', productKeys: ['p1', 'p2', 'p3'], wordmarkKey: 'wm_a', copy: { headline: ['Un prénom, un animal,', 'un paysage.'], labels: ['Un prénom', 'Un animal', 'Un paysage'], closing: ['Trois façons de faire sa coque,', 'créées en boutique à Namur.'] } });
  for (const [spec, w, h] of [[s, 1080, 1920], [t, 1080, 1350]]) {
    const r = compose(spec);
    assert.equal(r.record.deliverable, true, JSON.stringify(failed(r)));
    assert.deepEqual([r.record.width, r.record.height], [w, h]);
  }
});

test('SC-5 copy is locked: a text that is not in locked_copy, or a locked text that is not shown, blocks delivery', () => {
  const spec = post();
  spec.locked_copy = spec.locked_copy.filter((t) => t !== 'Exemple de rendu.');
  assert.ok(failed(compose(spec)).includes('COPY_EXACT'));
  const spec2 = post(); spec2.locked_copy.push('Un texte jamais affiché');
  assert.ok(failed(compose(spec2)).includes('COPY_EXACT'));
});

test('SC-6 a text over the product, a distorted box, a third font, an off-palette colour and text outside the safe zone are all refused', () => {
  const over = post(); over.layers.find((l) => l.id === 'headline').x = 640; over.layers.find((l) => l.id === 'headline').y = 600;
  assert.ok(failed(compose(over)).includes('PRODUCT_NOT_OVERLAPPED'));
  const font = post(); font.layers.find((l) => l.id === 'headline').family = 'Comic Sans';
  assert.throws(() => compose(font), /not an approved HABB font/);
  const color = post(); color.layers.find((l) => l.id === 'panel').fill = '#d4af37';
  assert.ok(failed(compose(color)).includes('PALETTE_ONLY'));
  const zone = post(); zone.layers.find((l) => l.id === 'address').y = 1330;
  assert.ok(failed(compose(zone)).includes('TEXT_IN_SAFE_ZONE'));
  const low = post(); low.layers.find((l) => l.id === 'note').fill = '#183247';
  assert.ok(failed(compose(low)).includes('TEXT_CONTRAST'));
  const small = post(); small.layers.find((l) => l.id === 'note').size = 22;
  assert.ok(failed(compose(small)).includes('TEXT_LEGIBLE_SIZE'));
  const strad = post(); strad.layers.find((l) => l.id === 'note').x = 400;
  assert.ok(failed(compose(strad)).includes('TEXT_NOT_STRADDLING_SURFACES'));
});

test('SC-7 the placement follows the declared box and the aspect ratio stays that of the source', () => {
  const a = compose(post()); const spec = post(); spec.layers.find((l) => l.id === 'product').box = { x: 630, y: 120, width: 300, height: 1110 };
  const b = compose(spec);
  assert.notEqual(a.png_sha256, b.png_sha256);
  assert.ok(b.record.products.find((p) => p.layer === 'product').placed.width < a.record.products.find((p) => p.layer === 'product').placed.width);
});

test('SC-8 cropToInk is lossless and refuses an empty image', () => {
  const src = plate(480, 120, [255, 255, 255, 0], [15, 42, 82, 255]);
  const out = cropToInk(src);
  const info = readImageInfo(out);
  assert.ok(info.width_px < 480 && info.height_px < 120);
  assert.throws(() => cropToInk(encodePng({ width: 4, height: 4, pixels: new Uint8Array(64) })), /nothing to crop/);
});

test('SC-9 changing one text layer leaves the product region byte-identical (an element can change without rebuilding the rest)', async () => {
  const { decodePng } = await import('../src/creative-intelligence/png-pixels.js');
  const a = compose(post());
  const spec = post(); spec.layers.find((l) => l.id === 'cta').lines = ['Passe nous voir', 'à Namur.'];
  spec.locked_copy = spec.layers.filter((l) => l.type === 'text').map((l) => l.lines.join(' '));
  const b = compose(spec);
  assert.notEqual(a.png_sha256, b.png_sha256);
  const pa = decodePng(a.png); const pb = decodePng(b.png);
  const box = a.record.products.find((p) => p.layer === 'product').placed;
  for (let y = box.y; y < box.y + box.height; y += 7) {
    for (let x = box.x; x < box.x + box.width; x += 5) {
      const o = (y * pa.width + x) * 4;
      assert.deepEqual([...pa.pixels.subarray(o, o + 4)], [...pb.pixels.subarray(o, o + 4)]);
    }
  }
});

test('SC-10 capability matrix: everything that needs a provider is named, none is claimed available, nothing publishes', async () => {
  const { CAPABILITIES, capabilitySummary } = await import('../src/studio-compose/index.js');
  const s = capabilitySummary();
  assert.ok(s.PROVIDER_REQUIRED.includes('SCENE_OR_BACKGROUND_GENERATION'));
  assert.ok(s.NOT_IMPLEMENTED.includes('AUTOMATIC_PUBLICATION'));
  assert.ok(!s.AVAILABLE_NOW.some((id) => /GENERATION|CRITIC|PUBLICATION|VIDEO/.test(id)));
  assert.equal(new Set(CAPABILITIES.map((c) => c.id)).size, CAPABILITIES.length);
});
