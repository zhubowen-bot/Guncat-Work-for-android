// 工作区镜像回归检查（Node，无需浏览器/真机）。
//
// 为什么需要它：Android 上文件工具跑在 memfs（src/mobile/shims/fs.ts），而 run_command
// 跑在真实进程里，两者之间靠 src/mobile/platform/mirror.ts 同步。镜像只要在**目录**上
// 漏一次，就会出现「delete_file 说删了、stat 还能看到」「rm -rf 之后 list_files 还列着」
// 「磁盘清空后目录又长回来」这类视图不一致。这些都不是 UI 层能看出来的，因此在这里
// 用真实文件系统当「设备」、memfs 当「工作区」，按命令的真实时序（syncDown → 命令 → syncUp）
// 跑一遍目录增删的完整矩阵。
//
// 用法：node scripts/mirror-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, '.tmp', 'mirror-check')
const ENTRY = path.join(TMP, 'entry.ts')
const OUT = path.join(TMP, 'bundle.cjs')

const DEVICE = path.join(TMP, 'device')
const VIRTUAL_PREFIX = '/guncat'
const FILES_DIR = '/guncat/data/files'
const CACHE_DIR = '/guncat/data/cache'

// 设备侧真实路径 ← 虚拟路径（与 ShellManager.resolveVirtual 同构）
function devicePath(virtualPath) {
  const clean = virtualPath.replace(/\/+$/, '') || VIRTUAL_PREFIX
  if (clean !== VIRTUAL_PREFIX && !clean.startsWith(VIRTUAL_PREFIX + '/')) {
    throw new Error('路径越界: ' + virtualPath)
  }
  return path.join(DEVICE, clean.slice(VIRTUAL_PREFIX.length))
}

function listDevice(virtualPath) {
  const base = devicePath(virtualPath)
  const entries = []
  let truncated = false
  const walk = (dir) => {
    if (truncated) {
      return
    }
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (entries.length >= 20000) {
        truncated = true
        return
      }
      const full = path.join(dir, name)
      const rel = path.relative(base, full).split(path.sep).join('/')
      let stat
      try {
        stat = fs.lstatSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        entries.push([rel, 'd', 0, stat.mtimeMs])
        walk(full)
      } else if (stat.isFile()) {
        entries.push([rel, 'f', stat.size, stat.mtimeMs])
      }
    }
  }
  walk(base)
  return { ok: true, entries, truncated }
}

// 与 ShellManager.java 的 fs* 接口等价（同步、只接受 /guncat 内路径）
const bridge = {
  info: () => JSON.stringify({ ok: true, nativeRoot: DEVICE, shell: 'check', abi: 'x', bundled: {} }),
  start: () => JSON.stringify({ ok: false, error: 'check 不执行真实命令' }),
  read: () => JSON.stringify({ ok: false, error: 'check 不执行真实命令' }),
  kill: () => {},
  release: () => {},
  reinstallBundled: () => {},
  fsList(virtualPath) {
    try {
      return JSON.stringify(listDevice(virtualPath))
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e && e.message) })
    }
  },
  fsRead(virtualPath) {
    try {
      const file = devicePath(virtualPath)
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return JSON.stringify({ ok: false, error: '不是文件: ' + virtualPath })
      }
      const bytes = fs.readFileSync(file)
      return JSON.stringify({
        ok: true,
        data: bytes.toString('base64'),
        size: bytes.length,
        mtime: fs.statSync(file).mtimeMs
      })
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e && e.message) })
    }
  },
  fsWrite(virtualPath, base64) {
    try {
      const file = devicePath(virtualPath)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, Buffer.from(base64, 'base64'))
      const stat = fs.statSync(file)
      return JSON.stringify({ ok: true, size: stat.size, mtime: stat.mtimeMs })
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e && e.message) })
    }
  },
  fsDelete(virtualPath) {
    try {
      fs.rmSync(devicePath(virtualPath), { recursive: true, force: true })
      return JSON.stringify({ ok: true })
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e && e.message) })
    }
  },
  fsMkdir(virtualPath) {
    try {
      const file = devicePath(virtualPath)
      if (!fs.existsSync(file)) {
        fs.mkdirSync(file, { recursive: true })
      }
      return JSON.stringify({ ok: true, mtime: fs.statSync(file).mtimeMs })
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e && e.message) })
    }
  },
  fsStat(virtualPath) {
    try {
      const file = devicePath(virtualPath)
      const exists = fs.existsSync(file)
      return JSON.stringify({
        ok: true,
        exists,
        dir: exists && fs.statSync(file).isDirectory(),
        size: exists && fs.statSync(file).isFile() ? fs.statSync(file).size : 0,
        mtime: exists ? fs.statSync(file).mtimeMs : 0
      })
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e && e.message) })
    }
  }
}

