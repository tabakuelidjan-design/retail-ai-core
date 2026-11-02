"""Nordla Création — compositeur (local, 0 €). Pose la VRAIE photo du produit dans le plateau rendu, ajoute des couches
de lumière séparées et bornées (niveau de la scène, contour, nappe), remet les accessoires de premier plan devant le
produit, place le texte selon le STAGE, puis MESURE :
  - fidélité : après retrait des couches, les pixels opaques du produit = photo mise à l'échelle (écart en niveaux) ;
  - qualité technique : texte sur le produit, contraste du texte, marges, part du produit dans l'image.
Usage : python compose_stage.py <stage.json> <rendu.png> <produit_rgba.png> <examen.json> <faits.json> <sortie.jpg>
"""
import glob, json, os, sys
from functools import lru_cache
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

stage = json.load(open(sys.argv[1])); SET = sys.argv[2]; PROD = sys.argv[3]; exam = json.load(open(sys.argv[4])); facts = json.load(open(sys.argv[5])); OUT = sys.argv[6]
info = json.load(open(SET + '.json'))
bg = Image.open(SET).convert('RGB'); W, H = bg.size
beauty = np.asarray(bg).astype(np.float32) / 255

bb = exam['bbox']
prod = Image.open(PROD).crop((bb['x'], bb['y'], bb['x'] + bb['w'], bb['y'] + bb['h']))
pw, ph = prod.size
bx, by = info['bottom_front']; tx, ty = info['top_front']
s = (by - ty) / ph; tw, th = max(1, round(pw * s)), max(1, round(ph * s))
arr = np.asarray(prod).astype(np.float32) / 255
prem = np.dstack([arr[..., :3] * arr[..., 3:4], arr[..., 3:4]])
pr = np.asarray(Image.fromarray((prem * 255).round().astype(np.uint8), 'RGBA').resize((tw, th), Image.LANCZOS)).astype(np.float32) / 255
x0 = round(bx - tw / 2); y0 = round(by - th)
a = np.clip(pr[..., 3:4], 0, 1); src_c = pr[..., :3]

# couches de lumière (séparées, bornées)
dark = stage['backdrop_tone'] in ('DEEP_BLACK', 'CHARCOAL', 'BRAND_NAVY')
key = stage['key_light']['intensity']
# scène générée autour du produit : le niveau est MESURÉ sur le produit redessiné par le modèle (scene_check.py), pas déduit du STAGE ;
# pas de liseré ajouté, la lumière de la scène est celle du modèle
scene_mode = info.get('render_backend') == 'SCENE_AROUND_PRODUCT'
scene_factor = 1.0 if scene_mode else (float(info['product_level']) if info.get('product_level') is not None else ({'LOW': 0.5, 'MEDIUM': 0.65, 'HIGH': 0.8}[key] if dark else 1.0))
L = (scene_factor - 1.0) * src_c
kinds = [] if scene_mode else [l['kind'] for l in [stage['key_light'], *stage['accent_lights']]]
xn = np.linspace(-1, 1, tw)[None, :]
if 'RIM' in kinds:
    edge = np.clip(1 - (1 - np.abs(xn)) / 0.14, 0, 1) ** 1.5
    L = L + (22 / 255) * edge[..., None] * np.ones((th, 1, 1)) * a
if info.get('slit_y') is not None:
    ys = np.arange(th)[:, None] + y0 + 0.5
    v = np.exp(-0.5 * ((ys - info['slit_y']) / (H * 0.0048)) ** 2)
    L = L + (90 / 255) * (v * np.sqrt(np.clip(1 - xn ** 2, 0, 1)) ** 0.7)[..., None] * a

base = beauty.copy()
yy_, xx_ = np.mgrid[0:H, 0:W].astype(np.float32)
ell = ((xx_ - bx) / (tw * 0.62)) ** 2 + ((yy_ - by) / (th * 0.018)) ** 2
if info.get('contact_shadow', True):  # l'ombre synthétique n'est posée que si la scène n'a pas la sienne
    base *= (1 - np.exp(-ell * 2.2) * 0.8)[..., None]
