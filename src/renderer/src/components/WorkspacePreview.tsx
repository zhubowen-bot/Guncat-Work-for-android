// WorkspacePreview: 工作区文件预览弹层（侧栏文件列表与对话流末尾的产物汇总卡共用）。
//
// 按扩展名分流：
//   图片 → 内置渲染（点击进灯箱）；Markdown → 走对话流同一套渲染器；
//   代码 → highlight.js 着色；纯文本 → 原文；其余（Office/PDF/压缩包等）→
//   给「用默认程序打开 / 在文件管理器中显示」两个动作，不再假装有预览。
//
// 为什么「打开哪份文件」放在 store 而不是组件本地状态：两个入口离 App 根部一样近，
// 此前各自持一份本地 state、弹层又按「面板展开时只由面板渲染」二选一，产物卡的点击
// 就落在了那份没人渲染的状态上 —— 点文件名和点「预览」都没有反应。状态收进 store、
// 弹层由 App 渲染一份，两处共用同一条链路，也不可能同时出现两层弹层。
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { IconClose, IconDownload, IconFolder, IconShare } from '../icons'
import { CodeBlock, normalizeLanguage } from './CodeBlock'
import { Markdown } from './Markdown'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx'])
/** utf8 解码失败时的替换字符：源码里直接写这个字符不可见，用码点构造 */
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd)

type PreviewContent =
  | { kind: 'image'; dataUrl: string }
  | { kind: 'markdown'; text: string; truncated: boolean }
  | { kind: 'code'; language: string; text: string; truncated: boolean }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'info'; hint: string }

function extOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
}

/** `workspace:read` 的 IPC 在主进程侧做了 2MB 上限与越界校验，这里只按类型分流 */
async function readAsContent(conversationId: string, path: string): Promise<PreviewContent> {
  const ext: string = extOf(path)
  try {
    if (IMAGE_EXTS.has(ext)) {
      const binary = await window.guncat.workspace.readBinary(conversationId, path)
      return { kind: 'image', dataUrl: binary.dataUrl }
    }
    const result = await window.guncat.workspace.read(conversationId, path)
    if (MARKDOWN_EXTS.has(ext)) {
      return { kind: 'markdown', text: result.text, truncated: result.truncated }
    }
    const language = normalizeLanguage(ext)
    if (language !== '' && language !== 'mermaid') {
      return { kind: 'code', language, text: result.text, truncated: result.truncated }
    }
    // 无扩展名/未知扩展：utf8 解码出现替换字符 ≈ 二进制文件，别把乱码端给用户
    if (result.text.includes(REPLACEMENT_CHAR)) {
      return { kind: 'info', hint: '该文件是二进制格式，没有内置预览。' }
    }
    return { kind: 'text', text: result.text, truncated: result.truncated }
  } catch (e) {
    const message: string = String(e instanceof Error ? e.message : e)
    // 读取失败不再只弹一条转瞬即逝的 toast：留在弹层里给出「打开/显示位置」的出路
    return { kind: 'info', hint: `无法在应用内预览：${message}` }
  }
}

export function WorkspacePreviewOverlay() {
  const target = useStore((s) => s.workspacePreview)
  const close = useStore((s) => s.closeWorkspaceFile)
  const openLightbox = useStore((s) => s.openLightbox)
  const pushNotice = useStore((s) => s.pushNotice)
  const runTransfer = useStore((s) => s.runTransfer)
  const [content, setContent] = useState<PreviewContent | null>(null)

  useEffect(() => {
    if (target === null) {
      setContent(null)
      return
    }
    let cancelled = false
    void readAsContent(target.conversationId, target.path).then((next: PreviewContent) => {
      if (!cancelled) {
        setContent(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [target])

  // Esc 关闭（与灯箱一致）
  useEffect(() => {
    if (target === null) {
      return
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [target, close])

  if (target === null) {
    return null
  }
  const conversationId: string = target.conversationId
  const path: string = target.path

  function openExternal(): void {
    window.guncat.workspace.openFile(conversationId, path).catch((e: unknown) => {
      pushNotice('warn', String(e instanceof Error ? e.message : e))
    })
  }

  function reveal(): void {
    window.guncat.workspace.reveal(conversationId, path).catch((e: unknown) => {
      pushNotice('warn', String(e instanceof Error ? e.message : e))
    })
  }

  /** 预览里的这一个文件：下载（选位置）或交给系统分享面板 */
  function transferFile(action: 'save' | 'share'): void {
    const segments: string[] = path.split('/')
    const name: string = segments[segments.length - 1] ?? path
    void runTransfer(
      {
        kind: 'file',
        conversationId,
        path,
        name,
        title: action === 'save' ? '下载文件' : '分享文件'
      },
      action
    )
  }

  let body: React.ReactNode = null
  if (content !== null) {
    if (content.kind === 'image') {
      const dataUrl: string = content.dataUrl
      body = (
        <div className="preview__image-wrap">
          <img
            className="preview__image"
            src={dataUrl}
            alt={path}
            title="点击看大图"
            onClick={() => openLightbox(dataUrl)}
          />
        </div>
      )
    } else if (content.kind === 'markdown') {
      body = (
        <div className="preview__rich">
          <Markdown text={content.text} />
        </div>
      )
    } else if (content.kind === 'code') {
      body = (
        <div className="preview__rich preview__rich--code">
          <CodeBlock language={content.language} code={content.text} />
        </div>
      )
    } else if (content.kind === 'text') {
      body = <pre className="preview__body">{content.text}</pre>
    } else {
      body = (
        <div className="preview__info">
          <span className="preview__info-hint">{content.hint}</span>
          <div className="preview__info-actions">
            <button className="btn" onClick={() => transferFile('save')}>
              <IconDownload size={14} />
              下载
            </button>
            <button className="btn" onClick={() => transferFile('share')}>
              <IconShare size={14} />
              分享
            </button>
            <button className="btn" onClick={openExternal}>
              用系统默认程序打开
            </button>
            <button className="btn" onClick={reveal}>
              <IconFolder size={14} />
              在文件管理器中显示
            </button>
          </div>
        </div>
      )
    }
  }

  const truncatedTag =
    content !== null && 'truncated' in content && content.truncated ? (
      <span className="preview__tag">已截断</span>
    ) : null

  return (
    <div className="preview-overlay" onClick={close}>
      <div className="preview" onClick={(e) => e.stopPropagation()}>
        <div className="preview__head">
          <strong title={path}>{path}</strong>
          {truncatedTag}
          <button
            className="filecard__action"
            title="用系统默认程序打开（Office/PDF/媒体等交给外部应用）"
            onClick={openExternal}
          >
            默认程序打开
          </button>
          <button
            className="filecard__action"
            title="下载这个文件（可选择保存位置）"
            onClick={() => transferFile('save')}
          >
            <IconDownload size={13} />
            下载
          </button>
          <button
            className="filecard__action"
            title="分享这个文件（系统分享面板，可发到微信）"
            onClick={() => transferFile('share')}
          >
            <IconShare size={13} />
            分享
          </button>
          <button className="filecard__action" title="在文件管理器中定位" onClick={reveal}>
            显示位置
          </button>
          <button className="icon-btn" title="关闭（Esc）" onClick={close}>
            <IconClose size={15} />
          </button>
        </div>
        <div className="preview__content">{body}</div>
      </div>
    </div>
  )
}
