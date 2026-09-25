# -*- coding: utf-8 -*-
"""快速体检 names.json：数量/重名/可疑字符"""
import os, sys, json, collections

ROOT = r'E:\boki\cigpricer'
out = []
for name in sorted(os.listdir(os.path.join(ROOT, 'tables'))):
    d = os.path.join(ROOT, 'tables', name)
    f = os.path.join(d, 'names.json')
    if name.startswith('_') or not os.path.exists(f):
        continue
    idx = json.load(open(f, encoding='utf-8'))
    flat = [(ci + 1, ri + 1, n) for ci, col in enumerate(idx['cols'])
            for ri, n in enumerate(col) if n]
    out.append('=== %s（%s）%d 个商品，%d 列 x %d 行 ==='
               % (name, idx.get('date', ''), len(flat), len(idx['cols']),
                  len(idx['cols'][0]) if idx['cols'] else 0))
    cnt = collections.Counter(n for _, _, n in flat)
    dup = {k: v for k, v in cnt.items() if v > 1}
    out.append('  同名多次：%s' % (dup if dup else '无'))
    weird = [n for _, _, n in flat if len(n) > 12 or '?' in n or n.strip() != n]
    out.append('  可疑（过长/含问号/前后空格）：%s' % (weird if weird else '无'))
    lens = sorted(len(n) for _, _, n in flat)
    out.append('  名字长度：最短 %d 最长 %d 中位 %d' % (lens[0], lens[-1], lens[len(lens) // 2]))
open(os.path.join(ROOT, '_names_check.txt'), 'w', encoding='utf-8').write('\n'.join(out))
print('\n'.join(out))
