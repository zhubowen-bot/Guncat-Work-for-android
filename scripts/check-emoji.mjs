// 渲染层「禁用字符」扫描：确认 src/renderer 下不再出现 emoji 与当作图标用的符号。
//
// 为什么需要一个独立脚本而不是 grep：
//   emoji 与各种符号散落在 Unicode 的多个区段（Misc Symbols / Dingbats / 补充平面），
//   单条正则很难覆盖全，而且还要排除「中文标点、省略号、全角括号」这类正常文案。
//   这里用区段白名单 + 显式允许字符来表达「什么算违规」，规则可读、可复核。
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2] ?? 'src/renderer'

/** 明确允许的非 ASCII 符号：中文文案里本来就会用到的标点 */
const ALLOWED = new Set([
  '，', '。', '、', '；', '：', '？', '！', '（', '）', '「', '」', '《', '》', '…',
  '·', '—', '－', '／', '×', '℃', '％', '　'
])

/** 违规区段：emoji、装饰符号、箭头、几何图形、制表符式方块、带圈数字等 */
const RANGES = [
  [0x2190, 0x21ff], // 箭头
  [0x2300, 0x23ff], // 技术符号（⌘ ⏺ ⏸ …）
  [0x2460, 0x24ff], // 带圈数字/字母
  [0x25a0, 0x25ff], // 几何图形（▶ ◉ ○ ■ ▲ ▼）
  [0x2600, 0x27bf], // 杂项符号 + 装饰符号（★ ♥ ✓ ✕ ⚙ ⤓ ⓘ ⚠ ✎ ↻ ✦ ⇅ ⛃）
  [0x2b00, 0x2bff], // 杂项箭头与符号（⤴ ⤓ ⬤）
  [0xfe0f, 0xfe0f], // 变体选择符
  [0x1f000, 0x1faff], // emoji 主体
  [0x1f900, 0x1f9ff]
]

function isViolation(ch) {
  if (ALLOWED.has(ch)) {
    return false
  }
  const cp = ch.codePointAt(0)
  if (cp <= 0x7f) {
    return false
  }
  // 中日韩文字、全角标点（U+3000–U+303F 的中文标点除外）不算违规
  if (cp >= 0x4e00 && cp <= 0x9fff) {
    return false
  }
  if (cp >= 0xff01 && cp <= 0xff5e) {
    return false
  }
  for (const [lo, hi] of RANGES) {
    if (cp >= lo && cp <= hi) {
      return true
    }
  }
  return false
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') {
        continue
      }
      walk(full, out)
    } else if (/\.(ts|tsx|css|html)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const hits = []
const commentOnlyHits = []
for (const file of walk(root)) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    // 注释里的「→」是中文说明的行文箭头（不是渲染出来的图标），单独统计、不算违规
    const isComment = /^(\/\/|\*|\/\*)/.test(trimmed)
    for (const ch of line) {
      if (!isViolation(ch)) {
        continue
      }
      const entry = `${file}:${i + 1}: ${ch} (U+${ch.codePointAt(0).toString(16).toUpperCase()}) — ${trimmed}`
      if (isComment && ch === '→') {
        commentOnlyHits.push(entry)
      } else {
        hits.push(entry)
      }
      break
    }
  })
}

if (commentOnlyHits.length > 0) {
  console.log(`注释中的行文箭头 ${commentOnlyHits.length} 处（不参与渲染，允许保留，逐条列出以便复核）：`)
  for (const h of commentOnlyHits) {
    console.log(`  ${h}`)
  }
  console.log('')
}

if (hits.length === 0) {
  console.log(`无 emoji / 图标字符：${root} 下所有 .ts/.tsx/.css/.html 均通过`)
} else {
  console.log(`发现 ${hits.length} 处可疑字符：`)
  for (const h of hits) {
    console.log(`  ${h}`)
  }
  process.exitCode = 1
}
