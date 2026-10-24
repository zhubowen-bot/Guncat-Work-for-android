// Android 端启动：先把内存文件系统从 IndexedDB 恢复，再装载随包资源，
// 最后才实例化 SessionManager / React —— 顺序不能反，否则 core 第一次读配置
// 会落到一个空目录上，用户看到的是「配置全部丢失」。
import { initAppPaths, clearTempDir } from '@core/platform/appPaths'
import { bindSafeStorage } from '@core/platform/kit/ArkData'
import { registerPickerHost } from '@core/platform/kit/CoreFileKit'
import { setShellPlatform } from '@core/common/PlatformInfo'
import { PdfTextExtractor } from '@core/service/PdfTextExtractor'
import fs from './shims/fs'
import { hydrateFs } from './shims/fs'
import { installBundledResources } from './resources'
import { installFetchProxy } from './native/net'
import { pickFilesFromDevice } from './native/picker'
import { createMobileHost } from './host'
import { runShell } from './platform/shell'
import { shellStatus } from './platform/shellExec'
import { mirrorRootFor } from './platform/mirror'
import { runJs } from './platform/libguncatjs'
import { pdfService } from '@kit.PDFKit'
import { installPdfJsBackend, preloadPdfJs } from './platform/pdfBackend'

export const DATA_ROOT = '/guncat/data'
export const RESOURCES_ROOT = '/guncat/resources'

/**
 * 浏览器冒烟用：把 base64 内容写进 memfs。
 * 生产路径不经过它（文件来自选择器/工作区工具），仅供 android-check 造测试素材。
 */
function writeFileBase64(absPath: string, base64: string): void {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  const parent = absPath.slice(0, absPath.lastIndexOf('/'))
  if (parent !== '') {
    fs.mkdirSync(parent, { recursive: true })
  }
  fs.writeFileSync(absPath, bytes)
}

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
  // PDF 工具（parse_document / search_pdf / pdf_to_images）走 PDF.js；
  // 这里只注入后端，PDF.js 本身在第一次打开文档时才动态加载。
  installPdfJsBackend()

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
    mirrorRootFor,
    // 浏览器冒烟专用：造测试素材 + 直接驱动 PDF 三件套（与工具执行走同一套内核）
    writeFileBase64,
    pdf: {
      ready: pdfService.hasPdfBackend(),
      extract: (absPath: string, page?: number, pageCount?: number) =>
        PdfTextExtractor.extractPages(absPath, page ?? 1, pageCount ?? 5, 20000),
      search: (absPath: string, query: string) =>
        PdfTextExtractor.searchText(absPath, query, 20),
      render: (absPath: string, outDir: string, page?: number, pageCount?: number) =>
        PdfTextExtractor.renderPages(absPath, page ?? 1, pageCount ?? 1, outDir)
    }
  }
  await session.bootstrap()
  // 后台预热 PDF 引擎：首次打开 PDF 时不再等两个 chunk 下载/解析。
  // 失败只记日志，不阻塞启动；真正失败的原因会在第一次工具调用时返回。
  preloadPdfJs()
  document.documentElement.dataset.platform = 'android'
  document.body.classList.add('platform-android')
  installViewportHeight()
}
