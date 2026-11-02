"""Nordla — contrôle d'une scène générée autour du vrai produit (moteur local, sans fournisseur).

Le modèle d'édition a reçu la plaque (la vraie photo posée à sa place) et rendu une scène AUTOUR. Il redessine aussi le produit : ses pixels ne
sont jamais gardés, le compositeur remet ceux de la photo. Mais remettre les pixels ne prouve pas que l'image est réaliste. Ce script mesure donc :

  ALIGNEMENT   où le modèle a VRAIMENT dessiné le produit (décalage et échelle cherchés sur les contours, corrélation normalisée) ; les pixels
               authentiques sont remis à CET endroit, pour que l'ombre et le reflet du modèle restent sous le produit restauré.
  FANTÔME      une bordure du produit redessiné qui dépasserait du produit restauré (silhouette plus large, déformée).
  DOUBLON      un deuxième produit ailleurs dans l'image (corrélation du produit sur toute la scène).
  OMBRE        une ombre de contact sous le pied (sinon le produit flotte).
  REFLET       un reflet sous le produit, attendu quand le sol choisi par Nordla est un miroir.
  LUMIÈRE      le côté éclairé du produit redessiné par le modèle contre celui de la photo restaurée.

ALIGNEMENT, FANTÔME et DOUBLON sont BLOQUANTS. OMBRE, REFLET, LUMIÈRE sont des AVERTISSEMENTS mesurés, montrés au critique et au propriétaire :
une restauration de pixels ne prouve pas le réalisme, et ces mesures ne le prouvent pas non plus ; elles disent où regarder.

Usage : python scene_check.py <variante.png> <plaque.png.json> <produit_rgba.png> <examen.json> <stage.json> <sortie.png>
Écrit <sortie.png> (la scène au format exact du canevas) et <sortie.png>.json (les métadonnées que compose_stage.py lit), imprime le rapport.
"""
import json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scene_plate import place, on_canvas  # noqa: E402

LIMITS = {
    'search_radius_px_at_1080': 28,     # décalage maximal cherché (au-delà : le modèle a déplacé le produit)
    'scales': [0.94, 0.96, 0.98, 1.0, 1.02, 1.04, 1.06],
    'min_edge_ncc': 0.30,                # corrélation minimale des contours, produit restauré contre produit redessiné
    'max_ghost_share': 0.20,             # part maximale de la bordure qui ressemble au produit plutôt qu'à la scène
    'ghost_min_contrast': 0.08,          # en dessous, produit et scène se confondent : une bordure n'est pas visible
    'duplicate_scales': [0.75, 0.9, 1.0, 1.1, 1.25],
    'max_duplicate_shape_ncc': 0.75,     # un deuxième produit : forme ET détail au-dessus de ces deux seuils
    'max_duplicate_detail_ncc': 0.45,
    'shadow_present_below': 0.85,        # luminance sous le pied / à côté
    'reflection_present_above': 0.35,
    'product_level_range': [0.6, 1.15],  # niveau appliqué au produit restauré (couche bornée, retirée par la preuve de fidélité)
}
LUMA = np.array([0.299, 0.587, 0.114], np.float32)


def ncc(a, b, m=None):
    if m is not None: a = a[m]; b = b[m]
    a = a - a.mean(); b = b - b.mean()
    d = float(np.sqrt((a * a).sum() * (b * b).sum()))
    return float((a * b).sum() / d) if d > 1e-9 else 0.0


def masked_ncc(I, T, m):
    """Corrélation normalisée de T (pondérée par le masque m) à chaque position valide de I (FFT, formule de Padfield)."""
    from scipy.signal import fftconvolve
    n = float(m.sum())
    t = (T - (T * m).sum() / n) * m; tn = float(np.sqrt((t * t).sum()))
    corr = lambda X, K: fftconvolve(X, K[::-1, ::-1], mode='valid')
    sI = corr(I, m); sI2 = corr(I * I, m); sIT = corr(I, t)
    var = np.clip(sI2 - sI * sI / n, 0, None)
    return np.where(var > 1e-6, sIT / (np.sqrt(var) * tn + 1e-12), 0.0)


