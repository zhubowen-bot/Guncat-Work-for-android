// node:fs/promises 的替身。端口代码只在类型位置引用它，这里保留运行时出口。
import { fs } from './fs'

export const promises = fs.promises
export default promises
