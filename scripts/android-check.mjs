// Android 前端冒烟：在桌面 Chromium 的手机视口里跑构建产物。
//
// 覆盖：首屏/抽屉/快捷设置/设置页、内置 Shell、run_js（含超时）、
// 保存配置 → mock SSE 流式回答 → 刷新后持久化。
//
// 前提：先跑 `npm run build:android`（或 dist:android）生成
// android/app/src/main/assets/public。没有可用浏览器时跳过（不算失败）。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const ROOT = path.resolve(import.meta.dirname, '..')
const WEB_ROOT = path.join(ROOT, 'android/app/src/main/assets/public')
const SHOTS = path.join(ROOT, '.smoke', 'android')

if (!fs.existsSync(path.join(WEB_ROOT, 'index.html'))) {
  console.error('缺少构建产物：先运行 npm run build:android')
  process.exit(1)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.icc': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2'
}

/**
 * 造一份最小可解析的 PDF（Helvetica + 一行文字）。
 * 用 latin1 逐字节拼，xref 偏移按真实字节数算，PDF.js 才能正常打开。
 */
function buildSamplePdf() {
  const parts = []
  let offset = 0
  const push = (text) => {
    const bytes = Buffer.from(text, 'latin1')
    parts.push(bytes)
    offset += bytes.length
  }
  const offsets = []
  push('%PDF-1.4\n')
  const obj = (body) => {
    offsets.push(offset)
    push(`${offsets.length} 0 obj\n${body}\nendobj\n`)
  }
  obj('<< /Type /Catalog /Pages 2 0 R >>')
  obj('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
  )
  obj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const stream = 'BT /F1 24 Tf 72 700 Td (Hello PDF smoke) Tj ET'
  offsets.push(offset)
  push(`5 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\nendobj\n`)
  const xref = offset
  push('xref\n0 6\n0000000000 65535 f \n')
  for (const entry of offsets) {
    push(`${String(entry).padStart(10, '0')} 00000 n \n`)
  }
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.concat(parts).toString('base64')
}

/**
 * 中文 PDF：Type0 字体 + 预定义 CMap（UniGB-UCS2-H）。
 * 文字层能不能抽出来，完全取决于随包的 cmaps/*.bcmap —— 这正是「中文 PDF 在
 * 桌面读得出、手机上读不出」的根因，因此单独做一条断言。
 */