// ===== 打包被测代码（memfs 当工作区、真实 fs 当设备） =====

const KIT_ALIAS = {
  '@kit.ArkTS': 'src/core/platform/kit/ArkTS.ts',
  '@kit.CoreFileKit': 'src/core/platform/kit/CoreFileKit.ts',
  '@kit.NetworkKit': 'src/core/platform/kit/NetworkKit.ts',
  '@kit.BasicServicesKit': 'src/core/platform/kit/BasicServicesKit.ts',
  '@kit.AbilityKit': 'src/core/platform/kit/AbilityKit.ts',
  '@kit.ArkData': 'src/core/platform/kit/ArkData.ts',
  '@kit.PerformanceAnalysisKit': 'src/core/platform/kit/PerformanceAnalysisKit.ts',
  '@kit.ImageKit': 'src/core/platform/kit/ImageKit.ts',
  '@kit.PDFKit': 'src/core/platform/kit/PDFKit.ts',
  'libguncatjs.so': 'src/core/platform/native/libguncatjs.ts',
  '@core': 'src/core',
  '@ipc': 'src/ipc'
}

function kitPlugin() {
  return {
    name: 'mirror-check-kit',
    setup(build) {
      build.onResolve({ filter: /^(?:@kit\.|@core$|@ipc$|libguncatjs\.so$)/ }, (args) => {
        const rel = KIT_ALIAS[args.path]
        return rel === undefined ? null : { path: path.join(ROOT, rel) }
      })
    }
  }
}

function fsPlugin() {
  return {
    name: 'mirror-check-fs',
    setup(build) {
      build.onResolve({ filter: /^node:fs$/ }, () => ({ path: path.join(TMP, 'memfs-shim.cjs') }))
    }
  }
}

async function bundle() {
  const esbuild = await import('esbuild')
  fs.mkdirSync(TMP, { recursive: true })
  fs.writeFileSync(
    ENTRY,
    [
      "export { WorkFileService } from '../../src/core/service/WorkFileService'",
      "export * from '../../src/mobile/platform/mirror'",
      ''
    ].join('\n')
  )
  fs.writeFileSync(
    path.join(TMP, 'memfs-shim.cjs'),
    [
      "const { Volume, createFsFromVolume } = require('memfs')",
      "const { notifyFsDelete } = require('../../src/mobile/shims/fsEvents.ts')",
      'const volume = new Volume()',
      'const fs = createFsFromVolume(volume)',
      '// 与 src/mobile/shims/fs.ts 一致：删除类操作发事件，镜像据此立即删设备副本',
      "for (const name of ['rmSync', 'rmdirSync', 'unlinkSync']) {",
      '  const original = fs[name].bind(fs)',
      '  fs[name] = (...args) => {',
      '    const result = original(...args)',
      "    notifyFsDelete(typeof args[0] === 'string' ? args[0] : '')",
      '    return result',
      '  }',
      '}',
      'module.exports = fs',
      'module.exports.default = fs',
      'module.exports.__volume = volume',
      ''
    ].join('\n')
  )
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: OUT,
    logLevel: 'silent',
    define: { 'import.meta.url': JSON.stringify('file://' + OUT.split(path.sep).join('/')) },
    plugins: [kitPlugin(), fsPlugin()]
  })
}

// ===== 断言工具 =====

let failures = 0
let checks = 0
function check(name, ok, detail) {
  checks += 1
  if (ok) {
    console.log('  ok   ' + name)
    return
  }
  failures += 1
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' -> ' + detail))
}

// ===== 主流程 =====

