# -*- coding: utf-8 -*-
"""cigpricer 公共库：照片 -> 整表 -> 逐格小图 -> 表数据

被 add_table.py / build_app.py / make_pack.py 共同使用。只依赖 numpy + PIL。

★ table_payload() 是"表"这个概念的唯一定义：
  内嵌进单文件 App 的表、导出成表包的"表"、都是它的产物 —— 结构完全一致，
  所以 App 里"内置表"和"导入表"能走完全相同的渲染/搜索代码路径。
"""
import os, io, json, math, base64
import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None

DARK = 160       # 灰度阈值：低于它算"黑"
LINE_THR = 0.55  # 一列/一行里有 55% 是黑的，才认作表格线（手写内容达不到）
MIN_GAP = 8      # 两条线离得比这还近就并成一条（防双线）
UPSCALE = 4      # 逐格小图放大倍数
STRIP_SCALE = 3  # 校对长条放大倍数
PAD = 1          # 四边外扩：网格线只有 1~2px 宽，取中心线会切掉一半；外扩 1px 刚好包住整条线


def find_lines(ratio, thr=LINE_THR, min_gap=MIN_GAP):
    """从"每列/每行暗像素占比"里找出表格线中心坐标"""
    idx = np.where(ratio > thr)[0]
    grp = []
    if len(idx):
        s = p = idx[0]
        for i in idx[1:]:
            if i <= p + 2:
                p = i
            else:
                grp.append((s, p)); s = p = i
        grp.append((s, p))
    out = []
    for a_, b_ in grp:
        c = (a_ + b_) / 2.0
        if out and c - out[-1] < min_gap:
            out[-1] = (out[-1] + c) / 2.0
        else:
            out.append(c)
    return [int(round(v)) for v in out]


def group_columns(xs):
    """把竖线两两成组：宽的当商品名，紧跟的窄的当价格 -> 合成一个商品格"""
    out = []
    i = 0
    while i + 1 < len(xs):
        a, b = xs[i], xs[i + 1]
        if i + 2 < len(xs) and (xs[i + 2] - b) < (b - a) * 0.7:
            out.append((a, xs[i + 2])); i += 2
        else:
            out.append((a, b)); i += 1
    return out


def pair_columns(xs, left=0):
    """把竖线**两两成组**：不管宽窄，一格 = 「商品名称 + 批发价」。

    什么时候用它：版式是 `[商品名称][批发价]` 交替、而且两列宽度差不多的时候。
    打分版式（真实案例「出货行情表」）列宽是 95/50、88/45、99/48 … —— 名称列与价格列
    只差两倍，`group_columns` 的 0.7 判据在**最后一组**会失手（99 与 76 → 76 > 99*0.7），
    于是一行切成 7 格而不是 6 格。

    代价：它假定**每一格都是「名称+价格」**。
    所以只给"结构已知的规整表"用（add_table.py --pair），不要拿它当默认。

    ⚠️ 这类表的竖线是**交替**出现的（实测「行情9月14日」间距 53/109/53/109…）：
        第 1 格的「名称|价格」线 → 第 1/2 格边界 → 第 2 格的「名称|价格」线 → …
      照"索引 0/2/4 硬配对"来，遇到**第一条线是格内线**的图（第 1 格的名称列左边界
      就贴在图片边缘、检测不到竖线）会**整表错位一格**，而且最左边一整格被漏掉。
      实盘踩过：那张图左边一整列「好日子」系列（41 个商品）被当成"没名字的孤儿价格列"
      裁掉了，表里少了整整一列。
      所以先看头两段间距：**窄的先来 → 首条线是格内线**，得把 [left, xs[1]] 补回来。
    """
    if len(xs) < 2:
        return []
    d = [xs[i + 1] - xs[i] for i in range(len(xs) - 1)]
    out, i = [], 0
    if len(d) > 1 and d[0] < d[1]:
        # 首条线是"名称|价格"线 → 它前面还贴着完整的一格（名称列从图片左边缘起）
        out.append((left, xs[1]))
        i = 1
    while i + 2 < len(xs):
        out.append((xs[i], xs[i + 2])); i += 2
    if i + 1 < len(xs):
        out.append((xs[i], xs[i + 1]))
    return out


