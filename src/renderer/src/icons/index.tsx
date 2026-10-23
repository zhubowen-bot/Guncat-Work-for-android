// 统一 SVG 图标集。
//
// 为什么自己画而不用图标库：
//   1. 鸿蒙原版用的是系统符号（sys.symbol）与少量自绘 SVG，桌面端没有那套符号；
//      引第三方图标库会让「原版观感」这件事不可控，也会多一个构建依赖。
//   2. 界面里原本用 emoji / Unicode 符号当图标（喇叭、麦克风、下载、星形、齿轮、叉号…），
//      它们在不同机器上被字体决定长相 —— 是最不稳定的一类「图标」。
//
// 统一规格（新增图标必须遵守）：
//   viewBox="0 0 24 24"、fill="none"、stroke="currentColor"、stroke-width 1.6、
//   stroke-linecap/linejoin = round，尺寸由 width/height 显式给出（默认 18）。
// 颜色一律走 currentColor，直接继承按钮/文字颜色，因此主题切换不需要额外处理。
//
// 其中 work / interactive / file / folder 四个的形状取自鸿蒙原版的
// entry/src/main/resources/base/media/ic_work.svg、ic_interactive.svg、
// ic_file.svg、ic_folder.svg —— 原版是实心路径，这里按统一规格重画成描边版，
// 保证与其它图标同一笔画语言，同时保留原版的可辨识轮廓。
import type { CSSProperties, ReactNode } from 'react'

export interface IconProps {
  /** 边长（px），默认 18 */
  size?: number
  className?: string
  style?: CSSProperties
  /** 覆盖线宽，默认 1.6 */
  strokeWidth?: number
}

interface SvgProps extends IconProps {
  children: ReactNode
  /** 允许个别图标改用自绘 viewBox（如原版 ic_work 的裁剪画布） */
  viewBox?: string
}

function Svg({ size = 18, className, style, strokeWidth = 1.6, viewBox = '0 0 24 24', children }: SvgProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={viewBox}
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

// ===== 形态 / 智能体标识 =====

/** 工作模式：取自原版 ic_work.svg 的机器人轮廓 */
export function IconWork(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="3.3" r="1.4" />
      <path d="M12 4.7v1.6" />
      <rect x="5" y="6.3" width="14" height="12.7" rx="3" />
      <path d="M2.4 10.6h1.2v3.8H2.4a.8.8 0 0 1-.8-.8v-2.2a.8.8 0 0 1 .8-.8Z" />
      <path d="M21.6 10.6h-1.2v3.8h1.2a.8.8 0 0 0 .8-.8v-2.2a.8.8 0 0 0-.8-.8Z" />
      <circle cx="9.2" cy="12" r="1.4" />
      <circle cx="14.8" cy="12" r="1.4" />
      <path d="M9.9 15.6h4.2" />
    </Svg>
  )
}

/** 交互模式：取自原版 ic_interactive.svg 的「带星火的画框」 */
export function IconInteractive(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.6" y="4.2" width="16.8" height="15.6" rx="3" />
      <path d="M8.9 8.6 9.9 11l2.4 1-2.4 1-1 2.4-1-2.4L5.5 12l2.4-1 1-2.4Z" />
      <circle cx="15.6" cy="10.4" r="1.05" />
      <circle cx="15.6" cy="14.1" r="1.05" />
    </Svg>
  )
}

/** 聊天模式：对话气泡 */
export function IconChat(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 5.4h14a1.6 1.6 0 0 1 1.6 1.6v8a1.6 1.6 0 0 1-1.6 1.6h-7.1L7.3 20v-3.4H5A1.6 1.6 0 0 1 3.4 15V7A1.6 1.6 0 0 1 5 5.4Z" />
      <path d="M8 10h8M8 13h4.5" />
    </Svg>
  )
}

