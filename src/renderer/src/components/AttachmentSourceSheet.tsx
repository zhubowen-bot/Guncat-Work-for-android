import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import { IconCamera, IconFile, IconImage } from '../icons'

interface Props {
  open: boolean
  onClose(): void
  onCamera(): void
  onGallery(): void
  onFile(): void
}

/** 右下角加号：拍照 / 相册 / 文件，三个入口都保留。 */
export function AttachmentSourceSheet(props: Props): JSX.Element | null {
  if (!props.open) {
    return null
  }
  const pick = (action: () => void): void => {
    props.onClose()
    action()
  }
  return createPortal(
    <div className="picker__overlay" onClick={props.onClose}>
      <div className="picker__sheet" role="dialog" aria-label="添加内容" onClick={(e) => e.stopPropagation()}>
        <div className="picker__sheet-head">
          <strong>添加</strong>
          <button type="button" className="picker__close" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <button type="button" className="picker__option" onClick={() => pick(props.onCamera)}>
          <span className="photo-sheet__action">
            <span className="photo-sheet__icon">
              <IconCamera size={20} />
            </span>
            <span className="picker__option-text">
              <span className="picker__option-label">拍照</span>
              <span className="picker__option-hint">打开系统相机，拍完直接加入</span>
            </span>
          </span>
        </button>
        <button type="button" className="picker__option" onClick={() => pick(props.onGallery)}>
          <span className="photo-sheet__action">
            <span className="photo-sheet__icon">
              <IconImage size={20} />
            </span>
            <span className="picker__option-text">
              <span className="picker__option-label">从相册选择</span>
              <span className="picker__option-hint">选一张已有的图片</span>
            </span>
          </span>
        </button>
        <button type="button" className="picker__option" onClick={() => pick(props.onFile)}>
          <span className="photo-sheet__action">
            <span className="photo-sheet__icon">
              <IconFile size={20} />
            </span>
            <span className="picker__option-text">
              <span className="picker__option-label">文件</span>
              <span className="picker__option-hint">文档、表格、压缩包等</span>
            </span>
          </span>
        </button>
      </div>
    </div>,
    document.body
  )
}