def orient_score(col_bounds, ys):
    """判断这个朝向是不是"正着看"。

    表格的单元格一定是扁长的（宽 > 高）：商品名横排、行密密麻麻。
    所以「列组宽中位数 ÷ 行高中位数」明显大于 1 才是正确朝向；
    躺着的表格这个值会小于 1（宽变成了行高）。
    """
    if len(col_bounds) < 2 or len(ys) < 3:
        return 0.0
    cw = sorted(b - a for a, b in col_bounds)
    rh = sorted(ys[i + 1] - ys[i] for i in range(len(ys) - 1))
    return cw[len(cw) // 2] / max(rh[len(rh) // 2], 1)


def analyze(photo_path, out_dir, upscale=UPSCALE, pad=PAD, force_rotate=None, pair_cols=False):
    """照片 -> 整表 + 网格坐标。产出 <out_dir>/sheet.png 与 grid.json

    方向：默认在 0°/90° 里挑单元格更"扁长"的那个。
    自动判定只看几何，分不出正看还是倒看 —— 如果切出来的字是倒的，
    用 add_table.py --rotate 270 显式指定。

    pair_cols=True：列**两两成组**（[商品名称][批发价] 交替的版式用这个），
    而不是靠"宽列后面跟窄列"去猜。见 pair_columns() 的说明。
    """
    os.makedirs(out_dir, exist_ok=True)
    im = Image.open(photo_path).convert('RGB')

    cands = [force_rotate] if force_rotate is not None else [0, 90]
    best = None
    for ang in cands:
        sh = im.rotate(ang, expand=True) if ang else im
        g = np.asarray(sh.convert('L'), dtype=np.uint8)
        dark = (g < DARK)
        xs = find_lines(dark.mean(axis=0))
        ys = find_lines(dark.mean(axis=1))
        cols = pair_columns(xs, left=0) if pair_cols else group_columns(xs)
        score = orient_score(cols, ys)
        if score <= 0:
            continue
        if best is None or score > best[0]:
            best = (score, ang, sh, xs, ys, cols)
    if best is None:
        raise SystemExit('网格线检测失败：请确认照片里是完整、平整的表格')
    if best[0] < 1.2:
        raise SystemExit('网格线检测到了、但格子的宽高比不像一张表格（%.2f）。\n'
                         '请把照片拍正、拍平（表格四边都进画面），或用 --rotate 指定方向。' % best[0])

    score, ang, sheet, xs, ys, col_bounds = best
    row_bounds = [(ys[i], ys[i + 1]) for i in range(len(ys) - 1)]
    W, H = sheet.size
    sheet.save(os.path.join(out_dir, 'sheet.png'))

    meta = {'rotate': ang, 'sheet': [W, H], 'col_bounds': col_bounds,
            'row_bounds': row_bounds, 'upscale': upscale, 'pad': pad,
            'n_col': len(col_bounds), 'n_row': len(row_bounds)}
    json.dump(meta, open(os.path.join(out_dir, 'grid.json'), 'w'), indent=1)

    # ---- 逐格切图 ----
    cells = os.path.join(out_dir, 'cells')
    os.makedirs(cells, exist_ok=True)
    for ci, (x0, x1) in enumerate(col_bounds, 1):
        for ri, (y0, y1) in enumerate(row_bounds, 1):
            box = (max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad))
            c = sheet.crop(box)
            c = c.resize((c.width * upscale, c.height * upscale), Image.LANCZOS)
            c.save(os.path.join(cells, 'c%dr%02d.png' % (ci, ri)))

    # ---- 校对长条（每列分两段） ----
    strips = os.path.join(out_dir, 'strips')
    os.makedirs(strips, exist_ok=True)
    half = math.ceil(len(row_bounds) / 2)
    for ci, (x0, x1) in enumerate(col_bounds, 1):
        for pi in range(2):
            rs = row_bounds[pi * half:(pi + 1) * half]
            if not rs:
                continue
            c = sheet.crop((x0, rs[0][0], x1, rs[-1][1]))
            c = c.resize((c.width * STRIP_SCALE, c.height * STRIP_SCALE), Image.LANCZOS)
            c.save(os.path.join(strips, 'g%d_p%d.png' % (ci, pi + 1)))

    return meta