def best_shift(ref, mov, weight, R):
    """Décalage entier (dx, dy) de mov qui maximise la corrélation avec ref pondérée (FFT, puis valeur exacte)."""
    a = (ref - ref[weight].mean()) * weight
    b = mov - mov.mean()
    F = np.fft.rfft2(b, s=a.shape) * np.conj(np.fft.rfft2(a, s=a.shape))
    corr = np.fft.irfft2(F, s=a.shape)
    best = (-2.0, 0, 0)
    for dy in range(-R, R + 1):
        for dx in range(-R, R + 1):
            v = corr[dy % a.shape[0], dx % a.shape[1]]
            if v > best[0]: best = (v, dx, dy)
    return best[1], best[2]


def shifted(img, dx, dy):
    return ndi.shift(img, (dy, dx), order=0, mode='nearest')


def main():
    var_path, plate_json, rgba_path, exam_path, stage_path, out_path = sys.argv[1:7]
    meta = json.load(open(plate_json, encoding='utf-8')); W, H = meta['canvas']
    exam = json.load(open(exam_path, encoding='utf-8')); stage = json.load(open(stage_path, encoding='utf-8'))
    img = Image.open(var_path).convert('RGB'); resized_from = None
    if img.size != (W, H):
        resized_from = list(img.size); img = img.resize((W, H), Image.LANCZOS)
    img.save(out_path, format='PNG')
    M = np.asarray(img).astype(np.float32) / 255; Lm = M @ LUMA
    bx, by = meta['bottom_front']; ty0 = meta['top_front'][1]; grey = meta['plate_grey'] / 255
    R = max(4, round(LIMITS['search_radius_px_at_1080'] * W / 1080))
    Gm = np.hypot(ndi.sobel(Lm, 0), ndi.sobel(Lm, 1))

    # ---- ALIGNEMENT : échelle (autour du pied) puis décalage, sur les contours
    trials = []
    for s in LIMITS['scales']:
        ty = round(by - (by - ty0) * s)
        pr, x0, y0, tw, th = place(exam, rgba_path, bx, by, ty)
        P, A = on_canvas(pr, x0, y0, W, H)
        Lp = (P + grey * (1 - A[..., None])) @ LUMA
        Gp = np.hypot(ndi.sobel(Lp, 0), ndi.sobel(Lp, 1))
        region = ndi.binary_dilation(A > 0.5, iterations=6)
        ys, xs = np.nonzero(region)
        if not len(ys): continue
        ya, yb, xa, xb = max(0, ys.min() - R), min(H, ys.max() + R + 1), max(0, xs.min() - R), min(W, xs.max() + R + 1)
        wgt = region[ya:yb, xa:xb]
        dx, dy = best_shift(Gp[ya:yb, xa:xb], Gm[ya:yb, xa:xb], wgt, R)
        score = ncc(Gp[ya:yb, xa:xb], shifted(Gm, -dx, -dy)[ya:yb, xa:xb], wgt)
        trials.append({'scale': s, 'dx': int(dx), 'dy': int(dy), 'edge_ncc': round(score, 4), 'ty': ty})
    if not trials: raise SystemExit('PRODUCT_OUTSIDE_CANVAS')
    best = max(trials, key=lambda t: t['edge_ncc'])
    dx, dy, s = best['dx'], best['dy'], best['scale']
    bxa, bya, tya = bx + dx, by + dy, best['ty'] + dy
    pr, x0, y0, tw, th = place(exam, rgba_path, bxa, bya, tya)
    P, A = on_canvas(pr, x0, y0, W, H)
    Lp = (P + grey * (1 - A[..., None])) @ LUMA
    solid = A >= 0.99; anyp = A > 0.02
    rejections, warnings = [], []
    if best['edge_ncc'] < LIMITS['min_edge_ncc']: rejections.append('PRODUCT_NOT_FOUND_WHERE_EXPECTED')
    if max(abs(dx), abs(dy)) >= R: rejections.append('PRODUCT_MOVED_BEYOND_SEARCH')

    # ---- FANTÔME : bordure de 2 à 6 px autour du produit restauré, hors bande du pied (ombre, reflet)
    foot = np.zeros((H, W), bool); foot[max(0, bya - round(0.06 * th)):, :] = True
    ring = ndi.binary_dilation(anyp, iterations=6) & ~ndi.binary_dilation(anyp, iterations=2) & ~foot
    inner = solid & ~ndi.binary_erosion(solid, iterations=5) & ~foot
    outer = ndi.binary_dilation(anyp, iterations=22) & ~ndi.binary_dilation(anyp, iterations=12) & ~foot
    ghost = {'share': None, 'contrast': None}
    if ring.any() and inner.any() and outer.any():
        mi = np.median(M[inner], 0); mo = np.median(M[outer], 0); contrast = float(np.linalg.norm(mi - mo))
        share = 0.0
        if contrast >= LIMITS['ghost_min_contrast']:
            c = M[ring]; share = float((np.linalg.norm(c - mi, axis=1) < np.linalg.norm(c - mo, axis=1)).mean())
        ghost = {'share': round(share, 4), 'contrast': round(contrast, 4)}
        if share > LIMITS['max_ghost_share']: rejections.append('GHOST_EDGE_AROUND_PRODUCT')

    # ---- DOUBLON : le produit cherché ailleurs dans la scène, à plusieurs échelles, à 1/3. Il faut À LA FOIS la forme (rectangle englobant,
    # le produit contre son entourage) et le détail (corrélation dans la silhouette : bouchon, logo) : une forme sombre seule (un poteau, une porte) ne suffit pas.
    f = 3
    small = lambda X, sc=1.0: np.asarray(Image.fromarray((np.clip(X, 0, 1) * 255).astype(np.uint8)).resize((max(1, round(W * sc / f)), max(1, round(H * sc / f))), Image.BOX)).astype(np.float32) / 255
    Ls = small(Lm)
    duplicate = {'shape_ncc': None, 'detail_ncc': None, 'at': None, 'scale': None}
    best_d = (-1.0, -1.0, None, None)
    for sc in LIMITS['duplicate_scales']:
        As = small(A, sc); Ps = small(Lp, sc)
        ys, xs = np.nonzero(As > 0.5)
        if len(ys) < 20: continue
        ta, tb, tl, tr = max(0, ys.min() - 2), min(As.shape[0], ys.max() + 3), max(0, xs.min() - 2), min(As.shape[1], xs.max() + 3)
        T = Ps[ta:tb, tl:tr]; Tm = (As[ta:tb, tl:tr] > 0.5).astype(np.float32)
        if T.shape[0] > Ls.shape[0] or T.shape[1] > Ls.shape[1]: continue
        shape_map = masked_ncc(Ls, T, np.ones_like(T)); detail_map = masked_ncc(Ls, T, Tm)
        # positions où la fenêtre recouvre le produit restauré (ou son reflet collé au pied) : exclues
        pa, pb = round((y0) / f), round((y0 + 1.6 * th) / f); pl, pr_ = round(x0 / f), round((x0 + tw) / f)
        hh, ww = T.shape
        yy, xx = np.mgrid[0:shape_map.shape[0], 0:shape_map.shape[1]]
        inter = np.clip(np.minimum(xx + ww, pr_) - np.maximum(xx, pl), 0, None) * np.clip(np.minimum(yy + hh, pb) - np.maximum(yy, pa), 0, None)
        ok = inter / float(hh * ww) <= 0.2
        both = np.where(ok, np.minimum(shape_map / LIMITS['max_duplicate_shape_ncc'], detail_map / LIMITS['max_duplicate_detail_ncc']), -9)
        k = np.unravel_index(int(np.argmax(both)), both.shape)
        if both[k] > -9 and both[k] > best_d[0]:
            best_d = (float(both[k]), None, [int(k[1] * f), int(k[0] * f)], sc)
            duplicate = {'shape_ncc': round(float(shape_map[k]), 4), 'detail_ncc': round(float(detail_map[k]), 4), 'at': best_d[2], 'scale': sc}
    if duplicate['shape_ncc'] is not None and duplicate['shape_ncc'] >= LIMITS['max_duplicate_shape_ncc'] and duplicate['detail_ncc'] >= LIMITS['max_duplicate_detail_ncc']:
        rejections.append('DUPLICATE_PRODUCT_IN_SCENE')

    # ---- OMBRE DE CONTACT : sous le pied, contre le sol à côté, aux mêmes lignes
    r0, r1 = min(H - 1, bya + 1), min(H, bya + max(4, round(0.02 * H)))
    cxa, cxb = max(0, round(bxa - 0.3 * tw)), min(W, round(bxa + 0.3 * tw))
    sides = [(round(bxa - 1.4 * tw), round(bxa - 0.9 * tw)), (round(bxa + 0.9 * tw), round(bxa + 1.4 * tw))]
    refs = [Lm[r0:r1, max(0, a):min(W, b)] for a, b in sides if min(W, b) - max(0, a) > 4]
    shadow = {'ratio': None, 'present': None}
    if r1 > r0 and cxb > cxa and refs:
        ref = float(np.mean([r.mean() for r in refs]))
        ratio = float(Lm[r0:r1, cxa:cxb].mean()) / max(ref, 1e-4)
        shadow = {'ratio': round(ratio, 4), 'present': ratio < LIMITS['shadow_present_below']}
        if not shadow['present']: warnings.append('NO_CONTACT_SHADOW_MEASURED')

    # ---- REFLET : sous le pied, le produit retourné
    hr = min(round(0.3 * th), H - bya - 3)
    reflection = {'ncc': None, 'present': None, 'expected': stage.get('floor_finish') == 'MIRROR'}
    if hr > 8:
        xa_, xb_ = max(0, x0), min(W, x0 + tw)
        below = Lm[bya + 2:bya + 2 + hr, xa_:xb_]; above = np.flipud(Lm[bya - hr:bya, xa_:xb_])
        mask = np.flipud(A[bya - hr:bya, xa_:xb_] > 0.5)
        if mask.sum() > 20 and below.shape == above.shape:
            v = ncc(above, below, mask); reflection.update({'ncc': round(v, 4), 'present': v > LIMITS['reflection_present_above']})
            if reflection['expected'] and not reflection['present']: warnings.append('MIRROR_FLOOR_WITHOUT_REFLECTION')

    # ---- LUMIÈRE : côté éclairé du produit redessiné (scène) contre la photo restaurée ; et niveau du produit restauré
    left = solid & (np.arange(W)[None, :] < bxa); right = solid & (np.arange(W)[None, :] >= bxa)
    lr = lambda L: (float(L[left].mean()) - float(L[right].mean())) / (float(L[left].mean()) + float(L[right].mean()) + 1e-6) if left.any() and right.any() else None
    m_lr, p_lr = lr(Lm), lr(Lp)
    light = {'scene_lr': None if m_lr is None else round(m_lr, 4), 'photo_lr': None if p_lr is None else round(p_lr, 4), 'consistent': None}
    if m_lr is not None and p_lr is not None:
        light['consistent'] = not (m_lr * p_lr < 0 and abs(m_lr) > 0.1 and abs(p_lr) > 0.05)
        if not light['consistent']: warnings.append('LIGHT_SIDE_DIFFERS_FROM_PHOTO')
    lo, hi = LIMITS['product_level_range']
    level = 1.0
    if solid.any():
        level = float(np.clip(np.percentile(Lm[solid], 90) / max(np.percentile(Lp[solid], 90), 1e-4), lo, hi))
    if abs(level - 1.0) > 0.1: warnings.append('SCENE_PRODUCT_LIGHT_LEVEL_DIFFERS')

    compose_meta = {'bottom_front': [int(bxa), int(bya)], 'top_front': [int(bxa), int(tya)], 'foreground_mask': None, 'slit_y': None,
                    'render_backend': 'SCENE_AROUND_PRODUCT', 'contact_shadow': False, 'product_level': 1.0,
                    'blender_capabilities_used': [], 'resolution': [W, H], 'foreground_props': 0, 'product_photo_untouched': True}
    json.dump(compose_meta, open(out_path + '.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    report = {'pass': not rejections, 'rejections': rejections, 'warnings': warnings, 'resized_from': resized_from,
              'alignment': {'dx': dx, 'dy': dy, 'scale': s, 'edge_ncc': best['edge_ncc'], 'trials': trials},
              'ghost': ghost, 'duplicate': duplicate, 'contact_shadow': shadow, 'reflection': reflection, 'light': light,
              'product_level': 1.0, 'measured_scene_level_ratio': round(level, 4), 'limits': LIMITS, 'compose_meta': compose_meta}
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
