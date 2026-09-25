#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成安卓启动图标 —— 红底 + 白色「价」字。

    python tools/mkicon.py

产出 android/res/mipmap-<density>/：
    ic_launcher.png        传统方形图标（圆角 22%）
    ic_launcher_round.png  传统圆形图标
    ic_launcher_fg.png     自适应图标的前景层（108dp 画布，只画中间安全区里的字）

Android 8+ 走 res/mipmap-anydpi-v26/ic_launcher.xml —— 那个 xml 把
「背景色」和「前景层」拼起来，由系统按各家厂商的形状（圆/方/水滴）去裁。
所以我们只要保证：
  · 背景是纯色（不需要图）
  · 前景层的字落在 **108dp 画布的中间 72dp 安全区** 内，四周留白够，
    这样无论被裁成什么形状，字都不会被切到。

为什么用 PIL 而不是像 douyin-nas 那样在 Node 里手写 SDF 光栅化：
  那边画的是几何图形（能拆成距离函数）；这里要画一个汉字「价」，
  手写字形不现实，直接用系统字体渲染才是正解。图标是"设计资产"，
  只在改设计时重跑，不需要每次打包都生成。
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'android', 'res')

BG = (179, 38, 30, 255)          # #b3261e，与网页 --primary 同色
FG = (255, 255, 255, 255)
SS = 4                            # 超采样倍数：4x 画完再缩，边缘才干净

# 各密度下的传统图标边长（dp=48 的倍数）与自适应前景层边长（dp=108 的倍数）
DENSITIES = [('mdpi', 1), ('hdpi', 1.5), ('xhdpi', 2), ('xxhdpi', 3), ('xxxhdpi', 4)]

FONT_CANDIDATES = [
    r'C:\Windows\Fonts\msyhbd.ttc',     # 微软雅黑 Bold
    r'C:\Windows\Fonts\msyh.ttc',
    r'C:\Windows\Fonts\simhei.ttf',
]

# 字形在各图层里占画布的比例。
#   传统图标：整张就是图标，字可以大一点
#   自适应前景：实测过 —— 各厂商遮罩形状不同，**圆形是最严的**（72dp 圆内切于 72dp 安全区，
#              内切正方形边长只有 72/√2 ≈ 50.9dp）。按 0.58 给时「价」的左侧「亻」和右侧
#              「卩」会明显越过圆边界被切掉，0.50 刚好压线。Google 的建议是内容落在
#              66dp 圆内（≈0.43）。折中取 0.46，方/圆/水滴三种遮罩下都不切、又不显小。
LEGACY_RATIO = 0.60
ADAPTIVE_RATIO = 0.46


def font_path():
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    sys.exit('找不到中文字体，试过：\n  ' + '\n  '.join(FONT_CANDIDATES))


def draw_glyph(img_size, ratio, shape):
    """在 img_size 的透明画布上居中画「价」。shape: 'none' | 'round' | 'squircle'"""
    S = img_size * SS
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    if shape != 'none':
        if shape == 'round':
            d.ellipse([0, 0, S - 1, S - 1], fill=BG)
        else:
            d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=BG)

    # 字号先按画布比例给一个大数，再按实际 ink bbox 收缩到目标尺寸 ——
    # 直接按 size 算会因为字体的行高留白而偏小、而且不同字体比例不一样。
    probe = int(S * 0.9)
    font = ImageFont.truetype(font_path(), probe)
    box = font.getbbox('价')
    ink_h = box[3] - box[1]
    target = S * ratio
    font = ImageFont.truetype(font_path(), max(1, int(probe * target / ink_h)))
    box = font.getbbox('价')

    # 按 ink bbox 居中（不是按 advance 宽度），字才是视觉居中的
    x = (S - (box[2] - box[0])) / 2 - box[0]
    y = (S - (box[3] - box[1])) / 2 - box[1]
    d.text((x, y), '价', font=font, fill=FG)

    return im.resize((img_size, img_size), Image.LANCZOS)


def main():
    n = 0
    for name, scale in DENSITIES:
        out = os.path.join(RES, 'mipmap-' + name)
        os.makedirs(out, exist_ok=True)

        legacy = int(round(48 * scale))
        draw_glyph(legacy, LEGACY_RATIO, 'squircle').save(os.path.join(out, 'ic_launcher.png'))
        draw_glyph(legacy, LEGACY_RATIO, 'round').save(os.path.join(out, 'ic_launcher_round.png'))

        fg = int(round(108 * scale))
        draw_glyph(fg, ADAPTIVE_RATIO, 'none').save(os.path.join(out, 'ic_launcher_fg.png'))
        n += 3
        print('  %-8s 传统 %3dpx  前景 %3dpx' % (name, legacy, fg))

    print('已生成 %d 张图标 → android/res/mipmap-*/' % n)


if __name__ == '__main__':
    main()