def blank_index(meta, name, date, col_labels=None, note=''):
    """生成待校对的名字骨架"""
    n = meta['n_row']
    return {
        'name': name,
        'date': date,
        'note': note,
        'col_labels': col_labels or ['第%d列' % i for i in range(1, meta['n_col'] + 1)],
        'cols': [[None] * n for _ in range(meta['n_col'])],
    }


PAL_CELL = 16        # 逐格小图调色板色数（16 色肉眼与原件无异，体积仅 1/5）
PAL_SHEET = 96       # 整表调色板色数
SHARPEN_CELL = 60    # 逐格小图轻度锐化，补偿源照片分辨率不足

PACK_FMT = 'cigpricer.table'
PACK_V = 1


def b64_png(im, colors, sharpen=0):
    """PIL 图 -> data:image/png;base64,xxx（调色板压缩，体积约为 RGB 的 1/5）"""
    im = im.convert('RGB')
    if sharpen:
        im = im.filter(ImageFilter.UnsharpMask(radius=1.2, percent=sharpen, threshold=2))
    b = io.BytesIO()
    im.quantize(colors=colors, method=Image.MEDIANCUT).save(b, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(b.getvalue()).decode()


def sheet_rotate(d, meta):
    """这张表当前照片的旋转角（0/90/180/270）。

    App 里「换照片」要沿用它：同一个人拍同一张纸，方向基本不变，
    而且**纯几何分不出正看还是倒看**（90° 和 270° 的扁长比完全相同），
    沿用旧表的角度是唯一可靠的定正反的办法。

    早期生成的 grid.json 没写 rotate，就用 list.jpg 与 sheet.png 的尺寸反推：
    宽高对调说明转过 90°（自动判定只在 0/90 里挑，所以是 90）。
    推不出来返回 None，让 App 自己按几何判。
    """
    r = meta.get('rotate')
    if r is not None:
        return int(r)
    p = os.path.join(d, 'list.jpg')
    if not os.path.exists(p):
        return None
    pw, ph = Image.open(p).size
    sw, sh = meta['sheet']
    if (pw, ph) == (sw, sh):
        return 0
    if (pw, ph) == (sh, sw):
        return 90
    return None


def table_payload(d, name, idx, meta):
    """tables/<name>/ 目录 -> App / 表包共用的表数据

    返回 (表字典, 缺失的格子图列表)。表字典结构：
      {id, name, date, note, colLabels, nCol, nRow, rot, sheetImg, items:[{n,c,r,w,h,img}]}
    """
    col_labels = idx.get('col_labels') or ['第%d列' % i for i in range(1, meta['n_col'] + 1)]
    items, missing = [], []
    for ci, col in enumerate(idx['cols'], 1):
        for ri, nm in enumerate(col, 1):
            if not nm:
                continue
            f = os.path.join(d, 'cells', 'c%dr%02d.png' % (ci, ri))
            if not os.path.exists(f):
                missing.append(f); continue
            im = Image.open(f)
            items.append({'n': nm, 'c': ci, 'r': ri, 'w': im.width, 'h': im.height,
                          'img': b64_png(im, PAL_CELL, SHARPEN_CELL)})
    sheet = os.path.join(d, 'sheet.png')
    return {
        'id': name, 'name': name,
        'date': idx.get('date', ''), 'note': idx.get('note', ''),
        'colLabels': col_labels, 'nCol': meta['n_col'], 'nRow': meta['n_row'],
        'rot': sheet_rotate(d, meta),
        'sheetImg': b64_png(Image.open(sheet), PAL_SHEET) if os.path.exists(sheet) else '',
        'items': items,
    }, missing


def pack_of(table):
    """表 -> 表包（给 App「管理」页导入的文件内容）"""
    return {'fmt': PACK_FMT, 'v': PACK_V, 'table': table}


def carry_over(old_index, meta, date):
    """把上一版的名字清单搬到新表上（尺度一致时），供逐格核对 —— 这是"每天更新"的关键"""
    new = blank_index(meta, old_index.get('name', ''), date,
                      old_index.get('col_labels'), old_index.get('note', ''))
    old_cols = old_index.get('cols') or []
    carried = 0
    for ci in range(meta['n_col']):
        if ci >= len(old_cols):
            continue
        old_col = old_cols[ci]
        for ri in range(meta['n_row']):
            if ri < len(old_col):
                new['cols'][ci][ri] = old_col[ri]
                if old_col[ri]:
                    carried += 1
    return new, carried
