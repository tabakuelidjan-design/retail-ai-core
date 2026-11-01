"""Prepare an AI-generated BACKGROUND for Nordla's existing local compositor.
Does not generate, examine or transmit the source product. Produces the metadata
interface expected by compose_stage.py, preserving the true product photo pixels.
Usage: python prepare_generated_background.py background.png examen.json stage.json
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageOps

def main():
    path = Path(sys.argv[1])
    exam_path = Path(sys.argv[2])
    stage_path = Path(sys.argv[3])
    exam = json.loads(exam_path.read_text(encoding='utf-8'))
    stage = json.loads(stage_path.read_text(encoding='utf-8'))
    if exam.get('status') not in (None, 'CUT_OUT'):
        raise ValueError('PRODUCT_NOT_CUT_OUT')
    bbox = exam['bbox']
    if min(bbox['w'], bbox['h']) <= 0:
        raise ValueError('INVALID_PRODUCT_BBOX')
    camera = stage['camera']
    # The product is grounded on the scene with free space reserved above and
    # below; the fixed pixel geometry is local, NOT invented by the image model.
    product_share = {'WIDE': 0.38, 'MEDIUM': 0.49, 'CLOSE': 0.61}[camera['framing']]
    product_x = {'LEFT_THIRD': 0.29, 'CENTER': 0.5, 'RIGHT_THIRD': 0.71}[camera['product_position']]
    with Image.open(path) as source:
        source.verify()
    with Image.open(path) as source:
        if source.format != 'PNG':
            raise ValueError('BACKGROUND_NOT_PNG')
        w, h = source.size
        if not (512 <= w <= 2048 and 512 <= h <= 2048):
            raise ValueError('BACKGROUND_DIMENSIONS_OUT_OF_RANGE')
        if source.mode not in ('RGB', 'RGBA'):
            source = source.convert('RGB')
        # Preserve all generated background pixels; resize is deterministic
        # and required only if the provider returns another valid dimension.
        source = source.convert('RGB')
        source.save(path, format='PNG', optimize=False)
    bottom = [round(w * product_x), round(h * 0.84)]
    top = [bottom[0], round(bottom[1] - h * product_share)]
    meta = {
        'bottom_front': bottom, 'top_front': top,
        'foreground_mask': None, 'slit_y': None,
        'render_backend': 'GENERATIVE_BACKGROUND',
        'blender_capabilities_used': [],
        'resolution': [w, h],
        'foreground_props': 0,
        'product_photo_untouched': True,
    }
    Path(str(path) + '.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding='utf-8')
    print(json.dumps(meta, ensure_ascii=False))

if __name__ == '__main__':
    main()
