# -*- coding: utf-8 -*-
"""cigpricer 构建单文件 App（支持多张表）

表放在 tables/<表名>/ 下，每张表一个目录：
    list.jpg      原始照片
    names.json    商品名索引（人工/模型校对过）
    sheet.png     整表（由 add_table.py 生成）
    cells/        逐格小图
    grid.json     网格坐标

注入 App 的数据结构（每张表自带 items，与"表包"格式完全一致，
所以 App 里内置表和导入表走同一套渲染/搜索代码）：
    {hot:[...], tables:[{id,name,date,note,colLabels,nCol,nRow,sheetImg,items:[{n,c,r,w,h,img}]}]}

用法：python tools/build_app.py
产出：build/烟价速查.html —— 单文件、离线、手机浏览器直接打开
"""
import os, sys, json, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TABLES = os.path.join(ROOT, 'tables')
BUILD = os.path.join(ROOT, 'build')
os.makedirs(BUILD, exist_ok=True)

HOT = ['中华', '玉溪', '黄鹤楼', '芙蓉王', '利群', '南京', '黄金叶', '白沙',
       '和天下', '七匹狼', '黄山', '真龙', '天子', '泰山', '金圣', '贵烟',
       '555', '万宝路', '兰州', '云烟', '双喜', '好日子']


def discover():
    """扫描 tables/ 下的所有表。返回 [(表名, 索引, 网格, 目录)]，最新的排前面"""
    out = []
    if not os.path.isdir(TABLES):
        raise SystemExit('找不到 tables/ 目录')
    for name in sorted(os.listdir(TABLES)):
        d = os.path.join(TABLES, name)
        if not os.path.isdir(d) or name.startswith('_'):
            continue
        f_idx = os.path.join(d, 'names.json')
        f_grid = os.path.join(d, 'grid.json')
        if not os.path.exists(f_idx):
            print('  跳过 %-10s：还没校对名字（names.json 不存在）' % name)
            continue
        if not os.path.exists(f_grid):
            print('  跳过 %-10s：还没切图（grid.json 不存在）' % name)
            continue
        out.append((name, json.load(open(f_idx, encoding='utf-8')),
                    json.load(open(f_grid, encoding='utf-8')), d))
    # pack_only 的表（names.json 里写了 "pack_only": true）**不打包进 App**，只出表包。
    # 为什么要有这个开关：App 的冒烟/验收脚本是按「内置表只有 1 张（香烟）」写的，
    # 而店主后加的表本来就走「导入表包」这条路（表包进 IndexedDB，不占 App 体积）。
    # 表一多就无脑塞进单文件 HTML，手机每次启动都要多解几 MB base64。
    keep = []
    for name, idx, meta, d in out:
        if idx.get('pack_only'):
            print('  跳过 %-10s：只出表包、不打包进 App（pack_only）' % name)
            continue
        keep.append((name, idx, meta, d))
    out = keep
    # updated 新的排前面；没有 updated 的按目录名排后面
    out.sort(key=lambda t: (t[1].get('updated', ''), t[0]), reverse=True)
    return out


found = discover()
print('发现 %d 张表：' % len(found))

tables, missing = [], []
for ti, (name, idx, meta, d) in enumerate(found):
    t, miss = plib.table_payload(d, name, idx, meta)
    missing += miss
    tables.append(t)
    print('  %-10s %s  %d 个商品（%d列 x %d行）' % (name, idx.get('date', ''),
                                              len(t['items']), meta['n_col'], meta['n_row']))

if missing:
    raise SystemExit('缺少 %d 个格子图，例如 %s\n（names.json 的列/行数可能和当前表格对不上，'
                     '请重跑 add_table.py）' % (len(missing), missing[:3]))
if not tables or not any(t['items'] for t in tables):
    raise SystemExit('没有任何商品：请先跑 add_table.py 加表并校对 names.json')

payload = {'hot': HOT, 'tables': tables}
data_js = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))

n_items = sum(len(t['items']) for t in tables)

tpl = open(os.path.join(ROOT, 'tools', 'app_template.html'), encoding='utf-8').read()
# 切图算法（照片 → 逐格小图）注入进页面。它是 tools/cropjs_src.js 这份唯一源码，
# 原型验证脚本 proto_crop.js 也读同一个文件。
cropjs = open(os.path.join(ROOT, 'tools', 'cropjs_src.js'), encoding='utf-8').read()

# 认字页：整页塞进 App（作为 srcdoc iframe 的来源，见 app_template 的 __OCRHTML__）。
# ⚠️ iframe 里没有相对路径可走，assets/crop.js 必须内联进去，否则切图库加载不上。
# ⚠️ 做成 JSON 字符串常量，并把 </ 转义成 <\/ —— 不然 HTML 解析器会把父页面的
#    <script> 提前闭合；U+2028/2029 在 JS 字符串里是非法换行，也要转义。
ocr_src = os.path.join(ROOT, 'recognizer', 'index.html')
if os.path.exists(ocr_src):
    ocr = open(ocr_src, encoding='utf-8').read()
    ocr = ocr.replace('<script src="assets/crop.js"></script>',
                      '<script>\n' + cropjs + '\n</script>')
    ocr_js = (json.dumps(ocr, ensure_ascii=False)
              .replace('</', '<\\/')
              .replace('\u2028', '\\u2028').replace('\u2029', '\\u2029'))
else:
    print('⚠ 没找到 recognizer/index.html —— App 里的「认字」页签会是空的')
    ocr_js = '""'

html = (tpl.replace('__CROPJS__', cropjs)
           .replace('__OCRHTML__', ocr_js)
           .replace('__DATA__', data_js)
           .replace('__TABLES__', str(len(tables)))
           .replace('__COUNT__', str(n_items)))

# ⚠️ 别查 __CROPJS__：cropjs_src.js 的文件头注释里就写着这个占位符名字，
#    注入之后注释里自然还留着一份，一查就误报（2026-09-25 踩过）。
for ph in ('__OCRHTML__', '__DATA__', '__TABLES__', '__COUNT__'):
    if ph in html:
        raise SystemExit('页面里还残留占位符 %s —— 注入漏了一处，App 会挂' % ph)

out = os.path.join(BUILD, '烟价速查.html')
open(out, 'w', encoding='utf-8').write(html)

# ASCII 名副本：给 Docker 同步服务器（server/public/index.html）托管用，
# 避免 Dockerfile COPY 中文文件名；内容跟中文版完全一致。
out_ascii = os.path.join(BUILD, 'index.html')
open(out_ascii, 'w', encoding='utf-8').write(html)

print()
print('表数          : %d' % len(tables))
print('商品总数      : %d' % n_items)
print('单文件体积    : %.2f MB' % (os.path.getsize(out) / 1048576))
print('输出          : %s' % out)
print('              : %s（服务器托管副本）' % out_ascii)
print('构建时间      : %s' % datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
