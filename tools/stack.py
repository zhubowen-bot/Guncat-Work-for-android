import sys, struct, re, json
sys.path.insert(0, r'C:\Users\a1519\Documents\Guncat-Work-for-web\tools')
import mdmp

def u32(d,o): return struct.unpack_from('<I',d,o)[0]
def u64(d,o): return struct.unpack_from('<Q',d,o)[0]

path = sys.argv[1]
data = open(path,'rb').read()
r = mdmp.R(data)
nstreams = r.u32(8); dirrva = r.u32(12)
streams = {}
for i in range(nstreams):
    o = dirrva + i*12
    streams.setdefault(r.u32(o), []).append((r.u32(o+4), r.u32(o+8)))

# ThreadList
threads = []
if 3 in streams:
    sz, rva = streams[3][0]
    n = u32(data, rva)
    for i in range(n):
        o = rva + 4 + i*48
        tid = u32(data, o)
        stk_start = u64(data, o+24)
        stk_size = u32(data, o+32)
        stk_rva  = u32(data, o+36)
        ctx_size = u32(data, o+40)
        ctx_rva  = u32(data, o+44)
        threads.append(dict(tid=tid, stack_start=stk_start, stack_size=stk_size,
                            stack_rva=stk_rva, ctx_rva=ctx_rva, ctx_size=ctx_size))
print('threads:', len(threads))

# ThreadNames
names = {}
if 24 in streams:
    sz, rva = streams[24][0]
    n = u32(data, rva)
    for i in range(n):
        o = rva + 4 + i*12
        tid = u32(data, o)
        nrva = u64(data, o+4)
        names[tid] = mdmp.read_minidump_string(r, nrva)
print('thread names:', len(names))
for t in threads:
    t['name'] = names.get(t['tid'], '')
print()
print('=== THREAD NAMES ===')
for t in sorted(names.values()):
    print('  ', t)
print()
print('=== EXCEPTION THREAD ===')
exc_rva = None
if 6 in streams:
    sz, rva = streams[6][0]
    tid = u32(data, rva)
    print('exception tid:', tid, 'name:', names.get(tid))
    exc_rva = rva
    print('context rva:', u32(data, rva+8+152+0), 'size:', u32(data, rva+8+152+4))
    for t in threads:
        if t['tid'] == tid:
            print('stack:', hex(t['stack_start']), t['stack_size'], 'bytes @ rva', t['stack_rva'])
            # dump strings from the stack
            stk = data[t['stack_rva']:t['stack_rva']+t['stack_size']]
            print()
            print('--- ASCII strings on exception thread stack (len>=5) ---')
            seen = set()
            for s in re.findall(rb'[\x20-\x7e]{5,}', stk):
                try: txt = s.decode('ascii')
                except: continue
                if txt in seen: continue
                seen.add(txt)
                print('   ', txt)
            print()
            print('--- UTF-16 strings on stack (len>=5) ---')
            seen2 = set()
            for m in re.finditer(rb'(?:[\x20-\x7e]\x00){5,}', stk):
                txt = m.group().decode('utf-16-le')
                if txt in seen2: continue
                seen2.add(txt)
                print('   ', txt)
