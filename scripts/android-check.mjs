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
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
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
page.on('pageerror', (error) => pageErrors.push(error.message))
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
      mic: rect('.composer__mic'),
      send: rect('.composer__send')
    }
  })
  check(
    '输入框与发送/语音按钮同高',
    composerHeights.input === composerHeights.mic && composerHeights.input === composerHeights.send,
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
  await page.click('.composer__camera')
  await page.waitForSelector('.picker__sheet', { timeout: 3000 })
  const photoChoices = await page.locator('.picker__sheet').innerText()
  check(
    '拍照/相册两个入口都在',
    photoChoices.includes('拍照') && photoChoices.includes('从相册选择'),
    photoChoices.replace(/\s+/g, ' ').slice(0, 80)
  )
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, 'photo-sheet.png') })
  await page.click('.picker__close')
  check('上传/拍照按钮可见', (await page.locator('.composer__upload').isVisible()) && (await page.locator('.composer__camera').isVisible()))
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

  check('无页面级异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
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
