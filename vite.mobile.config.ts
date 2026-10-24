import { cpSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import pkg from './package.json'

// Android 版构建：与 Electron 渲染层共用同一套 React 界面与 core，
// 区别只在「平台适配层指向哪里」：
//   @kit.*                 → src/mobile/kit/*（浏览器实现）
//   node:fs / node:path    → memfs / path-browserify
//   shellExec              → 内置 JS Shell（没有 child_process）
//   libguncatjs.so         → Web Worker 版 run_js
const ROOT = resolve(__dirname)

// core 里有几处按**相对路径**引用平台实现（例如 CommandService 的
// `../platform/shellExec`）。路径别名只能改模块说明符，改不到相对引用，
// 因此在解析结果上再做一次重定向：这些文件一律换成 mobile 版本。
const PLATFORM_REDIRECTS: Array<[string, string]> = [
  ['/src/core/platform/shellExec.ts', '/src/mobile/platform/shellExec.ts'],
  ['/src/core/platform/kit/ImageKit.ts', '/src/mobile/kit/ImageKit.ts'],
  ['/src/core/platform/kit/PDFKit.ts', '/src/mobile/kit/PDFKit.ts'],
  ['/src/core/platform/native/libguncatjs.ts', '/src/mobile/platform/libguncatjs.ts'],
  ['/src/core/platform/native/svgRaster.ts', '/src/mobile/platform/svgRaster.ts'],
  ['/src/core/platform/kit/ArkTS.ts', '/src/mobile/kit/ArkTS.ts']
]

function mobilePlatformRedirect() {
  return {
    name: 'guncat-mobile-platform-redirect',
    enforce: 'pre' as const,
    async resolveId(source: string, importer: string | undefined, options: { [key: string]: unknown }) {
      if (importer === undefined) {
        return null
      }
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (resolved === null) {
        return null
      }
      for (const [from, to] of PLATFORM_REDIRECTS) {
        if (resolved.id.endsWith(from)) {
          return resolve(ROOT, to.substring(1))
        }
      }
      return null
    }
  }
}

// ===== PDF.js 随包数据 =====
//
// 浏览器版 PDF.js 要从同源 URL 取四组数据：
//   cmaps/          CJK 预定义 CMap（没有它，中文 PDF 的文字层抽不出来）
//   standard_fonts/ 标准 14 字体的度量（渲染 PDF 时用）
//   wasm/           JPEG2000 / JBIG2 图片解码器
//   iccs/           CMYK ICC 色彩配置
// worker 本身是独立脚本，也必须能从同源加载（CSP worker-src 'self'）。
//
// 这些文件不适合经 Vite 的 import 打进 bundle（169 个 bcmap + 二进制），
// 因此构建结束时原样拷进 assets/public/pdfjs；`vite dev` 则由中间件直接
// 从 node_modules 提供同一批路径，开发态与打包态 URL 完全一致。
const PDFJS_ROOT = resolve(ROOT, 'node_modules/pdfjs-dist')
const PDFJS_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs']
const PDFJS_OUT = resolve(ROOT, 'android/app/src/main/assets/public/pdfjs')

function pdfjsMime(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.wasm':
      return 'application/wasm'
    case '.ttf':
      return 'font/ttf'
    case '.woff2':
      return 'font/woff2'
    default:
      return 'application/octet-stream'
  }
}

