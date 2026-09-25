# -*- coding: utf-8 -*-
"""生成自检用的表包夹具（不是真实数据，只用于跑 tools/smoke.js）

产出 tools/fixtures/：
  测试酒水.cigtable.json       2 列 x 3 行 = 6 个商品
  测试酒水-更新.cigtable.json   同名表的新一版（日期不同、多一个商品）→ 验"更新"语义
  测试饮料.cigtable.json       另一张全新的表 → 验"一次选多个表包"能全都进来
  坏包.json                    格式不对，验错误处理
"""
import os, sys, io, json, base64
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plib
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'fixtures')
os.makedirs(OUT, exist_ok=True)

FONT = None
for f in (r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\simhei.ttf', r'C:\Windows\Fonts\simsun.ttc'):
    if os.path.exists(f):
        FONT = f
        break

COLS = [
    ('白酒', [('飞天茅台', 2380), ('五粮液普五', 1050), ('洋河梦之蓝', 620)]),
    ('啤酒', [('青岛纯生', 6), ('雪花勇闯', 5), ('百威听装', 8)]),
]
COLS2 = [
    ('白酒', [('飞天茅台', 2380), ('五粮液普五', 1050), ('洋河梦之蓝', 620), ('国窖1573', 900)]),
    ('啤酒', [('青岛纯生', 6), ('雪花勇闯', 5), ('百威听装', 8)]),
]
# 另一张表：验"一次选多个表包"时，全新的表和同名的表能在同一次里各走各的
COLS3 = [
    ('饮料', [('可口可乐', 4), ('元气森林', 6)]),
    ('矿泉水', [('农夫山泉', 2), ('怡宝', 2)]),
]


def cell_img(name, price):
    W, H = 340, 52
    im = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(im)
    f1 = ImageFont.truetype(FONT, 24) if FONT else ImageFont.load_default()
    f2 = ImageFont.truetype(FONT, 26) if FONT else ImageFont.load_default()
    d.text((10, 12), name, font=f1, fill='black')
    d.text((250, 10), str(price), font=f2, fill=(200, 20, 20))
    d.rectangle([0, 0, W - 1, H - 1], outline='black')
    return im


def make_table(name, date, cols):
    items = []
    labels = []
    for ci, (lab, rows) in enumerate(cols, 1):
        labels.append(lab)
        for ri, (nm, pr) in enumerate(rows, 1):
            im = cell_img(nm, pr)
            items.append({'n': nm, 'c': ci, 'r': ri, 'w': im.width, 'h': im.height,
                          'img': plib.b64_png(im, plib.PAL_CELL, plib.SHARPEN_CELL)})
    sheet = Image.new('RGB', (720, 200), 'white')
    return {'id': name, 'name': name, 'date': date, 'note': '自检夹具',
            'colLabels': labels, 'nCol': len(cols),
            'nRow': max(len(r) for _, r in cols),
            'sheetImg': plib.b64_png(sheet, plib.PAL_SHEET), 'items': items}


def w(fn, obj):
    p = os.path.join(OUT, fn)
    json.dump(obj, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('  %-28s %6.1f KB' % (fn, os.path.getsize(p) / 1024))


print('生成表包夹具 -> tools/fixtures/')
w('测试酒水.cigtable.json', plib.pack_of(make_table('测试酒水', '9月1日', COLS)))
w('测试酒水-更新.cigtable.json', plib.pack_of(make_table('测试酒水', '10月1日', COLS2)))
w('测试饮料.cigtable.json', plib.pack_of(make_table('测试饮料', '10月2日', COLS3)))
w('坏包.json', {'hello': 'world'})
print()
print('注意：这些是自检夹具，不是真实价目表。')
