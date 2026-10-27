#!/usr/bin/env python3
"""把纯 Python 三方库预置进内置 Termux bootstrap。

背景：Android 版随包带一套 Termux 用户态，Python 自带 numpy/scipy/pillow/lxml。
鸿蒙版还预置了 requests / bs4 / openpyxl / python-docx / python-pptx / sympy /
reportlab 等纯 Python 包。这些包不依赖 Android ABI，直接解压进
`lib/python3.14/site-packages/` 即可，不需要在设备上联网 pip。

原生扩展包（pandas / matplotlib / contourpy / kiwisolver / psutil /
pycryptodomex）在 Termux 主仓库和 TUR 仓库里是 .deb，由
scripts/add-termux-packages.py 负责，不在这里重复。

用法（仓库根目录，需联网）：
    python scripts/add-python-preset.py            # 下载 + 合并进 bootstrap
    python scripts/add-python-preset.py --verify   # 只检查现有 bootstrap 内容

产物：
    android/app/src/main/assets/termux/bootstrap-aarch64.zip  （原地更新）

清单：scripts/python-preset-packages.txt
本地辅助模块：scripts/python-preset/*.py
"""
from __future__ import annotations

import argparse
import json
import os
import posixpath
import re
import shutil
import sys
import tarfile
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'termux', 'bootstrap-aarch64.zip')
SPEC = os.path.join(ROOT, 'scripts', 'python-preset-packages.txt')
LOCAL = os.path.join(ROOT, 'scripts', 'python-preset')
TMP = os.path.join(ROOT, '.tmp', 'python-preset')
CACHE = os.path.join(ROOT, '.tmp', 'python-wheels')
STAGE = os.path.join(TMP, 'stage')

SITE = 'lib/python3.14/site-packages'
BIN = 'bin'
PYTHON = '/data/data/com.guncat.work/abcd/bin/python3.14'
STAMP = (2026, 10, 18, 0, 0, 0)

# 源码包里“包目录”的名字与 PyPI 项目名不一致时在这里映射
SDIST_PACKAGE = {
    'PyYAML': 'yaml',
    'MarkupSafe': 'markupsafe',
    'watchdog': 'watchdog',
}

# 合并后必须存在的入口（防止下载/解压静默失败）
REQUIRED = [
    'requests/__init__.py',
    'urllib3/__init__.py',
    'bs4/__init__.py',
    'soupsieve/__init__.py',
    'openpyxl/__init__.py',
    'docx/__init__.py',
    'pptx/__init__.py',
    'xlsxwriter/__init__.py',
    'xlrd/__init__.py',
    'pypdf/__init__.py',
    'reportlab/__init__.py',
    'markdown/__init__.py',
    'sympy/__init__.py',
    'mpmath/__init__.py',
    'dateutil/__init__.py',
    'pytz/__init__.py',
    'tabulate/__init__.py',
    'tqdm/__init__.py',
    'qrcode/__init__.py',
    'png.py',
    'fontTools/__init__.py',
    'cycler/__init__.py',
    'jinja2/__init__.py',
    'markupsafe/__init__.py',
    'yaml/__init__.py',
    'watchdog/__init__.py',
    'sitecustomize.py',
    'guncat_fonts.py',
    'guncat_net.py',
    'guncat_mp.py',
    'Crypto/__init__.py',
]


def log(message: str) -> None:
    print(message, flush=True)


def read_spec():
    entries = []
    for raw in open(SPEC, encoding='utf-8'):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        sdist = False
        if '|' in line:
            line, mode = line.split('|', 1)
            line, mode = line.strip(), mode.strip()
            if mode != 'sdist':
                raise SystemExit(f'未知的清单模式 {mode!r}: {raw.rstrip()}')
            sdist = True
        name, sep, version = line.partition('==')
        if not sep or not name or not version:
            raise SystemExit(f'清单行格式应为 name==version: {raw.rstrip()}')
        entries.append((name.strip(), version.strip(), sdist))
    return entries


def http_json(url: str):
    req = urllib.request.Request(url, headers={'User-Agent': 'guncat-build'})
    with urllib.request.urlopen(req, timeout=120) as response:
        return json.load(response)


