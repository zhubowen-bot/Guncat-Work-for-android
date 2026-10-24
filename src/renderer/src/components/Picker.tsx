import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconChevronDown } from '../icons'

export interface PickerOption {
  value: string
  label: string
  hint?: string
}

interface Props {
  value: string
  options: PickerOption[]
  onChange(value: string): void
  disabled?: boolean
  title?: string
  ariaLabel?: string
  /** 触发按钮的 class（复用现有 chip / field / topbar 样式） */
  triggerClassName?: string
  /** 触发按钮前的文字，如「推理」 */
  prefix?: string
  /** field：设置页的整行输入框；plain：顶栏胶囊；chip：输入框上方胶囊 */
  variant?: 'field' | 'plain' | 'chip'
  /** 弹层标题，默认用 ariaLabel/title */
  sheetTitle?: string
}

/**
 * 移动端友好的选择器：原生 <select> 在 Android WebView 里会弹一个巨大的系统列表，
 * 样式完全不可控；这里改成「按钮 + 底部弹层」，桌面端自动收成中间浮层。
 */
export function Picker(props: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const selected = useMemo(
    () => props.options.find((option) => option.value === props.value),
    [props.options, props.value]
  )
  const sheetTitle = props.sheetTitle ?? props.ariaLabel ?? props.title ?? '请选择'

  useEffect(() => {
    if (!open) {
      return
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  function pick(value: string): void {
    setOpen(false)
    if (value !== props.value) {
      props.onChange(value)
    }
  }

  return (
    <div className={`picker picker--${props.variant ?? 'plain'}`}>
      <button
        type="button"
        className={`picker__trigger${props.triggerClassName !== undefined ? ' ' + props.triggerClassName : ''}`}
        disabled={props.disabled}
        title={props.title}
        aria-label={props.ariaLabel ?? props.title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {props.prefix !== undefined ? <span className="picker__prefix">{props.prefix}</span> : null}
        <span className="picker__value">{selected?.label ?? props.value}</span>
        <IconChevronDown size={14} className="picker__chevron" />
      </button>

      {open
        ? createPortal(
            <div className="picker__overlay" onClick={() => setOpen(false)}>
              <div
                className="picker__sheet"
                role="listbox"
                aria-label={sheetTitle}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="picker__sheet-head">
                  <strong>{sheetTitle}</strong>
                  <button type="button" className="picker__close" onClick={() => setOpen(false)}>
                    关闭
                  </button>
                </div>
                {props.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={option.value === props.value}
                    className="picker__option"
                    title={option.hint}
                    onClick={() => pick(option.value)}
                  >
                    <span className="picker__option-text">
                      <span className="picker__option-label">{option.label}</span>
                      {option.hint !== undefined ? (
                        <span className="picker__option-hint">{option.hint}</span>
                      ) : null}
                    </span>
                    {option.value === props.value ? <IconCheck size={16} /> : null}
                  </button>
                ))}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
