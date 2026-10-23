import { useEffect } from 'react'

/** 让 textarea 随内容自适应高度（上限由 CSS 的 max-height 控制） */
export function useAutoResize(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string
): void {
  useEffect(() => {
    const element = ref.current
    if (element === null) {
      return
    }
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [ref, value])
}
