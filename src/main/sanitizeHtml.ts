// 表格识别结果的白名单清洗。
//
// 为什么必须清洗：`TableOcrService.recognizeImage` 的返回值是**模型生成的 HTML**，
// 桌面端要把它渲染成表格（对齐原版 TableOcrPage 的预览）。直接 innerHTML 是不行的 ——
// 模型可能（被图片内容诱导）输出 `<img src=x onerror=...>` 这类载荷，
// 而 innerHTML 里的事件属性是会真正执行的。
//
// 因此这里按**白名单**重建：只保留表格结构与 colspan/rowspan，其余标签与属性一律丢弃；
// script/style 连内容一起去掉。模型输出本来就被提示词限定为 `<table>…</table>`，
// 白名单之外的任何东西都属于「不该出现在这里」，丢掉它不会损失正常结果。

const ALLOWED_TAGS: Set<string> = new Set([
  'table',
  'caption',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'br'
])

const ALLOWED_ATTRS: Set<string> = new Set(['colspan', 'rowspan'])

/** 自闭合且没有内容的标签（重建时要保留为 <br>） */
const VOID_TAGS: Set<string> = new Set(['br', 'col'])

/** 整块丢弃（连内容一起）的标签 */
const DROP_WITH_CONTENT: string[] = ['script', 'style', 'iframe', 'object', 'embed', 'template']

// colspan/rowspan 必须是纯数字，且给一个合理上限，避免用超大跨度把表格撑坏
const MAX_SPAN: number = 200

export function sanitizeTableHtml(html: string): string {
  let text: string = html
  for (const tag of DROP_WITH_CONTENT) {
    text = text.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'gi'), '')
    text = text.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), '')
  }
  // HTML 注释里也可能藏东西，一并去掉
  text = text.replace(/<!--[\s\S]*?-->/g, '')

  let out: string = ''
  const tagPattern: RegExp = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g
  let lastIndex: number = 0
  let match: RegExpExecArray | null = tagPattern.exec(text)
  while (match !== null) {
    // 标签之间的纯文本原样保留（单元格内文字），转义交给渲染层
    out += escapeText(text.slice(lastIndex, match.index))
    lastIndex = tagPattern.lastIndex

    const closing: boolean = match[1] === '/'
    const name: string = match[2].toLowerCase()
    if (ALLOWED_TAGS.has(name)) {
      const attrs: string = closing || VOID_TAGS.has(name) ? '' : keepAttrs(match[3])
      if (closing) {
        out += `</${name}>`
      } else if (VOID_TAGS.has(name)) {
        out += `<${name}${attrs}>`
      } else {
        out += `<${name}${attrs}>`
      }
    }
    // 白名单外的标签：只丢掉标签本身，保留其中文字（内容通常无害且有意义）
    match = tagPattern.exec(text)
  }
  out += escapeText(text.slice(lastIndex))
  return out.trim()
}

/** 只保留白名单属性，且值必须是纯数字 */
function keepAttrs(raw: string): string {
  let result: string = ''
  const attrPattern: RegExp = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g
  let attr: RegExpExecArray | null = attrPattern.exec(raw)
  while (attr !== null) {
    const name: string = attr[1].toLowerCase()
    if (ALLOWED_ATTRS.has(name)) {
      const value: string = attr[2].replace(/^["']|["']$/g, '')
      const span: number = Number.parseInt(value, 10)
      if (!Number.isNaN(span) && span > 1 && span <= MAX_SPAN) {
        result += ` ${name}="${String(span)}"`
      }
    }
    attr = attrPattern.exec(raw)
  }
  return result
}

function escapeText(text: string): string {
  return text.replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