cx0, cy0 = max(x0, 0), max(y0, 0); cx1, cy1 = min(x0 + tw, W), min(y0 + th, H)
sl = (slice(cy0 - y0, cy1 - y0), slice(cx0 - x0, cx1 - x0))
region = base[cy0:cy1, cx0:cx1]
base[cy0:cy1, cx0:cx1] = src_c[sl] + L[sl] + region * (1 - a[sl])
# accessoires de premier plan : devant le produit
if info.get('foreground_mask'):
    fm = np.asarray(Image.open(info['foreground_mask']).convert('RGBA')).astype(np.float32)[..., 3:4] / 255
    base = base * (1 - fm) + beauty * fm
out = Image.fromarray((np.clip(base, 0, 1) * 255).round().astype(np.uint8))

# preuve de fidélité
opaque = a[..., 0] >= 0.999
fin = np.asarray(out).astype(np.float32)[cy0:cy1, cx0:cx1] / 255
back = np.round((fin - L[sl]) * 255).astype(np.int16); ref = np.round(src_c[sl] * 255).astype(np.int16)
clip = ((src_c[sl] + L[sl]) > 1).any(2) | ((src_c[sl] + L[sl]) < 0).any(2)
occluded = np.zeros(opaque[sl].shape, bool)
if info.get('foreground_mask'): occluded = fm[cy0:cy1, cx0:cx1, 0] > 0.02
ok = opaque[sl] & ~clip & ~occluded
checked_pixels = int(ok.sum())
minimum_checked_pixels = max(100, min(1000, int(np.ceil(0.02 * int(opaque[sl].sum())))))
diff = np.abs(back - ref)[ok] if checked_pixels else np.array([], dtype=np.int16)
visible_diff = np.abs(np.round(fin * 255).astype(np.int16) - ref)[ok] if checked_pixels else np.array([], dtype=np.int16)

# texte : position décidée par le STAGE, taille ajustée à la colonne, couleur choisie par contraste mesuré
@lru_cache(maxsize=64)
def font(name, size):
    # Inter is preferred. On Windows, Linux and macOS fall back to a real
    # system sans font instead of failing on a hard-coded Linux path.
    bold = 'SemiBold' in name
    candidates = [name, 'Inter-SemiBold.ttf' if bold else 'Inter-Regular.ttf',
                  'arialbd.ttf' if bold else 'arial.ttf',
                  'DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf']
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, max(1, size))
        except OSError:
            pass
    roots = [os.environ.get('NORDLA_FONT_DIR'), str(Path.home() / 'AppData/Local/Microsoft/Windows/Fonts'),
             'C:/Windows/Fonts', '/usr/share/fonts', '/usr/local/share/fonts', '/Library/Fonts']
    for root in filter(None, roots):
        for candidate in candidates:
            for found in glob.glob(str(Path(root) / '**' / candidate), recursive=True):
                try:
                    return ImageFont.truetype(found, max(1, size))
                except OSError:
                    continue
    raise RuntimeError('NORDLA_FONT_NOT_AVAILABLE: install Inter or Arial, or set NORDLA_FONT_DIR')
d = ImageDraw.Draw(out); k = min(W, H) / 1080; m = round(88 * k)
place = stage['text_placement']; prod_box = (x0, y0, x0 + tw, y0 + th)
col_w = {'LEFT_COLUMN': prod_box[0] - 2 * m, 'RIGHT_COLUMN': W - prod_box[2] - 2 * m}.get(place, W * 0.42)
col_w = max(col_w, W * 0.25)
def wrap(text, f, width):
    words, lines, cur = text.split(), [], ''
    for w_ in words:
        t = (cur + ' ' + w_).strip()
        if d.textlength(t, font=f) <= width or not cur: cur = t
        else: lines.append(cur); cur = w_
    return lines + ([cur] if cur else [])
size = round(84 * k)
while True:
    fh = font('InterDisplay-SemiBold.otf', size); lines = wrap(stage['headline'], fh, col_w)
    if max(d.textlength(l, font=fh) for l in lines) <= col_w or size < 40 * k: break
    size -= 4
