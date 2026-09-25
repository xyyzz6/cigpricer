# -*- coding: utf-8 -*-
"""生成"校对对照图"：左边是表格里那一格的原样，右边是当前 names.json 里的名字。

用途：老板换了一张新表后，names.json 会沿用上一版的名字。
      对着这张对照图扫一眼，**只需要找出"图里的字和右边名字不一样"的那几格**改掉即可，
      不用从零把 41 行重新认一遍。

用法：python tools/review.py 酒水            # 全部列
      python tools/review.py 酒水 3 5        # 只看第 3、5 列
产出：tables/<表名>/review/c<列>-<段>.png
"""
import os, sys, json, textwrap
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TABLES = os.path.join(ROOT, 'tables')
FONT_CANDIDATES = [r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\simhei.ttf',
                   r'C:\Windows\Fonts\simsun.ttc']
ROWS_PER_PAGE = 21     # 每段多少格（41 行分两段，手机上也能看清）
CELL_H = 42            # 每格在对照图里的高度
TEXT_W = 300           # 名字区宽度
PAD = 6


def pick_font(size):
    for f in FONT_CANDIDATES:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def build(table, only_cols=None):
    d = os.path.join(TABLES, table)
    grid = json.load(open(os.path.join(d, 'grid.json'), encoding='utf-8'))
    idx = json.load(open(os.path.join(d, 'names.json'), encoding='utf-8'))
    cells = os.path.join(d, 'cells')
    out = os.path.join(d, 'review')
    os.makedirs(out, exist_ok=True)

    n_row = grid['n_row']
    cols = only_cols or range(1, grid['n_col'] + 1)
    f_txt = pick_font(19)
    f_idx = pick_font(13)
    pages = []

    for ci in cols:
        for pi in range((n_row + ROWS_PER_PAGE - 1) // ROWS_PER_PAGE):
            rs = range(pi * ROWS_PER_PAGE, min(n_row, (pi + 1) * ROWS_PER_PAGE))
            rs = list(rs)
            # 先按比例算出格子缩略图宽度
            sample = os.path.join(cells, 'c%dr%02d.png' % (ci, rs[0] + 1))
            if not os.path.exists(sample):
                continue
            im0 = Image.open(sample)
            cw = int(im0.width * CELL_H / im0.height)

            W = PAD + cw + PAD + TEXT_W + PAD
            H = PAD + len(rs) * (CELL_H + PAD)
            canvas = Image.new('RGB', (W, H), (250, 250, 252))
            dr = ImageDraw.Draw(canvas)

            for k, ri in enumerate(rs):
                y = PAD + k * (CELL_H + PAD)
                f = os.path.join(cells, 'c%dr%02d.png' % (ci, ri + 1))
                if os.path.exists(f):
                    c = Image.open(f).convert('RGB').resize((cw, CELL_H), Image.LANCZOS)
                    canvas.paste(c, (PAD, y))
                else:
                    dr.rectangle([PAD, y, PAD + cw, y + CELL_H], outline=(220, 80, 80))
                name = ''
                if ci - 1 < len(idx['cols']) and ri < len(idx['cols'][ci - 1]):
                    name = idx['cols'][ci - 1][ri] or ''
                tx = PAD + cw + PAD
                # 行号
                dr.text((tx, y + 2), 'R%02d' % (ri + 1), font=f_idx, fill=(150, 150, 158))
                if name:
                    dr.text((tx + 42, y + 11), name[:14], font=f_txt, fill=(20, 20, 24))
                else:
                    dr.text((tx + 42, y + 11), '（空）', font=f_txt, fill=(200, 90, 90))
                if ri % 5 == 4:            # 每 5 行一条浅分隔线，方便数行
                    dr.line([(0, y + CELL_H + PAD // 2), (W, y + CELL_H + PAD // 2)],
                            fill=(228, 228, 234), width=1)

            dr.rectangle([0, 0, W - 1, H - 1], outline=(210, 210, 218))
            p = os.path.join(out, 'c%d-%d.png' % (ci, pi + 1))
            canvas.save(p)
            pages.append(p)
    return pages


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit('用法: python tools/review.py <表名> [列号...]')
    table = sys.argv[1]
    cols = [int(x) for x in sys.argv[2:]] or None
    got = build(table, cols)
    print('生成 %d 张对照图 -> tables/%s/review/' % (len(got), table))
    for p in got:
        print('  ', os.path.basename(p))
