// 组装可双击运行的 Windows 应用目录。
//
// 为什么不用 electron-builder：
//   它的 pnpm 依赖收集器在本机环境下拿不到 `pnpm list --json` 的输出（管道捕获失败），
//   会在打包中途报 "No JSON content found in output"。而本应用的运行时代码已被 vite
//   全部打进 out/，**没有任何 node_modules 需要在打包时收集** —— 收集这一步本就是多余的。
//
// 组装方式（Electron 的标准应用目录结构）：
//   release/Guncat Work/
//   ├── Guncat Work.exe                 ← 双击这个
//   ├── *.dll / *.pak / locales/ …      ← Electron 运行时（整份复制）
//   └── resources/
//       ├── app/                        ← 我们的代码（out/ + package.json）
//       └── resources/                  ← 随包资源（智能体、提示词、技能库）
//
// 用法：node scripts/package-portable.mjs
//   前置：已跑过 `pnpm build`（out/ 存在）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildRunCompatCmd,
  buildRunAsAdminCmd,
  buildEnableAdminCmd,
  buildDisableAdminCmd,
  buildDesktopShortcutCmd,
  buildDiagnosePs1,
  writeAsciiFile,
  DIAG_MODES
} from './launch-scripts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appName = 'Guncat Work'
const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkgJson.version
// 输出目录带版本号：一来用户一眼知道拿的是哪版，二来避免旧目录被占用
// （比如用户还开着上一次的 cmd 窗口，其工作目录就在里面）导致整个打包失败。
//
// GUNCAT_PACKAGE_OUTDIR 是给 scripts/package-installer.mjs 用的出口：安装包需要的是
// **同一份产物**，但它不该污染 release/ 下的便携目录（安装包里还要额外塞 uninstall.exe，
// 那些文件不该出现在便携版里）。所以允许调用方把产物装到自己的临时目录里去。
const outDirOverride = process.env.GUNCAT_PACKAGE_OUTDIR
const outDir = outDirOverride
  ? path.resolve(outDirOverride)
  : path.join(root, 'release', `${appName}-${version}`)
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function step(message) {
  console.log(`  · ${message}`)
}

// ===== 前置检查 =====
if (!fs.existsSync(electronDist)) {
  fail('找不到 Electron 运行时（node_modules/electron/dist）。请先跑 pnpm install。')
}
if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  fail('找不到构建产物（out/main/index.js）。请先跑 pnpm build。')
}

console.log(`\n组装 ${appName} …`)

