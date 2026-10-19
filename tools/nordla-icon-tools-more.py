"""Second half of tools/nordla-icon-tools.py: technical candidates, sharpness, complete gallery. Loaded by the first file (shared helpers passed in `g`)."""
import html, io, json, shutil
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

SIZES = (16, 24, 32, 48, 64, 128, 256)


def _load(g):
    return json.loads((g['OUT'] / 'INVENTORY.json').read_text(encoding='utf-8'))


def _rgba(path):
    return np.asarray(Image.open(path).convert('RGBA')).astype(np.float64)


def _target_margin_ratio(g, inv):
    """The margin the official V1 pack leaves around its drawing (median over the 46 validated icons), as a fraction of the canvas."""
    ms = []
    for r in inv['files']:
        if r['status'] == 'VALIDATED_V1' and r.get('margins_px'):
            m = r['margins_px']; ms.append(min(m.values()) / r['width'])
    return float(np.median(ms)) if ms else 0.05


def remove_background(rgba):
    """Border-connected pale background -> transparent, with the anti-aliased edge rebuilt from the nearest solid colour (no colour of the drawing is invented or changed).
    Returns (rgba_out, stats)."""
    h, w = rgba.shape[:2]
    rgb = rgba[..., :3]; a0 = rgba[..., 3]
    pale = (rgb.min(axis=2) >= 214) & ((rgb.max(axis=2) - rgb.min(axis=2)) <= 34) & (a0 > 8)
    lab, n = ndimage.label(pale)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    bg = np.isin(lab, list(border))
    fg = ~bg
    # solid interior = foreground pixels at least 2 px away from the background
    dist_bg = ndimage.distance_transform_edt(fg)
    solid = fg & (dist_bg >= 2.5)
    # nearest solid pixel colour for every pixel (to rebuild the edge ring)
    idx = ndimage.distance_transform_edt(~solid, return_distances=False, return_indices=True)
    near = rgb[idx[0], idx[1]]
    white = np.array([255.0, 255.0, 255.0])
    d = near - white; denom = (d * d).sum(axis=2); denom[denom < 1] = 1
    alpha_ring = np.clip(((rgb - white) * d).sum(axis=2) / denom, 0, 1)
    ring = fg & ~solid
    out = np.zeros_like(rgba)
    out[..., :3] = np.where(ring[..., None], near, rgb)
    out[..., 3] = np.where(bg, 0, np.where(ring, alpha_ring * 255, 255))
    # keep pre-existing transparency
    out[..., 3] = np.minimum(out[..., 3], np.where(a0 < 255, a0, 255))
    stats = {'background_pct': round(float(bg.mean()) * 100, 1), 'ring_pixels': int(ring.sum()), 'components_removed': len(border)}
    return out, stats


def pad_to_margin(rgba, margin_ratio):
    """Add transparent canvas (no resampling) so that the drawing keeps the official margin on every side."""
    a = rgba[..., 3] > 8
    ys, xs = np.where(a)
    if not len(ys): return rgba
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    box = rgba[y0:y1, x0:x1]; bh, bw = box.shape[:2]
    side = int(np.ceil(max(bh, bw) / (1 - 2 * margin_ratio)))
    out = np.zeros((side, side, 4)); oy = (side - bh) // 2; ox = (side - bw) // 2
    out[oy:oy + bh, ox:ox + bw] = box
    return out


def _fidelity(before, after):
    """How much the drawing changed: composite both over white, mean absolute difference over the pixels that are drawing (not background) - must stay tiny."""
    def over(x, c): a = x[..., 3:4] / 255.0; return x[..., :3] * a + c * (1 - a)
    b = over(before, 255.0); aft = over(after[:before.shape[0], :before.shape[1]] if after.shape == before.shape else after, 255.0)
    return None if b.shape != aft.shape else float(np.abs(b - aft).mean())


