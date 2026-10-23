import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// 端口代码里的 import 保持与鸿蒙侧完全一致（'@kit.NetworkKit' 等），
// 由 bundler 别名把它们指向 src/core/platform/kit 下的桌面实现。
// 这样 src/core 下的移植文件不需要任何 import 改写，也便于日后与上游同步。
const KIT_ALIASES: Record<string, string> = {
  '@kit.ArkTS': resolve('src/core/platform/kit/ArkTS.ts'),
  '@kit.CoreFileKit': resolve('src/core/platform/kit/CoreFileKit.ts'),
  '@kit.NetworkKit': resolve('src/core/platform/kit/NetworkKit.ts'),
  '@kit.BasicServicesKit': resolve('src/core/platform/kit/BasicServicesKit.ts'),
  '@kit.AbilityKit': resolve('src/core/platform/kit/AbilityKit.ts'),
  '@kit.ArkData': resolve('src/core/platform/kit/ArkData.ts'),
  '@kit.PerformanceAnalysisKit': resolve('src/core/platform/kit/PerformanceAnalysisKit.ts'),
  '@kit.ImageKit': resolve('src/core/platform/kit/ImageKit.ts'),
  '@kit.PDFKit': resolve('src/core/platform/kit/PDFKit.ts')
}

// 鸿蒙侧 run_js 的原生 JSVM 模块，桌面端换成 node:vm 实现
const NATIVE_ALIASES: Record<string, string> = {
  'libguncatjs.so': resolve('src/core/platform/native/libguncatjs.ts')
}

const SHARED_ALIASES: Record<string, string> = {
  '@core': resolve('src/core'),
  '@ipc': resolve('src/ipc')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        ...KIT_ALIASES,
        ...NATIVE_ALIASES,
        ...SHARED_ALIASES,
        '@main': resolve('src/main')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        // 两个不能打进 bundle 的依赖：
        //   · pdfjs-dist —— 内部有 worker / wasm / 标准字体的动态路径，打包会改坏它们；
        //   · @napi-rs/canvas —— .node 原生模块，只能运行时按路径解析。
        // 两者都由 package-portable.mjs 随包放到 resources/app/node_modules 下，
        // 运行时经 createRequire 解析（取不到 canvas 时 PDF 仍有文本能力，只是不出图）。
        external: ['pdfjs-dist', 'pdfjs-dist/legacy/build/pdf.mjs', '@napi-rs/canvas']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { ...SHARED_ALIASES }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: { ...SHARED_ALIASES, '@renderer': resolve('src/renderer/src') }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
