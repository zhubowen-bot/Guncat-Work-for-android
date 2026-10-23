import zipfile, os, collections, hashlib

SRC = '.tmp/termux/bootstrap-aarch64.zip'
OUT = 'android/app/src/main/assets/termux/bootstrap-aarch64.zip'
OLD_USR = b'/data/data/com.termux/files/usr'
OLD_HOME = b'/data/data/com.termux/files/home'
OLD_BASE = b'/data/data/com.termux'
NEW_USR = b'/data/data/com.guncat.work/abcd'
NEW_HOME = b'/data/data/com.guncat.work/abcde'
NEW_BASE = b'/data/data/com.guncat.work'
assert len(OLD_USR) == len(NEW_USR) == 31
assert len(OLD_HOME) == len(NEW_HOME) == 32

MAGIC_SKIP = (b'\x1f\x8b', b'BZh', b'\xfd7zXZ\x00', b'PK\x03\x04', b'\x89PNG', b'\xff\xd8\xff', b'GIF8', b'RIFF')

def is_text(data):
    if data.startswith(b'#!'):
        return True
    head = data[:4096]
    if b'\x00' in head:
        return False
    try:
        data.decode('utf-8')
        return True
    except UnicodeDecodeError:
        return False

os.makedirs(os.path.dirname(OUT), exist_ok=True)
zin = zipfile.ZipFile(SRC)
zout = zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=6)
stats = collections.Counter()
for info in zin.infolist():
    data = zin.read(info.filename)
    text = is_text(data)
    patched = False
    if not info.is_dir() and not data.startswith(MAGIC_SKIP):
        if OLD_USR in data:
            data = data.replace(OLD_USR, NEW_USR); patched = True
        if OLD_HOME in data:
            data = data.replace(OLD_HOME, NEW_HOME); patched = True
        if text and OLD_BASE in data:
            data = data.replace(OLD_BASE, NEW_BASE); patched = True
    stats['patched_' + ('text' if text else 'binary') if patched else 'untouched'] += 1
    zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
    zi.compress_type = zipfile.ZIP_DEFLATED
    zi.external_attr = info.external_attr
    zi.internal_attr = info.internal_attr
    zi.create_system = info.create_system
    zi.comment = info.comment
    zout.writestr(zi, data)
zout.close(); zin.close()
print('written', OUT, os.path.getsize(OUT))
print(dict(stats))
z = zipfile.ZipFile(OUT)
left_usr = left_home = left_base = 0
for info in z.infolist():
    if info.is_dir(): continue
    d = z.read(info.filename)
    left_usr += d.count(OLD_USR); left_home += d.count(OLD_HOME); left_base += d.count(OLD_BASE)
print('remaining old usr/home/base', left_usr, left_home, left_base)
print('sha256', hashlib.sha256(open(OUT,'rb').read()).hexdigest())
