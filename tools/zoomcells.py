# -*- coding: utf-8 -*-
"""把指定的若干格放大叠成一张图（复核用）

用法：python tools/_zoomcells.py <表名> <输出> <scale> c,r c,r c,r ...
"""
import os, sys, json
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = 'C:/Windows/Fonts/arialbd.ttf'


def main():
    table, out, scale = sys.argv[1], sys.argv[2], float(sys.argv[3])
    pairs = []
    for a in sys.argv[4:]:
        c, r = a.split(',')
        pairs.append((int(c), int(r)))
    d = os.path.join(ROOT, 'tables', table)
    meta = json.load(open(os.path.join(d, 'grid.json'), encoding='utf-8'))
    sheet = Image.open(os.path.join(d, 'sheet.png')).convert('RGB')
    cb, rb = meta['col_bounds'], meta['row_bounds']
    font = ImageFont.truetype(FONT, 22)
    segs = []
    W = 0
    for c, r in pairs:
        x0, y0, x1, y1 = cb[c - 1][0], rb[r - 1][0], cb[c - 1][1], rb[r - 1][1]
        cell = sheet.crop((x0, y0, x1, y1))
        cell = cell.resize((int(cell.width * scale), int(cell.height * scale)), Image.LANCZOS)
        segs.append(((c, r), cell))
        W = max(W, cell.width + 150)
    H = sum(s.height + 8 for _, s in segs) + 10
    img = Image.new('RGB', (W, H), (255, 255, 255))
    dr = ImageDraw.Draw(img)
    y = 6
    for (c, r), s in segs:
        dr.text((6, y + s.height // 2 - 12), 'C%dR%d' % (c, r), fill=(200, 0, 0), font=font)
        img.paste(s, (140, y))
        y += s.height + 8
    img.save(out)
    print('%s -> %s  %dx%d  %d 格' % (table, out, img.width, img.height, len(segs)))


if __name__ == '__main__':
    main()
