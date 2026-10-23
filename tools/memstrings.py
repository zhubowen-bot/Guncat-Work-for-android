import sys, struct, re, json, os
sys.path.insert(0, r'C:\Users\a1519\Documents\Guncat-Work-for-web\tools')
import mdmp

def u32(d,o): return struct.unpack_from('<I',d,o)[0]
def u64(d,o): return struct.unpack_from('<Q',d,o)[0]

path = sys.argv[1]
outdir = sys.argv[2]
data = open(path,'rb').read()
r = mdmp.R(data)
nstreams = r.u32(8); dirrva = r.u32(12)
streams = {}
for i in range(nstreams):
    o = dirrva + i*12
    streams.setdefault(r.u32(o), []).append((r.u32(o+4), r.u32(o+8)))

mods = []
if 4 in streams:
    sz, rva = streams[4][0]
    n = u32(data, rva)
    for i in range(n):
        o = rva + 4 + i*108
        base = u64(data, o); size = u32(data, o+8)
        name = mdmp.read_minidump_string(r, u32(data, o+20))
        mods.append((base, base+size, name, os.path.basename(name)))

def sym(addr):
    for b, e, name, short in mods:
        if b <= addr < e:
            return '%s+0x%x' % (short, addr-b)
    return hex(addr)

def addstr(store, s):
    s = s.strip()
    if len(s) < 6: return
    store.add(s)

ranges = 0
strings_ascii = set()
strings_wide = set()
if 5 in streams:
    sz, rva = streams[5][0]
    n = u32(data, rva)
    ranges = n
    for i in range(n):
        o = rva + 4 + i*16
        start = u64(data, o)
        msize = u32(data, o+8)
        mrva = u32(data, o+12)
        blob = data[mrva:mrva+msize]
        for m in re.finditer(rb'[\x20-\x7e\t]{8,}', blob):
            addstr(strings_ascii, m.group().decode('ascii','replace'))
        for m in re.finditer(rb'(?:[\x20-\x7e]\x00){6,}', blob):
            try: addstr(strings_wide, m.group().decode('utf-16-le'))
            except Exception: pass
print('memory ranges:', ranges)
print('ascii strings:', len(strings_ascii), ' wide strings:', len(strings_wide))

KW = re.compile(r'gpu|GPU|sandbox|Sandbox|FATAL|ERROR|WARNING|CHECK|Check failed|DCHECK|process launch|error_code|mojo|viz|Dawn|ANGLE|d3d|D3D|swiftshader|SwiftShader|disable|fallback|dxgi|DXGI|direct_composition|Compositor|registry|Registry|policy|Policy|access|Access|denied|Denied|blocked|Blocked', re.I)
sel_a = sorted([s for s in strings_ascii if KW.search(s)])
sel_w = sorted([s for s in strings_wide if KW.search(s)])
with open(os.path.join(outdir,'mem-ascii-all.txt'),'w',encoding='utf-8') as f:
    f.write('\n'.join(sorted(strings_ascii)))
with open(os.path.join(outdir,'mem-wide-all.txt'),'w',encoding='utf-8') as f:
    f.write('\n'.join(sorted(strings_wide)))
with open(os.path.join(outdir,'mem-keywords.txt'),'w',encoding='utf-8') as f:
    f.write('=== ASCII keyword hits ===\n')
    f.write('\n'.join(sel_a))
    f.write('\n\n=== WIDE keyword hits ===\n')
    f.write('\n'.join(sel_w))
print('keyword hits: ascii', len(sel_a), 'wide', len(sel_w))
print('written to', outdir)
