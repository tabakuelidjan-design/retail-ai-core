"""Nordla Création — examen du produit (moteur local, sans fournisseur).

Lit la photo produit, mesure le fond, la silhouette, les couleurs dominantes, et produit une découpe RÉVERSIBLE
(produit_rgba.png) par des règles génériques, sans coordonnées propres à une photo :
  - fond uni mesuré sur les bords (sinon : arrêt BACKGROUND_NOT_PLAIN, il faut un fournisseur de segmentation) ;
  - silhouette = composantes connexes remplies, les pixels « de fond » enfermés restent transparents ;
  - base : la bande du bas ne peut pas dépasser la largeur du corps, et, pour un objet sombre, le reflet clair du sol
    du studio est retiré (il n'appartient pas au produit) ;
  - bords décontaminés (le fond ne déborde pas).
Usage : python examine_product.py <photo> <out_dir>
"""
import json, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

src_path, out_dir = sys.argv[1], sys.argv[2]
img = Image.open(src_path).convert('RGB')
src = np.asarray(img).astype(np.float32)
Hh, Ww, _ = src.shape
border = np.concatenate([src[:12].reshape(-1, 3), src[-12:].reshape(-1, 3), src[:, :12].reshape(-1, 3), src[:, -12:].reshape(-1, 3)])
bg = np.median(border, axis=0); bg_std = float(border.std(0).max())
report = {'source': {'width': Ww, 'height': Hh}, 'background': {'rgb': [round(float(x)) for x in bg], 'std': round(bg_std, 2)}}
if bg_std > 8:
    # fond en dégradé ? on ajuste une surface quadratique sur les bords, puis on cherche ce que l'image contient d'autre que le produit
    yy0, xx0 = np.mgrid[0:Hh, 0:Ww].astype(np.float32) / max(Hh, Ww)
    bm = np.zeros((Hh, Ww), bool); bm[:12] = bm[-12:] = True; bm[:, :12] = bm[:, -12:] = True
    A = np.stack([np.ones(bm.sum()), xx0[bm], yy0[bm], xx0[bm] ** 2, yy0[bm] ** 2, xx0[bm] * yy0[bm]], 1)
    coef, *_ = np.linalg.lstsq(A, src.mean(2)[bm], rcond=None)
    model = coef[0] + coef[1] * xx0 + coef[2] * yy0 + coef[3] * xx0 ** 2 + coef[4] * yy0 ** 2 + coef[5] * xx0 * yy0
    resid = float(np.abs(src.mean(2)[bm] - model[bm]).std())
    dd = np.abs(src.mean(2) - model)
    mm = dd > 14
    lab_, n_ = ndi.label(mm); sz = ndi.sum(mm, lab_, range(1, n_ + 1)); big = np.argsort(sz)[::-1]
    main = lab_ == (big[0] + 1)
    others = [int(sz[k]) for k in big[1:] if sz[k] > 0.0005 * Ww * Hh]
    ring = ndi.binary_dilation(main, iterations=25) & ~ndi.binary_dilation(main, iterations=3)
    halo = float((dd[ring] > 6).mean())
    reasons = []
    if resid > 4: reasons.append('BACKGROUND_NOT_PLAIN_OR_GRADIENT')
    if others: reasons.append(f'SEPARATE_ELEMENTS_IN_THE_IMAGE ({len(others)}: a caption, a logo or a second object)')
    if halo > 0.35: reasons.append('SHADOW_OR_GLOW_BAKED_AROUND_THE_PRODUCT')
    report['background']['gradient_fit_residual'] = round(resid, 2)
    report['halo_share'] = round(halo, 3)
    report['status'] = 'NEEDS_CLEAN_ASSET' if reasons else 'GRADIENT_BACKGROUND_NOT_SUPPORTED_YET'
    report['reasons'] = reasons
    report['needs'] = 'the same image exported without shadow, glow or caption, on a plain or transparent background (or a segmentation provider)'
    if True:
        json.dump(report, open(f'{out_dir}/examen.json', 'w'), indent=1, ensure_ascii=False); print(json.dumps(report)); sys.exit(0)
if False:
    pass
    report['needs'] = 'a segmentation provider (the photo is not on a plain background)'
    json.dump(report, open(f'{out_dir}/examen.json', 'w'), indent=1, ensure_ascii=False); print(json.dumps(report)); sys.exit(0)

