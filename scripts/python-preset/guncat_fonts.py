"""Guncat Work 自带: 中文字体支持（matplotlib / Pillow 都能直接写中文）。

与鸿蒙版同名模块对齐，区别是 Android 上不额外打字体文件，直接复用系统字库
（`/system/fonts/NotoSansCJK-Regular.ttc`、`NotoSansSC-Regular.otf` 等，
几乎所有机型都随系统提供全量 CJK 字形）。也可以用 `GUNCAT_FONT_DIR` 指定
自己放字体的目录，或调用 `use_cjk("/path/your.ttf")`。

用法：

    import guncat_fonts
    guncat_fonts.use_cjk()                # 注册给 matplotlib 并设为默认字体
    font = guncat_fonts.pillow_font(24)   # Pillow 用的 ImageFont

matplotlib 一旦 import 过 `matplotlib.font_manager`，本模块会**自动注册**一次
（由 sitecustomize.py 在解释器启动时挂好钩子），所以多数情况下你什么都不用做，
直接 `plt.title("中文")` 就能显示。
"""

from __future__ import annotations

import os

FONT_NAME = "SourceHanSansSC-Regular.otf"
_FONT_FAMILY = "Source Han Sans SC"

# Android 系统字库，按“优先简体、再 TTC 合集”的顺序。
# 真机实测这些路径都是全量 CJK 字形；找不到时返回 None，不抛异常。
SYSTEM_FONTS = (
    "/system/fonts/NotoSansSC-Regular.otf",
    "/system/fonts/NotoSansSC-Regular.ttf",
    "/system/fonts/NotoSansCJKsc-Regular.otf",
    "/system/fonts/SourceHanSansCN-Regular.otf",
    "/system/fonts/NotoSansCJK-Regular.ttc",
    "/system/fonts/NotoSerifCJK-Regular.ttc",
    "/system/fonts/DroidSansFallback.ttf",
)

_cached_path = None
_registered = False


def _candidates():
    env_dir = os.environ.get("GUNCAT_FONT_DIR")
    if env_dir:
        yield env_dir
    here = os.path.dirname(os.path.abspath(__file__))
    yield os.path.join(here, "fonts")
    yield os.path.join(os.path.dirname(here), "fonts")


def path() -> str | None:
    """返回可用的中文字体路径；优先随包/自定义字体，其次系统字库，都没有返回 None。"""
    global _cached_path
    if _cached_path and os.path.isfile(_cached_path):
        return _cached_path
    for directory in _candidates():
        candidate = os.path.join(directory, FONT_NAME)
        if os.path.isfile(candidate):
            _cached_path = candidate
            return candidate
    for candidate in SYSTEM_FONTS:
        if os.path.isfile(candidate):
            _cached_path = candidate
            return candidate
    return None


def use_cjk(extra_font: str | None = None, family: str | None = None) -> str | None:
    """把中文字体注册进 matplotlib 并设为默认。返回实际使用的字体路径。"""
    global _registered
    chosen = extra_font or path()
    if not chosen or not os.path.isfile(chosen):
        return None
    try:
        from matplotlib import font_manager, rcParams
    except BaseException:
        return chosen
    try:
        font_manager.fontManager.addfont(chosen)
        # 字体真正的 family 名以文件里的 name 表为准；拿不到才退回常量。
        name = family
        if not name:
            try:
                name = font_manager.FontProperties(fname=chosen).get_name()
            except BaseException:
                name = None
            if not name or name.lower() in ("dejavu sans", "sans"):
                name = _FONT_FAMILY
        rcParams["font.family"] = ["sans-serif"]
        rcParams["font.sans-serif"] = [name, "DejaVu Sans"]
        rcParams["axes.unicode_minus"] = False
        _registered = True
    except BaseException:
        pass
    return chosen


def pillow_font(size: int = 20, index: int = 0):
    """Pillow 的 ImageFont 对象（默认用系统中文字体）。"""
    from PIL import ImageFont

    chosen = path()
    if not chosen:
        return ImageFont.load_default()
    return ImageFont.truetype(chosen, size, index=index)


def _install_auto_hook() -> None:
    """matplotlib.font_manager 被 import 后自动注册中文字体。

    用 sys.addaudithook 监听 'import' 事件——它在 import 完成**之后**触发，
    此时 font_manager 已就绪。任何异常都吞掉，用户仍可显式调用 use_cjk()。
    """
    if os.environ.get("GUNCAT_FONT_AUTO", "1") in ("0", "false", "no"):
        return
    if path() is None:
        return

    try:
        import sys as _sys

        def _hook(event, args):
            if event != "import" or not args:
                return
            if args[0] in ("matplotlib.font_manager", "matplotlib.pyplot"):
                try:
                    if not _registered:
                        use_cjk()
                except BaseException:
                    pass

        _sys.addaudithook(_hook)
    except BaseException:
        pass


_install_auto_hook()
