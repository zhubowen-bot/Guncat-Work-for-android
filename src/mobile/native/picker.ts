// 文件选择：Android WebView 实现了 onShowFileChooser，所以 HTML <input type=file>
// 就是系统文件/相册选择器。选中的文件先读进应用的内存文件系统，再交给 core 的
// 既有链路（FileService / intakePaths）处理 —— 与桌面端「选择后拿到路径」的语义一致。
import fs from 'node:fs'
import path from 'node:path'
import { makeTempDir } from '@core/platform/appPaths'

export interface PickOptions {
  extensions?: string[]
  maxCount?: number
  imagesOnly?: boolean
  multiple?: boolean
  /** true = 直接调起相机（Android 上给 input 加 capture=environment） */
  camera?: boolean
}

function acceptOf(options: PickOptions): string {
  if (options.imagesOnly === true || options.camera === true) {
    return 'image/*'
  }
  const extensions = options.extensions ?? []
  const cleaned = extensions
    .map((ext) => ext.replace(/^\./, '').replace(/^\*\.?/, ''))
    .filter((ext) => ext !== '' && ext !== '*')
  return cleaned.map((ext) => `.${ext}`).join(',')
}

function sanitizeName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  return base === '' ? 'file' : base
}

/**
 * 把系统选择器返回的 File 读进应用的**临时**目录（`/guncat/data/temp/...`），返回应用内路径。
 *
 * 为什么落在 temp 而不是数据目录：这只是一份「把一次性 File 折成路径」的暂存副本，
 * 上游（intakePaths / 附件预解析 / 发送）读完之后就不再需要它了。放在 temp 下有两个好处：
 *   · 每次启动 clearTempDir() 会整目录清掉，选过的原图不会在 IndexedDB 里永久留一份
 *     （旧实现落在数据目录下，一个相册 150 张照片就是 200MB+，删会话也不回收）；
 *   · 「暂存」和「用户数据/工作区」在磁盘上分开，排查体积时不会混在一起。
 */
async function importSelected(files: File[]): Promise<string[]> {
  if (files.length === 0) {
    return []
  }
  // 每次选择一个独立子目录：多选同名文件不会互相覆盖，也方便整目录回收
  const dir = makeTempDir('intake')
  const out: string[] = []
  for (const file of files) {
    const target = path.posix.join(dir, sanitizeName(file.name))
    try {
      const buffer = await file.arrayBuffer()
      fs.writeFileSync(target, new Uint8Array(buffer))
      out.push(target)
    } catch (e) {
      console.warn('[picker] 读取文件失败', file.name, e)
    }
  }
  return out
}

export function pickFilesFromDevice(options: PickOptions = {}): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = acceptOf(options)
    input.multiple = options.multiple === true || (options.maxCount ?? 1) > 1
    if (options.camera === true) {
      input.multiple = false
      input.setAttribute('capture', 'environment')
      // 部分 WebView 不把 capture 转成 isCaptureEnabled()；显式通知原生这次一定开相机
      const bridge = window.GuncatAndroid
      if (bridge !== undefined && typeof bridge.armCameraCapture === 'function') {
        try {
          bridge.armCameraCapture()
        } catch {
          // 原生不支持时仍走 input capture 的默认行为
        }
      }
    }
    input.style.display = 'none'
    document.body.appendChild(input)

    let settled = false
    // change 已经触发 = 用户确实选了文件。此后**绝不能**再走「取消」兜底：
    // 多选/相册里的文件要逐个读进内存，耗时可能超过兜底计时器，
    // 先前就是因为这个计时器把「读取中」当成「用户取消」，多选结果被整体丢掉。
    let changeSeen = false
    let focusTimer = 0
    const finish = (paths: string[]): void => {
      if (settled) {
        return
      }
      settled = true
      if (focusTimer !== 0) {
        window.clearTimeout(focusTimer)
        focusTimer = 0
      }
      input.remove()
      resolve(paths)
    }

    input.addEventListener('change', () => {
      changeSeen = true
      if (focusTimer !== 0) {
        window.clearTimeout(focusTimer)
        focusTimer = 0
      }
      const files = Array.from(input.files ?? [])
      const limited = files.slice(0, Math.max(1, options.maxCount ?? 1))
      void importSelected(limited).then(finish, () => finish([]))
    })
    input.addEventListener('cancel', () => finish([]))

    // 某些旧 WebView 没有 cancel 事件：窗口重新获得焦点后若还没有 change，按取消处理。
    // 只在「确实失焦过」之后才计时 —— 否则 picker 还没打开、焦点事件先到，
    // 计时器会在用户挑选文件的过程中把这次选择判成取消。
    let blurred = false
    const onBlur = (): void => {
      blurred = true
    }
    const onFocus = (): void => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      if (!blurred || settled) {
        return
      }
      // 给系统选择器回传结果留出时间；changeSeen 之后这个计时器不会再判取消。
      focusTimer = window.setTimeout(() => {
        if (!settled && !changeSeen && (input.files === null || input.files.length === 0)) {
          finish([])
        }
      }, 2000)
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)

    input.click()
  })
}
