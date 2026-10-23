// 智能体标识 —— 逐条对齐鸿蒙原版 DswSidebar.buildAgentItem / AgentDrawerView 的三条分支：
//
//   · 虚拟引擎（work / interactive）→ 原版 entry/src/main/resources/base/media/ic_work.svg、
//     ic_interactive.svg 的形态图标；
//   · 真实智能体 → agents.json 的 `icon`（原版 rawfile/icons/*.png 原图，1024² PNG 十张，
//     已随包在 resources/icons 下，经 app:// 的 /res/ 根暴露，见 src/main/protocol.ts）；
//   · 两者都取不到 → 名字首字兜底（头像不该成为界面起不来的原因）。
//
// 应用自身的图标是原版的 app.media.cat_avatar —— AppScope/resources/base/media/layered_image.json
// 里 background 与 foreground **都**指向 cat_avatar.png，所以它就是真正的应用图标。
// 这里统一走 APP_ICON_SRC，而不是再自绘一个「大猫」：自绘的那只既不是原版形态，
// 也无法表达品牌色渐变与细节，是最容易被一眼看穿「不对齐」的地方。
import { useState } from 'react'
import type { AgentDto } from '@ipc/contract'
import { IconInteractive, IconWork, type IconProps } from '../icons'
import { INTERACTIVE_AGENT_ID, WORK_AGENT_ID } from '../conversations'

/** 随包资源在 app:// 下的根前缀（Android 构建注入 ./resources/） */
export const RESOURCE_BASE =
  typeof __GUNCAT_RESOURCE_BASE__ !== 'undefined' ? __GUNCAT_RESOURCE_BASE__ : 'app://guncat/res/'

/** 应用图标（= 原版 app.media.cat_avatar） */
export const APP_ICON_SRC = `${RESOURCE_BASE}cat_avatar.png`

/** 虚拟引擎 id → 原版形态图标 */
const VIRTUAL_ICON: Record<string, (props: IconProps) => React.ReactElement> = {
  [WORK_AGENT_ID]: IconWork,
  [INTERACTIVE_AGENT_ID]: IconInteractive
}

export interface AgentGlyphProps {
  /** 目标智能体；为空时退回应用图标 */
  agent?: AgentDto | null
  /** 边长（px），默认 20 */
  size?: number
  className?: string
  /** 圆角头像（真实智能体的 PNG 需要裁圆；形态图标不需要） */
  rounded?: boolean
  /** 按**墨迹占比**归一化视觉大小（空态大图标用；侧栏小图标不需要） */
  inkNormalize?: boolean
  title?: string
}

/**
 * 每个随包图标的「墨迹占比」= 非透明像素的包围盒边长 / 画布边长。
 *
 * 为什么需要它：各智能体的图标不是同一批素材 —— 有的是 1024×1024 满幅图（占比 1.0），
 * 有的是 96×96 且自带透明留白（轻简/效率 只有 0.80）。同一个盒子下看着就是「有的大有的小」，
 * 用户提了两轮。这里的数字是用 @napi-rs/canvas 逐像素量出来的（资源随包固定，不会漂），
 * 渲染时按 1/占比 放大，让**可见图形**一样大。新增图标量不到就默认 1.0。
 */
const ICON_INK: Record<string, number> = {
  'guncat-3.0-flash': 0.917,
  'guncat-3.0-mini': 0.802,
  'guncat-3.0-pro': 0.938,
  'guncat-3.1-flash': 0.802
}

/** 描边 SVG 图标的墨迹占比：24 的 viewBox 里图形大致占 20（工作/交互两枚都是这个量级） */
const VIRTUAL_ICON_INK = 0.83

/** 从 `icons/xxx.png` 这种路径里取图标名（去掉目录与扩展名） */
function iconKey(icon: string): string {
  const name = icon.slice(icon.lastIndexOf('/') + 1)
  return name.endsWith('.png') ? name.slice(0, -4) : name
}

/**
 * 渲染一个智能体标识。
 * 虚拟引擎是描边 SVG（跟随 currentColor，主题自适应）；真实智能体是原图圆形头像。
 */
export function AgentGlyph({
  agent,
  size = 20,
  className,
  rounded = true,
  inkNormalize = false,
  title
}: AgentGlyphProps): React.ReactElement {
  const [broken, setBroken] = useState(false)

  if (agent !== undefined && agent !== null) {
    const Virtual = VIRTUAL_ICON[agent.id]
    if (Virtual !== undefined) {
      // 描边图标自带 viewBox 留白：按占比放大，视觉上才与满幅头像一样大
      const glyphSize = inkNormalize ? Math.round(size / VIRTUAL_ICON_INK) : size
      return <Virtual size={glyphSize} className={className} />
    }
    if (agent.icon !== '' && !broken) {
      const ink = inkNormalize ? (ICON_INK[iconKey(agent.icon)] ?? 1) : 1
      return (
        <img
          className={className !== undefined ? className : rounded ? 'agent-avatar agent-avatar--img' : undefined}
          src={RESOURCE_BASE + agent.icon}
          alt=""
          title={title ?? agent.name}
          width={size}
          height={size}
          // **尺寸必须写进 style**，不能只靠 width/height 属性：
          // 默认类 `.agent-avatar` 里写着 `width:20px; height:20px`（侧栏那一档的尺寸），
          // 而 CSS 类的优先级高于 `<img width>` 这类表现属性 —— 于是空态里 48 的图标
          // 被死死压成 20（用户看到的「轻简/效率/专家的图标特别特别小」就是这个）。
          // transform 不参与布局：盒子仍是 size（排版统一），只有图形按墨迹占比放大。
          style={{
            width: size,
            height: size,
            ...(rounded ? { borderRadius: size / 2 } : {}),
            ...(ink < 1 ? { transform: `scale(${(1 / ink).toFixed(3)})` } : {})
          }}
          onError={() => setBroken(true)}
        />
      )
    }
    return (
      <span
        className={className !== undefined ? className : 'agent-avatar'}
        title={title ?? agent.name}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
      >
        {agent.name.slice(0, 1)}
      </span>
    )
  }

  return (
    <img
      className={className !== undefined ? className : 'agent-avatar agent-avatar--img'}
      src={APP_ICON_SRC}
      alt=""
      title={title ?? 'Guncat Work'}
      width={size}
      height={size}
      // 同 AgentGlyph：尺寸写进 style，否则会被 `.agent-avatar` 的 20px 覆盖
      style={{ width: size, height: size, ...(rounded ? { borderRadius: size / 2 } : {}) }}
    />
  )
}
