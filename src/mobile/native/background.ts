// 后台任务保活：把渲染层的 running 翻转同步给 Android 原生外壳。
//
// 为什么放在 mobile 层：`running` 是两端共享的 store 状态，桌面端不需要额外动作；
// 只有 Android 要在任务开始时拉起前台服务（通知 + 唤醒锁 + Wi-Fi 锁），
// 在任务结束时释放，否则用户一切到后台/熄屏，WebView 进程就可能被系统冻结。
//
// 为什么还要「等通知出现」：用户报障，**刚进应用就发任务、立刻切后台**时，
// 通知还没出现（前台服务还在启动路上），连接就先被系统掐了；跑两步之后再切就正常。
// 所以 setTaskRunning(true, id) 会带一个回执 id，原生在 startForeground 完成后
// 调 window.__guncatTaskKeepAliveReady(id)；mobile host 在真正发请求前 await 这个回执。
import { useStore } from '../../renderer/src/store'
import { androidBridge } from './bridge'

type ReadyCallback = () => void

let installed = false
let applied: boolean | null = null
let serviceReady = false
let callbackSeq = 0
let readyPromise: Promise<void> = Promise.resolve()
let pendingCallback: ReadyCallback | null = null

const pending = new Map<string, ReadyCallback>()

function finishReady(id: string): void {
  const resolve = pending.get(id)
  if (resolve === undefined) {
    return
  }
  pending.delete(id)
  serviceReady = true
  if (pendingCallback === resolve) {
    pendingCallback = null
  }
  resolve()
}

function installReadyHook(): void {
  window.__guncatTaskKeepAliveReady = (id: string): void => {
    finishReady(id)
  }
}

function startService(): Promise<void> {
  const bridge = androidBridge()
  if (bridge === null || typeof bridge.setTaskRunning !== 'function') {
    return Promise.resolve()
  }
  if (serviceReady) {
    return Promise.resolve()
  }
  if (pendingCallback !== null) {
    return readyPromise
  }
  installReadyHook()
  const id = `keepalive_${++callbackSeq}_${Date.now()}`
  readyPromise = new Promise<void>((resolve) => {
    pendingCallback = resolve
    pending.set(id, resolve)
    // 服务启动失败/系统不回调时不能让任务永远等：1.5s 后放行，前台执行仍然正常。
    // 真机正常路径通常 50~200ms 内就回执。
    setTimeout(() => {
      finishReady(id)
    }, 1500)
    try {
      bridge.setTaskRunning?.(true, id)
    } catch (error) {
      console.warn('[guncat] 后台任务保活启动失败', error)
      finishReady(id)
    }
  })
  return readyPromise
}

function apply(running: boolean): void {
  if (running === applied) {
    return
  }
  applied = running
  if (running) {
    void startService()
    return
  }
  serviceReady = false
  const bridge = androidBridge()
  try {
    bridge?.setTaskRunning?.(false, '')
  } catch (error) {
    console.warn('[guncat] 后台任务保活释放失败', error)
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
  installReadyHook()
  apply(useStore.getState().running)
  useStore.subscribe((state) => apply(state.running))
}

/**
 * 真正发请求前等前台服务进入 foreground。
 * 只在 mobile host 的 chat.send / work.run 里调用；桌面端不会走到这里。
 */
export function whenBackgroundTaskReady(): Promise<void> {
  return applied === true ? readyPromise : Promise.resolve()
}
