import struct, sys, os, json

MDMP_SIGNATURE = b'MDMP'
StreamType = {0:'Unused',3:'ThreadList',4:'ModuleList',5:'MemoryList',6:'Exception',7:'SystemInfo',
              8:'ThreadExList',9:'Memory64List',10:'CommentA',11:'CommentW',12:'HandleData',
              13:'FunctionTable',14:'UnloadedModuleList',15:'MiscInfo',16:'MemoryInfoList',
              17:'ThreadInfoList',18:'HandleOperationList',19:'Token',20:'JavaScriptData',
              21:'SystemMemoryInfo',22:'ProcessVmCounters',23:'IptTrace',24:'ThreadNames'}

class R:
    def __init__(self, data): self.d = data
    def u32(self, o): return struct.unpack_from('<I', self.d, o)[0]
    def u64(self, o): return struct.unpack_from('<Q', self.d, o)[0]
    def i32(self, o): return struct.unpack_from('<i', self.d, o)[0]
    def u16(self, o): return struct.unpack_from('<H', self.d, o)[0]
    def md5rva(self, o): return self.u32(o)

def read_cstring(r, rva):
    end = r.d.index(b'\x00', rva)
    return r.d[rva:end].decode('utf-8', 'replace')

def read_minidump_string(r, rva):
    if rva == 0: return ''
    n = r.u32(rva)
    if n == 0: return ''
    raw = r.d[rva+4:rva+4+n]
    if n % 2 == 0:
        return raw.decode('utf-16-le', 'replace')
    return raw.decode('utf-8', 'replace')

def parse(path, memsample=0):
    with open(path,'rb') as f: data = f.read()
    r = R(data)
    assert data[:4] == MDMP_SIGNATURE, 'not a minidump'
    ver = r.u32(4); nstreams = r.u32(8); dirrva = r.u32(12)
    out = {'file': path, 'size': len(data), 'version': hex(ver), 'streams': {}}
    streams = {}
    for i in range(nstreams):
        o = dirrva + i*12
        st = r.u32(o); sz = r.u32(o+4); rva = r.u32(o+8)
        streams.setdefault(st, []).append((sz, rva))
        out['streams'].setdefault(StreamType.get(st, str(st)), []).append({'size':sz,'rva':rva})
    # ModuleList
    mods = []
    if 4 in streams:
        sz, rva = streams[4][0]
        n = r.u32(rva)
        for i in range(n):
            o = rva+4+i*108
            base = r.u64(o); size = r.u32(o+8)
            namerva = r.u32(o+20)
            name = read_minidump_string(r, namerva)
            ts = r.u32(o+12)
            mods.append({'base':base,'size':size,'name':name,'ts':ts})
    out['modules'] = mods
    out['module_count'] = len(mods)
    # SystemInfo
    if 7 in streams:
        sz, rva = streams[7][0]
        arch = r.u16(rva)
        out['system'] = {
            'processor_architecture': arch,
            'number_of_processors': r.d[rva+6],
            'product_type': r.u32(rva+8) & 0xffff,
            'major': r.u32(rva+12), 'minor': r.u32(rva+16), 'build': r.u32(rva+20),
            'platform': r.u32(rva+24),
            'csd_rva': r.u32(rva+28),
            'suite': r.u16(rva+32),
        }
    # MiscInfo
    if 15 in streams:
        sz, rva = streams[15][0]
        size_of_info = r.u32(rva)
        flags1 = r.u32(rva+4)
        info = {}
        # ProcessId is 1 << 4 = 0x10 ... flags are bits for presence
        off = rva+8
        def take(nbytes):
            nonlocal off
            v = r.d[off:off+nbytes]; off += nbytes; return v
        if flags1 & 0x1: info['ProcessId'] = r.u32(off); off += 4
        if flags1 & 0x2: info['ProcessCreateTime'] = r.u32(off); off += 4
        if flags1 & 0x4: info['ProcessUserTime'] = r.u32(off); off += 4
        if flags1 & 0x8: info['ProcessKernelTime'] = r.u32(off); off += 4
        if flags1 & 0x10: info['ProcessorMaxMhz'] = r.u32(off); off += 4
        if flags1 & 0x20: info['ProcessorCurrentMhz'] = r.u32(off); off += 4
        if flags1 & 0x40: info['ProcessorMhzLimit'] = r.u32(off); off += 4
        if flags1 & 0x80: info['ProcessorMaxIdleState'] = r.u32(off); off += 4
        if flags1 & 0x100: info['ProcessorCurrentIdleState'] = r.u32(off); off += 4
        out['misc'] = info
    # Exception
    if 6 in streams:
        sz, rva = streams[6][0]
        tid = r.u32(rva)
        # MINIDUMP_EXCEPTION starts at rva+8 (ThreadId(4) + __alignment(4))
        e = rva+8
        code = r.u32(e); eflags = r.u32(e+4)
        rec = r.u64(e+8)
        addr = r.u64(e+16)
        nparam = r.u32(e+24)
        params = []
        for i in range(min(nparam,15)):
            params.append(r.u64(e+32+i*8))
        out['exception'] = {'thread_id': tid, 'code': code, 'code_hex': hex(code & 0xffffffff),
                            'flags': eflags, 'address': addr, 'address_hex': hex(addr),
                            'num_params': nparam, 'params': [hex(p) for p in params]}
        # ThreadContext at rva + 4 + 168 (sizeof MINIDUMP_EXCEPTION = 152? actually 4+4+8+8+4+4pad+15*8)
        # MINIDUMP_EXCEPTION: Code(4) Flags(4) Record(8) Address(8) NumberParameters(4) __unusedAlignment(4) ExceptionInformation[15](120) = 152
        # MINIDUMP_EXCEPTION_STREAM: ThreadId(4) __alignment(4) Exception(152) ThreadContext(LocationDescriptor 8)
        loc_rva = rva + 4 + 152
        tctx_size = r.u32(loc_rva); tctx_rva = r.u32(loc_rva+4)
        out['exception']['context_size'] = tctx_size
        if tctx_size >= 0x4d0:
            ctx = parse_context(r, tctx_rva)
            out['exception']['context'] = ctx
    # find faulting module
    exc = out.get('exception')
    if exc:
        a = exc['address']
        best = None
        for m in mods:
            if m['base'] <= a < m['base']+m['size']:
                best = m; break
        out['faulting_module'] = best['name'] if best else None
        out['faulting_module_base'] = hex(best['base']) if best else None
        out['offset_in_module'] = hex(a - best['base']) if best else None
    return out

