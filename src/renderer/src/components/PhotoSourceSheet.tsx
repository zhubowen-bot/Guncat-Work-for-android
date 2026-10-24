import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import { IconCamera, IconImage } from '../icons'

interface Props {
  open: boolean
  onClose(): void
  onCamera(): void
  onGallery(): void
}

/** 拍照 / 从相册选择：两个入口都保留，避免「拍照」按钮只能进相册。 */
export function PhotoSourceSheet(props: Props): JSX.Element | null {
  if (!props.open) {
    return null
  }
  return createPortal(
    <div className="picker__overlay" onClick={props.onClose}>
      <div className="picker__sheet" role="dialog" aria-label="添加照片" onClick={(e) => e.stopPropagation()}>
        <div className="picker__sheet-head">
          <strong>添加照片</strong>
          <button type="button" className="picker__close" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <button
          type="button"
          className="picker__option"
          onClick={() => {
            props.onClose()
            props.onCamera()
          }}
        >
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
        <button
          type="button"
          className="picker__option"
          onClick={() => {
            props.onClose()
            props.onGallery()
          }}
        >
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
      </div>
    </div>,
    document.body
  )
}
