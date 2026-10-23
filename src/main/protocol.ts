// 用自定义协议 app:// 提供界面文件，替代 file://。
//
// 为什么必须换掉 file://：
//   Vite 产出的 index.html 是 `<script type="module" crossorigin src="./assets/x.js">`，
//   而 Chromium 对 **模块脚本一律按 CORS 语义抓取**，file:// 的 origin 是 opaque，
//   于是脚本被 CORS 拦掉。现象非常迷惑：文档本身加载成功（did-start-loading 正常触发），
//   但 DOMContentLoaded 被待执行的模块脚本一直挡住，
//   结果 dom-ready / did-finish-load 都不触发、也不报 did-fail-load ——
//   窗口停在加载占位页或一片空白。这正是本项目踩到的坑。
//
// 换成 app:// 之后：
//   - origin 是 app://guncat，是标准且安全的源，ESM / CSP 'self' / fetch 全部正常；
//   - 相对路径 ./assets/… 解析行为与 http 一致；
//   - 不再依赖 file:// 那一堆特例。
import { app, net, protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootLog } from './bootlog'

export const APP_SCHEME = 'app'
export const APP_HOST = 'guncat'
/** 界面的 origin，渲染进程里可用作绝对路径前缀 */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

/** 必须在 app ready 之前调用 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8'
}

/**
 * 注册 app:// 的处理器。rootDir 是界面产物目录（out/renderer）。
 * 必须在 app ready 之后调用。
 *
 * extraRoot 用于把随包资源也暴露给渲染层，挂载在 /res/ 前缀下：
 * 智能体的头像（agents.json 里的 `icon` 字段，如 `icons/guncat-3.1-flash.png`）
 * 就在 resources/resources/icons 下。不这么做的话，渲染层只能拿到
 * 「名字首字」这类替代品（原图是 1024² 的 PNG，10 张，重复拷进渲染层要 2.3MB）。
 */
export function serveRenderer(rootDir: string, extraRoot?: string): void {
  const root: string = path.resolve(rootDir)
  const extra: string = extraRoot !== undefined ? path.resolve(extraRoot) : ''
  const EXTRA_PREFIX = '/res/'

  protocol.handle(APP_SCHEME, async (request: Request): Promise<Response> => {
    let pathname = ''
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response('错误的请求地址', { status: 400 })
    }

    // 目录请求回落到 index.html
    if (pathname === '' || pathname === '/') {
      pathname = '/index.html'
    }

    // 随包资源走独立根目录
    let base: string = root
    if (extra !== '' && pathname.startsWith(EXTRA_PREFIX)) {
      base = extra
      pathname = `/${pathname.slice(EXTRA_PREFIX.length)}`
    }

    // 防目录穿越：解析后必须仍在 base 之内
    const full: string = path.resolve(base, `.${pathname}`)
    if (full !== base && !full.startsWith(base + path.sep)) {
      bootLog(`✗ app:// 拒绝越界请求: ${pathname}`)
      return new Response('路径越界', { status: 403 })
    }
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      bootLog(`✗ app:// 找不到文件: ${pathname}`)
      return new Response('文件不存在', { status: 404 })
    }

    const type: string = CONTENT_TYPES[path.extname(full).toLowerCase()] ?? 'application/octet-stream'
    // 用 net.fetch 读本地文件：Electron 官方推荐，能正确处理流与大文件
    const response: Response = await net.fetch(pathToFileURL(full).toString())
    return new Response(response.body, {
      status: 200,
      headers: {
        'content-type': type,
        'cache-control': 'no-cache'
      }
    })
  })

  bootLog(`app:// 协议已注册，根目录=${root}${extra !== '' ? ` 资源目录=${extra}` : ''}`)
}

/** 界面入口地址 */
export function rendererUrl(): string {
  return `${APP_ORIGIN}/index.html`
}

/** 供 app.getAppPath 等场景使用（保留导出，便于将来切换根目录） */
export function isAppSchemeReady(): boolean {
  return app.isReady()
}
