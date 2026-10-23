// ImageLightbox: 点图片看大图（逐字对齐原版 views/ImageLightbox.ets）
//
// 原版是一个全屏黑色遮罩 + Contain 大图 + 右上角关闭钮，由 ChatPage 实例化、
// ChatBubbleView 的 onImageTap 打开。桌面端此前**整条链路都不存在**：
// 全仓 grep lightbox 零命中，消息里的图片是不可点的缩略图
// （工作区预览弹层只渲染文本 `pre`，看不了图）。
//
// 放在最外层（App）渲染：消息气泡、Markdown 正文、附件卡片都会用到它，
// 状态放在 store 里，避免层层传回调。
import { useEffect } from 'react'
import { useStore } from '../store'
import { IconClose } from '../icons'

export function ImageLightbox() {
  const url = useStore((s) => s.lightboxUrl)
  const openLightbox = useStore((s) => s.openLightbox)

  // Esc 关闭：桌面上这是最自然的方式（原版是触摸端的点按关闭）
  useEffect(() => {
    if (url === '') {
      return
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        openLightbox('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [url, openLightbox])

  return <LightboxView url={url} onClose={() => openLightbox('')} />
}

/** 纯展示层：url 为空时不渲染。抽出来是为了让渲染验证能直接断言它的结构。 */
export function LightboxView({ url, onClose }: { url: string; onClose(): void }) {
  if (url === '') {
    return null
  }
  return (
    <div className="lightbox" onClick={onClose}>
      <img className="lightbox__img" src={url} alt="" onClick={(e) => e.stopPropagation()} />
      <button
        className="lightbox__close"
        title="关闭（Esc）"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        <IconClose size={20} />
      </button>
    </div>
  )
}
