// node:path 的浏览器替身：Android 上所有路径都是 POSIX，path-browserify 正好对齐。
// path-browserify 只导出 POSIX 实现本身，没有 Node 的 `path.posix` / `path.win32`
// 命名空间；端口代码（内置 Shell、PDF 后端）会访问 path.posix，这里补齐。
import pathBrowserify from 'path-browserify'

const path = Object.assign({}, pathBrowserify, {
  posix: pathBrowserify,
  win32: pathBrowserify
})

export default path
export const {
  resolve,
  join,
  dirname,
  basename,
  extname,
  relative,
  isAbsolute,
  sep,
  normalize,
  parse,
  format,
  delimiter,
  toNamespacedPath
} = path
export const posix = path
export const win32 = path
