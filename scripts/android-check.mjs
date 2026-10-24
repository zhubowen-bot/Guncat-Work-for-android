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

  // PDF：解析文字层 → 搜索 → 渲染成 JPG（走真实的 PDF.js worker 与随包数据）
  const pdfSmoke = await page.evaluate(async (pdfBase64) => {
    const conversation = await window.guncat.conversations.create('work', 'work')
    const root = '/guncat/data/files/workspaces/' + conversation.id
    const abs = root + '/smoke.pdf'
    window.__guncatDebug.writeFileBase64(abs, pdfBase64)
    const debug = window.__guncatDebug
    const extracted = await debug.pdf.extract(abs, 1, 5)
    const hits = await debug.pdf.search(abs, 'hello')
    const rendered = await debug.pdf.render(abs, root + '/pdf_images/smoke', 1, 1)
    const jpg = await window.guncat.workspace.readBinary(conversation.id, 'pdf_images/smoke/p001.jpg')
    return {
      ready: debug.pdf.ready,
      extracted,
      hits,
      rendered,
      jpg: { mimeType: jpg.mimeType, size: jpg.size, prefix: jpg.dataUrl.slice(0, 30) }
    }
  }, buildSamplePdf())
  check('PDF 后端已注入', pdfSmoke.ready === true)
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