def parse_context(r, o):
    # AMD64 CONTEXT
    c = {}
    c['Rip'] = r.u64(o+0xF8)
    c['Rsp'] = r.u64(o+0x98)
    c['Rbp'] = r.u64(o+0xA0)
    c['Rax'] = r.u64(o+0x78)
    c['Rcx'] = r.u64(o+0x80)
    c['Rdx'] = r.u64(o+0x88)
    c['Rbx'] = r.u64(o+0x90)
    c['Rsi'] = r.u64(o+0xA8)
    c['Rdi'] = r.u64(o+0xB0)
    c['R8'] = r.u64(o+0xB8); c['R9'] = r.u64(o+0xC0); c['R10'] = r.u64(o+0xC8)
    c['R11'] = r.u64(o+0xD0); c['R12'] = r.u64(o+0xD8); c['R13'] = r.u64(o+0xE0)
    c['R14'] = r.u64(o+0xE8); c['R15'] = r.u64(o+0xF0)
    # ContextFlags at 0x30
    c['ContextFlags'] = hex(r.u32(o+0x30))
    # MxCsr / etc.
    return c

if __name__ == '__main__':
    for p in sys.argv[1:]:
        try:
            info = parse(p)
        except Exception as ex:
            print(f'{p}: FAILED {ex}'); continue
        print('='*100)
        print('FILE:', p, os.path.getsize(p), 'bytes')
        print('Version:', info['version'], ' ModuleCount:', info['module_count'])
        print('System:', json.dumps(info.get('system')))
        print('Misc:', json.dumps(info.get('misc')))
        e = info.get('exception')
        if e:
            print('Exception code:', e['code_hex'], ' addr:', e['address_hex'], ' tid:', e['thread_id'])
            print('Params:', e['params'])
            print('Faulting module:', info.get('faulting_module'), 'base', info.get('faulting_module_base'), 'offset', info.get('offset_in_module'))
            print('Context:', json.dumps(e.get('context'), indent=1))
        # print a few modules
        print('Modules (first 40):')
        for m in info['modules'][:40]:
            print('   %016x %8x  %s' % (m['base'], m['size'], m['name']))
