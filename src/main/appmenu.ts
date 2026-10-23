// 应用级外观：任务栏身份（AppUserModelID）与菜单栏。
//
// 用户报障：「应用标题栏图标对了，但是显示在 exe 程序和菜单栏里面的图标还是 electron 默认图标」。
// 三处现象其实是三个不同的成因，这里处理后两处，exe 的图标由打包脚本用 rcedit 打进 PE 资源：
//
//   1) exe 文件本身的图标 —— 它不是运行时能改的，就藏在 PE 的图标资源里。
//      组装脚本把 electron.exe 直接改名成「Guncat Work.exe」，图标自然还是 Electron 的。
//      → scripts/package-portable.mjs 用 rcedit 覆写图标与版本信息。
//   2) 任务栏 / 窗口缩略图 —— Windows 按 AppUserModelID 归组并回退到该身份的图标。
//      不设 AppUserModelID 时它会去用 exe 的图标（= Electron 的）。
//      → setAppUserModelId 指向我们自己的标识。
//   3) 菜单栏 —— 此前完全没设过菜单，Electron 就摆上了它自带的
//      File / Edit / View / Window / Help 这一整套英文菜单（连带 Electron 的身份观感）。
//      → 换成一个中文「视图」菜单，只留重新加载 / 开发者工具 / 缩放 / 全屏这几项真正有用的。
import { app, Menu } from 'electron'
import { bootLog } from './bootlog'

/** 任务栏身份。Windows 用它把同一应用的窗口归到一起，并据此找图标。 */
export const APP_USER_MODEL_ID = 'com.guncat.work'

/**
 * 设置任务栏身份。
 * 必须在创建窗口**之前**调用 —— 窗口一旦建立就已经带着旧身份进了任务栏。
 */
export function installAppIdentity(): void {
  if (process.platform !== 'win32') {
    return
  }
  try {
    app.setAppUserModelId(APP_USER_MODEL_ID)
    bootLog(`任务栏身份已设置: ${APP_USER_MODEL_ID}`)
  } catch (e: unknown) {
    // 设不上不该影响启动，只是任务栏归组会退回默认行为
    bootLog(`任务栏身份设置失败（不影响使用）: ${String(e)}`)
  }
}

/**
 * 换上自己的菜单栏。
 *
 * 为什么不是干脆 `Menu.setApplicationMenu(null)`：开发者工具是排障时唯一的现场手段
 * （窗口在本机甚至起不来，用户那边的报错也只有他自己能打开控制台看）。
 * 保留这几项、去掉 Electron 自带的英文菜单，才是既对齐原版观感又不自断退路的做法。
 */
export function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' }
      ]
    }
  ]
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
    bootLog('菜单栏已替换为应用自己的「视图」菜单')
  } catch (e: unknown) {
    bootLog(`菜单栏设置失败（不影响使用）: ${String(e)}`)
  }
}