// 注意：这里**没有**「品牌大猫」图标，也不应该有。
// 应用标识（侧栏品牌行、聊天助手头像、空态封面）一律用原版 app.media.cat_avatar 的原图，
// 经 app:// 的 /res/ 提供，统一入口是 components/AgentGlyph 的 APP_ICON_SRC。
// 早先版本在这里自绘了一只描边猫当品牌标识，既不是原版形态也丢了原图细节，
// 是用户一眼就看出来的「不对齐」—— 不再提供这种替代品。

// ===== 朗读 / 语音 =====

/** 朗读 / 播放 */
export function IconSpeaker(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M11 5.2 6.6 8.6H3.6v6.8h3L11 18.8V5.2Z" />
      <path d="M15 9.6a3.6 3.6 0 0 1 0 4.8" />
      <path d="M17.8 7a7.2 7.2 0 0 1 0 10" />
    </Svg>
  )
}

/** 麦克风 */
export function IconMic(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.6a2.9 2.9 0 0 1 2.9 2.9v5.2a2.9 2.9 0 0 1-5.8 0V6.5A2.9 2.9 0 0 1 12 3.6Z" />
      <path d="M6.1 11.4a5.9 5.9 0 0 0 11.8 0" />
      <path d="M12 17.3v3.1M9.2 20.4h5.6" />
    </Svg>
  )
}

/** 停止（方块） */
export function IconStop(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="7" y="7" width="10" height="10" rx="2.2" />
    </Svg>
  )
}

/** 停止生成（圆圈内方块，输入区的「停止」） */
export function IconStopCircle(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <rect x="9.4" y="9.4" width="5.2" height="5.2" rx="1.3" />
    </Svg>
  )
}

/** 播放（朗读条） */
export function IconPlay(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8.6 5.4 18.4 12l-9.8 6.6V5.4Z" />
    </Svg>
  )
}

/** 暂停 */
export function IconPause(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.2 5.2v13.6M14.8 5.2v13.6" />
    </Svg>
  )
}

// ===== 操作 =====

/** 发送（纸飞机，对应原版 sys.symbol.paperplane） */
export function IconSend(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.2 11.6 20 4l-7.1 16-1.9-6.5L4.2 11.6Z" />
      <path d="m11 13.5 9-9.5" />
    </Svg>
  )
}

/** 导出 / 下载（对应原版 sys.symbol.arrow_down_to_line） */
export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.8v11.4" />
      <path d="m7.6 10.8 4.4 4.4 4.4-4.4" />
      <path d="M4.4 20.2h15.2" />
    </Svg>
  )
}

/** 新建（加号） */
export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5.2v13.6M5.2 12h13.6" />
    </Svg>
  )
}

/** 完成（圆内对勾，对应原版 sys.symbol.checkmark_circle_fill） */
export function IconCheckCircle(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.4l2.6 2.6L16 9.6" />
    </Svg>
  )
}

/** 未完成（空心圆，对应原版 sys.symbol.circle） */
export function IconCircle(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
    </Svg>
  )
}

/** 插话（在既有流程里加一条旁注/补充说明） */
export function IconSteer(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6.5h9M4 12h16M4 17.5h9" />
      <path d="M16.5 5.5l3 2.5-3 2.5" />
    </Svg>
  )
}

/** 附件（回形针，对应原版 MessageInputView 的附件入口） */
export function IconPaperclip(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17.6 10.4 11 17a3.4 3.4 0 0 1-4.8-4.8l7.4-7.4a2.4 2.4 0 0 1 3.4 3.4l-7.2 7.2a1.4 1.4 0 0 1-2-2l6.6-6.6" />
    </Svg>
  )
}

/** 关闭（叉） */
export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8" />
    </Svg>
  )
}

