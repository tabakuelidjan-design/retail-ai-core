"""TEST FIXTURES ONLY (never used by a real run): a synthetic product photo and SIMULATED provider scenes built from Nordla's plate.

  photo <out.jpg>                                   a dark bottle with a light lid band and a light "logo" on a white studio background
  scenes <plate.png> <plate.png.json> <out_dir>     three simulated provider answers, PNG:
      good.png       a wall + floor scene AROUND the product, the product redrawn by the "model" (blurred, darker, moved 3 px right / 2 px up,
                     2 % larger), a contact shadow and a mirror reflection under it
      moved.png      the same scene, the product redrawn 60 px to the right (beyond the search: must be refused)
      double.png     the good scene plus a second copy of the product elsewhere (must be refused)
      ghost.png      the product redrawn 12 % wider, so its edge shows around the restored one (must be refused)
"""
import json, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage as ndi


def photo(out):
    W, H = 900, 1200
    im = Image.new('RGB', (W, H), (250, 250, 250)); d = ImageDraw.Draw(im)
    d.rounded_rectangle((330, 260, 570, 1050), radius=40, fill=(22, 22, 24))      # body
    d.rounded_rectangle((350, 170, 550, 280), radius=24, fill=(30, 30, 32))       # lid
    d.rectangle((360, 300, 540, 316), fill=(150, 150, 150))                        # lid band
    d.rectangle((405, 860, 495, 890), fill=(225, 225, 225))                        # logo
    d.rectangle((420, 900, 480, 908), fill=(180, 180, 180))                        # small line under the logo
    im.save(out, quality=95)


def scenes(plate_path, meta_path, out_dir):
    plate = np.asarray(Image.open(plate_path).convert('RGB')).astype(np.float32) / 255
    meta = json.load(open(meta_path)); W, H = meta['canvas']
    A = np.asarray(Image.open(meta['mask'])).astype(np.float32) / 255
    bx, by = meta['bottom_front']; box = meta['box']
    y = np.arange(H)[:, None] / H; x = np.arange(W)[None, :] / W
    horizon = (by - 0.18 * box['h']) / H
    wall = 0.20 + 0.10 * np.exp(-((x - 0.7) / 0.35) ** 2) + 0.03 * np.sin(x * 40)
    floor = 0.26 + 0.12 * (y - horizon)
    L = np.where(y < horizon, wall, floor) * np.ones((1, W))
    scene = np.dstack([L * 0.92, L * 0.97, L * 1.06])

    def product_layer(dx, dy, scale, widen=1.0):
        prod = plate * A[..., None]
        ys, xs = np.nonzero(A > 0.01)
        ya, yb, xa, xb = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        crop = np.dstack([prod[ya:yb, xa:xb], A[ya:yb, xa:xb]])
        h, w = crop.shape[:2]; nh, nw = round(h * scale), round(w * scale * widen)
        im = Image.fromarray((crop * 255).astype(np.uint8), 'RGBA').resize((nw, nh), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.8))
        c = np.asarray(im).astype(np.float32) / 255
        out_c = np.zeros((H, W, 3), np.float32); out_a = np.zeros((H, W), np.float32)
        cx = (xa + xb) / 2 + dx; foot = yb + dy
        x0, y0 = round(cx - nw / 2), round(foot - nh)
        out_c[y0:y0 + nh, x0:x0 + nw] = c[..., :3] * 0.85; out_a[y0:y0 + nh, x0:x0 + nw] = c[..., 3]
        return out_c, out_a, (x0, y0, nw, nh)

    def compose(dx, dy, scale, widen=1.0, extra=None):
        s = scene.copy()
        pc, pa, (x0, y0, nw, nh) = product_layer(dx, dy, scale, widen)
        foot = y0 + nh
        # contact shadow
        yy, xx = np.mgrid[0:H, 0:W]
        ell = ((xx - (x0 + nw / 2)) / (nw * 0.75)) ** 2 + ((yy - foot) / (H * 0.012)) ** 2
        s *= (1 - 0.7 * np.exp(-ell * 1.5))[..., None]
        # mirror reflection
        hr = min(nh, H - foot - 1)
        refl = np.flipud(pc[foot - hr:foot]); ra = np.flipud(pa[foot - hr:foot]) * 0.45
        s[foot:foot + hr] = s[foot:foot + hr] * (1 - ra[..., None]) + refl * ra[..., None] * 1.6
        if extra is not None:
            ec, ea, _ = extra
            s = s * (1 - ea[..., None]) + ec
        s = s * (1 - pa[..., None]) + pc
        return s

    out = lambda name, img: Image.fromarray((np.clip(img, 0, 1) * 255).round().astype(np.uint8)).save(f'{out_dir}/{name}', format='PNG')
    out('good.png', compose(3, -2, 1.02))
    out('moved.png', compose(60, 0, 1.0))
    second = product_layer(-int(0.30 * W) if bx > W / 2 else int(0.40 * W), -40, 0.9)
    out('double.png', compose(3, -2, 1.02, extra=second))
    out('ghost.png', compose(0, 0, 1.0, widen=1.12))


if __name__ == '__main__':
    if sys.argv[1] == 'photo': photo(sys.argv[2])
    else: scenes(sys.argv[2], sys.argv[3], sys.argv[4])
