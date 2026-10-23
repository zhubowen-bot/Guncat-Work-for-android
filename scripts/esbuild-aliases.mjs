// 与 electron.vite.config.ts 保持一致的别名表，供无头脚本复用。
//
// 顺带把 esbuild 的临时目录固定到项目内的 .tmp：
// 在 Windows 上 esbuild 会在系统 TEMP 里建临时文件再删掉，而本机环境下这一步
// 会报 "Access is denied"（构建直接在 vite:esbuild-transpile 阶段失败）。
// 把 TMP/TEMP 指到项目内即可绕开，且不依赖任何 shell 语法，跨平台一致。
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const tempDir = path.join(root, '.tmp')
fs.mkdirSync(tempDir, { recursive: true })
process.env.TMP = tempDir
process.env.TEMP = tempDir
// 少数库读 TMPDIR（非 Windows 平台）
process.env.TMPDIR = tempDir
void os

const kit = (name) => path.join(root, 'src/core/platform/kit', name)

export const alias = {
  '@kit.ArkTS': kit('ArkTS.ts'),
  '@kit.CoreFileKit': kit('CoreFileKit.ts'),
  '@kit.NetworkKit': kit('NetworkKit.ts'),
  '@kit.BasicServicesKit': kit('BasicServicesKit.ts'),
  '@kit.AbilityKit': kit('AbilityKit.ts'),
  '@kit.ArkData': kit('ArkData.ts'),
  '@kit.PerformanceAnalysisKit': kit('PerformanceAnalysisKit.ts'),
  '@kit.ImageKit': kit('ImageKit.ts'),
  '@kit.PDFKit': kit('PDFKit.ts'),
  'libguncatjs.so': path.join(root, 'src/core/platform/native/libguncatjs.ts'),
  '@core': path.join(root, 'src/core'),
  '@ipc': path.join(root, 'src/ipc')
}
