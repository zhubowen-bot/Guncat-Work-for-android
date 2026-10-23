// Markdown 渲染：CommonMark + GFM 表格/任务列表 + LaTeX 公式 + 代码高亮 + Mermaid。
// 鸿蒙原版用 @luvi/lv-markdown-in 原生组件，它的四项内建能力就是这四项；
// 桌面端用 react-markdown 撑解析，缺的三项分别补齐：
//   · LaTeX   → remark-math + rehype-katex，**并且必须引入 katex 的样式表**
//               （只引插件不引样式，公式会被渲染成一堆错位的裸 span，看起来就是「没渲染」）；
//   · 代码高亮 → components/CodeBlock（highlight.js，对齐原版 CodeHighlight 配色）；
//   · Mermaid  → components/CodeBlock 的 MermaidBlock（围栏语言为 mermaid 时画成图）。
//
// 脚注的两处默认文案被显式覆盖：
//   remark-rehype 的脚注回跳链接默认内容是一个箭头符号（U+21A9），它会真的渲染进界面 ——
//   与「界面里不出现符号当图标」的口径冲突，因此换成中文「返回」，脚注区标题写成「脚注」。
import { isValidElement, memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { sanitizeMarkdownForRender } from '@core/common/MarkdownSanitizer'
import { useStore } from '../store'
import { CodeBlock, MermaidBlock } from './CodeBlock'

interface Props {
  text: string
}

/** 透传给 remark-rehype 的脚注文案（不含任何符号） */
export const REHYPE_OPTIONS = {
  footnoteBackContent: '返回',
  footnoteBackLabel: '返回正文',
  footnoteLabel: '脚注'
} as const

/** 从 `language-xxx` 类名里取围栏语言标记 */
export function fenceLanguage(className: unknown): string {
  const match = /language-([^\s]+)/.exec(typeof className === 'string' ? className : '')
  return match === null ? '' : match[1]
}

/**
 * 链接与图片地址的放行规则。
 *
 * react-markdown 默认的 urlTransform 只放 http(s)/mailto 之类，会把 `data:` 整个剥掉 ——
 * 而桌面端的图片正是 data URL（附件直传、交互模式内嵌图、SVG 预览都是）。
 * 直接返回 url 又等于关掉防护（`javascript:` 会真的可点）。所以这里用白名单：
 *   · http / https / mailto / app:（自定义协议）
 *   · data:image/*（只放图片，`data:text/html` 这类不放）
 *   · 没有协议头的相对路径（工作区资源）
 * 其余一律返回空串，链接不可点、图片不渲染。
 */
export function safeUrlTransform(url: string): string {
  const trimmed = url.trim()
  if (trimmed === '') {
    return ''
  }
  if (/^(https?:|mailto:|app:|data:image\/)/i.test(trimmed)) {
    return trimmed
  }
  // 没有协议头 → 相对路径，放行
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return trimmed
  }
  return ''
}

const COMPONENTS: Components = {
  // react-markdown 把围栏/缩进代码块渲染成 <pre><code class="language-x">。
  // 「块级还是行内」只有在 pre 这一层才区分得出来（两者的 code 长一样），
  // 所以块级代码的接管放在 pre 上：解析出子 code 的语言与正文，交给 CodeBlock/MermaidBlock，
  // 并且**不再输出 pre 外壳** —— 否则会把块级组件压成单行。
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children
    if (isValidElement(child)) {
      const props = child.props as { className?: unknown; children?: React.ReactNode }
      const language = fenceLanguage(props.className)
      const code = String(props.children ?? '').replace(/\n$/, '')
      if (language.toLowerCase() === 'mermaid') {
        return <MermaidBlock code={code} />
      }
      return <CodeBlock language={language} code={code} />
    }
    return <pre>{children}</pre>
  },
  // 走到这里的只剩行内代码
  code({ node: _node, className, children, ...rest }) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    )
  },
  // 正文里的图片点击放大（原版 RichTextView 的 onImageTap → ChatPage 打开灯箱）。
  // 直接用 store 而不是层层传回调：正文渲染在气泡、产物卡、预览弹层里都可能出现，
  // 穿透 props 会把这条链路弄得很脆。
  img({ src, alt }) {
    const url = typeof src === 'string' ? src : ''
    if (url === '') {
      return null
    }
    return (
      <img
        className="msg__img"
        src={url}
        alt={alt ?? ''}
        title="点击查看大图"
        onClick={() => useStore.getState().openLightbox(url)}
      />
    )
  }
}

export const Markdown = memo(function Markdown({ text }: Props) {
  // 渲染前做表格结构规范化。
  //
  // `core/common/MarkdownSanitizer` 是原版为 @luvi/lv-markdown-in 的表格闪退写的防御
  // （表头全空、某行缺单元格这类退化表格会让库内部抛 TypeError 并闪退），
  // 桌面端用 react-markdown 不会闪退，但同一个模块**在端口里此前零调用点** ——
  // 而它做的事情对这里同样有意义：结构合法的表格被补齐到统一形态，
  // 修不了的退化表格降级成纯文本（内容不丢，不会被渲染成一张错位的表）。
  const prepared = sanitizeMarkdownForRender(text)
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      remarkRehypeOptions={REHYPE_OPTIONS}
      urlTransform={safeUrlTransform}
      components={COMPONENTS}
    >
      {prepared}
    </ReactMarkdown>
  )
})
