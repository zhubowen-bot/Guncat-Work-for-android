"""`Crypto` -> `Cryptodome` 兼容层（Termux 只提供 pycryptodomex）。

鸿蒙版内置的是 PyCryptodome（包名 `Crypto`），Termux 仓库只有同源代码的
PyCryptodomeX（包名 `Cryptodome`）。装了本模块后，两种写法都能用：

    from Crypto.Cipher import AES
    from Cryptodome.Cipher import AES

实现方式：把 `Crypto.*` 一律映射到已安装的 `Cryptodome.*`。注意两边是**两套
模块对象**（`Crypto.Cipher.AES.AESCipher is not Cryptodome.Cipher.AES.AESCipher`），
不要拿两边的类做 isinstance 判断；新代码建议直接 import Cryptodome。
"""

from __future__ import annotations

import importlib
import importlib.abc
import importlib.util
import sys


class _CryptodomeAliasFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    prefix = "Crypto."
    target_prefix = "Cryptodome."

    def find_spec(self, fullname, path=None, target=None):
        if not fullname.startswith(self.prefix):
            return None
        try:
            importlib.import_module(self.target_prefix + fullname[len(self.prefix):])
        except ImportError:
            return None
        return importlib.util.spec_from_loader(fullname, self, is_package=True)

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        real = importlib.import_module(self.target_prefix + module.__name__[len("Crypto."):])
        skip = {"__name__", "__spec__", "__loader__", "__package__", "__file__", "__cached__", "__path__"}
        for key, value in real.__dict__.items():
            if key not in skip:
                module.__dict__[key] = value
        if hasattr(real, "__path__"):
            module.__path__ = list(real.__path__)


if not any(isinstance(finder, _CryptodomeAliasFinder) for finder in sys.meta_path):
    sys.meta_path.append(_CryptodomeAliasFinder())