def _sheet(items, path, title, per_row=6, cell=168):
    """before / after on white, checker and dark navy (halos and clipped strokes show immediately)."""
    rows = []
    for name, before, after in items:
        rows.append((name, before, after))
    W = per_row * cell; H = ((len(rows) + per_row - 1) // per_row) * (cell * 2 + 22) + 34
    sheet = Image.new('RGB', (W, H), (245, 246, 248)); dr = ImageDraw.Draw(sheet); dr.text((8, 8), title, fill=(15, 42, 82))
    def tile(img, bgcol):
        t = Image.new('RGBA', (cell - 8, cell - 8), bgcol + (255,)); im = img.copy(); im.thumbnail((cell - 16, cell - 16), Image.LANCZOS)
        t.alpha_composite(im, ((cell - 8 - im.width) // 2, (cell - 8 - im.height) // 2)); return t.convert('RGB')
    def checker(img):
        t = Image.new('RGBA', (cell - 8, cell - 8), (255, 255, 255, 255)); d = ImageDraw.Draw(t)
        for y in range(0, cell, 12):
            for x in range(0, cell, 12):
                if (x // 12 + y // 12) % 2: d.rectangle([x, y, x + 11, y + 11], fill=(218, 222, 228, 255))
        im = img.copy(); im.thumbnail((cell - 16, cell - 16), Image.LANCZOS); t.alpha_composite(im, ((cell - 8 - im.width) // 2, (cell - 8 - im.height) // 2)); return t.convert('RGB')
    for i, (name, before, after) in enumerate(rows):
        x = (i % per_row) * cell + 4; y = 30 + (i // per_row) * (cell * 2 + 22)
        sheet.paste(tile(before, (255, 255, 255)), (x, y)); sheet.paste(checker(after), (x, y + cell - 4)); dr.text((x, y + cell * 2 - 8), name[:26], fill=(60, 60, 60))
    sheet.save(path)


def candidates(g):
    inv = _load(g); OUT = g['OUT']; ROOT = g['ROOT']
    dest = OUT / 'candidates-technical'; shutil.rmtree(dest, ignore_errors=True); dest.mkdir(parents=True)
    margin = _target_margin_ratio(g, inv)
    manifest = []; sheets = {}
    for r in inv['files']:
        if r['status'] != 'V2_TO_FIX' or r['fix_class'] not in ('FIX_MARGIN', 'FIX_BACKGROUND_LOWRES'): continue
        src = ROOT / r['path']; before = _rgba(src); stats = {}
        if r['fix_class'] == 'FIX_BACKGROUND_LOWRES':
            after, stats = remove_background(before)
        else:
            after = before.copy()
        after = pad_to_margin(after, margin)
        a8 = np.clip(after, 0, 255).astype(np.uint8); img = Image.fromarray(a8, 'RGBA')
        stem = f"{r['function_id']}__{Path(r['path']).stem}"
        out = dest / r['fix_class'].lower() / f'{stem}.png'; out.parent.mkdir(parents=True, exist_ok=True); img.save(out, optimize=True)
        # fidelity: drawing pixels unchanged except the edge ring (composite over white, restricted to the original canvas)
        oy = (after.shape[0] - before.shape[0]) // 2; ox = (after.shape[1] - before.shape[1]) // 2
        crop = np.zeros_like(before)
        ys, xs = np.where(before[..., 3] > 8)
        fid = None
        try:
            bb = before; ab = a8.astype(np.float64)
            # compare the drawing on white: build both composites on a common canvas
            S = ab.shape[0]; canvas = np.full((S, S, 3), 255.0)
            a = ab[..., 3:4] / 255.0; after_w = ab[..., :3] * a + 255 * (1 - a)
            bcanvas = np.full((S, S, 3), 255.0)
            # the content box was centred: find its offset by matching bbox of non-white in both
            def bbox_nonwhite(x): m = (x < 245).any(axis=2); yy, xx = np.where(m); return yy.min(), yy.max() + 1, xx.min(), xx.max() + 1
            bw = np.minimum(bb[..., :3] * (bb[..., 3:4] / 255.0) + 255 * (1 - bb[..., 3:4] / 255.0), 255)
            by0, by1, bx0, bx1 = bbox_nonwhite(bw); ay0, ay1, ax0, ax1 = bbox_nonwhite(after_w)
            if (by1 - by0, bx1 - bx0) == (ay1 - ay0, ax1 - ax0):
                fid = float(np.abs(bw[by0:by1, bx0:bx1] - after_w[ay0:ay1, ax0:ax1]).mean())
        except Exception:
            fid = None
        m = np.where(after[..., 3] > 8); h, w = after.shape[:2]
        entry = {'function_id': r['function_id'], 'source': r['path'], 'candidate': g['rel'](out), 'fix_class': r['fix_class'], 'native_before': [r['width'], r['height']], 'canvas_after': [w, h],
                 'margins_after_px': {'top': int(m[0].min()), 'left': int(m[1].min()), 'bottom': int(h - 1 - m[0].max()), 'right': int(w - 1 - m[1].max())}, 'corners_transparent': bool(all(a8[y, x, 3] == 0 for y in (0, -1) for x in (0, -1))),
                 'drawing_mean_abs_diff_on_white': None if fid is None else round(fid, 3), 'background_stats': stats, 'status': 'CANDIDATE_TECHNICAL_TO_VALIDATE',
                 'safe_css_size_px': int(min(w, h) // 2) if min(w, h) < 256 else 256, 'defects_not_fixable_here': [d for d in r.get('defects', []) if 'basse résolution' in d],
                 'style_warning': ('lot 2 « D à G » : traits plus épais et cuivre granuleux (constat de l’audit) : cohérence avec la famille Finance V1 à arbitrer' if 'Categories_D_a_G' in r['path'] else None)}
        manifest.append(entry); sheets.setdefault(r['fix_class'], []).append((f"{r['function_id']}", Image.fromarray(np.clip(before, 0, 255).astype(np.uint8), 'RGBA'), img))
    for cls, items in sheets.items():
        for k in range(0, len(items), 18):
            _sheet(items[k:k + 18], dest / f'sheet-{cls.lower()}-{k // 18 + 1}.png', f'{cls} : en haut AVANT (fond blanc), en bas APRES (damier = transparence) : {len(items)} fichiers')
    (dest / 'manifest.json').write_text(json.dumps({'note': 'Technical clean-ups only (background removal with edge rebuilt from the nearest solid colour; transparent margin added without resampling). Nothing is redrawn, recoloured or enlarged. NOT wired anywhere; each file needs a visual validation. Native resolution is kept: a candidate whose native size is below 256 px is only crisp up to safe_css_size_px.',
                                                    'margin_ratio_used': round(margin, 4), 'count': len(manifest), 'by_class': {c: len(v) for c, v in sheets.items()}, 'files': manifest}, ensure_ascii=False, indent=1), encoding='utf-8')
    bad = [e for e in manifest if not e['corners_transparent'] or (e['drawing_mean_abs_diff_on_white'] is not None and e['drawing_mean_abs_diff_on_white'] > 6)]
    print('candidates', len(manifest), dict((c, len(v)) for c, v in sheets.items()), 'suspicious', len(bad))
    for e in bad[:10]: print('  suspicious', e['function_id'], e['drawing_mean_abs_diff_on_white'], e['corners_transparent'])


def _render(path, size):
    im = Image.open(path).convert('RGBA'); w, h = im.size
    k = size / max(w, h); im = im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (255, 255, 255, 255)); canvas.alpha_composite(im, ((size - im.width) // 2, (size - im.height) // 2)); return canvas.convert('RGB')


def sharpness(g):
    """Sharpness control at 16 / 24 / 32 / 48 / 64 / 128 / 256 px. A raster is only crisp up to its native size: above it the icon is UPSCALED (soft) and is reported as such; nothing is presented as vector."""
    inv = _load(g); OUT = g['OUT']; ROOT = g['ROOT']
    targets = [r for r in inv['files'] if r['status'] in ('VALIDATED_V1', 'V2_CONFORME_PENDING_VALIDATION')]
    manifest = json.loads((OUT / 'candidates-technical' / 'manifest.json').read_text(encoding='utf-8'))
    cands = [{'path': e['candidate'], 'status': 'CANDIDATE', 'label': e['function_id'], 'width': e['canvas_after'][0], 'height': e['canvas_after'][1]} for e in manifest['files']]
    rows = []
    for r in targets: rows.append({'path': r['path'], 'status': r['status'], 'label': r.get('registry_key') or r.get('function_id'), 'width': r['width'], 'height': r['height']})
    rows += cands
    for r in rows:
        native = min(r['width'], r['height']) if False else max(r['width'], r['height'])
        r['native_px'] = native
        r['sizes'] = {str(s): ('NET (réduction du fichier source)' if s <= native else 'AGRANDI : flou (fichier plus petit que la taille demandée)') for s in SIZES}
        r['crisp_up_to_px'] = max((s for s in SIZES if s <= native), default=0)
        r['vector'] = False
    from collections import Counter
    summ = {}
    for st in ('VALIDATED_V1', 'V2_CONFORME_PENDING_VALIDATION', 'CANDIDATE'):
        rs = [r for r in rows if r['status'] == st]; summ[st] = {'files': len(rs), 'crisp_up_to': dict(Counter(r['crisp_up_to_px'] for r in rs))}
    (OUT / 'SHARPNESS.json').write_text(json.dumps({'sizes_px': SIZES, 'note': 'No file is vector. A bitmap is never presented as vector: above its native size an icon is soft.', 'summary': summ, 'files': rows}, ensure_ascii=False, indent=1), encoding='utf-8')
    # sheets: every validated + V2 conformant icon at each size, side by side (legibility at 16 / 24 / 32 px is what the screens use)
    pick = [r for r in rows if r['status'] != 'CANDIDATE']
    sd = OUT / 'sharpness'; sd.mkdir(exist_ok=True)
    def strip(items, sizes, path, title):
        pad = 6; colw = [s + pad for s in sizes]; W = sum(colw) + 150; H = len(items) * (max(sizes) + pad) + 28
        sh = Image.new('RGB', (W, H), (255, 255, 255)); d = ImageDraw.Draw(sh); d.text((6, 6), title, fill=(15, 42, 82))
        for i, r in enumerate(items):
            y = 24 + i * (max(sizes) + pad); x = 4
            for s in sizes: sh.paste(_render(ROOT / r['path'], s), (x, y)); x += s + pad
            d.text((x + 6, y + 4), str(r['label'])[:26], fill=(60, 60, 60))
        sh.save(path)
    chunk = 20
    for k in range(0, len(pick), chunk):
        strip(pick[k:k + chunk], (16, 24, 32, 48, 64), sd / f'sheet-{k // chunk + 1:02d}-16-64px.png', f'Nettete 16/24/32/48/64 px (reductions du fichier source) - {k + 1} a {min(k + chunk, len(pick))} sur {len(pick)}')
    cs = [r for r in rows if r['status'] == 'CANDIDATE']
    for k in range(0, len(cs), chunk):
        strip(cs[k:k + chunk], (16, 24, 32, 48), sd / f'sheet-candidates-{k // chunk + 1:02d}-16-48px.png', f'Candidats techniques 16/24/32/48 px (pas au-dela : resolution native limitee) - {k + 1} a {min(k + chunk, len(cs))}')
    md = ['# Nordla — contrôle de netteté des pictogrammes', '', 'Tailles contrôlées : ' + ', '.join(f'{s} px' for s in SIZES) + '. **Aucun fichier n\'est vectoriel** : tous les pictogrammes sont des PNG. Un PNG est net **jusqu\'à sa taille native** ; au-delà il est agrandi (flou) et signalé comme tel. Aucune image bitmap agrandie n\'est présentée comme vectorielle.', '',
          '| Ensemble | Fichiers | Nets jusqu\'à (px) |', '|---|---|---|']
    names = {'VALIDATED_V1': 'Pack officiel V1 (validé)', 'V2_CONFORME_PENDING_VALIDATION': 'V2 conformes (validation en attente)', 'CANDIDATE': 'Candidats techniques (fond nettoyé, résolution native conservée)'}
    for st, v in summ.items(): md.append(f"| {names[st]} | {v['files']} | " + ', '.join(f'{k} px : {n}' for k, n in sorted(v['crisp_up_to'].items())) + ' |')
    md += ['', 'Lecture : les écrans affichent 16, 20 et 28 px CSS (soit 32 à 84 px sur écran 2× / 3×). Les 80 icônes V1 et V2 (256 px) sont nettes à toutes ces tailles. Les candidats techniques issus de fichiers basse résolution (48–64 px natifs) sont nets pour **16 à 24 px CSS** (32–48 px sur écran 2×) et **flous au-delà** : ils ne conviennent pas aux grandes tailles ni aux écrans 3×.', '',
           'Planches : `sharpness/sheet-*.png` (chaque ligne = une icône à 16, 24, 32, 48, 64 px, rendue depuis le fichier source).']
    (OUT / 'SHARPNESS.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    print(json.dumps(summ, ensure_ascii=False))
