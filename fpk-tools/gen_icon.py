#!/usr/bin/env python3
"""生成 烟价速查同步服务 应用图标（64x64 / 256x256）。

图形语义：橙红渐变圆角底 + 白色价签（带挂孔）。
输出到 fpk 工程的 4 个位置：
  fpk/ICON.PNG            fpk/ICON_256.PNG
  fpk/app/ui/images/icon_64.png   fpk/app/ui/images/icon_256.png

用法：python gen_icon.py
"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_ROOT = os.path.abspath(os.path.join(HERE, "..", "fpk"))

SIZES = {"64": 64, "256": 256}

# 渐变配色：琥珀橙 -> 红
TOP = (251, 146, 60)
BOTTOM = (220, 38, 38)
WHITE = (255, 255, 255, 255)
HOLE = (180, 28, 28, 255)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def build(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # ── 渐变圆角底 ──────────────────────────────────────────────
    radius = int(size * 0.22)
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        gd.line([(0, y), (size, y)], fill=lerp(TOP, BOTTOM, y / max(size - 1, 1)) + (255,))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    # ── 价签（白色圆角矩形，略旋转，右上角挂孔）────────────────
    s = size / 256.0
    tag_w, tag_h = int(150 * s), int(104 * s)
    tag = Image.new("RGBA", (tag_w, tag_h), (0, 0, 0, 0))
    td = ImageDraw.Draw(tag)
    td.rounded_rectangle([0, 0, tag_w - 1, tag_h - 1], radius=int(18 * s), fill=WHITE)
    # 挂孔（右下角，深色圆点示意）
    hr = int(12 * s)
    td.ellipse(
        [tag_w - int(36 * s), tag_h - int(36 * s), tag_w - int(36 * s) + 2 * hr, tag_h - int(36 * s) + 2 * hr],
        fill=HOLE,
    )
    tag = tag.rotate(-24, expand=True)
    pos = (int((size - tag.width) / 2), int((size - tag.height) / 2))
    img.paste(tag, pos, tag)

    return img


def main():
    for name, size in SIZES.items():
        img = build(size)
        targets = [
            os.path.join(OUT_ROOT, "ICON.PNG" if size == 64 else "ICON_256.PNG"),
            os.path.join(OUT_ROOT, "app", "ui", "images", f"icon_{size}.png"),
        ]
        for t in targets:
            os.makedirs(os.path.dirname(t), exist_ok=True)
            img.save(t, "PNG")
            print(f"saved {t} ({size}x{size})")


if __name__ == "__main__":
    main()
