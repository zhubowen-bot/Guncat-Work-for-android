// 文件选择：Android WebView 实现了 onShowFileChooser，所以 HTML <input type=file>
// 就是系统文件/相册选择器。选中的文件先读进应用的内存文件系统，再交给 core 的
// 既有链路（FileService / intakePaths）处理 —— 与桌面端「选择后拿到路径」的语义一致。
import fs from 'node:fs'
import path from 'node:path'

export interface PickOptions {
  extensions?: string[]
  maxCount?: number
  imagesOnly?: boolean
  multiple?: boolean
}

function acceptOf(options: PickOptions): string {
  if (options.imagesOnly === true) {
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

let seq = 0

/** 把系统选择器返回的 File 读进 /guncat/data/intake/...，返回应用内路径。 */
async function importSelected(files: File[]): Promise<string[]> {
  if (files.length === 0) {
    return []
  }
  const dir = `/guncat/data/intake/${Date.now()}_${seq++}`
  fs.mkdirSync(dir, { recursive: true })
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
    input.style.display = 'none'
    document.body.appendChild(input)

    let settled = false
    const finish = (paths: string[]): void => {
      if (settled) {
        return
      }
      settled = true
      input.remove()
      resolve(paths)
    }

    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? [])
      const limited = files.slice(0, Math.max(1, options.maxCount ?? 1))
      void importSelected(limited).then(finish, () => finish([]))
    })
    input.addEventListener('cancel', () => finish([]))

    // 某些旧 WebView 没有 cancel 事件：窗口重新获得焦点后若还没有 change，按取消处理。
    const onFocus = (): void => {
      window.setTimeout(() => {
        if (!settled && (input.files === null || input.files.length === 0)) {
          finish([])
        }
      }, 800)
      window.removeEventListener('focus', onFocus)
    }
    window.addEventListener('focus', onFocus)

    input.click()
  })
}
