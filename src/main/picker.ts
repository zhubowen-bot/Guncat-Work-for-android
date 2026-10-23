// 把 Electron 的系统对话框接到平台层的 picker 接口上。
// 端口代码调用 picker.DocumentViewPicker / PhotoViewPicker 时，
// 实际由这里弹出原生对话框并把结果回填。
import { dialog } from 'electron'
import { registerPickerHost, type PickerSelectOptions, type PickerSaveOptions } from '@core/platform/kit/CoreFileKit'
import { getMainWindow } from './window'

function toFilters(extensions: string[] | undefined): Electron.FileFilter[] {
  if (extensions === undefined || extensions.length === 0) {
    return [{ name: '所有文件', extensions: ['*'] }]
  }
  const normalized: string[] = extensions
    .map((e) => e.trim().replace(/^\./, '').replace(/^\*\./, ''))
    .filter((e) => e !== '' && e !== '*')
  if (normalized.length === 0) {
    return [{ name: '所有文件', extensions: ['*'] }]
  }
  return [{ name: normalized.join(' / ').toUpperCase(), extensions: normalized }]
}

export function registerElectronPicker(): void {
  registerPickerHost({
    async selectFiles(options: PickerSelectOptions): Promise<string[]> {
      const window: Electron.BrowserWindow | null = getMainWindow()
      const result: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(window ?? undefined!, {
        title: '选择文件',
        properties: options.maxCount !== undefined && options.maxCount > 1 ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: toFilters(options.extensions)
      })
      return result.canceled ? [] : result.filePaths
    },

    async selectImages(maxCount: number): Promise<string[]> {
      const window: Electron.BrowserWindow | null = getMainWindow()
      const result: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(window ?? undefined!, {
        title: '选择图片',
        properties: maxCount > 1 ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
      })
      return result.canceled ? [] : result.filePaths
    },

    async saveFile(options: PickerSaveOptions): Promise<string[]> {
      const window: Electron.BrowserWindow | null = getMainWindow()
      const suggested: string = options.suggestedName ?? 'untitled'
      const result: Electron.SaveDialogReturnValue = await dialog.showSaveDialog(window ?? undefined!, {
        title: '保存文件',
        defaultPath: suggested,
        filters: toFilters(options.extensions)
      })
      return result.canceled || result.filePath === undefined ? [] : [result.filePath]
    }
  })
}
