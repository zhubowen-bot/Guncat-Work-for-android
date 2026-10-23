import { resolve } from 'node:path'
import { defineConfig } from 'vite'
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
