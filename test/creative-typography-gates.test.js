// Typography and output gates of the deterministic compositor (scripts/creative-autonomy/compose_stage.py), measured on what is actually drawn:
// accents, glyphs the font cannot draw, an over-long word, info contrast and width, rounded product contours kept pixel-exact, output resolution.
// These gates prove legibility and integrity, NOT taste: passing them says nothing about premium quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PY = process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const ready = (() => { try { execFileSync(PY, ['-c', 'import numpy, PIL, scipy'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const OPT = { skip: !ready && `needs Python with numpy, Pillow and scipy (NORDLA_PYTHON=${PY})`, timeout: 180_000 };

let world = null;
function setup() {
  if (world) return world;
  const w = mkdtempSync(join(tmpdir(), 'typo-gates-'));
  execFileSync(PY, [join(ROOT, 'test/helpers/scene_fixtures.py'), 'photo', join(w, 'photo.jpg')]); // a bottle with rounded lid and body
  mkdirSync(join(w, 'ex')); execFileSync(PY, [join(ROOT, 'scripts/creative-autonomy/examine_product.py'), join(w, 'photo.jpg'), join(w, 'ex')]);
  world = w; return w;
}
/** One composition on a scene of the given size/colours; returns the compositor's report and the output path. */
function compose({ headline = 'Le noir, sans détour', merchant = 'Boutique test, Namur', title = 'TEST — Gourde démo 500 ml', W = 1080, H = 1350, top = [40, 42, 48], bottom = null, tag }) {
  const w = setup(); const dir = mkdtempSync(join(w, `${tag}-`));
  const py = `from PIL import Image\nim = Image.new('RGB', (${W}, ${H}), ${JSON.stringify(top).replace('[', '(').replace(']', ')')})\n${bottom ? `im.paste(${JSON.stringify(bottom).replace('[', '(').replace(']', ')')}, (0, ${Math.round(H * 0.72)}, ${W}, ${H}))\n` : ''}im.save('${join(dir, 'decor.png')}')`;
  execFileSync(PY, ['-c', py]);
  const bx = Math.round(W * 0.3); const by = Math.round(H * 0.86); const ty = Math.round(H * 0.36);
  writeFileSync(join(dir, 'decor.png.json'), JSON.stringify({ bottom_front: [bx, by], top_front: [bx, ty], foreground_mask: null, slit_y: null, render_backend: 'SCENE_AROUND_PRODUCT', contact_shadow: false, product_level: 1.0,
    blender_capabilities_used: [], resolution: [W, H], foreground_props: 0, product_photo_untouched: true }));
  writeFileSync(join(dir, 'stage.json'), JSON.stringify({ backdrop: 'WALL_AND_FLOOR', backdrop_tone: 'CHARCOAL', floor_finish: 'MATTE', key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'COOL', purpose: 'p' },
    accent_lights: [], camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' }, props: [], headline, text_placement: 'RIGHT_COLUMN', show_price: 'YES', rationale: 'r' }));
  writeFileSync(join(dir, 'faits.json'), JSON.stringify({ product_title: title, variant: 'Noir', price: '19,90 €', merchant, personalisation_offered: false }));
  const out = join(dir, 'out.png');
  const r = JSON.parse(execFileSync(PY, [join(ROOT, 'scripts/creative-autonomy/compose_stage.py'), join(dir, 'stage.json'), join(dir, 'decor.png'), join(w, 'ex', 'produit_rgba.png'), join(w, 'ex', 'examen.json'), join(dir, 'faits.json'), out]).toString().trim().split('\n').pop());
  return { r, out };
}
const pngSize = (p) => { const b = readFileSync(p); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('baseline: clean composition at the exact output resolution; the rounded contours of the real product are kept pixel-exact', OPT, () => {
  const { r, out } = compose({ tag: 'base' });
  assert.deepEqual(r.technical.defects, []); assert.deepEqual(r.technical.resolution, [1080, 1350]); assert.deepEqual(pngSize(out), [1080, 1350]);
  assert.ok(r.fidelity.checked_pixels >= r.fidelity.minimum_checked_pixels, 'fidelity measured on enough product pixels (anti-aliased rounded edges included in the cut-out)');
  assert.ok(r.fidelity.max_visible_level_difference <= 2, `product pixels differ by ${r.fidelity.max_visible_level_difference}`);
  assert.ok(r.technical.typography.info_contrast_ratio_worst_tenth >= 4.5);
});

test('accents and Latin special characters render (no missing glyph): French, Dutch, Polish, German', OPT, () => {
  const { r } = compose({ tag: 'accents', headline: 'Été à Liège : œuvre, ça', merchant: 'Atelier Ödön & Łucja, Gent', title: 'Coffret Noël — Ærø' });
  assert.deepEqual(r.technical.typography.glyphs_missing, []); assert.ok(!r.technical.defects.includes('TEXT_GLYPHS_MISSING_IN_FONT'));
});

test('a character the font cannot draw is a defect, never a silent empty box', OPT, () => {
  const { r } = compose({ tag: 'cjk', headline: '漢字の夜' });
  assert.ok(r.technical.defects.includes('TEXT_GLYPHS_MISSING_IN_FONT')); assert.ok(r.technical.typography.glyphs_missing.includes('漢'));
});

test('a word longer than the text column at the smallest size is a defect (not clipped silently)', OPT, () => {
  const { r } = compose({ tag: 'long', headline: 'Anticonstitutionnellementissimement' });
  assert.ok(r.technical.defects.includes('HEADLINE_WORD_OVERFLOWS_COLUMN'), JSON.stringify(r.technical));
});

test('info lines: contrast measured on THEIR background (a light floor under dark-scene ink is caught), width bounded', OPT, () => {
  const low = compose({ tag: 'lowinfo', top: [30, 32, 36], bottom: [235, 235, 232] });
  assert.ok(low.r.technical.defects.includes('LOW_INFO_TEXT_CONTRAST'), JSON.stringify(low.r.technical));
  const wide = compose({ tag: 'wide', merchant: 'Une boutique au nom extraordinairement long qui ne tiendra jamais dans la largeur utile, Namur, Belgique' });
  assert.ok(wide.r.technical.defects.includes('INFO_LINE_TOO_WIDE') || wide.r.technical.defects.includes('INFO_TEXT_OUTSIDE_MARGINS'), JSON.stringify(wide.r.technical));
});

test('another format: the output keeps the scene\'s exact resolution (square 1080x1080)', OPT, () => {
  const { r, out } = compose({ tag: 'square', W: 1080, H: 1080 });
  assert.deepEqual(r.technical.resolution, [1080, 1080]); assert.deepEqual(pngSize(out), [1080, 1080]);
});
