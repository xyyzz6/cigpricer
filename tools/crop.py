# -*- coding: utf-8 -*-
"""裁剪并放大图片局部，用于人眼/视觉模型读取。用法：
    python crop.py <src> <x> <y> <w> <h> <scale> <out>
"""
import sys
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
src, x, y, w, h, scale, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), float(sys.argv[6]), sys.argv[7]
im = Image.open(src).convert('RGB')
box = (x, y, x + w, y + h)
c = im.crop(box)
c = c.resize((int(c.width * scale), int(c.height * scale)), Image.LANCZOS)
c.save(out)
print('saved', out, c.size)
