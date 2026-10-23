// 附件预览条（纯展示）。
//
// 为什么单独抽一个文件：这条带子的三种解析状态（解析中... / 解析失败 / 已就绪）与
// 「解析中不显示删除钮」「失败整卡淡红底」是本次对齐原版的核心口径，而它们全都只取决于
// props —— 抽成纯展示层后就能像 TableOcrPanel 那样在无头环境里逐态渲染断言
// （Composer 本身要读 store、订阅 IPC 事件，SSR 里拿不到这些）。
//
// 对应原版 ChatPage.ets:958-1042 的预览条卡片渲染。
import type { PickedAttachmentDto } from '@ipc/contract'
import { IconClose, IconFile } from '../icons'

export interface AttachmentBarProps {
  attachments: PickedAttachmentDto[]
  onRemove(path: string): void
}

/** 文件大小（原版预览条同款的人类可读量级） */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 状态文案（逐字对齐原版 parseOneFile 的三种状态） */
function statusText(status: PickedAttachmentDto['status']): string {
  if (status === 'parsing') {
    return '解析中...'
  }
  return status === 'error' ? '解析失败' : '已就绪'
}

export function AttachmentBar({ attachments, onRemove }: AttachmentBarProps) {
  if (attachments.length === 0) {
    return null
  }
  return (
    <div className="composer__attachments">
      {attachments.map((att) => {
        // 失败原因挂 tooltip：卡片只有一行，红底只说明「坏了」，
        // 具体是接口没配还是超时，必须让用户能查得到。
        const tip: string =
          att.status === 'error' && att.error !== undefined && att.error !== ''
            ? `${att.path}\n${att.error}`
            : att.path
        return (
          <span
            className={`attachment attachment--${att.status}`}
            key={att.path}
            data-status={att.status}
            title={tip}
          >
            {att.thumbnail !== '' ? (
              <img className="attachment__img" src={att.thumbnail} alt={att.name} />
            ) : (
              <>
                <span className="attachment__tag">
                  <IconFile size={12} />
                </span>
                <span className="attachment__name">{att.name}</span>
              </>
            )}
            <span className="attachment__size">{formatAttachmentSize(att.size)}</span>
            <span className="attachment__status">{statusText(att.status)}</span>
            {/* 解析中不给删除钮（原版如此）：此时文件正在主进程后台解析，
                删掉卡片只会让这次解析的结果无处落地，用户也会以为「没解析」。
                等它落到已就绪/解析失败，再决定留还是删。 */}
            {att.status === 'parsing' ? null : (
              <button
                className="attachment__del"
                title="移除这个附件"
                onClick={() => onRemove(att.path)}
              >
                <IconClose size={12} />
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}
