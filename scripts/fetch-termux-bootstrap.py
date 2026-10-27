#!/usr/bin/env python3
"""下载内置终端所需的 Termux bootstrap 与全部 deb（构建前一次性准备）。

用法（仓库根目录）：
    python scripts/fetch-termux-bootstrap.py

默认使用清华镜像；离线/自建镜像可设环境变量：
    TERMUX_MIRROR=https://packages.termux.dev/apt/termux-main/
    TERMUX_TUR_INDEX=<TUR 的 Packages 地址>

产物：
    .tmp/termux/bootstrap-aarch64.zip   官方基础 bootstrap
    .tmp/termux/debs/<包名>.deb          工具链 deb（清单见 scripts/termux-toolchain-packages.txt）
    .tmp/termux/debs/<包名>.deb          TUR deb（清单见 scripts/termux-tur-packages.txt）

之后运行：
    python scripts/prepare-termux-bootstrap.py
    python scripts/add-termux-packages.py
    python scripts/add-python-preset.py
"""
import hashlib
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(ROOT, '.tmp', 'termux')
DEBS = os.path.join(TMP, 'debs')
MIRROR = os.environ.get('TERMUX_MIRROR', 'https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main/')
TUR_INDEX = os.environ.get(
    'TERMUX_TUR_INDEX',
    'https://termux-user-repository.github.io/dists/dists/tur-packages/tur/binary-aarch64/Packages',
)
BOOTSTRAP_URL = (
    'https://github.com/termux/termux-packages/releases/download/'
    'bootstrap-2026.10.18-r1%2Bapt.android-7/bootstrap-aarch64.zip'
)
MANIFEST = os.path.join(ROOT, 'scripts', 'termux-toolchain-packages.txt')
TUR_MANIFEST = os.path.join(ROOT, 'scripts', 'termux-tur-packages.txt')


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(url, dest, expect_sha256=None):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        if not expect_sha256 or sha256(dest) == expect_sha256:
            print('cached  ', os.path.relpath(dest, ROOT))
            return
        print('校验和不匹配，重新下载', os.path.relpath(dest, ROOT))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print('download', url)
    req = urllib.request.Request(url, headers={'User-Agent': 'guncat-build'})
    with urllib.request.urlopen(req, timeout=180) as response, open(dest, 'wb') as output:
        output.write(response.read())
    if expect_sha256 and sha256(dest) != expect_sha256:
        os.remove(dest)
        raise SystemExit('校验和失败: ' + url)


def load_index(url, name):
    path = os.path.join(TMP, name)
    fetch(url, path)
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
    if not packages:
        raise SystemExit(f'{name} 解析失败（缓存损坏？删除后重试）: {path}')
    return packages


def tur_release_urls(name, fields):
    """TUR 的 apt 仓库是 GitHub Pages 上的元数据 + GitHub Releases 里的 deb。

    三条路径按 github 上实际存在的发布位置依次尝试（见 TUR dists 仓库的
    scripts/cf-worker.js）。
    """
    deb = os.path.basename(fields['Filename'])
    version = fields['Version'].split(':', 1)[-1]
    return [
        'https://github.com/tur-dists/{0}/releases/download/{1}/{2}'.format(name, version, deb),
        'https://github.com/termux-user-repository/dists/releases/download/{0}/{1}'.format(name, deb),
        'https://github.com/termux-user-repository/dists/releases/download/0.1/{0}'.format(deb),
    ]


def read_manifest(path):
    return [line.strip() for line in open(path, encoding='utf-8')
            if line.strip() and not line.strip().startswith('#')]


def main():
    os.makedirs(DEBS, exist_ok=True)
    fetch(BOOTSTRAP_URL, os.path.join(TMP, 'bootstrap-aarch64.zip'))

    packages = load_index(MIRROR + 'dists/stable/main/binary-aarch64/Packages', 'Packages')
    names = read_manifest(MANIFEST)
    missing = [name for name in names if name not in packages]
    if missing:
        raise SystemExit('镜像里缺少包: ' + ', '.join(missing))
    for index, name in enumerate(names, 1):
        info = packages[name]
        print(f'[{index}/{len(names)}] {name}')
        fetch(MIRROR + info['Filename'], os.path.join(DEBS, name + '.deb'))

    tur_names = read_manifest(TUR_MANIFEST)
    if tur_names:
        tur = load_index(TUR_INDEX, 'Packages-tur')
        missing = [name for name in tur_names if name not in tur]
        if missing:
            raise SystemExit('TUR 镜像里缺少包: ' + ', '.join(missing))
        for index, name in enumerate(tur_names, 1):
            info = tur[name]
            dest = os.path.join(DEBS, name + '.deb')
            print(f'[tur {index}/{len(tur_names)}] {name} {info.get("Version", "")}')
            if os.path.exists(dest) and sha256(dest) == info.get('SHA256'):
                print('cached  ', os.path.relpath(dest, ROOT))
                continue
            last_error = None
            for url in tur_release_urls(name, info):
                try:
                    fetch(url, dest, info.get('SHA256'))
                    break
                except Exception as error:  # noqa: BLE001 - 依次尝试多个发布位置
                    last_error = error
                    print('  失败:', url, error)
            else:
                raise SystemExit(f'TUR 包 {name} 下载失败: {last_error}')

    print('\n完成。接下来运行：')
    print('  python scripts/prepare-termux-bootstrap.py')
    print('  python scripts/add-termux-packages.py')
    print('  python scripts/add-python-preset.py')


if __name__ == '__main__':
    main()
