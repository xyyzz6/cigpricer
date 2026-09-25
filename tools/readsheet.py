# -*- coding: utf-8 -*-
"""生成"可读联系表"：把某张表的若干列 x 若干行拼成一张图，带行号/列号，供模型肉眼转录。

用法：
  python tools/_readsheet.py <表名> [--cols 3] [--rows 20] [--scale 2.5] [--from-row 1]

约定：
  - 行号用**整表的行序号**（1 基），跟 grid.json 的 row_bounds 下标 +1 一致，直接对着写 names.json
  - 列号同理（1 基）
  - 输出到 _read/<表名>_r<起>_c<起>.png
"""
import os, sys, json, argparse
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, '_read')

FONT = 'C:/Windows/Fonts/arialbd.ttf'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('table')
    ap.add_argument('--cols', type=int, default=3)
    ap.add_argument('--rows', type=int, default=20)
    ap.add_argument('--scale', type=float, default=2.5)
    ap.add_argument('--from-row', type=int, default=1, help='从第几行开始（1 基）')
    ap.add_argument('--to-row', type=int, default=0, help='到第几行（1 基，0=最后）')
    ap.add_argument('--from-col', type=int, default=1)
    ap.add_argument('--to-col', type=int, default=0)
    a = ap.parse_args()

    d = os.path.join(ROOT, 'tables', a.table)
    meta = json.load(open(os.path.join(d, 'grid.json'), encoding='utf-8'))
    sheet = Image.open(os.path.join(d, 'sheet.png')).convert('RGB')
    cb, rb = meta['col_bounds'], meta['row_bounds']
    n_c, n_r = len(cb), len(rb)
    to_col = a.to_col or n_c
    to_row = a.to_row or n_r
    s = a.scale
    os.makedirs(OUT, exist_ok=True)

    font = ImageFont.truetype(FONT, max(14, int(16 * s)))
    made = []
    for c0 in range(a.from_col, to_col + 1, a.cols):
        cs = list(range(c0, min(c0 + a.cols, to_col + 1)))
        for r0 in range(a.from_row, to_row + 1, a.rows):
            rs = list(range(r0, min(r0 + a.rows, to_row + 1)))
            cw = [int((cb[c - 1][1] - cb[c - 1][0]) * s) for c in cs]
            rh = [int((rb[r - 1][1] - rb[r - 1][0]) * s) for r in rs]
            mg = int(70 * s / 2.5) + 30
            head = int(22 * s) + 8
            W = mg + sum(cw) + 3 * len(cs) + 4
            H = head + sum(rh) + 3 * len(rs) + 4
            img = Image.new('RGB', (W, H), (255, 255, 255))
            dr = ImageDraw.Draw(img)
            x = mg
            for i, c in enumerate(cs):
                dr.text((x + 4, 4), 'C%d' % c, fill=(0, 0, 160), font=font)
                x += cw[i] + 3
            dr.line([(0, head - 2), (W, head - 2)], fill=(200, 0, 0), width=2)
            y = head
            for j, r in enumerate(rs):
                dr.text((4, y + 4), 'R%d' % r, fill=(0, 0, 160), font=font)
                x = mg
                for i, c in enumerate(cs):
                    box = (cb[c - 1][0], rb[r - 1][0], cb[c - 1][1], rb[r - 1][1])
                    cell = sheet.crop(box).resize((cw[i], rh[j]), Image.LANCZOS)
                    img.paste(cell, (x, y))
                    x += cw[i] + 3
                dr.line([(mg, y), (W, y)], fill=(190, 190, 190), width=1)
                y += rh[j] + 3
                dr.line([(0, y - 2), (W, y - 2)], fill=(230, 120, 120), width=1)
            x = mg
            for i, c in enumerate(cs):
                dr.line([(x - 1, 0), (x - 1, H)], fill=(190, 190, 190), width=1)
                x += cw[i] + 3
            name = '%s_r%d_c%d.png' % (a.table, r0, c0)
            img.save(os.path.join(OUT, name))
            made.append('%s  %dx%d  (%d 列 x %d 行)' % (name, W, H, len(cs), len(rs)))
    open(os.path.join(OUT, '_index.txt'), 'w', encoding='utf-8').write('\n'.join(made))
    print('\n'.join(made))


if __name__ == '__main__':
    main()
