"""
生成 caldesk 的应用图标与安卓启动图。

与应用内的 CalMark 同形：四格窗，左上格填实。改图标只改这个文件，然后：

    pip install pillow
    python scripts/make-icons.py

产物：
  build/icon.png                                   Windows 安装包 / 任务栏（1024）
  android/.../mipmap-*/ic_launcher.png             旧式图标（蓝底 + 白标记）
  android/.../mipmap-*/ic_launcher_round.png       圆形版本
  android/.../mipmap-*/ic_launcher_foreground.png  自适应图标前景（透明底，留安全区）
  android/.../drawable*/splash.png                 启动图（纸色底 + 居中标）

注意：`android/` 是 `npx cap add android` 生成的，不进版本库。
重新生成安卓工程后要再跑一次这个脚本，启动器图标才不会被换回默认图。
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / 'android/app/src/main/res'

BLUE = (47, 107, 255, 255)
WHITE = (255, 255, 255, 255)
PAPER = (245, 247, 250, 255)

SS = 4  # 超采样倍数，圆角和十字边缘才不会有锯齿


def ibox(box):
    return tuple(int(round(v)) for v in box)


def draw_mark(img, box, stroke, color, filled_corner=True):
    """在 box 里画四格窗：外框 + 十字 + 左上格填实（用掩膜，边缘干净）。"""
    x0, y0, x1, y1 = ibox(box)
    w = x1 - x0
    stroke = max(1, int(round(stroke)))
    half = max(1, stroke // 2)
    r = max(2, int(w * 0.19))
    cx, cy = w // 2, w // 2

    mask = Image.new('L', (w, w), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, w - 1, w - 1), radius=r, fill=255)
    md.rounded_rectangle(
        (stroke, stroke, w - 1 - stroke, w - 1 - stroke),
        radius=max(1, r - stroke),
        fill=0,
    )
    md.rectangle((0, cy - half, w - 1, cy + half), fill=255)
    md.rectangle((cx - half, 0, cx + half, w - 1), fill=255)
    if filled_corner:
        md.rectangle((stroke, stroke, cx, cy), fill=255)

    layer = Image.new('RGBA', (w, w), color)
    img.paste(layer, (x0, y0), mask)


def tile_icon(size, radius_ratio=0.225, round_icon=False, mark_ratio=0.54):
    """蓝底 + 白标记的完整图标。"""
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if round_icon:
        d.ellipse((0, 0, big - 1, big - 1), fill=BLUE)
    else:
        d.rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * radius_ratio), fill=BLUE)
    m = big * mark_ratio
    box = ((big - m) / 2, (big - m) / 2, (big + m) / 2, (big + m) / 2)
    draw_mark(img, box, stroke=m * 0.075, color=WHITE)
    return img.resize((size, size), Image.LANCZOS)


def foreground(size, mark_ratio=0.50):
    """自适应图标前景：透明底，标记控制在 66% 安全区内。"""
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    m = big * mark_ratio
    box = ((big - m) / 2, (big - m) / 2, (big + m) / 2, (big + m) / 2)
    draw_mark(img, box, stroke=m * 0.075, color=WHITE)
    return img.resize((size, size), Image.LANCZOS)


def splash(w, h):
    """启动图：纸色底 + 居中的蓝色图标，图标边长取短边的 22%。"""
    img = Image.new('RGB', (w, h), PAPER)
    side = int(min(w, h) * 0.22)
    icon = tile_icon(side)
    img.paste(icon, ((w - side) // 2, (h - side) // 2), icon)
    return img


def main():
    (ROOT / 'build').mkdir(exist_ok=True)
    tile_icon(1024).save(ROOT / 'build/icon.png')

    if not RES.exists():
        print('android/ 不存在，只生成了 build/icon.png')
        return

    density = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
    fg_density = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}

    for name, size in density.items():
        folder = RES / f'mipmap-{name}'
        folder.mkdir(parents=True, exist_ok=True)
        tile_icon(size).save(folder / 'ic_launcher.png')
        tile_icon(size, round_icon=True).save(folder / 'ic_launcher_round.png')
        foreground(fg_density[name]).save(folder / 'ic_launcher_foreground.png')

    splash_sizes = {
        'drawable/splash.png': (480, 320),
        'drawable-land-hdpi/splash.png': (800, 480),
        'drawable-land-mdpi/splash.png': (480, 320),
        'drawable-land-xhdpi/splash.png': (1280, 720),
        'drawable-land-xxhdpi/splash.png': (1600, 960),
        'drawable-land-xxxhdpi/splash.png': (1920, 1280),
        'drawable-port-hdpi/splash.png': (480, 800),
        'drawable-port-mdpi/splash.png': (320, 480),
        'drawable-port-xhdpi/splash.png': (720, 1280),
        'drawable-port-xxhdpi/splash.png': (960, 1600),
        'drawable-port-xxxhdpi/splash.png': (1280, 1920),
    }
    for rel, (w, h) in splash_sizes.items():
        path = RES / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        splash(w, h).save(path)

    print('图标与启动图已更新：build/icon.png + android/app/src/main/res')


if __name__ == '__main__':
    main()
