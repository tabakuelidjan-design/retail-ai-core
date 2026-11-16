"""Synthetic sets for the support check (test/creative-support-check.test.js): a wall, a lit top plane, a darker vertical face, a floor, drawn with soft edges and a little seeded noise.
   python support_fixtures.py <kind> <out_dir>      kind: edge | plane | face | diagonal | flat
Each kind writes set.png and plate.json (the planned point of support, the reserved box, the lowest point of the product)."""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

W, H = 1080, 1350
CONTACT = (540, 1134)


def build(kind):
    rng = np.random.default_rng(7)
    img = np.full((H, W), 40.0, np.float32)           # wall
    r = np.arange(H)
    yy = r[:, None]
    if kind == 'flat':
        img[:] = 70.0
    else:
        if kind == 'edge':            # a lit top plane from y=1000 to the front edge exactly at the planned point, a dark face under it
            top, front, floor = 1000, 1134, 1290
        elif kind == 'plane':         # the planned point stands 70 px BEHIND the front edge, on the top plane
            top, front, floor = 950, 1204, 1320
        else:                         # 'face' and 'diagonal': the front edge is drawn far above the planned point
            top, front, floor = 800, 930, 1290
        img[(r >= top) & (r < front), :] = 125.0
        img[(r >= front) & (r < floor), :] = 55.0
        img[r >= floor, :] = 30.0
        if kind == 'diagonal':        # the front edge is a perspective diagonal: it falls 0.30 px per px to the right
            xs = np.arange(W)[None, :]
            edge_y = 700 + 0.30 * xs
            img = np.where(yy < 560, 40.0, np.where(yy < edge_y, 125.0, np.where(yy < 1290, 55.0, 30.0))).astype(np.float32)
    img += rng.normal(0, 1.2, img.shape).astype(np.float32)
    im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), 'L').filter(ImageFilter.GaussianBlur(1.6)).convert('RGB')
    return im


if __name__ == '__main__':
    kind, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    build(kind).save(os.path.join(out, 'set.png'))
    plate = {'canvas': [W, H], 'box': {'x0': 300, 'y0': 570, 'w': 457, 'h': 662}, 'contact_front': list(CONTACT), 'bottom_front': [540, 1232], 'top_front': [540, 570]}
    json.dump(plate, open(os.path.join(out, 'plate.json'), 'w'))
    print(out)
