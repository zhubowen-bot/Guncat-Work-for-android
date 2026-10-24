import { useEffect } from 'react'

/**
 * 让 textarea 随内容自适应高度（上限由 CSS 的 max-height 控制）。
 *
 * 注意两个坑：
 *  - 空输入时不能量 `scrollHeight`：占位符在窄屏会换行，一量就把输入框顶成两行；
 *  - 运行中「插话/停止」按钮增减会改变输入框宽度，只依赖 value 的话高度不会回落，
 *    所以这里再盯一次宽度变化（视觉上按钮回到原位，输入框却还是两行）。
 */
export function useAutoResize(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string
): void {
  useEffect(() => {
    const element = ref.current
    if (element === null) {
      return
    }
    let lastWidth = element.clientWidth
    const apply = (): void => {
      if (value === '') {
        // 高度交给 CSS 的 .is-empty（桌面 44 / 手机 40），不让占位符参与测量
        element.style.height = ''
        element.classList.add('is-empty')
        return
      }
      element.classList.remove('is-empty')
      element.style.height = 'auto'
      element.style.height = `${element.scrollHeight}px`
    }
    apply()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      // 只认宽度：设置 height 本身也会触发回调，盯高度会自己打自己
      if (element.clientWidth === lastWidth) {
        return
      }
      lastWidth = element.clientWidth
      apply()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, value])
}
