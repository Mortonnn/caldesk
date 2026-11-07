"""
生成系统托盘图标。

为什么单独做一套：
    托盘原来直接用 `build/icon.png`（1024×1024 的应用图标）在运行时 `resize({16,16})`。
    那个图标是给安装包和任务栏大图看的：一条 1.5px 分隔线、四格、圆角，
    缩到 16px 之后线条糊成一团 —— 这就是"托盘图标不够高清"的原因。
    正确做法是**按每个尺寸原生绘制**，而不是把大图缩下来。

图案：与应用图标同族的「蓝底 + 四格窗口」，但为了 16px 可读做了**反相简化**
    （应用图标是蓝底白线框；托盘是白色书页 + 蓝色十字）。
    实测下来这是唯一在 16px 还能清楚看出"四格"的画法，
    其它写法（白线框、纯剪影）在这个尺寸都会糊成一个白块。
    应用图标本身没动。

产物（build/ 下的都会随 electron-builder 打进包）：
    tray.ico            Windows 托盘。多尺寸 16/20/24/32/40/48/64，Windows 自己挑最合适的
    trayTemplate.png    macOS 模板图（16pt，单色透明底，系统按亮暗自动反色）
    trayTemplate@2x.png macOS 模板图 Retina（32px）
    tray-22.png         Linux 托盘（多数桌面环境用 22 或 24）
    tray-24.png

用法：
    python scripts/make-tray-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / 'build'

BLUE = (47, 107, 255, 255)
WHITE = (255, 255, 255, 255)
BLACK = (0, 0, 0, 255)
CLEAR = (0, 0, 0, 0)

SS = 8  # 超采样倍数：圆角和斜边才不会有锯齿


def draw_tray(size, *, ink=WHITE, plate=BLUE):
    """
    画一枚 size×size 的托盘图标，与应用图标（CalMark）完全同形：
        蓝底圆角方块 + 白色线框四格窗 + 左上角实心填白。
        按每个尺寸超采样原生绘制，保证在每个 DPI 档位（16/20/24/32/40/48）清晰锐利。
    """
    big = size * SS
    img = Image.new('RGBA', (big, big), CLEAR)
    d = ImageDraw.Draw(img)

    if plate is not CLEAR:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 0.225, fill=plate)

    # 标记位于中心
    m = big * 0.62
    x0 = int((big - m) / 2)
    y0 = int((big - m) / 2)
    w = int(m)
    stroke = max(SS, int(w * 0.12))
    r_mark = max(SS, int(w * 0.20))
    half = max(1, stroke // 2)

    mask = Image.new('L', (w, w), 0)
    md = ImageDraw.Draw(mask)
    # 外线框
    md.rounded_rectangle((0, 0, w - 1, w - 1), radius=r_mark, fill=255)
    md.rounded_rectangle(
        (stroke, stroke, w - 1 - stroke, w - 1 - stroke),
        radius=max(1, r_mark - stroke),
        fill=0
    )
    # 十字分隔线
    md.rectangle((0, w // 2 - half, w - 1, w // 2 + half), fill=255)
    md.rectangle((w // 2 - half, 0, w // 2 + half, w - 1), fill=255)
    # 左上角实心填白（与应用图标 CalMark 完全一致）
    md.rectangle((stroke, stroke, w // 2, w // 2), fill=255)

    layer = Image.new('RGBA', (w, w), ink)
    img.paste(layer, (x0, y0), mask)

    return img.resize((size, size), Image.LANCZOS)


def main():
    BUILD.mkdir(parents=True, exist_ok=True)

    # --- Windows: 每个 DPI 档位一枚原生尺寸 PNG ---
    # 为什么不是只给 ICO：实测 `nativeImage.createFromPath(tray.ico)` 被 Skia 解成
    # 单张 256×256 位图（getSize 返回 256×256），再交给 Windows 缩放，等于又把
    # 清晰度丢了。所以运行时按主显示器的 scaleFactor 直接挑对应尺寸的 PNG，
    # 一个像素都不缩。—— 同时保留 ICO 供其它工具使用。
    win_sizes = [16, 20, 24, 32, 40, 48]
    for s in win_sizes:
        p = BUILD / f'tray-{s}.png'
        draw_tray(s).save(p)
        print(f'  {p.relative_to(ROOT)}  ({s}px)   # Windows {int(s / 16 * 100)}% DPI')

    ico_sizes = [16, 20, 24, 32, 40, 48, 64]
    ico_path = BUILD / 'tray.ico'
    draw_tray(64).save(ico_path, format='ICO', sizes=[(s, s) for s in ico_sizes])
    print(f'  {ico_path.relative_to(ROOT)}  ({", ".join(str(s) for s in ico_sizes)}px)')

    # --- macOS: 模板图（单色 + 透明底；系统自己按菜单栏亮暗反色）---
    for name, size in (('trayTemplate.png', 16), ('trayTemplate@2x.png', 32)):
        p = BUILD / name
        draw_tray(size, ink=BLACK, plate=CLEAR).save(p)
        print(f'  {p.relative_to(ROOT)}  ({size}px)')

    # --- Linux ---
    for size in (22, 24):
        p = BUILD / f'tray-{size}.png'
        draw_tray(size).save(p)
        print(f'  {p.relative_to(ROOT)}  ({size}px)')

    # --- 预览：写进仓库外的临时目录，别塞进安装包 ---
    try:
        import tempfile

        prev = Path(tempfile.gettempdir()) / 'caldesk-tray-preview.png'
        sizes = [16, 20, 24, 32, 48]
        scale = 6
        cell = max(sizes) * scale + 16
        sheet = Image.new('RGBA', (cell * len(sizes) + 16, cell * 2 + 16), (246, 248, 251, 255))
        for row, bg in enumerate(((246, 248, 251, 255), (30, 32, 36, 255))):
            band = Image.new('RGBA', (sheet.width - 16, cell), bg)
            for i, s in enumerate(sizes):
                icon = draw_tray(s).resize((s * scale, s * scale), Image.NEAREST)
                band.alpha_composite(icon, (i * cell + 8, (cell - s * scale) // 2))
            sheet.alpha_composite(band, (8, 8 + row * cell))
        sheet.save(prev)
        print(f'  预览：{prev}')
    except Exception as e:  # 预览失败不影响产物
        print(f'  （预览生成失败：{e}）')


if __name__ == '__main__':
    print('生成托盘图标：')
    main()
    print('完成。build/**/* 本来就会打进安装包，不用改 electron-builder。')