function pdfjsAssets(): Plugin {
  return {
    name: 'guncat-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const raw = (req.url ?? '').split('?')[0]
        const rel = decodeURIComponent(raw).replace(/^\/+/, '')
        // 运行时 worker 固定叫 pdf.worker.mjs；node_modules 里是压缩版
        const mapped = rel === 'pdf.worker.mjs' ? 'build/pdf.worker.min.mjs' : rel
        const file = resolve(PDFJS_ROOT, mapped)
        if (!file.startsWith(PDFJS_ROOT + sep) || !existsSync(file) || statSync(file).isDirectory()) {
          next()
          return
        }
        res.setHeader('Content-Type', pdfjsMime(file))
        res.setHeader('Cache-Control', 'no-cache')
        createReadStream(file).pipe(res)
      })
    },
    closeBundle() {
      mkdirSync(PDFJS_OUT, { recursive: true })
      for (const dir of PDFJS_DIRS) {
        const from = resolve(PDFJS_ROOT, dir)
        if (existsSync(from)) {
          cpSync(from, resolve(PDFJS_OUT, dir), { recursive: true })
        }
      }
      const worker = resolve(PDFJS_ROOT, 'build/pdf.worker.min.mjs')
      if (existsSync(worker)) {
        cpSync(worker, resolve(PDFJS_OUT, 'pdf.worker.mjs'))
      }
    }
  }
}

export default defineConfig({
  root: resolve(ROOT, 'src/mobile'),
  base: './',
  publicDir: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GUNCAT_RESOURCE_BASE__: JSON.stringify('./resources/'),
    global: 'globalThis'
  },
  resolve: {
    alias: [
      { find: '@core/platform/shellExec', replacement: resolve(ROOT, 'src/mobile/platform/shellExec.ts') },
      { find: /^libguncatjs\.so$/, replacement: resolve(ROOT, 'src/mobile/platform/libguncatjs.ts') },
      { find: '@kit.ImageKit', replacement: resolve(ROOT, 'src/mobile/kit/ImageKit.ts') },
      { find: '@kit.PDFKit', replacement: resolve(ROOT, 'src/mobile/kit/PDFKit.ts') },
      { find: '@kit.ArkTS', replacement: resolve(ROOT, 'src/mobile/kit/ArkTS.ts') },
      { find: '@kit.CoreFileKit', replacement: resolve(ROOT, 'src/core/platform/kit/CoreFileKit.ts') },
      { find: '@kit.NetworkKit', replacement: resolve(ROOT, 'src/core/platform/kit/NetworkKit.ts') },
      { find: '@kit.BasicServicesKit', replacement: resolve(ROOT, 'src/core/platform/kit/BasicServicesKit.ts') },
      { find: '@kit.AbilityKit', replacement: resolve(ROOT, 'src/core/platform/kit/AbilityKit.ts') },
      { find: '@kit.ArkData', replacement: resolve(ROOT, 'src/core/platform/kit/ArkData.ts') },
      { find: '@kit.PerformanceAnalysisKit', replacement: resolve(ROOT, 'src/core/platform/kit/PerformanceAnalysisKit.ts') },
      { find: /^node:fs\/promises$/, replacement: resolve(ROOT, 'src/mobile/shims/fs-promises.ts') },
      { find: /^node:fs$/, replacement: resolve(ROOT, 'src/mobile/shims/fs.ts') },
      { find: /^node:path$/, replacement: resolve(ROOT, 'src/mobile/shims/path.ts') },
      { find: /^path$/, replacement: resolve(ROOT, 'src/mobile/shims/path.ts') },
      { find: /^node:util$/, replacement: resolve(ROOT, 'src/mobile/shims/util.ts') },
      { find: '@main', replacement: resolve(ROOT, 'src/main') },
      { find: '@core', replacement: resolve(ROOT, 'src/core') },
      { find: '@ipc', replacement: resolve(ROOT, 'src/ipc') },
      { find: '@renderer', replacement: resolve(ROOT, 'src/renderer/src') }
    ]
  },
  plugins: [
    mobilePlatformRedirect(),
    pdfjsAssets(),
    react(),
    nodePolyfills({
      include: ['events', 'stream', 'url', 'buffer', 'process', 'util'],
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true
    })
  ],
  build: {
    outDir: resolve(ROOT, 'android/app/src/main/assets/public'),
    emptyOutDir: true,
    target: 'chrome110',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: { index: resolve(ROOT, 'src/mobile/index.html') }
    }
  },
  server: {
    port: 5174,
    host: '127.0.0.1'
  }
})
