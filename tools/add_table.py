# -*- coding: utf-8 -*-
"""cigpricer 加表 / 更新表

用法：
  # 看现有表和 inbox 待处理照片
  python tools/add_table.py --list

  # 加一张新表
  python tools/add_table.py inbox/九月香烟.jpg --name 香烟 --date 9月24日

  # 同一张表出了新版价格 -> 沿用上一版商品名清单（默认行为），校对起来只需核对变动
  python tools/add_table.py inbox/九月香烟.jpg --name 香烟 --date 9月24日

  # 名字全变了、不想继承
  python tools/add_table.py inbox/酒水.jpg --name 酒水 --date 9月24日 --blank

  # 切出来的字是倒的
  python tools/add_table.py inbox/x.jpg --name 香烟 --rotate 270
"""
import os, sys, json, shutil, argparse, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TABLES = os.path.join(ROOT, 'tables')
INBOX = os.path.join(ROOT, 'inbox')
EXTS = ('.jpg', '.jpeg', '.png', '.webp', '.bmp')


def table_dir(name):
    return os.path.join(TABLES, name)


def read_index(name):
    f = os.path.join(table_dir(name), 'names.json')
    if not os.path.exists(f):
        return None
    return json.load(open(f, encoding='utf-8'))


def load_all():
    """返回 [(表名, names.json, 已填名字数, 总格数)]，按目录名排序（新表在后）"""
    out = []
    if not os.path.isdir(TABLES):
        return out
    for name in sorted(os.listdir(TABLES)):
        d = os.path.join(TABLES, name)
        if not os.path.isdir(d) or name.startswith('_'):
            continue
        idx = read_index(name)
        if idx is None:
            out.append((name, None, 0, 0)); continue
        done = sum(1 for c in idx['cols'] for n in c if n)
        total = sum(1 for c in idx['cols'] for _ in c)
        out.append((name, idx, done, total))
    return out


def cmd_list():
    rows = load_all()
    if not rows:
        print('还没有任何表。把照片丢进 inbox/ 然后跑 add_table.py 吧。')
    for name, idx, done, total in rows:
        if idx is None:
            print('  %-12s  ⚠ 只有图片、还没校对名字' % name)
        else:
            flag = '✅' if done == total and done else '✏️ '
            print('  %s %-12s  %s  %d/%d 格已命名' % (flag, name, idx.get('date', ''), done, total))
    print()
    if os.path.isdir(INBOX):
        imgs = [f for f in sorted(os.listdir(INBOX)) if f.lower().endswith(EXTS)]
        if imgs:
            print('inbox/ 里有 %d 张待处理照片：' % len(imgs))
            for f in imgs:
                print('   ', f)
        else:
            print('inbox/ 是空的。')
    else:
        print('inbox/ 目录还不存在（第一次用 add_table.py 会自动建）。')


def cmd_add(a):
    src = a.photo
    if not os.path.exists(src):
        raise SystemExit('找不到照片：%s' % src)
    name = a.name
    d = table_dir(name)
    os.makedirs(d, exist_ok=True)
    os.makedirs(INBOX, exist_ok=True)

    old = read_index(name)
    if old:
        hist = os.path.join(d, '_history')
        os.makedirs(hist, exist_ok=True)
        stamp = old.get('date', 'prev').replace('/', '-').replace(' ', '')
        shutil.copy(os.path.join(d, 'names.json'),
                    os.path.join(hist, 'names-%s.json' % stamp))
        print('已归档上一版名字清单 -> tables/%s/_history/names-%s.json' % (name, stamp))

    # 照片留档
    ext = os.path.splitext(src)[1].lower() or '.jpg'
    dst = os.path.join(d, 'list' + ext)
    if os.path.abspath(src) != os.path.abspath(dst):
        shutil.copy(src, dst)
    print('照片 -> tables/%s/list%s' % (name, ext))

    meta = plib.analyze(dst, d, force_rotate=a.rotate, pair_cols=a.pair)
    print('版式：%d 列组 x %d 行（旋转 %d°）%s' % (
        meta['n_col'], meta['n_row'], meta['rotate'],
        '（成对分列：[商品名称|批发价] 合成一格）' if a.pair else ''))

    if old and not a.blank:
        idx, carried = plib.carry_over(old, meta, a.date)
        idx['name'] = name
        note = a.note or old.get('note', '')
        idx['note'] = note
        print('已沿用上一版名字：%d 格（其中 %d 格有名字，核对时只需看变动处）' % (carried, carried))
    else:
        idx = plib.blank_index(meta, name, a.date, note=a.note or '')
        print('生成空白名字骨架：%d 格待命名' % (meta['n_col'] * meta['n_row']))

    if a.note:
        idx['note'] = a.note
    idx['source'] = os.path.basename(dst)
    idx['updated'] = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
    json.dump(idx, open(os.path.join(d, 'names.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)

    print()
    print('下一步：')
    print('  1) python tools/review.py %s        # 生成"左图右名"对照图' % name)
    print('     扫一眼找出"图里的字 ≠ 右边名字"的那几格，改 tables/%s/names.json' % name)
    print('  2) python tools/build_app.py         # 重新生成 App')
    print('  3) node tools/smoke.js               # 自检')


def main():
    p = argparse.ArgumentParser(description='给烟价速查加一张表 / 更新一张表')
    p.add_argument('photo', nargs='?', help='照片路径（也可以直接给 inbox/ 里的文件）')
    p.add_argument('--name', help='表名，也是目录名，例如 香烟 / 酒水 / 饮料')
    p.add_argument('--date', default=datetime.datetime.now().strftime('%m月%d日'),
                   help='表上写的日期，用于显示，例如 9月24日')
    p.add_argument('--note', default='', help='备注')
    p.add_argument('--rotate', type=int, default=None, choices=[0, 90, 180, 270],
                   help='强制旋转角度（切出来的字是倒的时用）')
    p.add_argument('--blank', action='store_true', help='不沿用上一版名字，生成空白骨架')
    p.add_argument('--pair', action='store_true',
                   help='列两两成组（[商品名称][批发价] 交替的规整表用；默认靠宽窄自动判）')
    p.add_argument('--list', action='store_true', help='列出已有表和 inbox 待处理照片')
    a = p.parse_args()

    if a.list or not a.photo:
        cmd_list()
        return
    if not a.name:
        raise SystemExit('新表请用 --name 指定表名，例如 --name 香烟')
    cmd_add(a)


if __name__ == '__main__':
    main()
