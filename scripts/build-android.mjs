// Android APK 构建：Vite 打包前端 → 拷资源 → aapt2 → javac → d8 → zipalign → apksigner。
//
// 为什么不走 Gradle：这个 App 只有一个 Activity + 纯 WebView，没有第三方 Android 依赖，
// 用 SDK 自带的 aapt2/d8/apksigner 直接出包更快、更可复现，也避免首次构建下载
// 几百 MB 的 Gradle/AGP 依赖。需要的是 JDK 17+ 与 Android SDK（platform 35 + build-tools 35）。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { unzipSync, zipSync } from 'fflate'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const ANDROID = path.join(ROOT, 'android')
const ASSETS = path.join(ANDROID, 'app', 'src', 'main', 'assets', 'public')
const OUT = path.join(ROOT, 'out', 'android-build')
const RELEASE = path.join(ROOT, 'release')
const TEMP = path.join(ROOT, '.tmp')
const BUILD_ENV = {
  TMP: TEMP,
  TEMP: TEMP,
  TMPDIR: TEMP
}

function log(message) {
  console.log(`\n[android] ${message}`)
}

function fail(message) {
  console.error(`\n[android] 失败：${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...(options.env ?? {}) },
    shell: options.shell ?? false
  })
  if (result.status !== 0) {
    fail(`${path.basename(command)} 退出码 ${result.status}`)
  }
}

function exists(p) {
  return fs.existsSync(p)
}

function resolveSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(ROOT, '.android-sdk'),
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
    '/opt/android-sdk'
  ].filter(Boolean)
  for (const base of candidates) {
    const jar = path.join(base, 'platforms', 'android-35', 'android.jar')
    const buildTools = path.join(base, 'build-tools', '35.0.0')
    if (exists(jar) && exists(buildTools)) {
      return { base, jar, buildTools }
    }
  }
  fail(
    '找不到 Android SDK（需要 platforms/android-35 与 build-tools/35.0.0）。\n' +
      '设置 ANDROID_HOME，或把 SDK 放到 <项目>/.android-sdk。'
  )
}

function resolveJava() {
  const candidates = [
    process.env.JAVA_HOME,
    'C:\\Program Files\\Android\\openjdk\\jdk-21.0.8',
    'C:\\Program Files\\Java\\jdk-21',
    '/usr/lib/jvm/java-21-openjdk'
  ].filter(Boolean)
  for (const home of candidates) {
    const javac = path.join(home, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac')
    if (exists(javac)) {
      return home
    }
  }
  const probe = spawnSync('javac', ['-version'], { stdio: 'ignore', shell: process.platform === 'win32' })
  if (probe.status === 0) {
    return ''
  }
  fail('找不到 JDK（需要 javac 17+）。设置 JAVA_HOME。')
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else {
      out.push(full)
    }
  }
  return out
}

function normalizeApkEntryNames(apk) {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(apk)))
  const fixed = {}
  for (const name of Object.keys(entries)) {
    const clean = name.replace(/\\/g, '/')
    // resources.arsc 在 Android 11+ 要求未压缩；其余保持压缩
    fixed[clean] =
      clean === 'resources.arsc' ? [entries[name], { level: 0 }] : [entries[name], { level: 6 }]
  }
  fs.writeFileSync(apk, zipSync(fixed, { level: 6 }))
}

function verifyApkZipEntries(apk) {
  const entries = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(apk))))
  const bad = entries.filter((name) => name.includes('\\'))
  if (bad.length > 0) {
    fail(`APK 内条目名含反斜杠（AssetManager 会找不到）：${bad.slice(0, 3).join(', ')}`)
  }
  if (!entries.includes('assets/public/index.html')) {
    fail('APK 内缺少 assets/public/index.html')
  }
  if (!entries.includes('assets/termux/bootstrap-aarch64.zip')) {
    fail('APK 内缺少 assets/termux/bootstrap-aarch64.zip（内置终端无法工作）')
  }
  // PDF 工具依赖 PDF.js 的随包数据（CMap / 字体 / wasm / ICC）；
  // worker 在 Android 端走主线程 fake worker，不再单独打包。
  if (!entries.some((name) => name.startsWith('assets/public/pdfjs/cmaps/'))) {
    fail('APK 内缺少 assets/public/pdfjs/cmaps/（中文 PDF 文字层会读不出来）')
  }
}

function ensureKeystore(javaHome, keytool) {
  const dir = path.join(ANDROID, 'keystore')
  fs.mkdirSync(dir, { recursive: true })
  const store = process.env.GUNCAT_KEYSTORE ?? path.join(dir, 'guncat.jks')
  const pass = process.env.GUNCAT_KS_PASS ?? 'guncat-work'
  if (!exists(store)) {
    log('生成签名密钥（仅本机使用，密码见 android/keystore/README.md）')
    run(keytool, [
      '-genkeypair',
      '-keystore', store,
      '-alias', 'guncat',
      '-keyalg', 'RSA',
      '-keysize', '2048',
      '-validity', '10000',
      '-storepass', pass,
      '-keypass', pass,
      '-dname', 'CN=Guncat Work, OU=Android, O=Guncat, L=Shanghai, C=CN'
    ])
  }
  return { store, pass }
}

async function main() {
  if (!exists(path.join(ROOT, 'node_modules', 'vite'))) {
    fail('缺少依赖，请先 npm install')
  }

  log('1/7 构建 Web 产物（src/mobile）')
  run(process.execPath, [
    path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    'build',
    '--config',
    path.join(ROOT, 'vite.mobile.config.ts')
  ], { env: BUILD_ENV })
  if (!exists(path.join(ASSETS, 'index.html'))) {
    fail(`Vite 没有产出 ${ASSETS}/index.html`)
  }

  log('2/7 复制随包资源（图标 / 智能体图片 / 技能引用文件）')
  fs.cpSync(path.join(ROOT, 'resources'), path.join(ASSETS, 'resources'), { recursive: true })

  const bootstrapZip = path.join(ANDROID, 'app', 'src', 'main', 'assets', 'termux', 'bootstrap-aarch64.zip')
  if (!exists(bootstrapZip)) {
    fail(
      '缺少内置终端资源 assets/termux/bootstrap-aarch64.zip。\n' +
        '先下载 Termux bootstrap，再运行：\n' +
        '  python scripts/prepare-termux-bootstrap.py\n' +
        '  python scripts/add-termux-packages.py'
    )
  }
  log(`内置终端资源：${(fs.statSync(bootstrapZip).size / 1024 / 1024).toFixed(1)} MB`)

  const { jar, buildTools, base } = resolveSdk()
  const javaHome = resolveJava()
  const isWin = process.platform === 'win32'
  const exe = (name) => path.join(buildTools, name + (isWin ? '.exe' : ''))
  const bat = (name) => path.join(buildTools, name + (isWin ? '.bat' : ''))
  const env = javaHome === '' ? {} : { JAVA_HOME: javaHome, PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` }

  log(`SDK: ${base}`)
  log(`JDK: ${javaHome || 'PATH 中的 javac'}`)

  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  fs.mkdirSync(RELEASE, { recursive: true })

  // versionName（package.json 的 version）是用户侧看到的版本，只在功能对齐/正式发布时改；
  // versionCode 是 Android 的安装顺序号，只增不减。两者解耦：versionCode 用构建时间（分钟）
  // 生成，避免 versionName 回退时被系统当成降级、拒绝覆盖安装。
  const versionCode = Math.floor(Date.now() / 60000)
  const resDir = path.join(ANDROID, 'app', 'src', 'main', 'res')
  const manifestSource = path.join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml')
  // aapt2 的 --version-code 在部分 Windows 版本上不覆盖清单属性，直接生成一份带版本号的清单更稳。
  const manifest = path.join(OUT, 'AndroidManifest.xml')
  const manifestText = fs
    .readFileSync(manifestSource, 'utf8')
    .replace(/android:versionCode="\d+"/, `android:versionCode="${versionCode}"`)
    .replace(/android:versionName="[^"]*"/, `android:versionName="${pkg.version}"`)
  fs.writeFileSync(manifest, manifestText, 'utf8')

  log('3/7 编译资源（aapt2 compile/link）')
  const compiled = path.join(OUT, 'resources.zip')
  run(exe('aapt2'), ['compile', '--dir', resDir, '-o', compiled])
  const unsigned = path.join(OUT, 'app-unsigned.apk')
  const genDir = path.join(OUT, 'gen')
  fs.mkdirSync(genDir, { recursive: true })
  // aapt2 在 Windows 上会把 -A 目录的路径分隔符带进 APK 条目名（assets\public\...），
  // 而 AssetManager 只认正斜杠。这里强制传正斜杠路径，并在打包后校验条目名。
  const assetsDir = path.join(ANDROID, 'app', 'src', 'main', 'assets').replace(/\\/g, '/')
  run(exe('aapt2'), [
    'link',
    '-o', unsigned,
    '-I', jar,
    '--manifest', manifest,
    '-A', assetsDir,
    '--java', genDir,
    '--min-sdk-version', '28',
    '--target-sdk-version', '28',
    '--version-code', String(versionCode),
    '--version-name', pkg.version,
    '--auto-add-overlay',
    compiled
  ])

  normalizeApkEntryNames(unsigned)
  verifyApkZipEntries(unsigned)
  log('4/7 编译 Java（javac → .class）')
  const classesDir = path.join(OUT, 'classes')
  fs.mkdirSync(classesDir, { recursive: true })
  const sources = walk(path.join(ANDROID, 'app', 'src', 'main', 'java'))
  const generated = walk(genDir)
  const javac = javaHome === '' ? 'javac' : path.join(javaHome, 'bin', isWin ? 'javac.exe' : 'javac')
  run(javac, [
    '-encoding', 'UTF-8',
    '--release', '8',
    '-classpath', jar,
    '-d', classesDir,
    ...sources,
    ...generated
  ], { env })

  log('5/7 dex（d8）')
  const dexDir = path.join(OUT, 'dex')
  fs.mkdirSync(dexDir, { recursive: true })
  const d8Args = ['--release', '--min-api', '28', '--lib', jar, '--output', dexDir, ...walk(classesDir)]
  if (isWin) {
    run(bat('d8'), d8Args, { env, shell: true })
  } else {
    run(path.join(buildTools, 'd8'), d8Args, { env })
  }

  log('6/7 组装 + 对齐（classes.dex 进 APK）')
  const jarTool = javaHome === '' ? 'jar' : path.join(javaHome, 'bin', isWin ? 'jar.exe' : 'jar')
  run(jarTool, ['uf', unsigned, '-C', dexDir, 'classes.dex'], { env })
  const aligned = path.join(OUT, 'app-aligned.apk')
  run(exe('zipalign'), ['-f', '-p', '4', unsigned, aligned])

  log('7/7 签名（apksigner）')
  const keytool = javaHome === '' ? 'keytool' : path.join(javaHome, 'bin', isWin ? 'keytool.exe' : 'keytool')
  const { store, pass } = ensureKeystore(javaHome, keytool)
  const finalApk = path.join(RELEASE, `Guncat-Work-${pkg.version}-android.apk`)
  const signArgs = [
    'sign',
    '--ks', store,
    '--ks-key-alias', 'guncat',
    '--ks-pass', `pass:${pass}`,
    '--key-pass', `pass:${pass}`,
    '--v1-signing-enabled', 'true',
    '--v2-signing-enabled', 'true',
    '--out', finalApk,
    aligned
  ]
  if (isWin) {
    run(bat('apksigner'), signArgs, { env, shell: true })
  } else {
    run(path.join(buildTools, 'apksigner'), signArgs, { env })
  }

  const size = fs.statSync(finalApk).size
  console.log(`\n[android] 完成：${finalApk}`)
  console.log(`[android] 版本：${pkg.version}（versionCode ${versionCode}）`)
  console.log(`[android] 体积：${(size / 1024 / 1024).toFixed(1)} MB`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
