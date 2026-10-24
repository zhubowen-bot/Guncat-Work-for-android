#!/usr/bin/env python3
"""下载内置终端所需的 Termux bootstrap 与全部 deb（构建前一次性准备）。

用法（仓库根目录）：
    python scripts/fetch-termux-bootstrap.py

默认使用清华镜像；离线/自建镜像可设环境变量：
    TERMUX_MIRROR=https://packages.termux.dev/apt/termux-main/

产物：
    .tmp/termux/bootstrap-aarch64.zip   官方基础 bootstrap
    .tmp/termux/debs/<包名>.deb          工具链 deb（清单见 scripts/termux-toolchain-packages.txt）

之后运行：
    python scripts/prepare-termux-bootstrap.py
    python scripts/add-termux-packages.py
"""
import json
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(ROOT, '.tmp', 'termux')
DEBS = os.path.join(TMP, 'debs')
MIRROR = os.environ.get('TERMUX_MIRROR', 'https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main/')
BOOTSTRAP_URL = (
    'https://github.com/termux/termux-packages/releases/download/'
    'bootstrap-2026.10.18-r1%2Bapt.android-7/bootstrap-aarch64.zip'
)
MANIFEST = os.path.join(ROOT, 'scripts', 'termux-toolchain-packages.txt')


def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        print('cached ', os.path.relpath(dest, ROOT))
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print('download', url)
    req = urllib.request.Request(url, headers={'User-Agent': 'guncat-build'})
    with urllib.request.urlopen(req, timeout=120) as response, open(dest, 'wb') as output:
        output.write(response.read())


def load_index():
    path = os.path.join(TMP, 'Packages')
    fetch(MIRROR + 'dists/stable/main/binary-aarch64/Packages', path)
    packages = {}
    text = open(path, encoding='utf-8', errors='replace').read()
    for block in text.split('\n\n'):
        fields = {}
        for line in block.splitlines():
            if line.startswith(' ') or ':' not in line:
                continue
            key, value = line.split(':', 1)
            fields[key.strip()] = value.strip()
        if 'Package' in fields:
            packages[fields['Package']] = fields
    return packages


def main():
    os.makedirs(DEBS, exist_ok=True)
    fetch(BOOTSTRAP_URL, os.path.join(TMP, 'bootstrap-aarch64.zip'))
    packages = load_index()
    names = [line.strip() for line in open(MANIFEST, encoding='utf-8') if line.strip()]
    missing = [name for name in names if name not in packages]
    if missing:
        raise SystemExit('镜像里缺少包: ' + ', '.join(missing))
    for index, name in enumerate(names, 1):
        info = packages[name]
        url = MIRROR + info['Filename']
        dest = os.path.join(DEBS, name + '.deb')
        print(f'[{index}/{len(names)}] {name}')
        fetch(url, dest)
    print('\n完成。接下来运行：')
    print('  python scripts/prepare-termux-bootstrap.py')
    print('  python scripts/add-termux-packages.py')


if __name__ == '__main__':
    main()