function buildCjkPdf() {
  const parts = []
  let offset = 0
  const push = (text) => {
    const bytes = Buffer.from(text, 'latin1')
    parts.push(bytes)
    offset += bytes.length
  }
  const offsets = []
  push('%PDF-1.4\n')
  const obj = (body) => {
    offsets.push(offset)
    push(`${offsets.length} 0 obj\n${body}\nendobj\n`)
  }
  obj('<< /Type /Catalog /Pages 2 0 R >>')
  obj('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>'
  )
  obj(
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>'
  )
  obj(
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 7 0 R /DW 1000 >>'
  )
  const stream = 'BT /F1 24 Tf 72 700 Td <FEFF4F60597D> Tj ET'
  offsets.push(offset)
  push(`6 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\nendobj\n`)
  obj(
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>'
  )
  const xref = offset
  push('xref\n0 8\n0000000000 65535 f \n')
  for (const entry of offsets) {
    push(`${String(entry).padStart(10, '0')} 00000 n \n`)
  }
  push(`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.concat(parts).toString('base64')
}

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(name)
}

// ===== 后台保活：清单与服务实现的静态断言 =====
// 这些不是浏览器能验证的：前台服务、唤醒锁、Wi-Fi 锁都只有在真机才会生效，
// 所以至少在每次冒烟时把「权限/服务声明被谁删了」拦在打包之前。
{
  const manifest = fs.readFileSync(
    path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'),
    'utf8'
  )
  check(
    '清单声明前台服务',
    /android:name="\.BackgroundTaskService"/.test(manifest) &&
      /android:foregroundServiceType="dataSync"/.test(manifest)
  )
  check(
    '清单声明保活权限',
    ['FOREGROUND_SERVICE', 'WAKE_LOCK', 'ACCESS_WIFI_STATE', 'CHANGE_WIFI_STATE'].every((name) =>
      manifest.includes(`android.permission.${name}`)
    )
  )

  const service = fs.readFileSync(
    path.join(ROOT, 'android/app/src/main/java/com/guncat/work/BackgroundTaskService.java'),
    'utf8'
  )
  check(
    '保活服务持有唤醒锁与 Wi-Fi 锁',
    service.includes('PARTIAL_WAKE_LOCK') &&
      service.includes('WIFI_MODE_FULL_HIGH_PERF') &&
      service.includes('WIFI_MODE_FULL_LOW_LATENCY')
  )

  const keepAlive = fs.readFileSync(
    path.join(ROOT, 'src/mobile/native/background.ts'),
    'utf8'
  )
  check(
    '渲染层按 running 驱动保活',
    keepAlive.includes('setTaskRunning') && keepAlive.includes('useStore.subscribe')
  )
}

function staticServer() {
  return http.createServer((req, res) => {
    let url = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (url === '/') url = '/index.html'
    const file = path.join(WEB_ROOT, url)
    if (!file.startsWith(WEB_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
}

function mockOpenAi() {
  let count = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*'
      })
      res.end()
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      count += 1
      const payload = JSON.parse(body)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      })
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      if (count === 1) {
        send({
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: 'call_smoke',
                type: 'function',
                function: { name: 'run_command', arguments: JSON.stringify({ command: 'ls' }) }
              }]
            }
          }]
        })
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else if (payload.tools !== undefined && payload.tools.length > 0) {
        send({ choices: [{ index: 0, delta: { role: 'assistant', content: '内置 Shell 已执行。' } }] })
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      } else {
        send({ choices: [{ index: 0, delta: { role: 'assistant', content: '移动端流式回答正常。' } }] })
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return { server, count: () => count }
}

async function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].filter(Boolean)
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

const executablePath = await findBrowser()
if (executablePath === null) {
  console.log('未找到 Edge/Chrome，跳过 Android 浏览器冒烟')
  if (failures.length > 0) {
    console.error(`\nAndroid 静态检查失败 ${failures.length} 项：${failures.join('、')}`)
    process.exit(1)
  }
  process.exit(0)
}

fs.mkdirSync(SHOTS, { recursive: true })
const app = staticServer()
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve))
const mock = mockOpenAi().server
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const port = app.address().port
const mockPort = mock.address().port

const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2
})
// 模拟老 Android WebView：ReadableStream 没有异步迭代器。
// PDF.js 的 getTextContent() 用 `for await (... of readableStream)`，缺了它会报
// 「e is not async iterable」；App 启动时应由 pdfBackend 的 polyfill 补回来。
await page.addInitScript(() => {
  const proto = ReadableStream.prototype
  window.__hadNativeStreamIterator = typeof proto[Symbol.asyncIterator] === 'function'
  if (window.__hadNativeStreamIterator) {
    delete proto[Symbol.asyncIterator]
  }
})
const pageErrors = []
const missing = []
page.on('pageerror', (error) => pageErrors.push(error.message))
page.on('response', (response) => {
  if (response.status() === 404) {
    missing.push(new URL(response.url()).pathname)
  }
})
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('favicon')) {
    pageErrors.push(message.text())
  }
})

try {
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app', { timeout: 15_000 })
  check('首屏渲染', await page.locator('.app').isVisible())
  const streamIterator = await page.evaluate(() => ({
    hadNative: window.__hadNativeStreamIterator === true,
    patched: typeof ReadableStream.prototype[Symbol.asyncIterator] === 'function'
  }))
  check(
    'ReadableStream 异步迭代 polyfill（模拟老 WebView）',
    streamIterator.hadNative && streamIterator.patched,
    JSON.stringify(streamIterator)
  )
  check('手机布局（抽屉按钮可见）', await page.locator('.mobile-menu-btn').isVisible())
  check('顶栏不再显示状态副标题', (await page.locator('.topbar__title small').count()) === 0)
  check('输入框上方胶囊可见', await page.locator('.composer__chips').isVisible())
  check('输入区不再使用原生 select', (await page.locator('.composer__chips select').count()) === 0)
  const composerHeights = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector)
      return element === null ? 0 : Math.round(element.getBoundingClientRect().height)
    }
    return {
      input: rect('.composer textarea'),
      upload: rect('.composer__upload'),
      send: rect('.composer__send')
    }
  })
  check(
    '输入框与发送/加号按钮同高',
    composerHeights.input === composerHeights.upload && composerHeights.input === composerHeights.send,
    JSON.stringify(composerHeights)
  )
  check(
    '手机不启用桌面 hover（避免按钮点完一直深色）',
    await page.evaluate(() => !document.documentElement.classList.contains('hoverable'))
  )
  await page.click('.composer__chips .picker__trigger')
  await page.waitForSelector('.picker__sheet', { timeout: 3000 })
  check('选择器打开底部弹层', await page.locator('.picker__sheet').isVisible())
  await page.waitForTimeout(350)
  await page.screenshot({ path: path.join(SHOTS, 'picker.png') })
  await page.click('.picker__close')
  await page.click('.composer__upload')
  await page.waitForSelector('.picker__sheet', { timeout: 3000 })
  const photoChoices = await page.locator('.picker__sheet').innerText()
  check(
    '加号里拍照/相册/文件三个入口都在',
    photoChoices.includes('拍照') && photoChoices.includes('从相册选择') && photoChoices.includes('文件'),
    photoChoices.replace(/\s+/g, ' ').slice(0, 90)
  )
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, 'photo-sheet.png') })
  await page.click('.picker__close')
  check(
    '加号按钮可见，独立拍照按钮已合并',
    (await page.locator('.composer__upload').isVisible()) &&
      (await page.locator('.composer__camera').count()) === 0
  )
  await page.screenshot({ path: path.join(SHOTS, 'home.png') })

  await page.click('.mobile-menu-btn')
  await page.waitForTimeout(500)
  check('会话抽屉打开', await page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().left === 0))
  await page.screenshot({ path: path.join(SHOTS, 'drawer.png') })
  await page.mouse.click(378, 400)
  await page.waitForTimeout(300)

  await page.click('.mobile-workspace-btn')
  await page.waitForTimeout(400)
  check('顶栏工作区按钮打开工作区', await page.locator('.workspace').isVisible())
  check(
    '工作区顶栏已精简：「实时」与刷新按钮都已移除（面板自己会刷）',
    (await page.locator('.workspace__live').count()) === 0 &&
      (await page.locator('.workspace__head .icon-btn[title="刷新"]').count()) === 0
  )
  check('不再提供「清空工作区」误触按钮', (await page.locator('.workspace__foot').count()) === 0)
  const panelRows = await page.evaluate(() =>
    [...document.querySelectorAll('.workspace__perm, .workspace__root, .workspace__instr')].map(
      (row) => row.className.split(' ')[0]
    )
  )
  check(
    '位置行排在命令审批之后、项目指令之前',
    panelRows.join(',') === 'workspace__perm,workspace__root,workspace__instr',
    panelRows.join(',')
  )
  const permLabel = await page.locator('.workspace__perm .workspace__perm-label').evaluate((el) => ({
    height: Math.round(el.getBoundingClientRect().height),
    text: (el.textContent ?? '').trim()
  }))
  check(
    '「命令审批」四个字单行显示（不再把「批」挤到第二行）',
    permLabel.text === '命令审批' && permLabel.height < 26,
    JSON.stringify(permLabel)
  )
  const stacking = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.className = 'preview-overlay'
    document.body.appendChild(probe)
    const previewZ = Number(getComputedStyle(probe).zIndex)
    const workspaceZ = Number(getComputedStyle(document.querySelector('.workspace')).zIndex)
    probe.remove()
    return { previewZ, workspaceZ }
  })
  check(
    '工作区文件预览层压在工作区之上',
    stacking.previewZ > stacking.workspaceZ,
    `preview=${stacking.previewZ} workspace=${stacking.workspaceZ}`
  )

  // 文件行的三个动作必须**常显**：手机没有 hover，靠悬停才出现的按钮等于不存在。
  // 顺带钉住「导出先弹去向选择」，而不是点一下就直接写下载目录。
  const seeded = await page.evaluate(async () => {
    // 启动时刚建的那个会话就是列表里最新的一条（listConversations 按 updatedAt 倒序）
    const conversations = await window.guncat.conversations.list()
    if (conversations.length === 0) {
      return ''
    }
    const convId = conversations[0].id
    const root = '/guncat/data/files/workspaces/' + convId
    window.__guncatDebug.writeFileBase64(root + '/行动测试.txt', btoa('hello actions'))
    return convId
  })
  if (seeded !== '') {
    // 面板每 3 秒兜底刷新一次（顶栏的「刷新」按钮已按真机反馈移除）
    await page.waitForTimeout(3400)
  }
  const rowActionCount = await page.locator('.file-item__act').count()
  check('工作区文件行有下载/分享入口', rowActionCount >= 2, `${rowActionCount} 个`)
  const delOpacity = await page
    .locator('.file-item__del')
    .first()
    .evaluate((el) => getComputedStyle(el).opacity)
    .catch(() => 'missing')
  check('文件行删除按钮在触屏上常显（不再依赖 hover）', delOpacity === '1', `opacity=${delOpacity}`)

  if (rowActionCount > 0) {
    await page.locator('.filecard__head .filecard__action', { hasText: '导出' }).click()
    await page.waitForSelector('.transfer__sheet', { timeout: 3000 })
    const transferText = await page.locator('.transfer__sheet').innerText()
    check(
      '导出先弹「存哪 / 分享到哪」的选择（不再点一下就报已导出）',
      transferText.includes('保存到') && transferText.includes('分享'),
      transferText.replace(/\s+/g, ' ').slice(0, 80)
    )
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(SHOTS, 'transfer-sheet.png') })
    await page.click('.transfer__sheet .picker__close')
  } else {
    check('导出先弹「存哪 / 分享到哪」的选择（不再点一下就报已导出）', false, '工作区里没有文件')
  }

  // 二进制文件没有内置预览，那一页的动作区曾经是「四个按钮挤一行、字被压成竖排」。
  // 这里断言它已改成竖排单行，并留一张截图复核。
  const binarySeeded = await page.evaluate(async () => {
    const conversations = await window.guncat.conversations.list()
    if (conversations.length === 0) {
      return ''
    }
    const root = '/guncat/data/files/workspaces/' + conversations[0].id
    const bytes = String.fromCharCode(0xff, 0xfe, 0x00, 0x01, 0x80)
    window.__guncatDebug.writeFileBase64(root + '/binary.bin', btoa(bytes))
    return conversations[0].id
  })
  if (binarySeeded !== '') {
    await page.waitForTimeout(3400)
    await page.locator('.file-item__name', { hasText: 'binary.bin' }).click()
    await page.waitForSelector('.preview__info-actions', { timeout: 3000 })
    const infoLayout = await page.locator('.preview__info-actions').evaluate((el) => {
      const style = getComputedStyle(el)
      const buttons = [...el.querySelectorAll('button')].map((button) => ({
        height: Math.round(button.getBoundingClientRect().height),
        text: (button.textContent ?? '').trim()
      }))
      return { direction: style.flexDirection, buttons }
    })
    check(
      '无预览文件的动作区：竖排、每项单行（不再被挤成竖排字）',
      infoLayout.direction === 'column' && infoLayout.buttons.every((b) => b.height <= 48),
      JSON.stringify(infoLayout)
    )
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(SHOTS, 'preview-binary.png') })
    await page.click('.preview__head .icon-btn')
  }

  await page.screenshot({ path: path.join(SHOTS, 'workspace.png') })
  await page.click('.workspace .mobile-only')
  await page.waitForTimeout(300)

  await page.click('.mobile-menu-btn')
  await page.waitForTimeout(400)
  await page.click('.foot-btn:last-child')
  await page.waitForTimeout(400)
  check('全屏设置页', await page.locator('.dialog').isVisible())
  await page.screenshot({ path: path.join(SHOTS, 'settings.png') })
  await page.click('.dialog__head .icon-btn')
  await page.waitForTimeout(300)

  const shell = await page.evaluate(() => {
    const { runShell, runJs } = window.__guncatDebug
    const cwd = '/guncat/data'
    const write = runShell('mkdir -p check && echo "hello" > check/a.txt && echo "world" >> check/a.txt', cwd)
    const pipeline = runShell('cat check/a.txt | grep -n hello | wc -l', cwd)
    const unsupported = runShell('python3 --version', cwd)
    runShell('rm -r check', cwd)
    return { write, pipeline, unsupported }
  })
  check('内置 Shell 写文件/管道', shell.pipeline.code === 0 && shell.pipeline.stdout.trim() === '1', shell.pipeline.stdout.trim())
  check('内置 Shell 不支持命令返回 127', shell.unsupported.code === 127)

  // 浏览器里没有 window.GuncatShell，ShellTask 必须如实报告「原生桥不可用」并回退，
  // 而不是让工作模式误以为在真机上执行命令。
  const shellMode = await page.evaluate(() => window.__guncatDebug.shellStatus())
  check('无原生桥时 Shell 回退', shellMode.available === false && shellMode.backend === 'bundled')

  // 工作区真实路径是 /guncat/data/files/workspaces/<conv>；镜像必须跟着 cwd 走，
  // 否则终端和文件工具会各自写一个目录（曾经的真实 bug）。
  const mirrored = await page.evaluate(() =>
    window.__guncatDebug.mirrorRootFor('/guncat/data/files/workspaces/conv_x/sub')
  )
  check('工作区镜像根与 cwd 一致', mirrored === '/guncat/data/files/workspaces/conv_x', mirrored)

  // 目录镜像：浏览器里没有真机 Shell 桥，就用内存版假桥驱动真实的 WorkspaceMirror，
  // 验证「工作区删目录 → 设备副本当轮消失」「命令删目录 → 工作区不再列出」两个方向。
  // 曾经的问题：delete_file 返回已删除、stat 还能看见；rm -rf 后 list_files 仍列旧目录。
  const dirMirror = await page.evaluate(async () => {
    const conversation = await window.guncat.conversations.create('work', 'work')
    const root = '/guncat/data/files/workspaces/' + conversation.id
    const device = new Map() // 虚拟路径 → { dir, size, data }（假设备，等价 ShellManager.fs*）
    const entriesOf = (base) => {
      const prefix = base.replace(/\/+$/, '') + '/'
      const entries = []
      for (const [path, item] of device) {
        if (path.startsWith(prefix)) {
          entries.push([path.slice(prefix.length), item.dir ? 'd' : 'f', item.size, Date.now()])
        }
      }
      return entries
    }
    const bridge = {
      info: () => '{"ok":true}',
      start: () => '{"ok":false,"error":"fake"}',
      read: () => '{"ok":false,"error":"fake"}',
      kill: () => {},
      release: () => {},
      reinstallBundled: () => {},
      fsList: (vpath) => JSON.stringify({ ok: true, entries: entriesOf(vpath), truncated: false }),
      fsRead: (vpath) => {
        const item = device.get(vpath)
        if (item === undefined || item.dir) {
          return '{"ok":false,"error":"不是文件"}'
        }
        return JSON.stringify({ ok: true, data: item.data ?? '', size: item.size, mtime: Date.now() })
      },
      fsWrite: (vpath, base64) => {
        device.set(vpath, { dir: false, data: base64, size: base64.length })
        return '{"ok":true}'
      },
      fsDelete: (vpath) => {
        for (const key of Array.from(device.keys())) {
          if (key === vpath || key.startsWith(vpath + '/')) {
            device.delete(key)
          }
        }
        return '{"ok":true}'
      },
      fsMkdir: (vpath) => {
        if (!device.has(vpath)) {
          device.set(vpath, { dir: true, size: 0 })
        }
        return '{"ok":true}'
      },
      fsStat: (vpath) => JSON.stringify({ ok: true, exists: device.has(vpath) })
    }
    window.GuncatShell = bridge
    const mirror = new window.__guncatDebug.WorkspaceMirror(root)

    // 工作区里造一棵目录树（writeFileBase64 会自动补父目录）
    window.__guncatDebug.writeFileBase64(root + '/ghost/inner/x.txt', 'eA==')
    mirror.syncDown()
    const syncedDown = device.has(root + '/ghost/inner/x.txt')

    // 1) 工作区删目录（面板删除 / delete_file 走同一条 fs 删除路径）
    await window.guncat.workspace.remove(conversation.id, 'ghost')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const deletePropagated = !Array.from(device.keys()).some((key) => key.startsWith(root + '/ghost'))

    // 2) 命令删目录：设备上 rm -rf 之后工作区不能还列着
    window.__guncatDebug.writeFileBase64(root + '/gone/inner/y.txt', 'eQ==')
    mirror.syncDown()
    bridge.fsDelete(root + '/gone')
    mirror.syncUp()
    const items = await window.guncat.workspace.list(conversation.id)
    const syncUpCleaned = !items.some((item) => item.path.startsWith('gone'))
    // 假桥只服务于本段用例，不能留给后面的「工作模式工具调用」把 run_command 抢走
    delete window.GuncatShell
    return { syncedDown, deletePropagated, syncUpCleaned, paths: items.map((item) => item.path) }
  })
  check('镜像：工作区目录同步到设备', dirMirror.syncedDown)
  check('镜像：删目录当轮同步到设备', dirMirror.deletePropagated)
  check('镜像：命令删目录后工作区不再列出', dirMirror.syncUpCleaned, dirMirror.paths.join(','))

  // 镜像边界：旧上限 8MB 会让 11MB 级的工作区文件在真机命令里凭空消失（用户实际踩过）。
  // 断言打包产物里的真实常量，避免改了源码却漏进 Android bundle。
  const mirrorLimits = await page.evaluate(() => window.__guncatDebug.mirrorLimits)
  check(
    '镜像：单文件上限 32MB',
    mirrorLimits.maxFileBytes === 32 * 1024 * 1024,
    String(mirrorLimits.maxFileBytes)
  )
  check(
    '镜像：单次同步上限 64MB',
    mirrorLimits.maxTotalBytes === 64 * 1024 * 1024,
    String(mirrorLimits.maxTotalBytes)
  )

  const js = await page.evaluate(async () => {
    const { runJs } = window.__guncatDebug
    const ok = await runJs('write("out.txt", inputs["a.txt"].toUpperCase()); inputs["a.txt"].length', {
      inputs: { 'a.txt': 'abc' },
      timeoutMs: 2000
    })
    const loop = await runJs('while(true){}', { inputs: {}, timeoutMs: 1200 })
    return { ok, loop }
  })
  check('run_js 输入/输出/完成值', js.ok.ok && js.ok.outputs['out.txt'] === 'ABC' && js.ok.result === '3')
  check('run_js 死循环被 Worker 终止', !js.loop.ok && js.loop.error.includes('超时'))

  // PDF：解析文字层 → 搜索 → 渲染成 JPG（走真实的 PDF.js 与随包数据）
  const pdfSmoke = await page.evaluate(async (pdfBase64) => {
    const conversation = await window.guncat.conversations.create('work', 'work')
    const root = '/guncat/data/files/workspaces/' + conversation.id
    const abs = root + '/smoke.pdf'
    window.__guncatDebug.writeFileBase64(abs, pdfBase64)
    // Android WebView 上 module worker 不可靠，后端应走主线程 fake worker：
    // 这里把 Worker 换成「一构造就抛错」，PDF 仍然可用才算真的不依赖它。
    const OriginalWorker = window.Worker
    let workerAttempts = 0
    window.Worker = class {
      constructor() {
        workerAttempts += 1
        throw new Error('Worker disabled in PDF smoke')
      }
    }
    try {
      const debug = window.__guncatDebug
      const extracted = await debug.pdf.extract(abs, 1, 5)
      const hits = await debug.pdf.search(abs, 'hello')
      const rendered = await debug.pdf.render(abs, root + '/pdf_images/smoke', 1, 1)
      const jpg = await window.guncat.workspace.readBinary(conversation.id, 'pdf_images/smoke/p001.jpg')
      return {
        ready: debug.pdf.ready,
        workerAttempts,
        extracted,
        hits,
        rendered,
        jpg: { mimeType: jpg.mimeType, size: jpg.size, prefix: jpg.dataUrl.slice(0, 30) }
      }
    } finally {
      window.Worker = OriginalWorker
    }
  }, buildSamplePdf())
  check('PDF 后端已注入', pdfSmoke.ready === true)
  check('PDF 不依赖 Web Worker（主线程 fake worker）', pdfSmoke.workerAttempts === 0)
  check(
    'PDF 文字层解析',
    pdfSmoke.extracted.pageCount === 1 && pdfSmoke.extracted.pages[0]?.includes('Hello PDF smoke'),
    pdfSmoke.extracted.pages[0]?.slice(0, 40)
  )
  check(
    'PDF 关键词搜索',
    pdfSmoke.hits.length === 1 && pdfSmoke.hits[0].pageIndex === 1,
    JSON.stringify(pdfSmoke.hits[0] ?? null)
  )
  check('PDF 页面转图', pdfSmoke.rendered.files.length === 1)
  check(
    'PDF 转图写出 JPEG',
    pdfSmoke.jpg.mimeType === 'image/jpeg' &&
      pdfSmoke.jpg.size > 1000 &&
      pdfSmoke.jpg.prefix.startsWith('data:image/jpeg;base64,'),
    `${pdfSmoke.jpg.mimeType} ${pdfSmoke.jpg.size}B`
  )

  const pdfAssets = await page.evaluate(async () => {
    const urls = [
      './pdfjs/cmaps/UniGB-UCS2-H.bcmap',
      './pdfjs/standard_fonts/LiberationSans-Regular.ttf',
      './pdfjs/wasm/openjpeg.wasm',
      './pdfjs/iccs/CGATS001Compat-v2-micro.icc'
    ]
    const out = {}
    for (const url of urls) {
      const response = await fetch(url)
      out[url] = response.ok
    }
    return out
  })
  check(
    'PDF 随包数据可访问（CMap/字体/wasm/ICC）',
    Object.values(pdfAssets).every(Boolean),
    JSON.stringify(pdfAssets)
  )

  const pdfCjk = await page.evaluate(async (pdfBase64) => {
    const conversation = await window.guncat.conversations.create('work', 'work')
    const root = '/guncat/data/files/workspaces/' + conversation.id
    const abs = root + '/cjk.pdf'
    window.__guncatDebug.writeFileBase64(abs, pdfBase64)
    const result = await window.__guncatDebug.pdf.extract(abs, 1, 2)
    return result.pages[0] ?? ''
  }, buildCjkPdf())
  check('中文 PDF 文字层（随包 CMap）', pdfCjk.includes('你好'), pdfCjk.slice(0, 40))

  const chat = await page.evaluate(async (mockPort) => {
    const events = []
    window.guncat.onEvent((event) => events.push(event.type))
    await window.guncat.settings.saveCurrentApiProfile('冒烟配置', {
      provider: 'openai-completions',
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      apiKey: 'test',
      model: 'mock',
      temperature: 0.7,
      topP: 1,
      maxTokens: 256,
      extraParams: '',
      autoSuffix: true
    }, { baseUrl: '', apiKey: '', model: '', preparseEnabled: false })
    const conversation = await window.guncat.conversations.create('work', 'work')
    await window.guncat.work.run({
      conversationId: conversation.id,
      text: '列出工作区',
      mode: 'work',
      thinkingEnabled: true,
      webSearchEnabled: false,
      reasoningEffort: 'low'
    })
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const after = await window.guncat.conversations.get(conversation.id)
    return {
      events,
      messages: after?.messages ?? [],
      conversationId: conversation.id
    }
  }, mockPort)
  const tool = chat.messages.flatMap((message) => message.toolCalls ?? []).find((call) => call.name === 'run_command')
  check('工作模式工具调用', tool !== undefined && tool.status === 'ok', tool?.result?.slice(0, 60))
  check('工作模式收尾', chat.messages.some((message) => message.content.includes('内置 Shell 已执行')))

  await page.reload()
  await page.waitForSelector('.app', { timeout: 15_000 })
  const persisted = await page.evaluate(async () => {
    const conversations = await window.guncat.conversations.list()
    const settings = await window.guncat.settings.load()
    return { count: conversations.length, model: settings.apiConfig?.model }
  })
  check('刷新后会话持久化', persisted.count > 0, `会话 ${persisted.count}`)
  check('刷新后配置持久化', persisted.model === 'mock', String(persisted.model))

  check('无页面级异常', pageErrors.length === 0, [...pageErrors.slice(0, 3), ...missing.slice(0, 5)].join(' | '))
} finally {
  await browser.close()
  mock.close()
  app.close()
}

if (failures.length > 0) {
  console.error(`\nAndroid 冒烟失败 ${failures.length} 项：${failures.join('、')}`)
  process.exit(1)
}
console.log('\nAndroid 冒烟全部通过')
