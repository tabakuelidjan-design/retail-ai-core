#!/usr/bin/env python3
"""Compose the raw captures of tools/nordla-capture-modules.mjs into side-by-side images (Core on the left, the module on the right) and one overview per viewport.
   python tools/nordla-compose-captures.py <rawDir> <outDir>
Pure Pillow: no network, nothing redrawn - the screenshots are only cropped to the same height and labelled."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

Image.MAX_IMAGE_PIXELS = None
raw = Path(sys.argv[1]); out = Path(sys.argv[2]); (out / 'side-by-side').mkdir(parents=True, exist_ok=True)
MODULES = [('finance', 'Finance'), ('analyses', 'Analyses'), ('developpement-des-ventes', 'Développement des ventes'), ('stock-achats', 'Stock & Achats'), ('china-sourcing', 'China Sourcing (app terrain)'),
           ('social-publishing', 'Social Publishing'), ('core-parle', 'Parle à Nordla (écran /nordla)'), ('core-modules', 'Tous les modules (écran /nordla)')]
try:
    FONT = ImageFont.truetype('arial.ttf', 22); SMALL = ImageFont.truetype('arial.ttf', 15)
except Exception:
    FONT = SMALL = ImageFont.load_default()


def load(name, view):
    p = raw / f'{name}-{view}.png'
    return Image.open(p).convert('RGB') if p.exists() else None


def fit(im, width):
    k = width / im.width
    return im.resize((width, max(1, round(im.height * k))), Image.LANCZOS)


def side_by_side(left, right, label_left, label_right, height):
    w = max(left.width, right.width)
    left, right = fit(left, w), fit(right, w)
    h = min(height, max(left.height, right.height))
    sheet = Image.new('RGB', (w * 2 + 12, h + 36), (229, 231, 235)); d = ImageDraw.Draw(sheet)
    d.text((8, 7), label_left, fill=(17, 24, 39), font=FONT); d.text((w + 20, 7), label_right, fill=(17, 24, 39), font=FONT)
    sheet.paste(left.crop((0, 0, w, min(h, left.height))), (0, 36)); sheet.paste(right.crop((0, 0, w, min(h, right.height))), (w + 12, 36))
    return sheet


for view, height, width in (('desktop', 1100, 1200), ('mobile', 1500, 390)):
    core = load('core-accueil', view)
    if core is None: continue
    core = fit(core, width)
    tiles = []
    for key, label in MODULES:
        im = load(key, view)
        if im is None: continue
        s = side_by_side(core, fit(im, width), 'Nordla Core (accueil)', label, height)
        s.save(out / 'side-by-side' / f'{key}-{view}.jpg', quality=84, optimize=True); tiles.append((label, fit(im, 560 if view == 'desktop' else 280)))
    # overview: every module, same width, cropped to the same height
    cw = 560 if view == 'desktop' else 280; ch = 520 if view == 'desktop' else 560; cols = 4 if view == 'desktop' else 4
    allt = [('Nordla Core', fit(core, cw))] + tiles
    rows = (len(allt) + cols - 1) // cols
    ov = Image.new('RGB', (cols * (cw + 8) + 8, rows * (ch + 34) + 8), (229, 231, 235)); d = ImageDraw.Draw(ov)
    for i, (label, im) in enumerate(allt):
        x = 8 + (i % cols) * (cw + 8); y = 8 + (i // cols) * (ch + 34)
        d.text((x + 2, y + 5), label, fill=(17, 24, 39), font=SMALL); ov.paste(im.crop((0, 0, cw, min(ch, im.height))), (x, y + 28))
    ov.save(out / f'overview-{view}.jpg', quality=84, optimize=True)
    print(view, 'overview', ov.size, len(tiles), 'modules')