/** 删除（垃圾桶，对应原版 sys.symbol.trash） */
export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.4 6.9h15.2" />
      <path d="M9.6 6.9V5.4a1.2 1.2 0 0 1 1.2-1.2h2.4a1.2 1.2 0 0 1 1.2 1.2v1.5" />
      <path d="M6.4 6.9l.8 11.3a1.6 1.6 0 0 0 1.6 1.5h6.4a1.6 1.6 0 0 0 1.6-1.5l.8-11.3" />
      <path d="M10.4 10.6v5.6M13.6 10.6v5.6" />
    </Svg>
  )
}

/** 设置（齿轮，对应原版 sys.symbol.gearshape） */
export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="2.7" />
      <path d="M19.1 14.6a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a1.9 1.9 0 1 1-3.8 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0-1.1-2.7h-.3a1.9 1.9 0 1 1 0-3.8h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1A1.6 1.6 0 0 0 9.4 4.6V4.3a1.9 1.9 0 1 1 3.8 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a1.9 1.9 0 1 1 0 3.8h-.2a1.6 1.6 0 0 0-1.4.9Z" />
    </Svg>
  )
}

/** 工作区（文件夹，取自原版 ic_folder 轮廓） */
export function IconFolder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.4 7.4a2 2 0 0 1 2-2h3.2l1.7 2.3h8.3a2 2 0 0 1 2 2v7.9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.4Z" />
    </Svg>
  )
}

/** 文件（取自原版 ic_file 轮廓） */
export function IconFile(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.6 3.4H8.2a2 2 0 0 0-2 2v13.2a2 2 0 0 0 2 2h7.6a2 2 0 0 0 2-2V7.4l-4.2-4Z" />
      <path d="M13.6 3.4v4h4.2" />
      <path d="M9.4 12h5.2M9.4 15.2h3.4" />
    </Svg>
  )
}

// ===== 工作区文件行按扩展名分类的图标（原版 WorkspaceFileIcons.iconFor） =====

/** 图片（原版 sys.symbol.picture） */
export function IconImage(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.6" y="5" width="16.8" height="14" rx="2.2" />
      <circle cx="9" cy="10.2" r="1.5" />
      <path d="m4.4 17.4 4.6-4.6 3.4 3.4 2.6-2.6 4.4 4.4" />
    </Svg>
  )
}

/** 拍照（手机输入区的相机入口） */
export function IconCamera(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.2 8.2h3l1.2-1.8h7.2l1.2 1.8h3a1.6 1.6 0 0 1 1.6 1.6v8a1.6 1.6 0 0 1-1.6 1.6H4.2a1.6 1.6 0 0 1-1.6-1.6v-8a1.6 1.6 0 0 1 1.6-1.6Z" />
      <circle cx="12" cy="13.4" r="3.4" />
    </Svg>
  )
}

/** PDF（原版 sys.symbol.pdf_doc） */
export function IconPdf(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.6 3.4H8.2a2 2 0 0 0-2 2v13.2a2 2 0 0 0 2 2h7.6a2 2 0 0 0 2-2V7.4l-4.2-4Z" />
      <path d="M13.6 3.4v4h4.2" />
      <path d="M9.6 16.6v-3.4h.9a1 1 0 0 1 0 2h-.9" />
      <path d="M13.2 13.2h1a1.7 1.7 0 0 1 0 3.4h-1v-3.4Z" />
    </Svg>
  )
}

/** 压缩包（原版 sys.symbol.doc_zipper） */
export function IconZip(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.6 3.4H8.2a2 2 0 0 0-2 2v13.2a2 2 0 0 0 2 2h7.6a2 2 0 0 0 2-2V7.4l-4.2-4Z" />
      <path d="M13.6 3.4v4h4.2" />
      <path d="M11.4 11.6h1.2M11.4 13.6h1.2M11.4 15.6h1.2" />
    </Svg>
  )
}

/** 源码（原版 sys.symbol.code） */
export function IconCode(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9.2 8.4-4 3.6 4 3.6" />
      <path d="m14.8 8.4 4 3.6-4 3.6" />
    </Svg>
  )
}

