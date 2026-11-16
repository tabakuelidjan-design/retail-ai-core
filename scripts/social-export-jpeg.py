"""PNG -> JPEG for Meta (the Instagram API takes JPEG only). Never overwrites: refuses an existing output.
usage: python scripts/social-export-jpeg.py <in.png> <out.jpg> [quality]
Opaque sources are converted as is; a source with transparency is flattened on white (reported, so the owner can look)."""
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
quality = int(sys.argv[3]) if len(sys.argv) > 3 else 92
im = Image.open(src)
flattened = False
if im.mode in ("RGBA", "LA", "P"):
    im = im.convert("RGBA")
    bg = Image.new("RGB", im.size, (255, 255, 255))
    bg.paste(im, mask=im.split()[-1])
    im, flattened = bg, True
elif im.mode != "RGB":
    im = im.convert("RGB")
with open(dst, "xb") as out:  # 'x': fail if it exists
    im.save(out, "JPEG", quality=quality, optimize=True, subsampling=0)
print(f"{im.size[0]}x{im.size[1]} flattened={flattened}")
