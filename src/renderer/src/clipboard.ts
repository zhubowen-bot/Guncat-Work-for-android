// 剪贴板：渲染层唯一的复制入口。
//
// 为什么不能直接用 navigator.clipboard：
//   Android WebView 不把剪贴板写权限授予页面，`navigator.clipboard.writeText` 会抛
//   `NotAllowedError: Write permission denied` —— 用户看到的正是截图里那条「复制失败」。
//   这不是安全上下文的问题（页面来自 127.0.0.1），而是 WebView 的权限模型：
//   它只允许通过原生 ClipboardManager 写。
//
// 因此按可靠性从高到低走三条路：
//   1. Android 原生桥 `GuncatAndroid.copyText`（ClipboardManager，一定成功）
//   2. `navigator.clipboard.writeText`（桌面 Electron / 支持的安全上下文）
//   3. 隐藏 textarea + `document.execCommand('copy')`（老内核兜底，需用户手势）
//
// 另外两个与「选中文字复制」有关的问题也在这里收口：
//   · copy 事件守卫：事件回来时把**当前选区文本**显式写进 clipboardData。
//     部分 WebView 在内核选区与 DOM 选区不同步时会把整页/整条消息塞进剪贴板，
//     显式覆写是成本最低、且不会误伤输入框（输入框里走浏览器默认行为）的修法。
//   · 选区跟踪：记住最近一次非空选区。消息操作行的「复制」按钮在用户刚选过
//     同一段文字时优先复制选区，而不是把整条回答再复制一遍。

interface ClipboardBridge {
  copyText?(text: string): string
}

interface TrackedSelection {
  text: string
  anchor: Node | null
  at: number
}

let tracked: TrackedSelection | null = null
let copyGuardInstalled = false

function bridge(): ClipboardBridge | null {
  if (typeof window === 'undefined') {
    return null
  }
  const value = (window as unknown as { GuncatAndroid?: ClipboardBridge }).GuncatAndroid
  return value === undefined ? null : value
}

/** 第三条路：隐藏 textarea + execCommand，复制前后恢复用户原来的选区 */
function legacyCopy(text: string): boolean {
  const active: Element | null = document.activeElement
  const selection = window.getSelection()
  const ranges: Range[] = []
  if (selection !== null) {
    for (let i = 0; i < selection.rangeCount; i++) {
      ranges.push(selection.getRangeAt(i).cloneRange())
    }
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.left = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  area.setSelectionRange(0, text.length)
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  // 别把焦点从输入框里抢走（手机上尤其明显：键盘会因此收起）
  if (active !== null && active instanceof HTMLElement && active !== document.body) {
    active.focus({ preventScroll: true })
  }
  if (selection !== null) {
    selection.removeAllRanges()
    for (const range of ranges) {
      selection.addRange(range)
    }
  }
  return copied
}

/** 复制一段文本；返回是否成功。调用方据此给出「已复制 / 复制失败」的提示。 */
export async function copyText(text: string): Promise<boolean> {
  const value = text ?? ''
  if (value === '') {
    return false
  }
  const native = bridge()
  if (native !== null && typeof native.copyText === 'function') {
    try {
      if (native.copyText(value) === 'ok') {
        return true
      }
    } catch {
      // 原生桥异常时继续走浏览器路径
    }
  }
  if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // 权限被拒（WebView 常态）→ 走 execCommand
    }
  }
  return legacyCopy(value)
}

/**
 * 用户选中文字后直接触发系统「复制」时的兜底。
 *
 * 只在「有非空选区、且不在输入框里」时接管：把选区原文写进剪贴板并阻止默认行为。
 * 输入框/可编辑区域完全交给浏览器，避免破坏正常的复制粘贴。
 */
export function installSelectionCopyGuard(): void {
  if (typeof document === 'undefined' || copyGuardInstalled) {
    return
  }
  copyGuardInstalled = true
  document.addEventListener(
    'copy',
    (event) => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
        return
      }
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return
      }
      if (target instanceof HTMLElement && target.isContentEditable) {
        return
      }
      const text = selection.toString()
      if (text === '') {
        return
      }
      const data = (event as ClipboardEvent).clipboardData
      if (data === null) {
        return
      }
      data.setData('text/plain', text)
      event.preventDefault()
    },
    true
  )

  // 跟踪最近一次非空选区：手机端点了按钮之后选区会被收起，
  // 等 click 里再读 window.getSelection() 往往已经是空的了。
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection()
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
      return
    }
    const text = selection.toString()
    if (text.trim() === '') {
      return
    }
    tracked = { text, anchor: selection.anchorNode, at: Date.now() }
  })
}

/**
 * 取「落在 container 里的那段最近选中文字」：
 * 还活着的选区优先；选区已被收起时回看 5 秒内跟踪到的选区（且要能对上容器内容）。
 */
export function selectionTextWithin(container: Element | null): string {
  if (container === null) {
    return ''
  }
  const selection = window.getSelection()
  if (selection !== null && !selection.isCollapsed && selection.rangeCount > 0) {
    const text = selection.toString()
    if (text !== '' && selection.anchorNode !== null && container.contains(selection.anchorNode)) {
      return text
    }
  }
  if (
    tracked !== null &&
    Date.now() - tracked.at < 5000 &&
    tracked.anchor !== null &&
    container.contains(tracked.anchor)
  ) {
    // 容器内容对不上就说明是别处的旧选区（例如消息列表已经重渲染过）
    const content = container.textContent ?? ''
    if (content.includes(tracked.text.trim().slice(0, 24))) {
      return tracked.text
    }
  }
  return ''
}