/** 音频（原版 sys.symbol.waveform） */
export function IconAudio(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.4 10.4v3.2M8.2 7.4v9.2M12 5.2v13.6M15.8 8v8M19.6 10.4v3.2" />
    </Svg>
  )
}

/** 视频（原版 sys.symbol.movie） */
export function IconVideo(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.4" y="5.6" width="17.2" height="12.8" rx="2.2" />
      <path d="M8 5.6v12.8M16 5.6v12.8" />
      <path d="M3.4 9.4h4.6M3.4 14.6h4.6M16 9.4h4.6M16 14.6h4.6" />
    </Svg>
  )
}

/** 复制 */
export function IconCopy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="8.6" y="8.6" width="11.8" height="11.8" rx="1.8" />
      <path d="M15.6 6.2V5.6a1.8 1.8 0 0 0-1.8-1.8H5.4a1.8 1.8 0 0 0-1.8 1.8v8.4a1.8 1.8 0 0 0 1.8 1.8h.6" />
    </Svg>
  )
}

/** 重新生成（对应原版 sys.symbol.arrow_counterclockwise） */
export function IconRegenerate(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19.6 12a7.6 7.6 0 1 1-2.3-5.4" />
      <path d="M19.8 4.6v5h-5" />
    </Svg>
  )
}

/** 编辑（铅笔） */
export function IconEdit(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.4 19.6h4.1L19.9 8.2a2.2 2.2 0 0 0-3.1-3.1L4.4 16.5v3.1Z" />
      <path d="m14.9 6.9 3.2 3.2" />
    </Svg>
  )
}

/** 刷新 */
export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20.2 4.4v5h-5" />
    </Svg>
  )
}

/** 深度思考（大脑） */
export function IconBrain(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M11.2 5.2A3.1 3.1 0 0 0 6 7.1a2.9 2.9 0 0 0-1.2 4.7 3.1 3.1 0 0 0 2 5.3 2.9 2.9 0 0 0 4.4 1.9V5.2Z" />
      <path d="M12.8 5.2A3.1 3.1 0 0 1 18 7.1a2.9 2.9 0 0 1 1.2 4.7 3.1 3.1 0 0 1-2 5.3 2.9 2.9 0 0 1-4.4 1.9V5.2Z" />
      <path d="M12 5.2v13.8" />
    </Svg>
  )
}

/** 联网搜索（地球） */
export function IconGlobe(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M3.6 12h16.8" />
      <path d="M12 3.6c2.5 2.6 2.5 14.2 0 16.8M12 3.6c-2.5 2.6-2.5 14.2 0 16.8" />
    </Svg>
  )
}

/** 侧栏折叠 / 展开（对应原版 chevron_left / chevron_right 的栏位按钮） */
export function IconSidebar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.4" />
      <path d="M9.4 4.4v15.2" />
    </Svg>
  )
}

/** 更多：手机顶栏右侧的横向三点 */
export function IconMore(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </Svg>
  )
}

// ===== 方向 / 展开折叠 =====

export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6.6 9.4 5.4 5.4 5.4-5.4" />
    </Svg>
  )
}

export function IconChevronUp(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6.6 14.6 5.4-5.4 5.4 5.4" />
    </Svg>
  )
}

export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9.4 6.6 5.4 5.4-5.4 5.4" />
    </Svg>
  )
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m14.6 6.6-5.4 5.4 5.4 5.4" />
    </Svg>
  )
}

export function IconArrowRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.6 12h14.2M13.6 6.8 18.8 12l-5.2 5.2" />
    </Svg>
  )
}

export function IconArrowLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19.4 12H5.2M10.4 6.8 5.2 12l5.2 5.2" />
    </Svg>
  )
}

export function IconArrowUp(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 19.4V5.2M6.8 10.4 12 5.2l5.2 5.2" />
    </Svg>
  )
}