def fetch(url: str, dest: str, sha256: str | None = None) -> str:
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        if not sha256:
            log(f'  cached  {os.path.basename(dest)}')
            return dest
        import hashlib
        digest = hashlib.sha256(open(dest, 'rb').read()).hexdigest()
        if digest == sha256:
            log(f'  cached  {os.path.basename(dest)}')
            return dest
        log(f'  重新下载（校验和不匹配）{os.path.basename(dest)}')
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    log(f'  download {url}')
    req = urllib.request.Request(url, headers={'User-Agent': 'guncat-build'})
    with urllib.request.urlopen(req, timeout=180) as response, open(dest, 'wb') as output:
        shutil.copyfileobj(response, output)
    if sha256:
        import hashlib
        digest = hashlib.sha256(open(dest, 'rb').read()).hexdigest()
        if digest != sha256:
            os.remove(dest)
            raise SystemExit(f'校验和失败: {url}')
    return dest


def pick_artifact(name: str, version: str, sdist: bool):
    data = http_json(f'https://pypi.org/pypi/{name}/{version}/json')
    candidates = []
    for item in data['urls']:
        filename = item['filename']
        if sdist:
            if filename.endswith(('.tar.gz', '.tar.bz2', '.zip')) and item['packagetype'] == 'sdist':
                candidates.append(item)
        elif filename.endswith('.whl') and (
                'py3-none-any' in filename or 'py2.py3-none-any' in filename):
            candidates.append(item)
    if not candidates:
        kind = '源码包' if sdist else 'py3-none-any 轮子'
        raise SystemExit(f'{name}=={version} 在 PyPI 上没有{kind}')
    # .tar.gz 优先，便于 tarfile 直接处理
    candidates.sort(key=lambda i: (not i['filename'].endswith('.tar.gz'), i['filename']))
    chosen = candidates[0]
    return chosen['filename'], chosen['url'], chosen.get('digests', {}).get('sha256')


def stage_file(rel_path: str, data: bytes, mode: int = 0o644) -> None:
    dest = os.path.join(STAGE, *rel_path.split('/'))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, 'wb') as handle:
        handle.write(data)
    if mode & 0o111:
        os.chmod(dest, 0o755)
    elif os.path.exists(dest):
        os.chmod(dest, 0o644)


def install_wheel(path: str) -> int:
    added = 0
    entry_points = b''
    with zipfile.ZipFile(path) as wheel:
        for info in wheel.infolist():
            if info.is_dir():
                continue
            name = info.filename
            data = wheel.read(info)
            if name.endswith('.dist-info/entry_points.txt'):
                entry_points = data
            match = re.match(r'^[^/]+\.data/(purelib|platlib|scripts|data|headers)/(.+)$', name)
            if match:
                kind, rest = match.group(1), match.group(2)
                if kind in ('purelib', 'platlib'):
                    stage_file(f'{SITE}/{rest}', data)
                elif kind == 'scripts':
                    script = f'#!{PYTHON}\n'.encode()
                    text = data
                    if text.startswith(b'#!'):
                        lines = text.split(b'\n', 1)
                        text = script + (lines[1] if len(lines) > 1 else b'')
                    else:
                        text = script + text
                    stage_file(f'{BIN}/{posixpath.basename(rest)}', text, 0o755)
                elif kind == 'data':
                    stage_file(rest, data)
                # headers 丢弃：运行期不需要编译头
                continue
            stage_file(f'{SITE}/{name}', data)
            added += 1
    added += install_console_scripts(entry_points)
    return added


def install_console_scripts(raw: bytes) -> int:
    """按 entry_points.txt 生成 bin/ 下的启动脚本（pip 安装时本来会做这一步）。"""
    if not raw:
        return 0
    added = 0
    section = ''
    for line in raw.decode('utf-8', 'replace').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1].strip()
            continue
        if section != 'console_scripts' or '=' not in line:
            continue
        script, target = line.split('=', 1)
        script = script.strip()
        target = target.split('[', 1)[0].strip()
        module, sep, func = target.partition(':')
        if not script or not sep:
            continue
        module, func = module.strip(), func.strip() or 'main'
        if os.path.exists(os.path.join(STAGE, BIN, script)):
            continue
        body = (
            f'#!{PYTHON}\n'
            'import importlib\n'
            'import sys\n\n'
            f'_module = importlib.import_module({module!r})\n'
            f'_func = getattr(_module, {func!r})\n'
            'if __name__ == "__main__":\n'
            '    sys.exit(_func())\n'
        )
        stage_file(f'{BIN}/{script}', body.encode('utf-8'), 0o755)
        added += 1
    return added


