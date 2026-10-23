// 构建 Guncat Work 的单文件安装包。
//
// 产物：release/Guncat-Work-<版本>-setup.exe
//   = 安装程序界面（WPF，无边框圆角，自绘）
//   + 应用本体（payload.7z，与 `npm run dist` 的便携目录逐字节相同）
//   + 7za.exe（安装时解压用，来自本机 electron-builder 的缓存）
//   + uninstall.exe（卸载程序，装完后留在安装目录里）
//
// 为什么不用 electron-builder 的 nsis 目标：
//   · 它给的是「向导式」Win32 界面，和本项目的要求（现代化界面）正好相反；
//     要在它上面做出圆角/渐变/自定义配色，得换一套皮肤插件，投入大且不可控。
//   · 本机环境下 electron-builder 在收集 node_modules 那一步会 spawn EPERM（管道被限制），
//     而我们把应用代码全部打进了 out/，这一步本来就是多余的。
//   于是安装程序改为用 Windows 自带的 csc.exe 编译的 WPF 程序，见 installer/README.md。
//
// 用法：
//   node scripts/package-installer.mjs               完整构建（含应用构建、7z 压缩、编译）
//   node scripts/package-installer.mjs --skip-build  复用已有 out/，不重跑 vite
//   node scripts/package-installer.mjs --skip-7z     复用已有 payload.7z（改界面时省时间）
//   node scripts/package-installer.mjs --shots       只渲染界面各页到 .tmp/installer-shots/
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appName = 'Guncat Work'
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
// --ui-only：只编界面、只渲染截图。改配色/排版时用它，跳过应用构建与 7z 压缩（省几分钟）。
// 这种模式下产物不进 release/，免得半成品覆盖真正的安装包。
const uiOnly = has('--ui-only')

const installerDir = path.join(root, 'installer')
const srcDir = path.join(installerDir, 'src')
const buildDir = path.join(root, '.tmp', 'installer')
const genDir = path.join(buildDir, 'gen')
const payloadRoot = path.join(buildDir, 'payload')
const payloadArchive = path.join(buildDir, 'payload.7z')
const uninstallerExe = path.join(buildDir, 'uninstall.exe')
const icoPath = path.join(root, 'resources', 'app-icon.ico')
const manifestPath = path.join(installerDir, 'app.manifest')
const releaseDir = path.join(root, 'release')
const outExe = uiOnly
  ? path.join(buildDir, 'setup-ui.exe')
  : path.join(releaseDir, `Guncat-Work-${version}-setup.exe`)

function step(msg) {
  console.log(`\n▸ ${msg}`)
}

function fail(msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })
  if (r.error) fail(`无法执行 ${cmd}：${r.error.message}`)
  if (r.status !== 0) fail(`${path.basename(cmd)} 退出码 ${r.status}`)
}

// ===== 1. 应用本体 =====
if (!uiOnly && !has('--skip-build')) {
  step('构建应用（Node 侧 + 渲染层）')
  run(process.execPath, [path.join(root, 'scripts', 'build.mjs'), 'build'])
} else if (!uiOnly && !fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  fail('--skip-build 但 out/main/index.js 不存在，先跑一次完整构建。')
}

// --skip-7z 只有在「压缩包与解压出来的载荷目录都还在」时才真的能跳过：
// 载荷目录还要用来统计文件数与体积（写进 BuildInfo），缺一个就必须重来。
const reusePayload =
  has('--skip-7z') && fs.existsSync(payloadArchive) && fs.existsSync(payloadRoot)
if (has('--skip-7z') && !reusePayload) {
  step('--skip-7z 用不了（缺 payload.7z 或载荷目录），改为重新组装并压缩')
}

// ===== 2. 组装载荷目录（与便携版完全同一份产物）=====
if (!uiOnly && !reusePayload) {
  step('组装应用载荷目录')
  run(process.execPath, [path.join(root, 'scripts', 'package-portable.mjs')], {
    env: { ...process.env, GUNCAT_PACKAGE_OUTDIR: payloadRoot }
  })
}

