// 后台任务保活：把渲染层的 running 翻转同步给 Android 原生外壳。
//
// 为什么放在 mobile 层：`running` 是两端共享的 store 状态，桌面端不需要额外动作；
// 只有 Android 要在任务开始时拉起前台服务（通知 + 唤醒锁 + Wi-Fi 锁），
// 在任务结束时释放，否则用户一切到后台/熄屏，WebView 进程就可能被系统冻结。
import { useStore } from '../../renderer/src/store'
import { androidBridge } from './bridge'

let installed = false
let applied: boolean | null = null

function apply(running: boolean): void {
  if (running === applied) {
    return
  }
  applied = running
  try {
    androidBridge()?.setTaskRunning?.(running)
  } catch (error) {
    // 保活失败不能反过来打断任务：只记录，让任务按前台方式继续。
    console.warn('[guncat] 后台任务保活切换失败', error)
  }
}

/**
 * 订阅 store 的执行态并驱动原生保活服务。
 * 浏览器预览没有原生桥，直接跳过（也不建立订阅）。
 */
export function installBackgroundTaskKeepAlive(): void {
  if (installed || androidBridge() === null) {
    return
  }
  installed = true
  apply(useStore.getState().running)
  useStore.subscribe((state) => apply(state.running))
}
