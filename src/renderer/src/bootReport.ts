// 启动诊断上报：把「渲染进程内部走到了哪一步」告诉主进程。
//
// 为什么单独一个模块：App 与 main.tsx 都要用，而且**上报本身绝不能变成新的故障源** ——
// preload 没装上、主进程还没注册处理器、窗口正在销毁……任何一种情况都必须静默放弃。
import type { RendererStage } from '@ipc/contract'

export function reportStage(stage: RendererStage, detail?: string): void {
  try {
    const api = window.guncat
    if (api === undefined || api.app === undefined || api.app.reportStage === undefined) {
      return
    }
    void api.app.reportStage(stage, detail).catch(() => {
      // 主进程没接住就算了，界面不该因此受影响
    })
  } catch {
    // 忽略
  }
}

/** 把任意抛出物描述成一行可写进日志的文本 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`
  }
  return String(error)
}