await bundle()
globalThis.window = { GuncatShell: bridge }
// 每次运行都从空设备开始
fs.rmSync(DEVICE, { recursive: true, force: true })
fs.mkdirSync(DEVICE, { recursive: true })

const mod = createRequire(import.meta.url)(OUT)
const WorkFileService = mod.WorkFileService
const WorkspaceMirror = mod.WorkspaceMirror
// 生产环境在 boot.ts 里装；这里等价地装一次，删除事件才会同步到设备
mod.installMirrorFsEvents()

const ctx = { filesDir: FILES_DIR, cacheDir: CACHE_DIR }

function rootOf(conv) {
  return FILES_DIR + '/workspaces/' + conv
}

function tool(conv, name, args) {
  return WorkFileService.executeTool(ctx, conv, name, JSON.stringify(args))
}

/** 模拟一次 run_command：执行前 syncDown，命令改设备目录，执行后 syncUp。 */
function runCommand(conv, mutate) {
  const mirror = new WorkspaceMirror(rootOf(conv))
  mirror.syncDown()
  try {
    mutate(devicePath(rootOf(conv)))
  } finally {
    mirror.syncUp()
  }
  return mirror.warnings.slice()
}

async function listing(conv) {
  const result = await tool(conv, 'list_files', { path: '.' })
  return result.output
}

// ---------- P1：delete_file 删目录，设备侧必须同步消失 ----------
{
  console.log('\nP1 delete_file 目录')
  const conv = 'p1'
  await tool(conv, 'create_dir', { path: 'a/b' })
  runCommand(conv, () => {})
  check('建目录后设备可见', fs.existsSync(path.join(devicePath(rootOf(conv)), 'a/b')))

  const del = await tool(conv, 'delete_file', { path: 'a' })
  check('delete_file 返回成功', del.ok, del.output)
  const out = await listing(conv)
  check('工作区列表已空', out.includes('工作区为空') || out.includes('目录为空'), out)
  check('设备上目录立即消失', !fs.existsSync(path.join(devicePath(rootOf(conv)), 'a')))
  check('设备上子目录立即消失', !fs.existsSync(path.join(devicePath(rootOf(conv)), 'a/b')))

  runCommand(conv, () => {})
  check('下一条命令的 stat 看不到 a', !fs.existsSync(path.join(devicePath(rootOf(conv)), 'a')))

  // 文件也一样：删除后设备副本当轮消失（隐私上也不该留到下一次命令）
  await tool(conv, 'write_file', { path: 'secret.txt', content: 's\n' })
  runCommand(conv, () => {})
  await tool(conv, 'delete_file', { path: 'secret.txt' })
  check('删文件当轮同步到设备', !fs.existsSync(path.join(devicePath(rootOf(conv)), 'secret.txt')))
}

// ---------- P2a：shell rm -rf 目录后，list_files 不能继续列 ----------
{
  console.log('\nP2a shell 删目录')
  const conv = 'p2a'
  await tool(conv, 'write_file', { path: 'autotest/src/x.ts', content: 'export const x = 1\n' })
  runCommand(conv, () => {})
  check('设备准备就绪', fs.existsSync(path.join(devicePath(rootOf(conv)), 'autotest/src/x.ts')))

  runCommand(conv, (dir) => fs.rmSync(path.join(dir, 'autotest'), { recursive: true, force: true }))
  const out = await listing(conv)
  check('list_files 不再列出 autotest', !out.includes('autotest'), out)
  check('设备侧确实已删', !fs.existsSync(path.join(devicePath(rootOf(conv)), 'autotest')))
}

// ---------- P2b：删掉又长回来的幻影目录 ----------
{
  console.log('\nP2b 幻影目录')
  const conv = 'p2b'
  await tool(conv, 'create_dir', { path: 'ghost/inner' })
  runCommand(conv, () => {})
  const del = await tool(conv, 'delete_file', { path: 'ghost' })
  check('delete_file 成功', del.ok, del.output)

  // 删除后再跑一条命令：旧实现会在 syncUp 里按设备残留把目录重新 mkdir 回来
  runCommand(conv, () => {})
  const out = await listing(conv)
  check('删除过的目录不会长回来', !out.includes('ghost'), out)

  // 设备侧被外部清空后，工作区也不能留着目录
  runCommand(conv, (dir) => fs.rmSync(path.join(dir, 'ghost'), { recursive: true, force: true }))
  check('设备清空后工作区同步', !(await listing(conv)).includes('ghost'))
}

