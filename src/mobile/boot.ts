// Android 端启动：先把内存文件系统从 IndexedDB 恢复，再装载随包资源，
// 最后才实例化 SessionManager / React —— 顺序不能反，否则 core 第一次读配置
// 会落到一个空目录上，用户看到的是「配置全部丢失」。
import { initAppPaths, clearTempDir } from '@core/platform/appPaths'
import { bindSafeStorage } from '@core/platform/kit/ArkData'
import { registerPickerHost } from '@core/platform/kit/CoreFileKit'
import { setShellPlatform } from '@core/common/PlatformInfo'
import { hydrateFs } from './shims/fs'
import { installBundledResources } from './resources'
import { installFetchProxy } from './native/net'
import { pickFilesFromDevice } from './native/picker'
import { createMobileHost } from './host'
import { runShell } from './platform/shell'
import { shellStatus } from './platform/shellExec'
import { mirrorRootFor } from './platform/mirror'
import { runJs } from './platform/libguncatjs'

export const DATA_ROOT = '/guncat/data'
export const RESOURCES_ROOT = '/guncat/resources'

/**
 * Android 的软键盘不会改变 CSS `vh`，但会缩小 visualViewport。
 * 把可视高度写进 --app-height，输入区才能始终留在键盘上方。
 */
function installViewportHeight(): void {
  const apply = (): void => {
    const height = window.visualViewport?.height ?? window.innerHeight
    document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`)
  }
  apply()
  window.addEventListener('resize', apply)
  window.visualViewport?.addEventListener('resize', apply)
  window.visualViewport?.addEventListener('scroll', apply)
}

export async function bootMobile(): Promise<void> {
  // 系统提示与 run_command 描述按 Android 的 bash 写，而不是 Windows cmd
  setShellPlatform('android')
  // 手机端没有可靠 hover：即使 WebView 把 matchMedia 报成 hover，也不启用桌面 hover 规则
  document.documentElement.classList.remove('hoverable')
  await hydrateFs()
  installBundledResources()
  initAppPaths({ dataRoot: DATA_ROOT, resourcesRoot: RESOURCES_ROOT })
  clearTempDir()
  bindSafeStorage(null)
  installFetchProxy()

  registerPickerHost({
    async selectFiles(options): Promise<string[]> {
      return pickFilesFromDevice({
        extensions: options.extensions ?? [],
        maxCount: options.maxCount ?? 1
      })
    },
    async selectImages(maxCount): Promise<string[]> {
      return pickFilesFromDevice({ imagesOnly: true, maxCount, multiple: maxCount > 1 })
    },
    async saveFile(): Promise<string[]> {
      // 保存走 native bridge 的 saveBytes，不经过 VFS；这里保留占位以对齐接口
      return []
    }
  })

  const { api, session } = createMobileHost()
  window.guncat = api
  ;(window as unknown as Record<string, unknown>).__guncatDebug = {
    version: __APP_VERSION__,
    dataRoot: DATA_ROOT,
    resourcesRoot: RESOURCES_ROOT,
    runShell,
    runJs,
    shellStatus,
    mirrorRootFor
  }
  await session.bootstrap()
  document.documentElement.dataset.platform = 'android'
  document.body.classList.add('platform-android')
  installViewportHeight()
}