// ===== 1. 清空并复制 Electron 运行时 =====
// Windows 上偶尔会把输出目录本身锁住（EPERM），但里面的内容通常可以删。
// 所以删除失败时退而求其次：清空内容，而不是整个打包流程失败。
fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
if (fs.existsSync(outDir)) {
  for (const entry of fs.readdirSync(outDir)) {
    try {
      fs.rmSync(path.join(outDir, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch {
      // 实在删不掉就留着，后面的复制会覆盖
    }
  }
  if (fs.existsSync(outDir)) {
    step('目录已存在且删不掉，改为就地覆盖')
  }
}
fs.mkdirSync(outDir, { recursive: true })
step('复制 Electron 运行时')
fs.cpSync(electronDist, outDir, { recursive: true })

// ===== 2. 去掉 Electron 自带的默认应用，换上我们的 =====
const defaultApp = path.join(outDir, 'resources', 'default_app.asar')
if (fs.existsSync(defaultApp)) {
  fs.rmSync(defaultApp, { force: true })
  step('移除 default_app.asar')
}

// ===== 3. 应用代码放到 resources/app =====
const appTarget = path.join(outDir, 'resources', 'app')
fs.mkdirSync(appTarget, { recursive: true })
step('写入应用代码 → resources/app')
fs.cpSync(path.join(root, 'out'), path.join(appTarget, 'out'), { recursive: true })

// package.json 只保留 Electron 启动需要的字段，避免把构建配置带进产物
const pkg = pkgJson
fs.writeFileSync(
  path.join(appTarget, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      productName: appName,
      version: pkg.version,
      description: pkg.description,
      main: pkg.main,
      author: pkg.author,
      license: pkg.license,
      type: pkg.type
    },
    null,
    2
  ),
  'utf8'
)

// ===== 4. 随包资源（智能体 / 提示词 / 技能库）放到 resources/resources =====
// 与 src/main/paths.ts 的 resolveResourcesRoot() 约定一致
step('复制随包资源 → resources/resources')
fs.cpSync(path.join(root, 'resources'), path.join(outDir, 'resources', 'resources'), {
  recursive: true
})

// ===== 4b. PDF 后端的两块随包数据（见 src/core/platform/native/pdfBackend.ts） =====
//
// 为什么不能只靠 vite 打包：这两样都不是「代码」。
//   · pdfjs-dist 的解析器与内嵌 worker 由主进程在运行时按模块名解析（构建里是 external），
//     因为它内部有自己的 worker / wasm / 字体动态路径，打进 bundle 会被改坏；
//   · 原生 canvas（.node）根本打不进 bundle，只能按路径 require。
// 于是这里把最小必要集合拷进去：
//   resources/app/node_modules/pdfjs-dist/  —— 只带 package.json 与 legacy/build（约 4MB，
//                                              而不是整包的 34MB）
//   resources/app/node_modules/@napi-rs/    —— canvas 本体 + win32 预编译二进制
//   resources/resources/pdfjs/              —— 标准字体 / CJK CMap / wasm 解码器
// 少任何一块都不会「报文件损坏」：文本抽取退化成缺字体度量，渲染退化成明确的「缺渲染后端」。
const nodeModulesOut = path.join(outDir, 'resources', 'app', 'node_modules')
const pdfjsSrc = path.join(root, 'node_modules', 'pdfjs-dist')
if (fs.existsSync(pdfjsSrc)) {
  const pdfjsOut = path.join(nodeModulesOut, 'pdfjs-dist')
  fs.mkdirSync(pdfjsOut, { recursive: true })
  fs.cpSync(path.join(pdfjsSrc, 'package.json'), path.join(pdfjsOut, 'package.json'))
  fs.cpSync(path.join(pdfjsSrc, 'legacy', 'build'), path.join(pdfjsOut, 'legacy', 'build'), {
    recursive: true,
    filter: (src) => !src.endsWith('.map')
  })
  step('复制 pdfjs-dist（package.json + legacy/build）')

  const dataOut = path.join(outDir, 'resources', 'resources', 'pdfjs')
  for (const sub of ['standard_fonts', 'cmaps', 'wasm']) {
    const from = path.join(pdfjsSrc, sub)
    if (fs.existsSync(from)) {
      fs.cpSync(from, path.join(dataOut, sub), { recursive: true })
    }
  }
  step('复制 pdfjs 数据（standard_fonts / cmaps / wasm）→ resources/pdfjs')
} else {
  console.warn('  ! 找不到 pdfjs-dist，PDF 工具将不可用（先跑 npm install）')
}

const canvasSrc = path.join(root, 'node_modules', '@napi-rs')
if (fs.existsSync(canvasSrc)) {
  const canvasOut = path.join(nodeModulesOut, '@napi-rs')
  fs.mkdirSync(canvasOut, { recursive: true })
  for (const name of fs.readdirSync(canvasSrc)) {    // 只带本平台的预编译二进制：别的平台的 .node 在 Windows 上纯属体积
    if (name.startsWith('canvas-win32') || name === 'canvas') {
      fs.cpSync(path.join(canvasSrc, name), path.join(canvasOut, name), { recursive: true })
    }
  }
  step('复制 @napi-rs/canvas（PDF 页面转图用）')
} else {
  console.warn('  ! 找不到 @napi-rs/canvas，PDF 页面转图将不可用（文本抽取不受影响）')
}

// ===== 5. 可执行文件改名 =====
const exeSource = path.join(outDir, 'electron.exe')
const exeTarget = path.join(outDir, `${appName}.exe`)
if (fs.existsSync(exeSource)) {
  fs.renameSync(exeSource, exeTarget)
  step(`可执行文件 → ${appName}.exe`)
}

// ===== 5b. 把原版图标与版本信息写进 exe 的 PE 资源 =====
//
// 为什么必须有这一步（用户报障「显示在 exe 程序和菜单栏里面的图标还是 electron 默认图标」）：
//   exe 是 electron.exe 直接改名的，它的图标资源里仍然是 **Electron 的图标**。
//   任务栏、资源管理器、Alt+Tab、开始菜单、桌面快捷方式的目标文件看到的都是它。
//   图标不是运行时能改的东西 —— 它就存在 PE 的 RT_ICON 资源里，
//   必须用资源编辑器写进去（electron-builder 内部做的也正是这件事：rcedit）。
//   窗口标题栏的图标之所以一直是对的，是因为那条走的是 BrowserWindow.icon，与 PE 资源无关。
//
// 顺带把版本信息也写对：属性对话框里的「产品名称 / 文件说明 / 版本」此前也是 Electron 的。
const icoPath = path.join(root, 'resources', 'app-icon.ico')
if (fs.existsSync(exeTarget) && fs.existsSync(icoPath)) {
  // rcedit 要求 MSDN 的四段版本号
  const ver4 = version.split('.').concat(['0', '0', '0', '0']).slice(0, 4).join('.')
  try {
    const rcedit = (await import('rcedit')).default
    await rcedit(exeTarget, {
      icon: icoPath,
      'version-string': {
        CompanyName: 'zhubowen-bot',
        FileDescription: appName,
        ProductName: appName,
        LegalCopyright: 'Apache License 2.0',
        OriginalFilename: `${appName}.exe`,
        InternalFilename: appName
      },
      'file-version': ver4,
      'product-version': ver4
    })
    step('exe 图标与版本信息已写入 PE 资源（rcedit）')
  } catch (e) {
    // 不因此中断打包：图标不对是观感问题，产物本身仍可用 —— 但必须说清楚
    console.warn(`  ! 写入 exe 图标失败（exe 会保留 Electron 默认图标）：${e?.message ?? e}`)
    console.warn('    exe 若正在运行会锁住文件，先关掉应用再重新打包。')
  }
} else {
  console.warn(`  ! 跳过 exe 图标写入：找不到 ${path.relative(root, icoPath)}`)
}

// ===== 6. 双击即用的辅助入口 =====
//
// 注意：.cmd / .ps1 一律只写 ASCII（生成器里做了字节级校验）。
// 事故：这些脚本最初用中文提示、以 UTF-8 写出，而 cmd.exe 在中文 Windows 上按 GBK
// 解析批处理文件 —— 内存里的字节被解成乱码，整行变成无法识别的命令，
// 批处理的 if/goto 控制流直接被拆坏（实测表现为 "'…' is not recognized"）。
// chcp 65001 放在文件里也救不了，因为解析从第一行就开始了。
// 中文说明一律放到 使用说明.txt。
//
// 兼容参数由 compat.ts 的 COMPAT_SWITCHES 定义。这里刻意照抄一份而不是从 TS 里引：
// 打包脚本是 node 直接跑的 .mjs，引 TS 需要额外的编译步骤；两者的同步由
// startup-check.mjs 的断言保证（它会拿生成出来的脚本文本去比对 COMPAT_SWITCHES）。
//
// 只剩 --no-sandbox 一条：14 组对照实验证明只有它能改变结果（见 docs/STARTUP-TROUBLESHOOTING.md）。
// 其余开关（--disable-gpu 之类）对这次崩溃毫无帮助，却会把界面降成软件渲染。
const COMPAT_SWITCHES = ['--no-sandbox']

// 兼容模式启动器：一条命令直接带上那唯一的必要开关（不提权）
writeAsciiFile(path.join(outDir, 'run-compat.cmd'), buildRunCompatCmd(appName, COMPAT_SWITCHES))

// 自提权启动器：最后的逃生口，不是默认路径（提权的作用至今未获证实，§2.9）
writeAsciiFile(path.join(outDir, 'run-as-admin.cmd'), buildRunAsAdminCmd(appName, COMPAT_SWITCHES))

/**
 * 把「双击即可用」固化到产物里。
 *
 * 本机实测（变量已分离）：同样带 --no-sandbox，管理员身份运行完全成功，
 * 非管理员双击却连第一行 JS 都跑不到（启动日志无新记录）。根因尚未查明。
 * 在查清之前，最可靠的做法是给 exe 挂上 RUNASADMIN 兼容性层 ——
 * 让普通双击弹一次 UAC 后以提权身份运行。
 *
 * 必须做成脚本：该设置按 exe 完整路径匹配且存在 HKCU，
 * 一旦挪动文件夹或拷给别人就会失效，用户会以为是我们修坏了。
 */
writeAsciiFile(path.join(outDir, 'enable-admin-mode.cmd'), buildEnableAdminCmd(appName))
writeAsciiFile(path.join(outDir, 'disable-admin-mode.cmd'), buildDisableAdminCmd(appName))

// 桌面快捷方式：使用说明里一直提到它，但之前根本没有生成过 —— 补上
writeAsciiFile(path.join(outDir, 'create-desktop-shortcut.cmd'), buildDesktopShortcutCmd(appName))

/**
 * 诊断脚本：逐级降级 + 「走到了哪一步」的判定，见 launch-scripts.mjs 的说明。
 * 关键改进除了阶梯本身，还有：
 *   · 每轮独立 --user-data-dir（否则第一轮留下的单实例锁会让第二轮直接失败）；
 *   · 读启动日志里的 ASCII 里程碑标记，把三种「白屏」区分开 ——
 *     渲染进程没起来 / 起来了但 React 没挂载 / 挂载了但画不出像素。
 */
writeAsciiFile(
  path.join(outDir, 'diagnose.ps1'),
  buildDiagnosePs1({ appName, modes: DIAG_MODES })
)

writeAsciiFile(
  path.join(outDir, 'diagnose.cmd'),
  [
    '@echo off',
    'cd /d "%~dp0"',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose.ps1"',
    'echo.',
    'pause',
    ''
  ].join('\r\n')
)

step('写入 run-compat.cmd / run-as-admin.cmd / create-desktop-shortcut.cmd / diagnose.cmd / diagnose.ps1（纯 ASCII，字节级校验）')
// ===== 7. 简短说明（UTF-8 带 BOM，记事本直接可读） =====
fs.writeFileSync(
  path.join(outDir, '使用说明.txt'),
  '\ufeff' +
    [
      'Guncat Work（电脑版）',
      '',
      '双击本目录下的「Guncat Work.exe」即可启动，无需安装、无需命令行。',
      '想放到桌面就从「create-desktop-shortcut.cmd」双击一次，会生成带图标的快捷方式。',
      '',
      '首次使用：',
      '  1. 打开应用后点左下角「设置」',
      '  2. 填入接入方式、Base URL、API Key 与模型，保存',
      '  3. 回到主界面即可开始对话',
      '',
      '数据位置：',
      '  对话历史、沙箱工作区与配置都保存在 %APPDATA%\\Guncat Work 下，',
      '  不会写入本目录，删除本目录不影响已有数据。',
      '  应用只用这一份数据目录（早期版本降级时会切到 -compat 目录，已取消：',
      '  崩溃与数据目录无关，两套目录只会让用户以为数据丢了）。',
      '',
      '左侧栏从上到下是这几块：',
      '  · 品牌行 —— Guncat Work、当前形态，最右侧的按钮把侧栏折叠成一条图标栏。',
      '  · 「新建会话」按钮。',
      '  · 「引擎」区 —— 选智能体。最上面是交互模式与工作模式，其下是各聊天智能体；',
      '    点一下即切到该引擎的最近会话（没有就新建一个）。',
      '  · 「会话」区 —— 每条会话显示标题，第二行是「引擎 · 时间 · 消息条数」；',
      '    鼠标移上去右侧出现删除按钮。',
      '  · 底部四个入口 —— 聊天 / 交互 / 工作 / 设置。',
      '',
      '三种形态：',
      '  聊天模式   纯对话',
      '  交互模式   一句话直出可操作界面（拖动参数即时重算）',
      '  工作模式   多轮工具循环 + 沙箱工作区，可直出 PPT / Word / Excel',
      '',
      '回答下方的按钮：复制文本 / 复制 Markdown / 朗读 / 导出 Word / 重新生成。',
      '工作模式下，一个任务里的多轮工具调用会收进可折叠的「过程」区，最终答复单独成块。',
      '',
      '把文件拖进窗口即可导入当前会话的工作区。',
      '',
      '────────────────────────────────────────',
      '如果双击后窗口没有出现（白屏 / 闪退）：',
      '',
      '  正常情况下什么都不用做。这个应用现在**默认**就把 --no-sandbox 带在命令行上：',
      '  双击启动时它会自己带参数重启一次（所以你可能会看到进程「闪一下又起来」，',
      '  这是预期行为，不是崩溃）。原因是这台机器上沙箱开启时 Chromium 建不出 GPU 子进程，',
      '  fallback 用尽后主进程会直接自杀（退出码 -2147483645），而崩溃发生在 Chromium 早期，',
      '  应用自己的看门狗根本来不及救 —— 只能一启动就把参数带上。',
      '',
      '  需要手动介入时（按优先级）：',
      '  · enable-admin-mode.cmd —— **本机需要先跑这一个**。',
      '    本机实测：同样带 --no-sandbox，以管理员身份运行完全成功（界面正常、能产帧），',
      '    但非管理员双击会连第一行日志都写不出来 —— 失败在「进程能不能起来」这一层，',
      '    与 Chromium 内部无关，根因尚未查明。',
      '    这个脚本给 exe 挂上 Windows 的 RUNASADMIN 兼容性层，',
      '    之后**普通双击就会弹一次 UAC 并以提权身份运行**。',
      '    代价：每次启动弹一次 UAC。撤销用 disable-admin-mode.cmd。',
      '    注意：该设置按 exe 的完整路径匹配且存在你的用户配置里 ——',
      '    **一旦把本文件夹挪位置、或拷给别人，都要重新跑一次这个脚本。**',
      '  · run-compat.cmd —— 不提权，直接以 --no-sandbox 启动。',
      '  · run-as-admin.cmd —— 以管理员身份启动（会弹 UAC 提权确认）。',
      '  · diagnose.cmd   —— 诊断，一次跑 6 档（每轮独立用户数据目录），并逐档给出结论。',
      '    第 1 档 --no-sandbox（现在的默认方式）、第 2 档再加 --disable-gpu、',
      '    第 3 档不加参数、第 4 档**故意保留沙箱**用来复现原始崩溃、',
      '    第 5 档是会造成白屏的老三参数组合（对照）、第 6 档是极简诊断页。',
      '    结果写进 diag-log.txt，各轮日志另存为 startup-N.log / chromium-N.log。',
      '    每轮的 VERDICT 会明确区分四种情况：',
      '      · 没到 dom-ready               → 页面根本没加载（看 chromium-N.log 里的 GPU 报错）',
      '      · 到了 dom-ready 但没挂载       → 界面产物没跑起来（脚本/CSP/React 报错）',
      '      · 挂载了但没产出帧              → 合成器画不出像素（DOM 正常，窗口却空白）',
      '      · 加载 + 挂载 + 产帧全都有       → 这条链路本身没问题',
      '  · 崩溃转储：如果启动即退，Windows 会在 %LOCALAPPDATA%\\CrashDumps 留下 .dmp；',
      '    各轮的 Chromium 日志由应用自己写在 <用户数据目录>\\logs\\chromium.log，',
      '    诊断脚本会逐轮复制成 chromium-N.log。',
      '────────────────────────────────────────'
    ].join('\r\n'),
  'utf8'
)

// ===== 汇总 =====
function treeSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? treeSize(full) : fs.statSync(full).size
  }
  return total
}

const size = treeSize(outDir)
console.log(`\n✓ 完成：${path.relative(root, exeTarget)}`)
console.log(`  目录：${path.relative(root, outDir)}（${(size / 1024 / 1024).toFixed(1)} MB）`)
console.log('  双击目录里的 exe 即可启动。\n')
