# -*- coding: utf-8 -*-
"""验收 proto_crop.js 落盘的 JS 版切图（一次性脚本）

验四件事：
  ① 327 张 PNG 都能被 PIL 正常打开、是真 PNG（不是 canvas 真彩糊出来的）
  ② 尺寸与 JS 自报的 w/h 一致
  ③ 跟 Python 切的同名格子尺寸对得上（边界差 1px，允许 ±2）
  ④ 图不是纯色（第一版像素传错时全是纯色，体积小到离谱）
最后拼一张"Python 切 vs JS 切"的对比图，肉眼过一遍。
"""
import os, json, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, 'tools', '_proto_out')
PY = os.path.join(ROOT, 'tables', '香烟', 'cells')

man = json.load(open(os.path.join(JS, 'manifest.json'), encoding='utf-8'))
print('JS 落盘 %d 格' % len(man))

bad_open, bad_size, bad_flat, size_diffs = [], [], [], []
modes = {}
total = 0
for m in man:
    f = os.path.join(JS, 'all', m['f'])
    try:
        im = Image.open(f)
        im.load()
    except Exception as e:
        bad_open.append((m['f'], str(e)))
        continue
    total += os.path.getsize(f)
    modes[(im.mode, im.size)] = modes.get((im.mode, im.size), 0) + 1
    if (im.width, im.height) != (m['w'], m['h']):
        bad_size.append((m['f'], im.size, (m['w'], m['h'])))
    # 纯色检测：颜色数
    cols = im.convert('RGB').getcolors(maxcolors=1 << 16)
    if cols is None or len(cols) <= 1:
        bad_flat.append(m['f'])
    # 与 Python 版对比
    pf = os.path.join(PY, m['f'])
    if os.path.exists(pf):
        pw, ph = Image.open(pf).size
        size_diffs.append((m['f'], (pw, ph), (im.width, im.height)))

print('① 能打开      : %d/%d %s' % (len(man) - len(bad_open), len(man), '全部 OK' if not bad_open else '失败 %s' % bad_open[:3]))
print('② 尺寸与自报一致: %s' % ('全部 OK' if not bad_size else '不符 %s' % bad_size[:3]))
print('③ 非纯色      : %s' % ('全部 OK' if not bad_flat else '纯色 %d 个 %s' % (len(bad_flat), bad_flat[:5])))
print('   合计体积    : %.2f MB  平均 %.1f KB/格' % (total / 1048576, total / len(man) / 1024))
print('   模式分布    : %s' % {str(k): v for k, v in list(modes.items())[:4]})

if size_diffs:
    dw = [abs(a[0] - b[0]) for _, a, b in size_diffs]
    dh = [abs(a[1] - b[1]) for _, a, b in size_diffs]
    same = sum(1 for _, a, b in size_diffs if a == b)
    print('④ 对比 Python : %d/%d 尺寸完全相同；宽最大差 %d、高最大差 %d'
          % (same, len(size_diffs), max(dw), max(dh)))

# 拼对比图：PIL 版在上、JS 版在下，取几个不同列/行
picks = ['c1r02.png', 'c2r15.png', 'c4r07.png', 'c6r30.png', 'c8r41.png', 'c1r41.png']
rows = []
for f in picks:
    pf, jf = os.path.join(PY, f), os.path.join(JS, 'all', f)
    if not (os.path.exists(pf) and os.path.exists(jf)):
        continue
    a, b = Image.open(pf).convert('RGB'), Image.open(jf).convert('RGB')
    w = max(a.width, b.width)
    strip = Image.new('RGB', (w, a.height + b.height + 6), (255, 0, 0))
    strip.paste(a, (0, 0))
    strip.paste(b, (0, a.height + 6))
    rows.append((f, strip))

if rows:
    W = max(s.width for _, s in rows)
    H = sum(s.height + 10 for _, s in rows)
    canvas = Image.new('RGB', (W, H), (210, 210, 210))
    y = 0
    for i, (f, s) in enumerate(rows):
        canvas.paste(s, (0, y))
        y += s.height + 10
    out = os.path.join(JS, 'compare.png')
    canvas.save(out)
    print('\n对比图: %s  (%d 组，每组上=Python 切，下=JS 切，红/灰条为分隔)'
          % (out, len(rows)))

# 整表图
sh = os.path.join(JS, 'sheet_js.png')
if os.path.exists(sh):
    im = Image.open(sh)
    print('整表图: %s  %s  %.2f MB' % (im.size, im.mode, os.path.getsize(sh) / 1048576))

ok = not bad_open and not bad_size and not bad_flat
print('\n%s' % ('验收通过 ✓' if ok else '有问题 ✗'))
sys.exit(0 if ok else 1)
