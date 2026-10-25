// 新建会话页的模式胶囊（交互模式 / 工作模式快速切换）：
//   只在空态出现，不占顶栏、不挤输入区；当前档位是白底浮起的一段。
// 切换走 store.setMode（与侧栏「交互 / 工作」同一入口），保留它的两道守卫：
// 已在目标形态不动作、执行中提示并拒绝。
import type { AgentMode } from '@ipc/contract'
import { useStore } from '../store'

const OPTIONS: { mode: Extract<AgentMode, 'interactive' | 'work'>; label: string }[] = [
  { mode: 'interactive', label: '交互模式' },
  { mode: 'work', label: '工作模式' }
]

export function ModeSwitch() {
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)

  // 聊天模式没有这两个形态，胶囊不出现
  if (mode === 'chat') {
    return null
  }

  return (
    <div className="mode-switch" role="tablist" aria-label="切换交互模式或工作模式">
      {OPTIONS.map((option) => {
        const active = mode === option.mode
        return (
          <button
            key={option.mode}
            type="button"
            role="tab"
            className="mode-switch__item"
            data-active={active}
            aria-selected={active}
            title={active ? `当前为${option.label}` : `切到${option.label}`}
            onClick={() => setMode(option.mode)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
