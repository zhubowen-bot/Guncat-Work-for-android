// 鸿蒙侧依赖若干 ArkTS / ArkUI 的全局环境声明，端口代码直接使用它们。
// 桌面端把这些名字补成等价的全局声明，避免为装饰器逐个改动移植文件。
import type { common } from './AbilityKit'

declare global {
  /** ArkTS 的全局上下文类型（端口代码签名里写作 `context: Context`） */
  type Context = common.Context
}

export {}
