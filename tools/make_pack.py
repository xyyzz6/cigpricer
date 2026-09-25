# -*- coding: utf-8 -*-
"""cigpricer 导出「表包」——给 App 的「管理」页导入用

为什么需要表包：App 是单个离线 HTML，里面的表是构建时写死的。
店主后面拍的新表不重新构建 App 也能用 —— 只要拿一个表包（.cigtable.json）
在 App 的「管理」页点「导入表包」选它，表就进 App 了，立刻能搜。

用法：
  python tools/make_pack.py --list          # 看有哪些表、能不能打包
  python tools/make_pack.py 酒水            # 导出单张表
  python tools/make_pack.py 酒水 饮料 --all # 导出多张
  python tools/make_pack.py --all           # 导出全部

产出：build/pack/<表名>.cigtable.json
      这个文件直接发给店主（手机/微信都能收），在 App 里选它即可。
"""
import os, sys, json, argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TABLES = os.path.join(ROOT, 'tables')
OUTDIR = os.path.join(ROOT, 'build', 'pack')


def load_table(name):
    d = os.path.join(TABLES, name)
    if not os.path.isdir(d):
        raise SystemExit('没有这张表：%s（可用 --list 看现有表）' % name)
    f_idx = os.path.join(d, 'names.json')
    f_grid = os.path.join(d, 'grid.json')
    if not os.path.exists(f_idx):
        raise SystemExit('%s 还没校对名字（缺 names.json）' % name)
    if not os.path.exists(f_grid):
        raise SystemExit('%s 还没切图（缺 grid.json），先跑 add_table.py' % name)
    idx = json.load(open(f_idx, encoding='utf-8'))
    meta = json.load(open(f_grid, encoding='utf-8'))
    return d, idx, meta


def verify(path, table):
    """读回来重新校验一遍：解析得出的 JSON 必须是有效表包 —— 防"文件生成了但打不开" """
    p = json.load(open(path, encoding='utf-8'))
    problems = []
    if p.get('fmt') != plib.PACK_FMT:
        problems.append('fmt 不对')
    if p.get('v') != plib.PACK_V:
        problems.append('v 不对')
    t = p.get('table') or {}
    if t.get('name') != table['name']:
        problems.append('表名对不上')
    items = t.get('items') or []
    if len(items) != len(table['items']):
        problems.append('商品数 %d != %d' % (len(items), len(table['items'])))
    if any(not x.get('img', '').startswith('data:image/png;base64,') for x in items):
        problems.append('有 item 的图不是内嵌 PNG')
    if any(not x.get('n') for x in items):
        problems.append('有 item 没名字')
    if items and any(x['c'] < 1 or x['r'] < 1 or x['w'] < 1 or x['h'] < 1 for x in items):
        problems.append('有 item 的列/行/宽高不合法')
    cols = set(x['c'] for x in items)
    if t.get('nCol') != len(cols) and t.get('nCol'):
        pass    # 空列是允许的（那列全是空格）
    return problems


def pack_one(name):
    d, idx, meta = load_table(name)
    table, missing = plib.table_payload(d, name, idx, meta)
    if missing:
        raise SystemExit('%s 缺 %d 个格子图，例如 %s\n（names.json 的列/行数可能和表格对不上）'
                         % (name, len(missing), missing[:3]))
    if not table['items']:
        raise SystemExit('%s 一个商品名都没有，没东西可打包' % name)

    os.makedirs(OUTDIR, exist_ok=True)
    path = os.path.join(OUTDIR, '%s.cigtable.json' % name)
    json.dump(plib.pack_of(table), open(path, 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))

    bad = verify(path, table)
    size = os.path.getsize(path)
    print('  %-10s %s  %3d 个商品  %5.2f MB  -> build/pack/%s.cigtable.json'
          % (name, idx.get('date', ''), len(table['items']), size / 1048576, name))
    if bad:
        print('     ⚠ 自检没过：%s' % ('；'.join(bad)))
    else:
        print('     自检通过（读回来重新解析：格式/表名/商品数/内嵌图 全部正常）')
    return path


def cmd_list():
    if not os.path.isdir(TABLES):
        print('还没有 tables/ 目录。')
        return
    names = [n for n in sorted(os.listdir(TABLES))
             if os.path.isdir(os.path.join(TABLES, n)) and not n.startswith('_')]
    if not names:
        print('还没有任何表。')
        return
    print('现有表：')
    for n in names:
        d = os.path.join(TABLES, n)
        ok = os.path.exists(os.path.join(d, 'names.json')) and os.path.exists(os.path.join(d, 'grid.json'))
        idx = json.load(open(os.path.join(d, 'names.json'), encoding='utf-8')) \
            if os.path.exists(os.path.join(d, 'names.json')) else {}
        cnt = sum(1 for c in idx.get('cols', []) for x in c if x) or 0
        pk = os.path.join(OUTDIR, '%s.cigtable.json' % n)
        flag = '✅' if ok and cnt else '⚠️ '
        print('  %s %-10s %s  %3d 个商品  %s' % (
            flag, n, idx.get('date', ''), cnt,
            ('已有表包 build/pack/%s.cigtable.json' % n) if os.path.exists(pk) else '还没导出表包'))


def main():
    p = argparse.ArgumentParser(description='把 tables/<表名>/ 导出成 App 可导入的表包')
    p.add_argument('names', nargs='*', help='表名（可给多个）')
    p.add_argument('--all', action='store_true', help='导出全部表')
    p.add_argument('--list', action='store_true', help='列出已有表')
    a = p.parse_args()

    if a.list or (not a.names and not a.all):
        cmd_list()
        return

    targets = a.names
    if a.all:
        targets = [n for n in sorted(os.listdir(TABLES))
                   if os.path.isdir(os.path.join(TABLES, n)) and not n.startswith('_')]
    print('导出表包：')
    for n in targets:
        pack_one(n)
    print()
    print('把 build/pack/ 里的 .cigtable.json 发给店主，')
    print('在 App 的「管理」页点「导入表包」选它就能用（同名表会自动替换旧的）。')


if __name__ == '__main__':
    main()
