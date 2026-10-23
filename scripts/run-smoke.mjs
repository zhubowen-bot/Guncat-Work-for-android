// 把 scripts/smoke.ts 用 esbuild 打成可直接被 Node 执行的 ESM，
// 并施加与 electron.vite.config.ts 完全相同的别名规则。
//
// 这样无头验证跑的就是「构建产物真实依赖的那套解析规则」，
// 而不是另起一套近似配置。
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { root, alias } from './esbuild-aliases.mjs'

const outDir = path.join(root, '.smoke')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
const outfile = path.join(outDir, 'smoke.mjs')

await build({
  entryPoints: [path.join(root, 'scripts/smoke.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  // electron 保持外部依赖：ImageKit 只在真正解码像素时才 require 它。
  // pdfjs 与原生 canvas 同样外部化：pdfjs 有自己的 worker / wasm / 字体动态路径，
  // 打进 bundle 会被改坏；@napi-rs/canvas 是 .node 原生模块，根本打不进去。
  // 生产构建（electron.vite.config.ts）对这两者也是 external，两边口径一致。
  external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas'],
  alias,
  logLevel: 'error'
})

console.log(`已打包冒烟脚本 → ${path.relative(root, outfile)}\n`)
await import(pathToFileURL(outfile).href)
