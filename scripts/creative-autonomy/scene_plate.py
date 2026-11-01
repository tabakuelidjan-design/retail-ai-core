"""Nordla — plaque de scène (moteur local, sans fournisseur).

La vraie photo détourée est posée sur une toile neutre, au format final, exactement là où le compositeur la remettra ensuite.
C'est la RÉFÉRENCE envoyée au modèle d'édition : il construit la scène autour d'un objet qu'il voit, à sa place, à sa taille.
Le placement est la copie conforme de compose_stage.py (même formule, même rééchantillonnage) : un test le vérifie au pixel près.

Usage : python scene_plate.py <examen.json> <produit_rgba.png> <stage.json> <largeur> <hauteur> <plaque.png>
Écrit <plaque.png> et <plaque.png>.json : { canvas, bottom_front, top_front, box, plate_grey, mask }.
"""
import json, sys
import numpy as np
from PIL import Image

# géométrie du produit dans le cadre : décidée par le STAGE de Nordla (cadrage, position), jamais par le modèle d'image
PRODUCT_SHARE = {'WIDE': 0.38, 'MEDIUM': 0.49, 'CLOSE': 0.61}
PRODUCT_X = {'LEFT_THIRD': 0.29, 'CENTER': 0.5, 'RIGHT_THIRD': 0.71}
BASE_Y = 0.84  # le pied du produit : la bande du bas reste libre pour le sol, l'ombre et le reflet
PLATE_GREY = 118  # gris neutre : rien que le modèle puisse prendre pour un décor


def geometry(stage, W, H):
    cam = stage['camera']
    bx = round(W * PRODUCT_X[cam['product_position']]); by = round(H * BASE_Y)
    ty = round(by - H * PRODUCT_SHARE[cam['framing']])
    return bx, by, ty


def place(exam, rgba_path, bx, by, ty):
    """Copie conforme du placement de compose_stage.py : (couleur prémultipliée, alpha, x0, y0, largeur, hauteur)."""
    bb = exam['bbox']
    prod = Image.open(rgba_path).crop((bb['x'], bb['y'], bb['x'] + bb['w'], bb['y'] + bb['h']))
    pw, ph = prod.size
    s = (by - ty) / ph; tw, th = max(1, round(pw * s)), max(1, round(ph * s))
    arr = np.asarray(prod).astype(np.float32) / 255
    prem = np.dstack([arr[..., :3] * arr[..., 3:4], arr[..., 3:4]])
    pr = np.asarray(Image.fromarray((prem * 255).round().astype(np.uint8), 'RGBA').resize((tw, th), Image.LANCZOS)).astype(np.float32) / 255
    x0 = round(bx - tw / 2); y0 = round(by - th)
    return pr, x0, y0, tw, th


def on_canvas(pr, x0, y0, W, H):
    """Le produit placé sur une toile W x H : (couleur prémultipliée H x W x 3, alpha H x W), coupé au cadre."""
    th, tw = pr.shape[:2]
    P = np.zeros((H, W, 3), np.float32); A = np.zeros((H, W), np.float32)
    cx0, cy0 = max(x0, 0), max(y0, 0); cx1, cy1 = min(x0 + tw, W), min(y0 + th, H)
    if cx1 > cx0 and cy1 > cy0:
        P[cy0:cy1, cx0:cx1] = pr[cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0, :3]
        A[cy0:cy1, cx0:cx1] = np.clip(pr[cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0, 3], 0, 1)
    return P, A


def main():
    exam_path, rgba_path, stage_path, W, H, out = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
    exam = json.load(open(exam_path, encoding='utf-8')); stage = json.load(open(stage_path, encoding='utf-8'))
    if exam.get('status') not in (None, 'CUT_OUT'):
        raise SystemExit('PRODUCT_NOT_CUT_OUT')
    bx, by, ty = geometry(stage, W, H)
    pr, x0, y0, tw, th = place(exam, rgba_path, bx, by, ty)
    P, A = on_canvas(pr, x0, y0, W, H)
    plate = P + (PLATE_GREY / 255) * (1 - A[..., None])
    Image.fromarray((np.clip(plate, 0, 1) * 255).round().astype(np.uint8)).save(out, format='PNG')
    mask = out + '.mask.png'
    Image.fromarray((A * 255).round().astype(np.uint8), 'L').save(mask, format='PNG')
    meta = {'canvas': [W, H], 'bottom_front': [bx, by], 'top_front': [bx, ty], 'box': {'x0': x0, 'y0': y0, 'w': tw, 'h': th},
            'plate_grey': PLATE_GREY, 'mask': mask, 'product_photo_untouched': True}
    json.dump(meta, open(out + '.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps(meta, ensure_ascii=False))


if __name__ == '__main__':
    main()