def install_sdist(name: str, version: str, path: str) -> int:
    pkg_dir_name = SDIST_PACKAGE.get(name, name.lower().replace('-', '_'))
    with tarfile.open(path, 'r:*') as tar:
        members = [m for m in tar.getmembers() if m.isfile()]
        roots = {m.name.split('/')[0] for m in members}
        if len(roots) != 1:
            raise SystemExit(f'{name} 源码包结构异常: 根目录 {sorted(roots)}')
        root = roots.pop()
        # 找到形如 <root>/[src|lib]/<pkg_dir>/__init__.py 的包目录
        pkg_dir = None
        for member in members:
            parts = member.name.split('/')
            if parts[-1] == '__init__.py' and len(parts) >= 3 and parts[-2] == pkg_dir_name:
                pkg_dir = '/'.join(parts[:-1])
                break
        if pkg_dir is None:
            raise SystemExit(f'{name} 源码包里找不到 {pkg_dir_name}/__init__.py')

        added = 0
        for member in members:
            if not member.name.startswith(pkg_dir + '/'):
                continue
            rel = member.name[len(pkg_dir) + 1:]
            if not rel or '__pycache__' in rel:
                continue
            if rel.endswith(('.c', '.h', '.pyx', '.pxd')):
                continue
            extracted = tar.extractfile(member)
            if extracted is None:
                continue
            stage_file(f'{SITE}/{pkg_dir_name}/{rel}', extracted.read())
            added += 1

        # 生成最小的 dist-info，保证 importlib.metadata / pip list 能识别
        pkg_info = None
        entry_points = b''
        for member in members:
            if member.name.endswith('/PKG-INFO'):
                extracted = tar.extractfile(member)
                if extracted is not None:
                    pkg_info = extracted.read()
            elif member.name.endswith('/entry_points.txt'):
                extracted = tar.extractfile(member)
                if extracted is not None:
                    entry_points = extracted.read()
        if pkg_info is None:
            pkg_info = (f'Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n').encode()
        metadata = pkg_info
        if b'Name:' not in metadata:
            metadata = f'Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n'.encode() + metadata
        dist_info = f'{SITE}/{name}-{version}.dist-info'
        stage_file(f'{dist_info}/METADATA', metadata)
        stage_file(f'{dist_info}/WHEEL',
                   b'Wheel-Version: 1.0\nGenerator: guncat-bootstrap\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
        stage_file(f'{dist_info}/INSTALLER', b'guncat-bootstrap\n')
        site_root = os.path.join(STAGE, SITE)
        record = ''.join(
            posixpath.relpath(os.path.join(dirpath, filename), site_root).replace('\\', '/') + ',,\n'
            for dirpath, _dirs, files in os.walk(os.path.join(site_root, pkg_dir_name))
            for filename in files)
        stage_file(f'{dist_info}/RECORD', record.encode())
        added += install_console_scripts(entry_points)
        return added


def install_local_modules() -> int:
    added = 0
    for dirpath, dirs, files in os.walk(LOCAL):
        dirs[:] = [d for d in dirs if d != '__pycache__']
        for filename in files:
            if not filename.endswith('.py'):
                continue
            source = os.path.join(dirpath, filename)
            rel = os.path.relpath(source, LOCAL).replace('\\', '/')
            stage_file(f'{SITE}/{rel}', open(source, 'rb').read())
            added += 1
    return added


def prepare_stage(entries) -> int:
    if os.path.isdir(STAGE):
        shutil.rmtree(STAGE)
    os.makedirs(STAGE, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)
    total = 0
    for index, (name, version, sdist) in enumerate(entries, 1):
        log(f'[{index}/{len(entries)}] {name}=={version}{" (sdist)" if sdist else ""}')
        filename, url, sha256 = pick_artifact(name, version, sdist)
        path = fetch(url, os.path.join(CACHE, filename), sha256)
        if sdist:
            total += install_sdist(name, version, path)
        else:
            total += install_wheel(path)
    total += install_local_modules()
    return total


def zip_info(name: str, date_time, mode: int, is_dir: bool = False) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=date_time)
    info.compress_type = zipfile.ZIP_STORED if is_dir else zipfile.ZIP_DEFLATED
    info.external_attr = ((0o040755 if is_dir else mode) << 16)
    return info