// ===== 3. 压缩成 payload.7z =====
function find7za() {
  const vendor = path.join(installerDir, 'vendor', '7za.exe')
  if (fs.existsSync(vendor)) return vendor
  const cacheRoot = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache')
  if (fs.existsSync(cacheRoot)) {
    for (const entry of fs.readdirSync(cacheRoot)) {
      if (!entry.startsWith('7zip@')) continue
      for (const inner of fs.readdirSync(path.join(cacheRoot, entry))) {
        const candidate = path.join(cacheRoot, entry, inner, 'bin', '7za.exe')
        if (fs.existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

if (!uiOnly && !reusePayload) {
  const sevenZip = find7za()
  if (!sevenZip) {
    fail(
      '找不到 7za.exe。它由 electron-builder 首次使用时下载到 ' +
        '%LOCALAPPDATA%\\electron-builder\\Cache\\7zip@*\\…\\bin\\7za.exe；\n' +
        '  也可以把 7za.exe 放到 installer/vendor/7za.exe 再重跑。'
    )
  }
  step(`压缩载荷（${path.relative(root, sevenZip)}）`)
  fs.rmSync(payloadArchive, { force: true })
  run(sevenZip, [
    'a',
    '-t7z',
    '-m0=lzma2',
    '-mx=7',
    '-mmt=on',
    '-ms=on',
    '-bso1',
    '-bsp0',
    payloadArchive,
    '*'
  ], { cwd: payloadRoot })
}

// ===== 4. 统计载荷，生成 BuildInfo.cs =====
function treeStats(dir) {
  let bytes = 0
  let files = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else {
        files++
        bytes += fs.statSync(full).size
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

const stats = uiOnly ? { bytes: 0, files: 0 } : treeStats(payloadRoot)
if (!uiOnly) {
  step(`载荷：${stats.files} 个文件 / ${(stats.bytes / 1024 / 1024).toFixed(1)} MB`)
  step(`压缩后：${(fs.statSync(payloadArchive).size / 1024 / 1024).toFixed(1)} MB`)
}

fs.mkdirSync(genDir, { recursive: true })
const buildInfo = `// 由 scripts/package-installer.mjs 生成，请勿手工修改。
namespace GuncatSetup
{
    static class BuildInfo
    {
        public const string AppName = ${JSON.stringify(appName)};
        public const string DefaultDirName = ${JSON.stringify(appName)};
        public const string ExeName = ${JSON.stringify(appName + '.exe')};
        public const string Version = ${JSON.stringify(version)};
        public const string Publisher = ${JSON.stringify(pkg.author || '')};
        public const long PayloadBytes = ${stats.bytes}L;
        public const int PayloadFiles = ${stats.files};
    }
}
`
fs.writeFileSync(path.join(genDir, 'BuildInfo.cs'), buildInfo, 'utf8')

// ===== 5. 找 csc 与 .NET Framework 引用程序集 =====
function findCsc() {
  const candidates = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

function findRefDir() {
  const base = 'C:\\Program Files (x86)\\Reference Assemblies\\Microsoft\\Framework\\.NETFramework'
  if (!fs.existsSync(base)) return null
  // 从高到低找第一个可用的目标框架
  const want = ['v4.8', 'v4.7.2', 'v4.7.1', 'v4.7', 'v4.6.2', 'v4.6.1', 'v4.6', 'v4.5.2', 'v4.5.1', 'v4.5']
  const have = fs.readdirSync(base)
  for (const w of want) {
    if (have.includes(w) && fs.existsSync(path.join(base, w, 'PresentationFramework.dll'))) {
      return path.join(base, w)
    }
  }
  return null
}

const csc = findCsc()
if (!csc) fail('找不到 csc.exe（.NET Framework 的 C# 编译器）。安装程序依赖它编译，见 installer/README.md。')
const refDir = findRefDir()
if (!refDir) fail('找不到 .NET Framework 的引用程序集（Reference Assemblies\\...\\.NETFramework\\v4.x）。')

const refs = ['System', 'System.Core', 'System.Xml', 'WindowsBase', 'PresentationCore', 'PresentationFramework', 'System.Xaml', 'Microsoft.CSharp']
  .map((n) => path.join(refDir, n + '.dll'))
  .filter((p) => {
    if (!fs.existsSync(p)) console.warn(`  ! 缺少引用程序集 ${path.basename(p)}`)
    return fs.existsSync(p)
  })

const common = [
  ['/nologo'],
  ['/target:winexe'],
  ['/platform:anycpu'],
  ['/optimize+'],
  // /noconfig：csc.rsp 会默认引用**运行时目录**下的 System.dll 等，与下面显式引用的
  // ref 目录版本是同一个标识但不同路径，编译器会直接报 CS1703 重复引用。
  ['/noconfig'],
  ['/win32icon:' + icoPath],
  ['/win32manifest:' + manifestPath],
  ...refs.map((r) => ['/r:' + r])
].flat()

const xamlRes = (name, file) => ['/resource:' + path.join(srcDir, file) + ',' + name]

// ===== 6. 编译卸载程序 =====
step('编译 uninstall.exe')
run(csc, [
  ...common,
  ...[
    ['/out:' + uninstallerExe],
    xamlRes('ThemeXaml', 'theme.xaml'),
    xamlRes('ShellXaml', 'shell.xaml'),
    xamlRes('UninstallXaml', 'uninstall.xaml'),
    ['/resource:' + icoPath + ',appicon.ico'],
    path.join(srcDir, 'common.cs'),
    path.join(srcDir, 'uninstall.cs'),
    path.join(genDir, 'BuildInfo.cs')
  ].flat()
])

await stampVersion(uninstallerExe, `卸载 ${appName}`)

// ===== 7. 编译安装程序（把载荷、解压器、卸载器一并嵌进去）=====
// 注意顺序：卸载程序的版本信息必须在**被嵌进去之前**写好，
// 否则装出来那个 uninstall.exe 的属性页是空的（第一版就是这么错的）。
step(uiOnly ? '编译安装程序（界面模式，不含载荷）' : '编译安装程序（内嵌 ' + (fs.statSync(payloadArchive).size / 1024 / 1024).toFixed(0) + ' MB 载荷）')
fs.mkdirSync(releaseDir, { recursive: true })
const payloadRes = uiOnly
  ? []
  : [
      ['/resource:' + payloadArchive + ',payload'],
      ['/resource:' + find7za() + ',sevenzip'],
      ['/resource:' + uninstallerExe + ',uninstaller']
    ].flat()
run(csc, [
  ...common,
  ...[
    ['/out:' + outExe],
    xamlRes('ThemeXaml', 'theme.xaml'),
    xamlRes('ShellXaml', 'shell.xaml'),
    xamlRes('SetupXaml', 'setup.xaml'),
    ['/resource:' + icoPath + ',appicon.ico'],
    payloadRes,
    path.join(srcDir, 'common.cs'),
    path.join(srcDir, 'setup.cs'),
    path.join(genDir, 'BuildInfo.cs')
  ].flat()
])

// ===== 8. 写 exe 的版本信息（PE 资源）=====
//
// csc **不会**生成 Win32 VERSIONINFO 资源，所以资源管理器 →「属性 → 详细信息」会是空的、
// 文件版本显示 0.0.0.0。csc 也没有 /win32res 可用的 rc.exe（本机没有 Windows SDK），
// 于是沿用 package-portable.mjs 里那套：编完用 rcedit 补写。
// 写入失败不中断构建 —— 版本信息是观感问题，产物本身可用。
async function stampVersion(exe, description) {
  try {
    const rcedit = (await import('rcedit')).default
    // rcedit 要求 MSDN 的四段版本号
    const ver4 = version.split('.').concat(['0', '0', '0', '0']).slice(0, 4).join('.')
    await rcedit(exe, {
      'version-string': {
        CompanyName: pkg.author || '',
        FileDescription: description,
        ProductName: appName,
        LegalCopyright: pkg.license || '',
        OriginalFilename: path.basename(exe),
        InternalFilename: path.basename(exe)
      },
      'file-version': ver4,
      'product-version': ver4
    })
    step(`写入版本信息：${path.basename(exe)} → ${ver4}`)
  } catch (e) {
    console.warn(`  ! 写入版本信息失败（属性页里会是空的）：${(e && e.message) || e}`)
  }
}

await stampVersion(outExe, `${appName} 安装程序`)

// ===== 9. 开发用：渲染界面各页 =====
if (has('--shots')) {
  const shotDir = path.join(root, '.tmp', 'installer-shots')
  fs.rmSync(shotDir, { recursive: true, force: true })
  step('渲染界面各页 → ' + path.relative(root, shotDir))
  run(outExe, ['--shots', shotDir])
  run(uninstallerExe, ['--shots', shotDir])
}

const outSize = fs.statSync(outExe).size
console.log(`\n✓ 完成：${path.relative(root, outExe)}`)
console.log(`  安装包        ${(outSize / 1024 / 1024).toFixed(1)} MB`)
if (!uiOnly) {
  console.log(`  其中应用载荷  ${(fs.statSync(payloadArchive).size / 1024 / 1024).toFixed(1)} MB（解压后 ${(stats.bytes / 1024 / 1024).toFixed(1)} MB）`)
  console.log(`  7za.exe       ${(fs.statSync(find7za()).size / 1024).toFixed(0)} KB`)
  console.log('  双击即装；静默安装：setup.exe --silent --dir "<目标目录>"\n')
}