export function IconArrowDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.6v14.2M6.8 13.6 12 18.8l5.2-5.2" />
    </Svg>
  )
}

export function IconTrendUp(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4.6 15.4 5.2-5.2 3.2 3.2 6.4-6.4" />
      <path d="M14.6 6.9h4.8v4.8" />
    </Svg>
  )
}

export function IconTrendDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4.6 8.6 5.2 5.2 3.2-3.2 6.4 6.4" />
      <path d="M14.6 17.1h4.8v-4.8" />
    </Svg>
  )
}

export function IconMinus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.2 12h13.6" />
    </Svg>
  )
}

// ===== 状态 / 通用 =====

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5.4 12.6 4.4 4.4 8.8-9.6" />
    </Svg>
  )
}

export function IconInfo(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 10.8v5.4" />
      <path d="M12 7.9h.01" />
    </Svg>
  )
}

export function IconWarning(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.2 20.6 19.4H3.4L12 4.2Z" />
      <path d="M12 9.8v4.4M12 17h.01" />
    </Svg>
  )
}

export function IconError(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
    </Svg>
  )
}

export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10.8" cy="10.8" r="6.4" />
      <path d="m15.6 15.6 4.2 4.2" />
    </Svg>
  )
}

export function IconChart(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.4 19.6V14M10.2 19.6V6.4M16 19.6v-8" />
      <path d="M20.6 19.6H3.4" />
    </Svg>
  )
}

export function IconTable(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.6" y="5.4" width="16.8" height="13.2" rx="2" />
      <path d="M3.6 10h16.8M9.6 10v8.6M15 10v8.6" />
    </Svg>
  )
}

export function IconList(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.4 6.6h10.2M9.4 12h10.2M9.4 17.4h10.2" />
      <path d="M5 6.6h.01M5 12h.01M5 17.4h.01" />
    </Svg>
  )
}

export function IconStar(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 4 2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.7-5 2.7 1-5.6-4.1-4 5.6-.8L12 4Z" />
    </Svg>
  )
}

export function IconHeart(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 19.6S4.2 15 4.2 9.7A4.1 4.1 0 0 1 12 7.4a4.1 4.1 0 0 1 7.8 2.3c0 5.3-7.8 9.9-7.8 9.9Z" />
    </Svg>
  )
}

export function IconShare(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 15.4V4.2" />
      <path d="m8.2 8 3.8-3.8L15.8 8" />
      <path d="M6 13.4v5.2a1.8 1.8 0 0 0 1.8 1.8h8.4a1.8 1.8 0 0 0 1.8-1.8v-5.2" />
    </Svg>
  )
}

export function IconClock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3.2 2" />
    </Svg>
  )
}

export function IconCalendar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.8" y="5.4" width="16.4" height="14.2" rx="2" />
      <path d="M3.8 10h16.4M8.4 3.6v3.4M15.6 3.6v3.4" />
    </Svg>
  )
}

export function IconUser(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8.6" r="3.6" />
      <path d="M5.2 20a6.8 6.8 0 0 1 13.6 0" />
    </Svg>
  )
}

export function IconHome(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.2 10.4 12 4l7.8 6.4v8.2a1.8 1.8 0 0 1-1.8 1.8H6a1.8 1.8 0 0 1-1.8-1.8v-8.2Z" />
      <path d="M9.8 20.4v-6h4.4v6" />
    </Svg>
  )
}

export function IconFilter(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.2 5.6h15.6l-6.2 7.4v5.4l-3.2 1.8v-7.2L4.2 5.6Z" />
    </Svg>
  )
}

export function IconSort(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8.2 5.6v12.8M5 15.2l3.2 3.2 3.2-3.2" />
      <path d="M15.8 18.4V5.6M12.6 8.8 15.8 5.6l3.2 3.2" />
    </Svg>
  )
}

/** 状态圆点（工具运行中、面板实时标记等） */
export function IconDot(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
    </Svg>
  )
}