d = np.abs(src - bg).max(2)
lum = src.mean(2)
m = d > 12
lab, n = ndi.label(m)
sizes = ndi.sum(m, lab, range(1, n + 1))
keep = np.isin(lab, np.where(sizes > 0.002 * Ww * Hh)[0] + 1)
filled = ndi.binary_fill_holes(keep)
ys, xs = np.where(filled)
x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
bh = y1 - y0 + 1
core = ndi.binary_erosion(filled, iterations=2)
dmax = float(np.percentile(d[core], 90)) if core.any() else 200.0
aK = np.clip((d - 3) / max(dmax - 3, 20), 0, 1)
bglike = d < 12
a = np.where(core & ~bglike, 1.0, aK)

yy = np.arange(Hh)[:, None] * np.ones((1, Ww))
xx = np.arange(Ww)[None, :] * np.ones((Hh, 1))
# largeur du corps mesurée entre 60 % et 85 % de la hauteur ; rien ne dépasse en bas
rows = [np.where(filled[y])[0] for y in range(int(y0 + 0.60 * bh), int(y0 + 0.85 * bh), max(1, bh // 60)) if filled[y].any()]
body_l = int(np.median([r.min() for r in rows])); body_r = int(np.median([r.max() for r in rows]))
bottom = yy > (y0 + 0.94 * bh)
a = np.where(bottom & ((xx < body_l) | (xx > body_r)), 0.0, a)
is_dark = float(np.median(lum[core & ~bglike])) < 90 if (core & ~bglike).any() else False
if is_dark:
    band = yy > (y0 + 0.965 * bh)
    a = np.where(band, np.clip((d - 0.55 * dmax) / (0.25 * dmax), 0, 1), a)
a = np.clip(a, 0, 1).astype(np.float32)

F = np.where(a[..., None] > 0.02, (src - (1 - a[..., None]) * bg) / np.maximum(a[..., None], 1e-3), 0)
F = np.clip(F, 0, 255)
F = np.where(a[..., None] >= 0.999, src, F)
edge = (a > 0) & (a < 0.999)
_, (iy, ix) = ndi.distance_transform_edt(a < 0.999, return_indices=True)
F[edge] = src[iy[edge], ix[edge]]
a = np.where(edge, a ** 1.4, a)

Image.fromarray(np.dstack([F, a * 255]).astype(np.uint8), 'RGBA').save(f'{out_dir}/produit_rgba.png')
ys2, xs2 = np.where(a > 0.5)
bx0, bx1, by0, by1 = int(xs2.min()), int(xs2.max()), int(ys2.min()), int(ys2.max())
opaque = a >= 0.999
px = src[opaque]
# couleurs dominantes (k-moyennes simples, 3 groupes)
rng = np.random.default_rng(0); sample = px[rng.choice(len(px), min(4000, len(px)), replace=False)]
cent = sample[rng.choice(len(sample), 3, replace=False)]
for _ in range(12):
    lab3 = np.argmin(((sample[:, None] - cent[None]) ** 2).sum(2), 1)
    cent = np.array([sample[lab3 == k].mean(0) if (lab3 == k).any() else cent[k] for k in range(3)])
share = [float((lab3 == k).mean()) for k in range(3)]
order = np.argsort(share)[::-1]
re = F * a[..., None] + (1 - a[..., None]) * bg
report.update({
    'status': 'CUT_OUT',
    'bbox': {'x': bx0, 'y': by0, 'w': bx1 - bx0 + 1, 'h': by1 - by0 + 1},
    'aspect_w_over_h': round((bx1 - bx0 + 1) / (by1 - by0 + 1), 4),
    'is_dark_object': bool(is_dark),
    'translucent_share': round(float(((a > 0.05) & (a < 0.95)).sum() / max(1, (a > 0.05).sum())), 4),
    'opaque_pixels': int(opaque.sum()),
    'dominant_colours': [{'rgb': [round(float(c)) for c in cent[k]], 'share': round(share[k], 3)} for k in order],
    'recomposite_on_source_background_mean_error': round(float(np.abs(re - src)[opaque].mean()), 4),
    'rules_applied': ['plain background keyed', 'enclosed background kept transparent', 'base clamped to body width'] + (['studio floor reflection removed at the base (dark object)'] if is_dark else []),
})
json.dump(report, open(f'{out_dir}/examen.json', 'w'), indent=1, ensure_ascii=False)
print(json.dumps(report))