// ---------- P2c：写入不复活幻影目录 ----------
{
  console.log('\nP2c 写入自愈')
  const conv = 'p2c'
  await tool(conv, 'create_dir', { path: 'stale/child' })
  runCommand(conv, () => {})
  await tool(conv, 'delete_file', { path: 'stale' })
  await tool(conv, 'write_file', { path: 'keep.txt', content: 'keep\n' })
  runCommand(conv, () => {})
  const out = await listing(conv)
  check('新文件可见', out.includes('keep.txt'), out)
  check('幻影目录未复活', !out.includes('stale'), out)
}

// ---------- 回归：shell 建目录 / 建文件仍要读回工作区 ----------
{
  console.log('\n回归 shell 新建')
  const conv = 'shellnew'
  runCommand(conv, (dir) => {
    fs.mkdirSync(path.join(dir, 'shellonly_dir/nested'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'shellonly_dir/nested/y.txt'), 'y\n')
  })
  const out = await listing(conv)
  check('shell 建的目录出现在 list_files', out.includes('shellonly_dir/'), out)
  check('shell 建的文件出现在 list_files', out.includes('shellonly_dir/nested/y.txt'), out)
  check('设备文件仍在', fs.existsSync(path.join(devicePath(rootOf(conv)), 'shellonly_dir/nested/y.txt')))

  // 再跑一条命令不能把它们删掉（本会话新建的目录不在 state.dirs 里，也不应被当成残留）
  runCommand(conv, () => {})
  check(
    '反复同步不丢 shell 新建的目录',
    fs.existsSync(path.join(devicePath(rootOf(conv)), 'shellonly_dir/nested'))
  )
  check('反复同步后列表仍完整', (await listing(conv)).includes('shellonly_dir/nested/y.txt'))

  // shell 删掉自己建的目录：工作区也要跟着消失（不能只在设备上删掉）
  runCommand(conv, (dir) => fs.rmSync(path.join(dir, 'shellonly_dir'), { recursive: true, force: true }))
  const after = await listing(conv)
  check('shell 删自己建的目录后列表清空', !after.includes('shellonly_dir'), after)
}

// ---------- 回归：目录移动 ----------
{
  console.log('\n回归 目录移动')
  const conv = 'move'
  await tool(conv, 'write_file', { path: 'old/inner/a.txt', content: 'a\n' })
  runCommand(conv, () => {})
  const moved = await tool(conv, 'move_file', { from: 'old', to: 'new' })
  check('move_file 目录成功', moved.ok, moved.output)
  runCommand(conv, () => {})
  const dir = devicePath(rootOf(conv))
  check('设备上新目录存在', fs.existsSync(path.join(dir, 'new/inner/a.txt')))
  check('设备上旧目录已消失', !fs.existsSync(path.join(dir, 'old')))
  const out = await listing(conv)
  check('列表只列新目录', out.includes('new/inner/a.txt') && !out.includes('old/'), out)
}

// ---------- 回归：清空工作区 ----------
{
  console.log('\n回归 清空工作区')
  const conv = 'wipe'
  await tool(conv, 'create_dir', { path: 'one/two' })
  await tool(conv, 'write_file', { path: 'one/two/f.txt', content: 'x\n' })
  runCommand(conv, () => {})
  const wipe = await tool(conv, 'delete_file', { path: '' })
  check('清空返回成功', wipe.ok, wipe.output)
  const deviceRoot = devicePath(rootOf(conv))
  const left = fs.existsSync(deviceRoot) ? fs.readdirSync(deviceRoot) : []
  check('设备工作区已清空', left.length === 0, left.join(','))
  runCommand(conv, () => {})
  check('清空后再同步仍为空', (fs.existsSync(deviceRoot) ? fs.readdirSync(deviceRoot) : []).length === 0)
}

console.log('\n' + (failures === 0 ? '通过' : '失败') + '：' + (checks - failures) + '/' + checks)
if (failures > 0) {
  process.exitCode = 1
}
