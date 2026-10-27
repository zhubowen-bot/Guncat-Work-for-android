import zipfile, os, re, io, tarfile, hashlib

ASSET='android/app/src/main/assets/termux/bootstrap-aarch64.zip'
OLD_USR=b'/data/data/com.termux/files/usr'; NEW_USR=b'/data/data/com.guncat.work/abcd'
OLD_HOME=b'/data/data/com.termux/files/home'; NEW_HOME=b'/data/data/com.guncat.work/abcde'
OLD_BASE=b'/data/data/com.termux'; NEW_BASE=b'/data/data/com.guncat.work'
MAGIC_SKIP=(b'\x1f\x8b',b'BZh',b'\xfd7zXZ\x00',b'PK\x03\x04',b'\x89PNG',b'\xff\xd8\xff',b'GIF8',b'RIFF')

def is_text(d):
    if d.startswith(b'#!'): return True
    if b'\x00' in d[:4096]: return False
    try: d.decode('utf-8'); return True
    except: return False

def patch(data):
    if data.startswith(MAGIC_SKIP): return data
    if OLD_USR in data: data=data.replace(OLD_USR,NEW_USR)
    if OLD_HOME in data: data=data.replace(OLD_HOME,NEW_HOME)
    if is_text(data) and OLD_BASE in data: data=data.replace(OLD_BASE,NEW_BASE)
    return data

def ar_data(path):
    data=open(path,'rb').read(); assert data[:8]==b'!<arch>\n'; pos=8; out={}
    while pos+60<=len(data):
        hdr=data[pos:pos+60]; name=hdr[0:16].decode('ascii','replace').strip().rstrip('/')
        size=int(hdr[48:58].decode('ascii').strip()); out[name]=data[pos+60:pos+60+size]
        pos+=60+size+(size&1)
    return out

def norm(name):
    p=name.replace('\\','/')
    while p.startswith('./'): p=p[2:]
    if p.startswith('data/data/com.termux/files/usr/'):
        return p[len('data/data/com.termux/files/usr/'):]
    if p.startswith('data/data/com.termux/files/home/'):
        return 'home/' + p[len('data/data/com.termux/files/home/'):]
    return None

def norm_link(target):
    t=target
    t=t.replace('/data/data/com.termux/files/usr','/data/data/com.guncat.work/abcd')
    t=t.replace('/data/data/com.termux/files/home','/data/data/com.guncat.work/abcde')
    return t

z=zipfile.ZipFile(ASSET)
entries={}; symlinks={}; dirs=set()
for info in z.infolist():
    if info.is_dir():
        dirs.add(info.filename.rstrip('/'))
        continue
    data=z.read(info.filename)
    if info.filename=='SYMLINKS.txt':
        for line in data.decode('utf-8').splitlines():
            if '\u2190' in line:
                target,path=line.split('\u2190',1)
                while path.startswith('./'): path=path[2:]
                symlinks[path]=target
        continue
    entries[info.filename]=data
z.close()
print('base entries', len(entries), 'symlinks', len(symlinks))

manifest = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'termux-toolchain-packages.txt')
tur_manifest = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'termux-tur-packages.txt')
def read_manifest(path):
    return [line.strip() for line in open(path, encoding='utf-8')
            if line.strip() and not line.strip().startswith('#')]

pkgs = read_manifest(manifest) + read_manifest(tur_manifest)
status=entries.get('var/lib/dpkg/status',b'').decode('utf-8','replace')
stanzas=[]
for name in pkgs:
    deb_path = f'.tmp/termux/debs/{name}.deb'
    if not os.path.exists(deb_path):
        raise SystemExit(f'缺少 {deb_path}，请先运行 python scripts/fetch-termux-bootstrap.py')
    members=ar_data(deb_path)
    control_name = next(k for k in members if k.startswith('control.tar.'))
    data_name = next(k for k in members if k.startswith('data.tar.'))
    ct=tarfile.open(fileobj=io.BytesIO(members[control_name]), mode='r:*')
    control=None
    for m in ct.getmembers():
        if m.name.lstrip('./')=='control':
            control=ct.extractfile(m).read().decode('utf-8','replace')
    ct.close()
    fields={}
    for line in control.splitlines():
        if line.startswith(' ') or ':' not in line: continue
        k,v=line.split(':',1); fields[k.strip()]=v.strip()
    stanzas.append((name, control))
    dt=tarfile.open(fileobj=io.BytesIO(members[data_name]), mode='r:*')
    members_list=dt.getmembers()
    hardlinks=[]; added=0
    for m in members_list:
        p=norm(m.name)
        if p is None or p=='':
            continue
        if m.isdir():
            dirs.add(p)
            continue
        if m.issym():
            symlinks[p]=norm_link(m.linkname)
            entries.pop(p,None)
            added+=1
            continue
        if m.islnk():
            hardlinks.append((p,norm(m.linkname)))
            continue
        if not m.isfile():
            continue
        f=dt.extractfile(m)
        content=f.read() if f else b''
        entries[p]=patch(content)
        added+=1
    for p,target in hardlinks:
        if target and target in entries:
            entries[p]=entries[target]; added+=1
        elif target:
            print('missing hardlink', p, target)
    dt.close()
    print('merged', name, fields.get('Version'), 'files', added)

for name, control in stanzas:
    if re.search(r'^Package: '+re.escape(name)+r'$', status, re.M):
        continue
    fields={}
    for line in control.splitlines():
        if line.startswith(' ') or ':' not in line: continue
        k,v=line.split(':',1); fields[k.strip()]=v.strip()
    stanza='Package: '+name+'\nStatus: install ok installed\n'
    for key in ['Priority','Section','Installed-Size','Maintainer','Architecture','Version','Depends','Description']:
        if key in fields: stanza+=key+': '+fields[key]+'\n'
    status=status.rstrip('\n')+'\n\n'+stanza
entries['var/lib/dpkg/status']=status.encode('utf-8')

for p in list(entries.keys()) + list(symlinks.keys()):
    parent=os.path.dirname(p)
    while parent and parent not in dirs:
        dirs.add(parent); parent=os.path.dirname(parent)
tmp=ASSET+'.tmp'
with zipfile.ZipFile(tmp,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as zout:
    for d in sorted(dirs):
        zi=zipfile.ZipInfo(d + '/', date_time=(2026,10,18,0,0,0))
        zi.compress_type=zipfile.ZIP_STORED; zi.external_attr=(0o040755<<16)
        zout.writestr(zi,b'')
    # SYMLINKS.txt 必须最后写，先写普通文件
    for path,data in entries.items():
        zi=zipfile.ZipInfo(path, date_time=(2026,10,18,0,0,0))
        zi.compress_type=zipfile.ZIP_DEFLATED
        zi.external_attr=(0o100755 if (path.startswith('bin/') or path.startswith('libexec/')) else 0o100644)<<16
        zout.writestr(zi,data)
    lines=''.join(target+'\u2190./'+path+'\n' for path,target in sorted(symlinks.items()))
    zi=zipfile.ZipInfo('SYMLINKS.txt', date_time=(2026,10,18,0,0,0))
    zi.compress_type=zipfile.ZIP_DEFLATED; zi.external_attr=0o100644<<16
    zout.writestr(zi,lines.encode('utf-8'))
os.replace(tmp,ASSET)
print('written', ASSET, os.path.getsize(ASSET))
print('entries', len(entries), 'symlinks', len(symlinks))
print('sha256', hashlib.sha256(open(ASSET,'rb').read()).hexdigest())