def merge_into_asset() -> tuple[int, int]:
    staged = {}
    for dirpath, _dirs, files in os.walk(STAGE):
        for filename in files:
            full = os.path.join(dirpath, filename)
            rel = os.path.relpath(full, STAGE).replace('\\', '/')
            staged[rel] = full
    if not staged:
        raise SystemExit('暂存目录为空，先运行不带 --verify 的命令')

    dirs = set()
    for rel in staged:
        parent = posixpath.dirname(rel)
        while parent and parent not in dirs:
            dirs.add(parent)
            parent = posixpath.dirname(parent)

    tmp = ASSET + '.tmp'
    added = 0
    with zipfile.ZipFile(ASSET) as zin, zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zout:
        existing = set()
        written = set()
        for info in zin.infolist():
            existing.add(info.filename)
            if info.filename in staged or info.filename in written:
                continue
            written.add(info.filename)
            data = zin.read(info.filename)
            target = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            target.compress_type = info.compress_type
            target.external_attr = info.external_attr
            target.internal_attr = info.internal_attr
            target.create_system = info.create_system
            target.comment = info.comment
            zout.writestr(target, data)
        for directory in sorted(dirs):
            if directory + '/' in existing:
                continue
            zout.writestr(zip_info(directory + '/', STAMP, 0o755, is_dir=True), b'')
        for rel, full in sorted(staged.items()):
            mode = 0o755 if rel.startswith(BIN + '/') else 0o644
            zout.writestr(zip_info(rel, STAMP, mode), open(full, 'rb').read())
            added += 1
    os.replace(tmp, ASSET)
    return added, len(staged)


def verify() -> int:
    problems = []
    counts = {}
    with zipfile.ZipFile(ASSET) as archive:
        names = set(archive.namelist())
        for rel in REQUIRED:
            path = f'{SITE}/{rel}'
            if path not in names:
                problems.append(f'缺少 {path}')
        native = [n for n in names if n.startswith(f'{SITE}/pandas/_libs/') and n.endswith('.so')]
        if not native:
            problems.append('缺少 pandas 原生扩展')
        for prefix in ('matplotlib', 'contourpy', 'kiwisolver', 'psutil', 'Cryptodome'):
            if not any(n.startswith(f'{SITE}/{prefix}/') for n in names):
                problems.append(f'缺少 {prefix}/')
        for name in names:
            if name.startswith(f'{SITE}/'):
                top = name[len(SITE) + 1:].split('/')[0]
                counts[top] = counts.get(top, 0) + 1
    log(f'站点包入口 {len(counts)} 个，文件 {sum(counts.values())} 个')
    for key in ('pandas', 'matplotlib', 'numpy', 'scipy', 'PIL', 'sympy', 'reportlab', 'openpyxl', 'docx', 'pptx'):
        log(f'  {key:12} {counts.get(key, 0)} files')
    if problems:
        for problem in problems:
            log('  [FAIL] ' + problem)
        return 1
    log('[OK] 预置 Python 包校验通过')
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify', action='store_true', help='只校验现有 bootstrap')
    args = parser.parse_args()
    if args.verify:
        return verify()
    if not os.path.exists(ASSET):
        raise SystemExit('缺少 bootstrap，请先运行 prepare-termux-bootstrap.py 与 add-termux-packages.py')
    entries = read_spec()
    staged = prepare_stage(entries)
    log(f'\n暂存 {staged} 个文件，合并进 {os.path.relpath(ASSET, ROOT)} …')
    added, _total = merge_into_asset()
    log(f'写入 {added} 个文件，bootstrap 现在 {os.path.getsize(ASSET) / 1024 / 1024:.1f} MB')
    return verify()


if __name__ == '__main__':
    sys.exit(main())
