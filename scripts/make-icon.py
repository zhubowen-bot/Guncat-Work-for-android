# 从鸿蒙原项目的应用图标生成桌面端需要的两种格式。
#
# 原项目 AppScope/resources/base/media/layered_image.json 里，
# 分层图标的 background 与 foreground 都指向 cat_avatar.png —— 它才是真正的应用图标。
#
# 产出：
#   resources/app-icon.png   256×256，用于 BrowserWindow 的窗口/任务栏图标
#   resources/app-icon.ico   多尺寸，用于 Windows 快捷方式
import sys
from PIL import Image

SRC = sys.argv[1]
PNG_OUT = sys.argv[2]
ICO_OUT = sys.argv[3]

src = Image.open(SRC).convert('RGBA')
print(f'源图: {SRC}  {src.size[0]}x{src.size[1]}')

# Windows 窗口图标用 256×256（高 DPI 下也够清晰）
png = src.resize((256, 256), Image.LANCZOS)
png.save(PNG_OUT, 'PNG', optimize=True)
print(f'窗口图标: {PNG_OUT}  256x256')

# ICO 需要内嵌多个尺寸，系统在不同位置各自取最合适的一张
ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
src.save(ICO_OUT, format='ICO', sizes=ico_sizes)
print(f'快捷方式图标: {ICO_OUT}  {len(ico_sizes)} 种尺寸')