small = font('InterDisplay-Regular.otf', round(27 * k))
info_lines = [l for l in [f"{facts['product_title']}{' — ' + facts['variant'] if facts.get('variant') else ''}", facts['price'] if stage['show_price'] == 'YES' else None, facts.get('merchant', 'HABB, Namur')] if l]
lh = round(size * 1.12); block_h = lh * len(lines)
left = place in ('TOP_LEFT', 'LEFT_COLUMN', 'BOTTOM_LEFT')
x_text = m if left else (W - m - max(d.textlength(l, font=fh) for l in lines))
if place in ('LEFT_COLUMN', 'RIGHT_COLUMN'): y_text = round(H * 0.18)
elif place.startswith('TOP'): y_text = m
else: y_text = H - m - block_h - round(140 * k)
x_info = m if left else W - m - max(d.textlength(l, font=small) for l in info_lines)
y_info = H - m - round(38 * k) * len(info_lines) if not place.startswith('BOTTOM') else y_text + block_h + round(24 * k)
# contraste : on mesure le fond sous le bloc et on choisit le blanc ou le noir
def lum(c): c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * c[..., 0] + 0.7152 * c[..., 1] + 0.0722 * c[..., 2]
bg_block = np.asarray(out).astype(np.float32)[max(0, y_text):y_text + block_h, max(0, int(x_text)):int(x_text + col_w)] / 255
Lb = float(np.percentile(lum(bg_block), 90)) if bg_block.size else 0.0
white, black = (244, 244, 242), (14, 14, 16)
cr_w = (1.0 + 0.05) / (Lb + 0.05); cr_b = (Lb + 0.05) / (0.0 + 0.05 + 0.006)
ink = white if cr_w >= cr_b else black; contrast = max(cr_w, cr_b)
for i, l in enumerate(lines): d.text((x_text, y_text + i * lh), l, font=fh, fill=ink)
sub = tuple(int(c * 0.72 + (255 if ink == black else 0) * 0.0) for c in ink)
for i, l in enumerate(info_lines): d.text((x_info, y_info + i * round(38 * k)), l, font=small, fill=ink if i < 2 else sub)
text_box = (x_text, y_text, x_text + max(d.textlength(l, font=fh) for l in lines), y_text + block_h)
info_box = (x_info, y_info, x_info + max(d.textlength(l, font=small) for l in info_lines), y_info + round(38 * k) * len(info_lines))
def inter(b1, b2): return not (b1[2] <= b2[0] or b2[2] <= b1[0] or b1[3] <= b2[1] or b2[3] <= b1[1])
defects = []
if checked_pixels < minimum_checked_pixels:
    defects.append('PRODUCT_FIDELITY_NOT_MEASURABLE')
if scene_mode and checked_pixels and int(visible_diff.max()) > 2:
    defects.append('PRODUCT_VISIBLE_COLOR_MISMATCH')
if inter(text_box, prod_box): defects.append('HEADLINE_OVERLAPS_PRODUCT')
if inter(info_box, prod_box): defects.append('INFO_OVERLAPS_PRODUCT')
if contrast < 4.5: defects.append('LOW_TEXT_CONTRAST')
if min(text_box[0], text_box[1], W - text_box[2], H - text_box[3]) < m * 0.6: defects.append('TEXT_OUTSIDE_MARGINS')
if (th / H) < 0.3: defects.append('PRODUCT_TOO_SMALL')
if x0 < 0 or y0 < 0 or x0 + tw > W or y0 + th > H: defects.append('PRODUCT_CROPPED_BY_FRAME')
out.save(OUT, quality=94)
report = {
    'fidelity': {'opaque_pixels': int(opaque.sum()), 'checked_pixels': checked_pixels, 'minimum_checked_pixels': minimum_checked_pixels, 'scene_mode': scene_mode, 'occluded_by_foreground': int((opaque[sl] & occluded).sum()),
                 'max_level_difference_after_removing_layers': int(diff.max()) if checked_pixels else None, 'mean_level_difference': round(float(diff.mean()), 4) if checked_pixels else None,
                 'max_visible_level_difference': int(visible_diff.max()) if checked_pixels else None, 'mean_visible_level_difference': round(float(visible_diff.mean()), 4) if checked_pixels else None,
                 'layers': {'scene_level_factor': scene_factor, 'rim_max_levels': 22 if 'RIM' in kinds else 0, 'slit_max_levels': 90 if info.get('slit_y') is not None else 0}},
    'technical': {'defects': defects, 'text_contrast_ratio': round(contrast, 2), 'product_height_share': round(th / H, 3), 'headline_font_px': size, 'text_ink': 'white' if ink == white else 'black'},
    'text_used': {'headline_proposed_by_brain': stage['headline'], 'facts_lines': info_lines},
}
json.dump(report, open(OUT + '.report.json', 'w'), indent=1, ensure_ascii=False)
print(json.dumps(report, ensure_ascii=False))
