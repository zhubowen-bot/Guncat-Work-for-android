// 导出 / 分享弹层。
//
// 为什么需要它：此前「导出」点一下就直接往默认下载目录写文件，然后提示一句
// 「已导出」—— 没有确认环节、也选不了位置，用户根本不知道文件去了哪。
// 现在统一先弹这一层，把「要处置什么、能怎么处置」讲清楚：
//   · 保存到手机/电脑：撒手交给系统保存位置选择（可换目录、改文件名、可取消）
//   · 分享到微信：Android 直接指向微信；不可用时原生侧会退回系统分享面板
//   · 其他应用分享：系统分享面板
// 工作区打包、单个文件、一条回答的 Word 共用这一层。
import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import { useStore } from '../store'
import { IconDownload, IconShare, IconSend } from '../icons'

/** Android 宿主注入的原生桥在上面；桌面端没有，据此给不同的按钮文案 */
function isAndroid(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as unknown as { GuncatAndroid?: unknown }).GuncatAndroid !== undefined
  )
}

export function TransferSheet(): JSX.Element | null {
  const subject = useStore((s) => s.transferSubject)
  const close = useStore((s) => s.closeTransfer)
  const runTransfer = useStore((s) => s.runTransfer)

  if (subject === null) {
    return null
  }
  const android = isAndroid()

  const act = (action: 'save' | 'share', target?: 'system' | 'wechat'): void => {
    close()
    void runTransfer(subject, action, target)
  }

  const kindHint =
    subject.kind === 'workspace'
      ? '把本会话工作区里的全部文件打包成一个压缩包'
      : subject.kind === 'message'
        ? '把这条回答导出为 Word（公式会转成原生格式）'
        : '工作区里的这一个文件'

  return createPortal(
    <div className="picker__overlay" onClick={close}>
      <div
        className="picker__sheet transfer__sheet"
        role="dialog"
        aria-label={subject.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="picker__sheet-head">
          <strong>{subject.title}</strong>
          <button type="button" className="picker__close" onClick={close}>
            关闭
          </button>
        </div>

        <div className="transfer__meta">
          <span className="transfer__name" title={subject.name}>
            {subject.name}
          </span>
          <span className="transfer__hint">{kindHint}</span>
        </div>

        <button type="button" className="picker__option" onClick={() => act('save')}>
          <span className="photo-sheet__action">
            <span className="photo-sheet__icon">
              <IconDownload size={20} />
            </span>
            <span className="picker__option-text">
              <span className="picker__option-label">{android ? '保存到手机…' : '保存到电脑…'}</span>
              <span className="picker__option-hint">
                打开系统保存位置选择，自己决定放在哪（也可以取消）
              </span>
            </span>
          </span>
        </button>

        <button
          type="button"
          className="picker__option"
          onClick={() => act('share', 'wechat')}
        >
          <span className="photo-sheet__action">
            <span className="photo-sheet__icon">
              <IconShare size={20} />
            </span>
            <span className="picker__option-text">
              <span className="picker__option-label">分享到微信</span>
              <span className="picker__option-hint">
                {android
                  ? '直接打开微信发送；没有可用入口时退回系统分享面板'
                  : '在下载目录留一份副本并复制其路径，可直接粘贴或拖进微信'}
              </span>
            </span>
          </span>
        </button>

        <button type="button" className="picker__option" onClick={() => act('share', 'system')}>
          <span className="photo-sheet__action">
            <span className="photo-sheet__icon">
              <IconSend size={20} />
            </span>
            <span className="picker__option-text">
              <span className="picker__option-label">其他应用分享</span>
              <span className="picker__option-hint">
                {android ? '打开系统分享面板，选其他应用' : '留一份副本并复制路径，便于发送到任意应用'}
              </span>
            </span>
          </span>
        </button>
      </div>
    </div>,
    document.body
  )
}
