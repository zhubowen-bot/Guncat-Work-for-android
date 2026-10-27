"""内置 Python 启动钩子（随 bootstrap 放在 site-packages 里）。

只做一件轻量的事：把设备自带的中文字体登记给 matplotlib。matplotlib 不读
Android 的 fontconfig，不登记的话 `plt.title("中文")` 会变成方框。

这里不 import matplotlib（那会让每次 `python3` 启动都变慢），只装一个 audithook；
真正 import matplotlib.font_manager 时才触发注册，见 guncat_fonts.py。
"""

try:
    import guncat_fonts  # noqa: F401  (导入即安装 audithook)
except BaseException:
    pass
