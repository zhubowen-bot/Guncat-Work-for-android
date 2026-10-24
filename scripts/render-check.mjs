// 交互模式渲染器的无头验证：用 react-dom/server 把界面程序渲染成 HTML 字符串，
// 断言关键组件确实出现在产物里。
//
// 为什么值得做：Electron GUI 在本机跑不起来，但「元素树 → React 组件树」这一段
// 完全可以在 Node 里跑通（SSR 不执行 useEffect，因此不依赖 ResizeObserver / window）。
// 这样阶段二最核心的渲染器就不会只停留在「类型检查通过」。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { root, alias } from './esbuild-aliases.mjs'

const dir = path.join(root, '.smoke')
fs.mkdirSync(dir, { recursive: true })
const outfile = path.join(dir, 'render.mjs')

await build({
  entryPoints: [path.join(root, 'scripts/render-entry.tsx')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: ['electron'],
  // react / react-dom / markdown 依赖链里有 CJS 内部 require，
  // 打进 ESM 会失败，交给 Node 自己解析更稳。
  packages: 'external',
  alias: {
    ...alias,
    '@renderer': path.join(root, 'src/renderer/src'),
    // katex 的样式表是「包内的 .css」：packages:'external' 会把它留给 Node，
    // 而 Node 不认识 .css。显式指到真实文件路径，它就会走下面的 empty loader。
    'katex/dist/katex.min.css': path.join(root, 'node_modules/katex/dist/katex.min.css')
  },
  // SSR 不需要样式：把 CSS 置空，避免 Node 解析 CSS
  loader: { '.css': 'empty' },
  logLevel: 'error'
})

const mod = await import(pathToFileURL(outfile).href)

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}${detail !== '' ? ' — ' + detail : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail !== '' ? ' — ' + detail : ''}`)
  }
}

/** 去掉标签并还原实体：用来断言「渲染产物里的可读文本」 */
function decode(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

console.log('\n14. 交互模式渲染器（React SSR）')
const html = mod.renderProgram()

check('渲染产出非空 HTML', html.length > 800, `${html.length} 字符`)
check('卡片外壳已渲染', html.includes('class="gui"'))
check('卡片标题正确', html.includes('季度销售复盘'))
check('副标题正确', html.includes('2024 Q3'))
check('$绑定表达式已求值', html.includes('金额 30 万'))
check('指标卡已渲染', html.includes('1,284'))
check('趋势方向已渲染', html.includes('gui-trend--up'))
check('滑块已渲染', html.includes('type="range"'))
check('滑块默认值正确', html.includes('value="30"'))
check('柱状图 SVG 已渲染', html.includes('<svg'))
check('柱状图图例已渲染', html.includes('本季') && html.includes('上季'))
check('表格已渲染', html.includes('<table') && html.includes('华东') && html.includes('820'))
check('选项卡已渲染', html.includes('概览') && html.includes('明细'))
check('折叠面板已渲染', html.includes('更多说明'))
check('步骤条已渲染', html.includes('立项') && html.includes('进行中'))
check('标签块已渲染', html.includes('标签甲'))
check('Callout 变体已渲染', html.includes('gui-callout--warn'))
check('代码块已渲染', html.includes('gui-code'))
check('饼图已渲染', html.includes('<path'))
check('键值清单已渲染', html.includes('合计'))
check('表单已渲染', html.includes('gui-form') && html.includes('口径'))
check('下拉框已渲染', html.includes('<select'))
check('按钮文案已渲染', html.includes('重算'))
check('界面块本身不吞正文（正文由外层渲染）', !html.includes('说明文字在前'))

// 裸程序（无围栏）也应可渲染；不可交互**只体现为控件禁用，不整块蒙灰**
const bareHtml = mod.renderBare()
check('裸程序（无围栏）可渲染', bareHtml.includes('季度销售复盘') && bareHtml.includes('class="gui"'))
check(
  '不可交互时不再整块蒙灰（去掉 gui--stale，用户报障）',
  !bareHtml.includes('gui--stale') && !bareHtml.includes('历史界面')
)
check('不可交互时控件仍然真的禁用', bareHtml.includes('disabled'))

// --- 工作模式 vs 交互模式的编排方式（用户报障：两者不该长一样） ---
// 工作模式 = 逐轮直接陈列（思考条 / 正文 / 工具行都在时间线上）；交互模式 = 回合收进一条活动折叠栏。
const workHtml = mod.renderWorkTurn(false)
const groupedHtml = mod.renderGroupedTurn(false)
check(
  '工作模式：每个助手轮都是直接陈列的块',
  workHtml.includes('work-round') && workHtml.split('work-round').length - 1 >= 2
)
check('工作模式：思考条在正文之前出现', workHtml.includes('thinking__head'))
check('工作模式：不把整回合收进单一活动折叠栏', !workHtml.includes('disclosure__title'))
check('交互模式：整回合收进一条活动折叠栏', groupedHtml.includes('disclosure__title'))

// --- 思考必须从第一个字开始就可见（跑马灯取末尾 400 字，压成单行） ---
check(
  '思考跑马灯：换行被压平',
  !/[\r\n\t]/.test(mod.marqueeText('第一行\n第二行\t第三行'))
)
check(
  '思考跑马灯：长文本取末尾 400 字（新内容始终可见）',
  mod.marqueeText('甲'.repeat(600) + '尾部锚点').endsWith('尾部锚点') &&
    mod.marqueeText('甲'.repeat(600)).length === 401
)

// MessageView 的组合方式：正文 Markdown + 界面块，两者都要在
const composedHtml = mod.renderComposed()
check(
  '正文与界面可共存（MessageView 组合方式）',
  composedHtml.includes('说明文字在前') && composedHtml.includes('季度销售复盘')
)

// --- 导出 Word 的文件名推导 ---
// 事故（用户实测）：最初直接拿正文前 20 个字符当文件名，而正文里几乎必然带换行 ——
// Windows 的保存对话框直接报「文件名无效」，导出功能等于不可用。
// 这类 bug 无法靠「看着像对的」发现，必须逐类非法字符断言。
const name = mod.docxFileName
check(
  '文件名：正文里的换行被折叠（这是本次事故的直接原因）',
  !/[\r\n]/.test(name('第一行\n第二行\n\n第三行')),
  name('第一行\n第二行')
)
check('文件名：制表符等空白也被折叠', !/\s{2,}/.test(name('甲\t乙  丙')), name('甲\t乙  丙'))
check('文件名：去掉 Windows 禁止的九个字符', !/[\\/:*?"<>|]/.test(name('a\\b/c:d*e?f"g<h>i|j')), name('a\\b/c:d*e?f"g<h>i|j'))
check('文件名：去掉控制字符', !/[\u0000-\u001f\u007f]/.test(name('甲\u0001乙\u007f丙')))
check(
  '文件名：不以点或空格结尾（Win32 会静默丢弃它们）',
  (() => {
    const n = name('结尾有点......   ')
    return !/\.docx$/.test(n) || n === '结尾有点.docx'
  })(),
  name('结尾有点......   ')
)
check('文件名：以 .docx 结尾', name('任意正文').endsWith('.docx'))
check('文件名：超长正文被截断', name('甲'.repeat(200)).length < 60, `${name('甲'.repeat(200)).length} 字符`)
check('文件名：正文全是非法字符时回退到默认名', name('\\/:*?"<>|') === 'Guncat 回答.docx', name('\\/:*?"<>|'))
check('文件名：空正文回退到默认名', name('') === 'Guncat 回答.docx')
// 用户实际踩到的那一条：正文以「如下」开头且带换行
const realCase = name('沙箱测试完成，各项能力逐项验证如下\n\n1. 文件读写\n2. CSV 转换')
check(
  '文件名：复现用户的实际场景（带换行的长正文）',
  !/[\r\n]/.test(realCase) && realCase.endsWith('.docx') && realCase.length < 60,
  realCase
)

// --- 会话列表：标题从哪来、时间怎么显示（用户报障的第 2 条） ---
//
// 事故回顾：主进程建会话时把「引擎名」写进了 title，而标题推导的守卫只认 ''/'新对话'，
// 于是侧栏里每条会话都顶着一个「轻简模式」。下面这些断言把正确的口径钉死。
console.log('\n15. 会话标题 / 侧栏元信息（纯函数）')
const AGENTS = [
  { id: 'guncat-3.1-flash', name: '轻简模式', description: '', shortDescription: '', icon: '', category: '通用智能体', prompt: '' },
  { id: 'guncat-3.0-pro', name: '专家模式', description: '', shortDescription: '', icon: '', category: '通用智能体', prompt: '' }
]
const ENGINES = mod.buildAgentList(AGENTS)

check(
  '引擎列表：工作 / 交互两个虚拟智能体排在最前（原版 unshift + splice）',
  ENGINES[0].id === mod.INTERACTIVE_AGENT_ID && ENGINES[1].id === mod.WORK_AGENT_ID,
  ENGINES.map((a) => a.id).join(',')
)
check('引擎列表：真实智能体一个不少且在后面', ENGINES.length === 4 && ENGINES[2].id === 'guncat-3.1-flash')

check(
  '标题：有标题就用标题',
  mod.conversationTitle({ title: '季度复盘', agentId: 'guncat-3.1-flash', mode: 'chat' }, ENGINES) ===
    '季度复盘'
)
check(
  '标题：空标题回退成「与 <引擎名> 的对话」',
  mod.conversationTitle({ title: '', agentId: 'guncat-3.1-flash', mode: 'chat' }, ENGINES) ===
    '与 轻简模式 的对话'
)
check(
  '标题：标题恰好等于引擎名（脏数据）同样回退 —— 这就是「每条都叫轻简模式」的修复点',
  mod.conversationTitle(
    { title: '轻简模式', agentId: 'guncat-3.1-flash', mode: 'chat' },
    ENGINES
  ) === '与 轻简模式 的对话'
)
check(
  '标题：工作模式会话的脏数据回退成「与 工作模式 的对话」（模式优先于 agentId）',
  mod.conversationTitle(
    { title: '工作模式', agentId: 'guncat-3.1-flash', mode: 'work' },
    ENGINES
  ) === '与 工作模式 的对话'
)
check(
  '标题：引擎完全对不上时兜底「新会话」',
  mod.conversationTitle({ title: '', agentId: 'ghost', mode: 'chat' }, ENGINES) === '新会话'
)
check(
  '归属：工作形态的会话归属 work 引擎（移植早期 agentId 还是真实智能体）',
  mod.engineIdOfConversation({ agentId: 'guncat-3.1-flash', mode: 'work' }) === mod.WORK_AGENT_ID &&
    mod.agentOfConversation({ agentId: 'guncat-3.1-flash', mode: 'work' }, ENGINES).name === '工作模式'
)
check(
  '归属：聊天形态的会话仍归属它自己的智能体',
  mod.engineIdOfConversation({ agentId: 'guncat-3.0-pro', mode: 'chat' }) === 'guncat-3.0-pro'
)
check(
  '形态 ↔ 引擎：work / interactive / chat 三向往返一致',
  mod.modeForAgentId(mod.agentIdForMode('work', AGENTS, 'guncat-3.1-flash')) === 'work' &&
    mod.modeForAgentId(mod.agentIdForMode('interactive', AGENTS, 'guncat-3.1-flash')) ===
      'interactive' &&
    mod.agentIdForMode('chat', AGENTS, 'guncat-3.0-pro') === 'guncat-3.0-pro'
)

// 时间显示：以固定「现在」断言，避免测试自己漂移
const NOW = new Date(2024, 8, 10, 15, 30, 0).getTime()
const TODAY = new Date(2024, 8, 10, 9, 5, 0).getTime()
const SAME_YEAR = new Date(2024, 2, 3, 9, 5, 0).getTime()
const OLD_YEAR = new Date(2023, 2, 3, 9, 5, 0).getTime()
check('时间：今天的只显示 时:分', mod.formatTimeLabel(TODAY, NOW) === '09:05', mod.formatTimeLabel(TODAY, NOW))
check('时间：今年其它日期显示 月/日', mod.formatTimeLabel(SAME_YEAR, NOW) === '3/3', mod.formatTimeLabel(SAME_YEAR, NOW))
check('时间：跨年显示 年/月/日', mod.formatTimeLabel(OLD_YEAR, NOW) === '2023/3/3', mod.formatTimeLabel(OLD_YEAR, NOW))
check('时间：没有时间戳时返回空串', mod.formatTimeLabel(0, NOW) === '')

check(
  '元信息：引擎名 · 时间 · 消息数（原版只有标题，桌面端宽屏补上这三个字段）',
  mod.conversationMeta(
    { agentId: 'guncat-3.1-flash', mode: 'chat', updatedAt: TODAY, messageCount: 8 },
    ENGINES,
    NOW
  ) === '轻简模式 · 09:05 · 8 条',
  mod.conversationMeta(
    { agentId: 'guncat-3.1-flash', mode: 'chat', updatedAt: TODAY, messageCount: 8 },
    ENGINES,
    NOW
  )
)
check(
  '元信息：空会话不显示「0 条」',
  mod.conversationMeta(
    { agentId: 'guncat-3.1-flash', mode: 'chat', updatedAt: 0, messageCount: 0 },
    ENGINES,
    NOW
  ) === '轻简模式'
)

// --- 工作模式的多轮归组（用户报障的第 5 条） ---
console.log('\n16. 回合归组 / 工具行（纯函数）')
function msg(role, content, extra = {}) {
  return {
    id: `${role}-${content}`,
    role,
    content,
    displayContent: '',
    reasoning: '',
    attachments: [],
    toolCalls: [],
    timestamp: 0,
    tokenSpeed: -1,
    cacheHitRate: -1,
    ...extra
  }
}

const MESSAGES = [
  msg('user', '做个复盘'),
  msg('assistant', '先读文件', {
    reasoning: '我需要先看数据',
    toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{"path":"a.csv"}', result: 'ok', status: 'ok' }]
  }),
  msg('assistant', '中轮结论', {
    toolCalls: [
      { id: 'c2', name: 'write_docx', argsJson: '{"path":"r.docx"}', result: '', status: 'error' }
    ]
  }),
  msg('assistant', '最终答复', { tokenSpeed: 12.34, cacheHitRate: 0.5 }),
  msg('user', '再改一版'),
  msg('assistant', '第二版答复')
]
const TURNS = mod.groupTurns(MESSAGES)
check('归组：一个用户请求 + 其后连续 assistant = 一个回合', TURNS.length === 2, `${TURNS.length} 个回合`)
check('归组：第一回合含 3 轮 assistant', TURNS[0].rounds.length === 3)
check('归组：第二回合含 1 轮 assistant', TURNS[1].rounds.length === 1)
check('归组：回合里的 user 就是那条用户消息', TURNS[0].user.content === '做个复盘')
check(
  '归组：前导 assistant 不会被丢弃（历史数据缺 user 时的兜底）',
  mod.groupTurns([msg('assistant', '孤儿回答')])[0].user === null
)

const STATS = mod.turnStats(TURNS[0])
check('统计：工具调用数与失败数分别计数', STATS.toolCalls === 2 && STATS.failedTools === 1, JSON.stringify(STATS))
check('统计：没有 running 的工具时不算执行中', STATS.running === false)
check(
  '统计：有 running 的工具即算执行中',
  mod.turnStats({
    index: 0,
    user: null,
    rounds: [msg('assistant', 'x', { toolCalls: [{ id: 'c', name: 'bash', argsJson: '{}', result: '', status: 'running' }] })]
  }).running === true
)
check(
  '「过程」标题把轮数与工具次数说清楚',
  mod.processTitle(STATS) === '过程 · 3 轮 · 2 次工具调用 · 1 次失败',
  mod.processTitle(STATS)
)
check(
  '「过程」标题：只有一轮时省略轮数',
  mod.processTitle({ rounds: 1, toolCalls: 1, failedTools: 0, chars: 0, running: false }) ===
    '过程 · 1 次工具调用'
)
check('最终答复取回合里最后一条 assistant', mod.groupTurns(MESSAGES)[0].rounds.at(-1).content === '最终答复')

check('统计行：输出速度与缓存命中', mod.formatStats(MESSAGES[3]) === '12 字符/秒 · 缓存命中 50%', mod.formatStats(MESSAGES[3]))
check('统计行：无数据时为空串', mod.formatStats(MESSAGES[5]) === '')
check('耗时：小于一秒用 ms', mod.formatDuration(320) === '320ms')
check('耗时：大于一秒用 s', mod.formatDuration(2400) === '2.4s')

check('工具标题：read_file → Read', mod.toolDisplayName('read_file') === 'Read')
check('工具标题：未知工具名原样返回', mod.toolDisplayName('whatever_tool') === 'whatever_tool')
check(
  '工具参数摘要：单参数省略键名（对齐 CLI 工具行观感）',
  mod.toolArgsSummary('{"path":"docs/a.md"}') === 'docs/a.md',
  mod.toolArgsSummary('{"path":"docs/a.md"}')
)
check(
  '工具参数摘要：流式未收口的 JSON 不解析，直接截断展示',
  mod.toolArgsSummary('{"path":"docs/a.md","content":"还没写完').startsWith('{"path"'),
  mod.toolArgsSummary('{"path":"docs/a.md","content":"还没写完')
)
check('工具状态：error/running/ok 三态', mod.toolStatus({ status: 'error' }).state === 'error' && mod.toolStatus({ status: 'running' }).state === 'running' && mod.toolStatus({ status: 'ok' }).state === 'ok')
check(
  '工具图标分类：读 / 写 / 搜 / 网 各自归位',
  mod.toolIconKind('read_file') === 'read' &&
    mod.toolIconKind('write_docx') === 'write' &&
    mod.toolIconKind('grep') === 'search' &&
    mod.toolIconKind('local_web_search') === 'web'
)

// --- SVG 图标集：统一规格 + 没有 emoji ---
console.log('\n17. SVG 图标集')
const iconHtml = mod.renderIcons()
check('图标渲染为行内 SVG', iconHtml.includes('<svg'))
check('图标统一 24×24 视图框', iconHtml.includes('viewBox="0 0 24 24"'))
check('图标颜色走 currentColor', iconHtml.includes('stroke="currentColor"'))
check('图标默认描边不填充', iconHtml.includes('fill="none"'))
check('图标线宽统一 1.6', iconHtml.includes('stroke-width="1.6"'))
check(
  '图标集里没有任何 emoji / 装饰符号',
  !/[\u2190-\u21ff\u2300-\u23ff\u2460-\u24ff\u25a0-\u25ff\u2600-\u27bf\u2b00-\u2bff\ufe0f]/.test(
    iconHtml
  )
)

// --- 侧栏条目 + 工作模式回合的实际 DOM（SSR） ---
console.log('\n18. 侧栏条目与工作模式回合（SSR 结构）')
const shell = mod.renderShell(false)
const shellRunning = mod.renderShell(true)
check('会话条目渲染出标题与元信息结构', shell.includes('conv-item__title') && shell.includes('conv-item__meta'))
check('会话条目：有标题的会话显示标题', shell.includes('做一个季度销售复盘'))
check(
  '会话条目：脏数据（标题=引擎名）回退成「与 轻简模式 的对话」',
  shell.includes('与 轻简模式 的对话')
)
check(
  '会话条目：元信息是「引擎名 · 时间 · 消息数」（工作形态归工作模式引擎）',
  shell.includes('工作模式 · 09:05 · 3 条')
)
check('引擎条目渲染出工作模式与交互模式', shell.includes('agent-item') && shell.includes('工作模式') && shell.includes('交互模式'))
check('引擎条目带选中态（原版 sidebar_item_active）', shell.includes('data-active="true"'))
check('任务卡渲染用户请求', shell.includes('task-card') && shell.includes('做一个季度销售复盘'))

// --- 工作模式：逐轮直接陈列（用户报障：工作模式不该和交互模式一样） ---
check(
  '工作模式：每一轮 assistant 都直接陈列成块（不是收进一条折叠栏）',
  (shell.match(/class="work-round"/g) ?? []).length === 3,
  `${(shell.match(/class="work-round"/g) ?? []).length} 轮`
)
check('工作模式：整回合**不**收进单一活动折叠栏', !shell.includes('disclosure__title'))
check(
  '工作模式：中间轮的正文也在时间线上（步骤顺序不会被糊掉）',
  shell.includes('先把数据读进来') && shell.includes('这是中间结论')
)
check(
  '工作模式：工具行直接陈列，参数摘要可见；细节仍要点开才出',
  shell.includes('Read') && shell.includes('sales.csv') && !shell.includes('io__label')
)
check(
  '工作模式：有思考的那一轮挂着思考条',
  (shell.match(/thinking__head/g) ?? []).length === 1
)
check('最终答复是主体并带操作行', shell.includes('这是最终答复') && shell.includes('重答'))
check('统计行口径与原版一致（整数 字符/秒 + 缓存命中）', shell.includes('20 字符/秒') && shell.includes('缓存命中 50%'))
check(
  '统计行带「工具 N 项 · 总耗时」（原版 buildStatsLine 的第三段）',
  mod.formatStats({
    id: 'm',
    role: 'assistant',
    content: '',
    displayContent: '',
    reasoning: '',
    createdAt: 0,
    tokenSpeed: 18.6,
    cacheHitRate: 0.5,
    attachments: [],
    toolCalls: [
      { id: 't1', name: 'read_file', argsJson: '{}', result: '', status: 'ok', startedAt: 0, finishedAt: 0, durationMs: 320, diff: '' },
      { id: 't2', name: 'write_file', argsJson: '{}', result: '', status: 'ok', startedAt: 0, finishedAt: 0, durationMs: 1200, diff: '' }
    ]
  }) === '19 字符/秒 · 缓存命中 50% · 工具 2 项 · 1.5s',
  mod.formatStats({
    id: 'm',
    role: 'assistant',
    content: '',
    displayContent: '',
    reasoning: '',
    createdAt: 0,
    tokenSpeed: 18.6,
    cacheHitRate: 0.5,
    attachments: [],
    toolCalls: [
      { id: 't1', name: 'read_file', argsJson: '{}', result: '', status: 'ok', startedAt: 0, finishedAt: 0, durationMs: 320, diff: '' },
      { id: 't2', name: 'write_file', argsJson: '{}', result: '', status: 'ok', startedAt: 0, finishedAt: 0, durationMs: 1200, diff: '' }
    ]
  })
)
check(
  '总耗时只累计已完成的单步（还在跑的那一步 durationMs<0 不计）',
  mod.formatStats({
    id: 'm',
    role: 'assistant',
    content: '',
    displayContent: '',
    reasoning: '',
    createdAt: 0,
    tokenSpeed: -1,
    cacheHitRate: -1,
    attachments: [],
    toolCalls: [
      { id: 't1', name: 'read_file', argsJson: '{}', result: '', status: 'ok', startedAt: 0, finishedAt: 0, durationMs: 500, diff: '' },
      { id: 't2', name: 'write_file', argsJson: '{}', result: '', status: 'running', startedAt: 0, finishedAt: 0, durationMs: -1, diff: '' }
    ]
  }) === '工具 2 项 · 500ms'
)
check(
  '复制纯文本会剥掉 Markdown 标记（「文本」与「MD」两个按钮语义不同）',
  mod.stripMarkdown('## 标题\n\n**粗体**与 `代码` 和 [链接](https://x)') === '标题\n\n粗体与 代码 和 链接',
  JSON.stringify(mod.stripMarkdown('## 标题\n\n**粗体**与 `代码` 和 [链接](https://x)'))
)
check(
  '剥 Markdown 时图片与围栏代码块整段丢弃（否则会把源码/图片地址复制出去）',
  !mod.stripMarkdown('前\n\n```\ncode\n```\n\n后').includes('code') &&
    !mod.stripMarkdown('前\n\n![图](a.png)\n\n后').includes('a.png')
)

// --- 界面块的可交互性（原版 uiLocked 的两种口径） ---
// 交互态由 `stale = !interactive || !complete` 决定，落成控件的 disabled 属性，
// 所以可以直接在产物里断言「有没有 disabled」。
const uiLive = mod.renderUiProgramBlock(true)
const uiLocked = mod.renderUiProgramBlock(false)
check(
  '可交互的界面块：控件不带 disabled（原版 interactive() = complete && !locked）',
  uiLive.includes('<button') && !uiLive.includes('disabled'),
  uiLive.includes('disabled') ? '被禁用了' : '可点'
)
check(
  '不可交互的界面块：控件带 disabled（原版 .enabled(false)）',
  uiLocked.includes('<button') && uiLocked.includes('disabled')
)
check(
  '不可交互时**不给整块蒙灰、也不挂只读横幅**（原版只有一个 locked 语义）',
  !uiLocked.includes('gui--locked') && !uiLocked.includes('历史界面')
)

// --- 雷达图（提示词推荐了它，但此前渲染层与组件库都没有） ---
const radar = mod.renderRadarChart()
check(
  'RadarChart 真的能渲染（不再落进「未知组件」分支）',
  radar.includes('<svg') &&
    radar.includes('<path') &&
    !radar.includes('未知组件') &&
    !radar.includes('gui-text'),
  radar.includes('未知组件') ? '被当成未知组件了' : '渲染成 SVG'
)
check(
  '雷达图的每根轴名都显示（多维对比的语义本身）',
  radar.includes('价格') && radar.includes('性能') && radar.includes('续航') && radar.includes('外观')
)
check(
  '多条序列时给出图例',
  radar.includes('A 机型') && radar.includes('B 机型') && radar.includes('gui-chart__legend')
)

// --- 交互模式：整个回合收进一条活动折叠栏 ---
const groupedShell = mod.renderGroupedTurn(false)
const groupedRunning = mod.renderGroupedTurn(true)
// 流式中间态：正文还没开始输出 —— 此时活动折叠栏应当默认展开
const groupedPending = mod.renderGroupedTurn(true, true)
check(
  '交互模式：一个回合只有一个活动折叠区（修复前是每条 assistant 各挂一条工具折叠条）',
  (groupedShell.match(/disclosure__title/g) ?? []).length === 1,
  `${(groupedShell.match(/disclosure__title/g) ?? []).length} 个活动折叠区`
)
check(
  '交互模式：折叠栏摘要写清思考轮数与工具数',
  groupedShell.includes('思考') && groupedShell.includes('1 个工具')
)
check(
  '被手动停止的回合，折叠栏标题是「已停止」而不是「已完成」（原版 isStopped）',
  mod.renderGroupedTurnStopped().includes('已停止') &&
    !mod.renderGroupedTurnStopped().includes('>已完成<'),
  '已停止'
)
check(
  '只有思考、没有工具的回合**不再**挂空的活动折叠栏（思考归思考栏，折叠栏不摆摆设）',
  !mod.renderGroupedTurnThinkingOnly().includes('已完成'),
  mod.renderGroupedTurnThinkingOnly().includes('已完成') ? '还挂着空折叠栏' : '只有思考栏'
)
check(
  '没有工具调用时，思考内容**直接可见**（不是藏在默认收起的折叠栏里）—— 用户报障点',
  mod.renderGroupedTurnThinkingOnly().includes('先看看目录结构'),
  mod.renderGroupedTurnThinkingOnly().includes('先看看目录结构') ? '思考可见' : '思考被藏起来了'
)
check(
  '思考栏汇总本回合所有轮的思考，并在标题上标出轮数',
  mod.renderGroupedTurnThinkingOnly().includes('思考'),
  '思考栏标题'
)
check(
  '交互模式：中间轮不单独成块（只有最终答复有 answer 块）',
  (groupedShell.match(/class="answer"/g) ?? []).length === 1
)
check(
  '交互模式：过程区收起时不渲染工具细节',
  !groupedShell.includes('sales.csv') && !groupedShell.includes('这是中间结论'),
  '细节应只在展开后出现'
)
check(
  '交互模式：正文未开始前默认展开，工具行与中间轮正文都在',
  groupedPending.includes('sales.csv') &&
    groupedPending.includes('这是中间结论') &&
    groupedPending.includes('Read')
)
check(
  '交互模式：跑动中写「正在处理…」，跑完后这一条就是**思考栏**（标题写「思考」/「思考 ×N」）',
  // 「正在处理…」用「正文还没开始输出」那一帧来断言：只有那一刻活动栏才是跑动状态
  groupedPending.includes('正在处理…') &&
    groupedShell.includes('思考') &&
    !groupedShell.includes('>已完成<'),
  groupedShell.includes('>已完成<') ? '仍是「已完成」' : '已改为思考栏'
)
check(
  '思考栏的展开箭头在**行尾**（不在最左边跟状态图标挤在一起）',
  (() => {
    // 注意：</button> 要**从 head 之后**开始找 —— 这个回合前面的任务卡自带按钮，
    // 直接 indexOf 会取到它，切片变空、断言假红（我自己踩过一次）。
    const start = groupedShell.indexOf('disclosure__head')
    const head = groupedShell.slice(start, groupedShell.indexOf('</button>', start))
    const title = head.indexOf('disclosure__title')
    const caret = head.indexOf('disclosure__caret')
    return title >= 0 && caret > title
  })(),
  '箭头在标题之后'
)
check(
  '交互模式的活动栏**按时间顺序**铺开（思考与工具不各自归堆）—— 用户明确要求',
  // 用「展开着」的那一帧（正文未开始输出时默认展开）来断言顺序
  (() => {
    const body = groupedPending.slice(groupedPending.indexOf('disclosure__body'))
    const firstThinking = body.indexOf('thinking__head')
    const firstTool = body.indexOf('tool__head')
    return firstThinking >= 0 && firstTool >= 0 && firstThinking < firstTool
  })(),
  '思考在工具之前'
)
check(
  '渲染出来的 DOM 里没有 emoji / 装饰符号',
  !/[\u2190-\u21ff\u2300-\u23ff\u2460-\u24ff\u25a0-\u25ff\u2600-\u27bf\u2b00-\u2bff\ufe0f\u{1f000}-\u{1faff}]/u.test(
    shell + shellRunning + groupedShell + groupedRunning
  )
)

// --- Markdown：第三方默认的脚注回跳符号必须被换掉 ---
console.log('\n19. Markdown（脚注文案）')
const mdHtml = mod.renderMarkdown()
check('脚注区标题是中文「脚注」', mdHtml.includes('脚注'))
check('脚注回跳用中文「返回」而不是第三方默认的箭头符号', mdHtml.includes('返回'))
check(
  'Markdown 产物里没有箭头 / 装饰符号',
  !/[\u2190-\u21ff\u2300-\u23ff\u2460-\u24ff\u25a0-\u25ff\u2600-\u27bf\u2b00-\u2bff\ufe0f]/.test(mdHtml),
  mdHtml.slice(0, 100)
)

// --- Markdown 的三项重能力（用户报障：mermaid / 代码块 / LaTeX 都渲染不出来） ---
console.log('\n20. Markdown 重能力（LaTeX / 代码块 / Mermaid）')
const mdFeatureHtml = mod.renderMarkdownFeatures()
check('行内公式走 KaTeX 渲染（不再是裸 $...$）', mdFeatureHtml.includes('class="katex"'))
check('块级公式单独成块', mdFeatureHtml.includes('katex-display'))
check(
  '公式真的被解析成了数学结构（.frac 等 KaTeX 节点）',
  mdFeatureHtml.includes('mfrac') || mdFeatureHtml.includes('katex-html')
)
check('带语言的围栏渲染成代码块（语言标签可见）', mdFeatureHtml.includes('code-block') && mdFeatureHtml.includes('python'))
check('代码块接了语法高亮（hljs 标记）', mdFeatureHtml.includes('hljs') && mdFeatureHtml.includes('hljs-keyword'))
check('代码块带复制按钮', mdFeatureHtml.includes('code-block__copy'))
check(
  '围栏内的代码原文一字不差（只被加了高亮标签，没有被 Markdown 吃掉字符）',
  decode(mdFeatureHtml).includes('def hello(name):') &&
    decode(mdFeatureHtml).includes('return f"hi {name}"')
)
check(
  'mermaid 围栏走 Mermaid 渲染路径（不再是普通代码块）',
  mdFeatureHtml.includes('mermaid-block')
)
check(
  'mermaid 未出图前给占位而不是空白',
  mdFeatureHtml.includes('正在绘图')
)
check('没有语言标记的围栏仍然渲染成代码块', mdFeatureHtml.includes('没有语言标记的围栏'))
check(
  '代码块不受行内代码样式污染（外框由 .code-block 负责）',
  mdFeatureHtml.includes('code-block__pre')
)

// mermaid 有时不渲染：模型把箭头写成 Unicode 长箭头，mermaid 判语法错，整张图退回源码
const ARROW_R = '\u27f6'
const ARROW_L = '\u2190'
const ARROW_LR = '\u2194'
const LABEL_ARROW = '\u2192'
check(
  'Unicode 箭头修成 mermaid 认的写法（图不再退回源码）',
  mod.mermaidSourceFixed(`A ${ARROW_R} B`) === 'A --> B' &&
    mod.mermaidSourceFixed(`A ${ARROW_L} B`) === 'A <-- B' &&
    mod.mermaidSourceFixed(`A ${ARROW_LR} B`) === 'A <--> B'
)
check(
  '已经是 ASCII 箭头的源码逐字不变（幂等，不能把好的图改坏）',
  mod.mermaidSourceFixed('A --> B\n  C<-->D') === 'A --> B\n  C<-->D'
)
check(
  '标签文字里的箭头不许动（那是用户要看的正文，不是语法）',
  mod.mermaidSourceFixed(`A["结论 ${LABEL_ARROW} 覆盖有洞"] --> B["下一步"]`) ===
    `A["结论 ${LABEL_ARROW} 覆盖有洞"] --> B["下一步"]`
)
check(
  'init 指令行与图类型行原样保留（只换箭头，不重排源码）',
  mod.mermaidSourceFixed('%%{init: {"flowchart": {"nodeSpacing": 50}}}%%\nflowchart TD\n  A' + ARROW_R + 'B') ===
    '%%{init: {"flowchart": {"nodeSpacing": 50}}}%%\nflowchart TD\n  A-->B'
)

// --- 工作区面板：上传入口必须看得见（用户报障「找不到入口」） ---
console.log('\n21. 工作区面板（上传入口 / 文件分类图标）')
const wsHtml = mod.renderWorkspacePanel()
check('面板头部有「上传」按钮', wsHtml.includes('workspace__upload') && wsHtml.includes('上传'))
check('空工作区里也有一个显眼的上传入口', wsHtml.includes('workspace__empty-btn'))
check('空态把「怎么加文件」说清楚（不再是只有拖拽这条隐形路径）', decode(wsHtml).includes('拖进窗口'))
check(
  '导出/分享 / 打开文件夹 入口都还在（导出改走「先选位置或分享」的弹层；位置行已挪到审批行下方）',
  wsHtml.includes('导出或分享工作区')
)

// 命令审批档位行：面板能把「跑命令要问不问」交给用户，前提是那几档主进程都认
const permRows = mod.commandPermissionRows()
check(
  '界面上的审批档位与 core 的档位表一一对应（不漂出一个主进程不认的选项）',
  permRows.rows.length === permRows.guardPermissions.length &&
    permRows.guardPermissions.every((v) => permRows.rows.some((r) => r.value === v))
)
check(
  '默认档是「自动审批」，且排在第一个（模型先审，判危险仍然找人）',
  permRows.rows[0].value === 'auto' &&
    permRows.rows[0].label.includes('自动审批') &&
    permRows.rows[0].hint.includes('默认档')
)
check(
  '「完全权限」那一档把话说清楚：毁灭性操作仍然会被拒（不能让人以为开了就什么都跑得动）',
  (() => {
    // 这一句原本钉在 'auto' 上。auto 改成「模型先审一轮」之后，真正不询问、
    // 由智能体自己跑的是 'full-access' —— 会误导人的是那一档，警告就必须跟着搬过去。
    const open = permRows.rows.find((r) => r.value === 'full-access')
    return (
      open !== undefined &&
      open.label.includes('完全权限') &&
      open.hint.includes('毁灭') &&
      open.hint.includes('拒绝')
    )
  })()
)
check(
  '「自动审批」说的是模型审阅而不是全自动：判危险仍然弹卡请人批',
  (() => {
    const auto = permRows.rows.find((r) => r.value === 'auto')
    return (
      auto !== undefined &&
      auto.hint.includes('审阅') &&
      auto.hint.includes('弹卡') &&
      !auto.hint.includes('全部自动')
    )
  })()
)

// 项目指令行：界面向用户承诺「放这几个文件就会生效」，清单必须和内核读盘的那份同源
const instrRow = mod.instructionRowCopy()
check(
  '面板的项目指令文案逐个列出了内核真正读取的候选文件（不承诺 README.md 这类不生效的名字）',
  instrRow.files.length > 0 && instrRow.files.every((f) => instrRow.hint.includes(f))
)
check(
  '候选清单第一项是业界通用名 AGENTS.md（在别的工具里写过的约定搬过来直接生效）',
  instrRow.files[0] === 'AGENTS.md'
)
check(
  '指令未设置时的提示同时说明「谁会用、怎么用」（不能只写一个「无」）',
  instrRow.hint.includes('每轮') && instrRow.hint.includes('遵守')
)

const wsIcons = mod.renderWorkspaceFileIcons()
const iconOf = (name) => wsIcons[name]
check('图片 / PDF / 压缩包 / 源码 / 视频 / 音频各用各的图标', (() => {
  const kinds = ['a.png', 'a.pdf', 'a.zip', 'a.py', 'a.mp4', 'a.mp3'].map(iconOf)
  return new Set(kinds).size === kinds.length
})(), Object.entries(wsIcons).map(([k, v]) => `${k}=${v.length}`).join(' '))
check('未知类型回退通用文件图标', iconOf('a.unknown') !== '' && iconOf('a.unknown') !== iconOf('a.py'))

// --- 输入区：附件入口必须存在（审计 P0：聊天模式的附件链路此前是空壳） ---
console.log('\n22. 输入区（附件入口）')
const composerChat = mod.renderComposer('chat')
const composerWork = mod.renderComposer('work')
check('聊天模式的输入区有附件入口（回形针）', composerChat.includes('composer__upload'))
check(
  '附件入口的提示说清是「发给模型直接查看」',
  composerChat.includes('发送给模型直接查看')
)
check(
  '工作/交互模式的上传入口进工作区（标题不同，不是附件直传）',
  composerWork.includes('composer__upload') && composerWork.includes('加入工作区')
)
check('发送按钮仍在', composerChat.includes('composer__send'))
// 语音按钮当前是显式关掉的（Composer 的 VOICE_BUTTON_VISIBLE=false）：
// 这条断言钉住的是「别在没接好链路时又把它放出来」这个现状，而不是要求它出现。
check(
  '语音输入按钮按既定开关隐藏（未接好链路前不放出来）',
  !composerChat.includes('composer__mic')
)

// 执行中的输入区（审计 P1-4：此前只有「停止」，想补充要求只能中止重来）
const composerWorkRunning = mod.renderComposer('work', true)
const composerChatRunning = mod.renderComposer('chat', true)
check(
  '工作模式执行中给出「插话」按钮（不打断当前执行，下一轮生效）',
  composerWorkRunning.includes('composer__send--steer') && composerWorkRunning.includes('插话')
)
check('执行中仍然有「停止」', composerWorkRunning.includes('composer__send--stop'))
check(
  '聊天模式执行中不给插话（一问一答没有「下一轮」可挂）',
  !composerChatRunning.includes('composer__send--steer') &&
    composerChatRunning.includes('composer__send--stop')
)

// --- 附件预览条的三种解析状态（对齐原版 ChatPage.ets:958-1042） ---
//
// 事故形状：附件此前只显示缩略图/文件名/大小，用户看不出这份文件到底解析完了没有。
// 原版的口径是「选完立刻出现卡片（解析中...）→ 解析完变已就绪 / 解析失败」，
// 且解析中不给删除钮、失败整卡淡红底并把原因挂 tooltip。
console.log('\n22b. 附件预览条（解析三态）')
const barParsing = mod.renderAttachmentBar('parsing')
const barReady = mod.renderAttachmentBar('ready')
const barError = mod.renderAttachmentBar('error')
check('解析中：文案为「解析中...」', barParsing.includes('解析中...'))
check(
  '解析中：卡片带 attachment--parsing 类名（次要色由它给）',
  barParsing.includes('attachment--parsing') && barParsing.includes('data-status="parsing"')
)
check(
  '解析中：不显示删除钮（此时删掉会让后台解析结果无处落地）',
  !barParsing.includes('attachment__del')
)
check(
  '解析中：还没有缩略图，退回显示文件名',
  barParsing.includes('attachment__name') && barParsing.includes('季度报表.png')
)
check('已就绪：文案为「已就绪」', barReady.includes('已就绪'))
check(
  '已就绪：卡片带 attachment--ready 类名（成功色由它给）',
  barReady.includes('attachment--ready') && barReady.includes('data-status="ready"')
)
check(
  '已就绪：显示缩略图与删除钮（与解析中的两条差异都在）',
  barReady.includes('attachment__img') && barReady.includes('attachment__del')
)
check('解析失败：文案为「解析失败」', barError.includes('解析失败'))
check(
  '解析失败：卡片带 attachment--error 类名（整卡淡红底由它给）',
  barError.includes('attachment--error') && barError.includes('data-status="error"')
)
check(
  '解析失败：失败原因挂在 tooltip 上（红底只说「坏了」，原因要查得到）',
  barError.includes('多模态接口返回 401 Unauthorized')
)
check('解析失败：仍然可以删掉这张卡片', barError.includes('attachment__del'))
check(
  '三种状态的类名互不相同（不会把已就绪画成失败色）',
  new Set(['attachment--parsing', 'attachment--ready', 'attachment--error']).size === 3 &&
    !barReady.includes('attachment--error') &&
    !barError.includes('attachment--ready')
)

// --- 侧栏：引擎分组 / 工作区入口（审计 P2-14、P2-15） ---
console.log('\n23. 侧栏（引擎分组 / 工作区入口）')
const sidebarHtml = mod.renderSidebar()
check(
  '引擎区分成「Agent 引擎（推荐）」与「聊天引擎」两段（此前是一段平铺）',
  sidebarHtml.includes('Agent 引擎（推荐）') && sidebarHtml.includes('聊天引擎')
)
check(
  '聊天引擎段是可折叠的（默认折叠，对齐原版 AgentDrawerView）',
  sidebarHtml.includes('sidebar__label--toggle') && sidebarHtml.includes('data-open="false"')
)
check(
  '侧栏底部有「工作区」入口（此前完全没有，聊天模式下来路文件无处可见）',
  sidebarHtml.includes('工作区') && sidebarHtml.includes('foot-btn')
)

// --- 工具行的 diff / 任务清单卡片（审计 P2-9） ---
//
// 事故形状：展开一个工具行只有「参数」「结果」两个 <pre> 原文块 ——
// edit 看不出改了哪几行，todo_write 显示成一段转义 JSON。
// 原版 WorkTurnView 是按工具名分派卡片，且三种形态**互斥**。
console.log('\n24. 工具行（diff / 任务清单卡片）')
const fileDiff = JSON.stringify({
  path: 'src/core/main.ts',
  adds: 2,
  dels: 1,
  truncated: false,
  hunks: [
    {
      header: '@@ -1,3 +1,4 @@',
      lines: [
        { t: 'same', x: 'const a = 1' },
        { t: 'del', x: 'const b = 2' },
        { t: 'add', x: 'const b = 3' },
        { t: 'add', x: 'const c = 4' }
      ]
    }
  ]
})
const editRow = mod.renderToolRow('edit', '{"path":"src/core/main.ts"}', '已写入', fileDiff)
check('edit 展开后是 diff 卡片', editRow.includes('diffcard') && editRow.includes('src/core/main.ts'))
check(
  '增删行分别着色（+ / - 两态）',
  editRow.includes('data-type="add"') &&
    editRow.includes('data-type="del"') &&
    editRow.includes('data-type="same"')
)
check('diff 卡片底部有增删统计', editRow.includes('diffcard__stat') && editRow.includes('+2'))
check(
  '有 diff 时不再叠一份原始参数/结果（原版是互斥的）',
  !editRow.includes('io__label') && !editRow.includes('io__pre')
)
check(
  '单行摘要右侧也能看到 +N -M',
  editRow.includes('tool__counts') && editRow.includes('diff-stat__del')
)

const todoRow = mod.renderToolRow(
  'todo_write',
  '{"todos":[]}',
  '[已完成] 1. 读需求\n[进行中] 2. 改代码\n[待开始] 3. 跑验证'
)
check('todo_write 展开后是任务清单卡', todoRow.includes('todocard') && todoRow.includes('todorow'))
check(
  '三种状态分别可辨（完成/进行中/待开始）',
  todoRow.includes('data-status="completed"') &&
    todoRow.includes('data-status="in_progress"') &&
    todoRow.includes('data-status="pending"')
)
check(
  '清单序号（1. ）被去掉，只留内容',
  todoRow.includes('读需求') && !todoRow.includes('1. 读需求')
)
check('单行摘要给出完成进度 1/3', todoRow.includes('1/3'))

const plainRow = mod.renderToolRow('read_file', '{"path":"a.md"}', '文件内容')
check(
  '没有结构化数据的工具仍然退回原始参数/结果（不会因为没卡片而空掉）',
  plainRow.includes('io__pre') && plainRow.includes('文件内容')
)
check(
  '损坏的 diff meta 安全退回原始 IO（不让界面因渲染失败而空掉）',
  mod.renderToolRow('edit', '{}', '已写入', '{ 这不是 JSON').includes('io__pre')
)
check(
  '工具行右端显示耗时（原版 formatDuration 口径：<1s 用 ms）',
  plainRow.includes('tool__duration') && plainRow.includes('320ms')
)
check('工具名与参数摘要之间有「·」分隔符（原版 Row 里的 Text(\'·\')）', plainRow.includes('tool__dot'))
check(
  '展开区带 2px 细竖线（原版挂在行内文字起点下方）',
  plainRow.includes('tool__detail')
)
const runningRow = mod.renderToolRowRunning()
check(
  '执行中的工具行：图标位是转圈、不给耗时，但**展开箭头始终在**（原版是无条件渲染的）',
  runningRow.includes('spinner') &&
    !runningRow.includes('tool__duration') &&
    runningRow.includes('tool__caret')
)
check('执行中的工具行仍然显示参数摘要', runningRow.includes('docs/a.md'))
check('已开始执行的显示「执行中…」（原版 stepStatusLabel）', runningRow.includes('执行中…'))
check('已生成参数但还没轮到的显示「等待中…」', mod.renderToolRowQueued().includes('等待中…'))
check(
  '本轮已结束但耗时仍为负 → 「已中断」（停止时遗留的空结果）',
  // 已中断的判据是 durationMs<0 且本轮已结束、也没有 preparing/started 标记 ——
  // 因此这里必须把 started 也置回 false，否则渲染成的是「执行中…」。
  mod.renderToolRowRunning('loop', false, false).includes('已中断') &&
    !mod.renderToolRowRunning('loop', false, false).includes('spinner')
)
check(
  '工作/交互模式的工具行是另一套规格（2×2 圆点分隔 + data-variant=loop）',
  runningRow.includes('data-variant="loop"') && runningRow.includes('tool__sep')
)
check(
  '聊天模式仍是「·」文字分隔（两套规格不混用）',
  mod.renderToolRow('read_file', '{"path":"a.md"}', '内容').includes('tool__dot')
)
check(
  '展开时的截断对齐原版 capText（参数 600 / 结果 800）',
  (() => {
    const longResult = 'x'.repeat(1200)
    const html = mod.renderToolRow('read_file', '{"path":"a.md"}', longResult)
    // 渲染出来的文本长度应当接近 800（含省略号），远小于 1200
    const body = html.slice(html.indexOf('io__pre'))
    return body.includes('…') && !body.includes('x'.repeat(900))
  })()
)

// --- 任务统计卡 / 目标卡（审计 P2-10） ---
//
// 事故形状：工作区面板只有「N 个文件 / N 个目录 / N 次工具调用」，
// 且是全会话累计、对应不到原版的「本轮」；全库 elapsed 零命中，
// GoalService.read 在主进程与渲染层都没有调用点 —— 跑长任务看不到「跑了多久、目标是什么」。
console.log('\n25. 任务统计卡 / 目标卡')
const statsHtml = mod.renderTaskStats()
check(
  '统计卡四项齐全（任务用时 / 输出速度 / 缓存命中 / 工具调用轮数）',
  statsHtml.includes('本轮统计') &&
    statsHtml.includes('任务用时') &&
    statsHtml.includes('输出速度') &&
    statsHtml.includes('缓存命中') &&
    statsHtml.includes('工具调用轮数')
)
check('任务用时是整数秒（原版 elapsedSec + 秒）', statsHtml.includes('83 秒'))
check('输出速度取整 + 单位「字符/秒」', statsHtml.includes('42 字符/秒'))
check('缓存命中按百分比取整', statsHtml.includes('81%'))
check('工具调用轮数显示', statsHtml.includes('>7<'))
check(
  '目标卡显示目标文本、状态与轮次进度',
  statsHtml.includes('把季度报表补齐并导出') &&
    statsHtml.includes('推进中') &&
    statsHtml.includes('第 3 / 40 轮')
)
const statsEmpty = mod.renderTaskStatsEmpty()
check(
  '没数据时统计卡仍在、值显示「—」；目标卡不渲染',
  statsEmpty.includes('statcard') && statsEmpty.includes('—') && !statsEmpty.includes('taskgoal')
)
const durations = mod.renderDurations()
check(
  '用时格式：整数秒 / MM:SS / HH:MM:SS',
  durations[0] === '0 秒' &&
    durations[1] === '83 秒' &&
    durations[2] === '01:23' &&
    durations[3] === '01:02:03',
  durations.join(' | ')
)

// --- 产物汇总卡（审计 P2-8） ---
//
// 事故形状：一轮工作跑完，用户看不到「这轮产出了/改了哪些文件、各加了多少行」，
// 只能去工作区列表里自己找。汇总逻辑（core/common/WorkArtifacts）在桌面端零引用 ——
// 连 core 内部都没人 import。
console.log('\n26. 产物汇总卡（Changes）')
const artifactsHtml = mod.renderArtifacts()
check('折叠头显示产物数量与总增减', artifactsHtml.includes('2 个文件') && artifactsHtml.includes('artifacts__head'))
check('默认展开列出文件（对齐原版 expanded 初值 true）', artifactsHtml.includes('artifacts__list'))
check(
  'Office 产物与源码文件都在列表里',
  artifactsHtml.includes('reports/季度复盘.docx') && artifactsHtml.includes('src/core/main.ts')
)
check(
  '每个文件有自己的 +N -M',
  artifactsHtml.includes('artifact__counts') && artifactsHtml.includes('+3')
)
// 行上只留「文件名」这一个入口（用户反馈：预览按钮 + 箭头 + 文件名挤在一行，两个入口做同一件事）
check('每行只有一个入口：文件名即预览入口（计数留在行右侧）', (() => {
  const paths = artifactsHtml.match(/class="artifact__path"/g) || []
  return paths.length === 2 && artifactsHtml.includes('artifact__name')
})(), (artifactsHtml.match(/class="artifact__path"/g) || []).length + ' 个文件名入口')
check(
  '行上没有多余的「预览」按钮，也没有行级 diff 的展开箭头',
  !artifactsHtml.includes('artifact__preview') && !artifactsHtml.includes('artifact__caret')
)
check(
  '行内不再嵌行级 diff 缩略（改动细节归时间线的工具行）',
  !artifactsHtml.includes('artifact__diff')
)
check('折叠头那颗整卡箭头还在（收起整卡是用户要的动作）', artifactsHtml.includes('artifacts__caret'))
check(
  '没有产物时整张卡不渲染',
  mod.renderArtifactsEmpty().length === 0,
  mod.renderArtifactsEmpty().length + ' 字节'
)
// 点开产物这一行必须真的打开预览（此前的形状：点了没反应）
const previewWiring = mod.workspacePreviewWiring()
check(
  '产物卡的预览入口写的是共享的 store 预览目标（含所属会话，切会话后不会指向别的工作区）',
  previewWiring.opened !== null &&
    previewWiring.opened.path === 'reports/季度复盘.docx' &&
    previewWiring.opened.conversationId === 'conv-1',
  JSON.stringify(previewWiring.opened)
)
check('关闭预览把 store 里的目标清掉（不会留下打不开的空弹层）', previewWiring.clearedAfterClose)
check('没有会话时不记预览目标（不会弹出一个读不到内容的空层）', previewWiring.ignoredWithoutConversation)

// --- 表格提取（审计 P1-3） ---
//
// 事故形状：原版唯一一个不依赖大模型对话的独立工具页，桌面端完全不存在 ——
// TableOcrService 零引用，也没有任何界面入口。
console.log('\n27. 表格提取')
const ocrHtml = mod.renderTableOcr()
check('弹层有「表格提取」标题', ocrHtml.includes('表格提取'))
check('有「选择图片」入口', ocrHtml.includes('选择图片'))
check('有模型选择（原版从配置方案里列模型）', ocrHtml.includes('识别模型') && ocrHtml.includes('<select'))
check(
  '模型下拉里带上来源（哪套配置方案 / 多模态解析）',
  ocrHtml.includes('glm-4v-flash（多模态解析）') && ocrHtml.includes('doubao-vision（生产）')
)
check('没选图时给出空态而不是空白', ocrHtml.includes('还没有选择图片'))
check(
  '说明里讲清「数据不进入对话上下文」（与原版独立页的语义一致）',
  ocrHtml.includes('不进入对话上下文')
)
const ocrResult = mod.renderTableOcrResult()
check('有图时给出缩略图、文件名与「开始识别」', ocrResult.includes('表格.png') && ocrResult.includes('开始识别'))
check(
  '有结果时渲染出 <table> 与「复制 HTML」',
  ocrResult.includes('<table>') && ocrResult.includes('<th>季度</th>') && ocrResult.includes('复制 HTML')
)
check('结果显示用的是哪个模型（用户要知道用了哪套配置）', ocrResult.includes('glm-4v-flash'))

// --- 开关与档位的默认值 / 下发值（对齐原版 ChatViewModel 的三条 getter） ---
console.log('\n28. 开关与推理档位')
check(
  '工作模式档位缺省 high，只认 max/low（其余回 high）',
  mod.workEffortFromPrefs(undefined) === 'high' &&
    mod.workEffortFromPrefs({ guncat_reasoning_effort: 'max' }) === 'max' &&
    mod.workEffortFromPrefs({ guncat_reasoning_effort: 'low' }) === 'low' &&
    mod.workEffortFromPrefs({ guncat_reasoning_effort: '乱写' }) === 'high'
)
check(
  '交互模式档位缺省是 low（首答速度优先），只认 off/low',
  mod.interactiveEffortFromPrefs(undefined) === 'low' &&
    mod.interactiveEffortFromPrefs({ guncat_interactive_effort: 'off' }) === 'off' &&
    mod.interactiveEffortFromPrefs({ guncat_interactive_effort: 'low' }) === 'low' &&
    mod.interactiveEffortFromPrefs({ guncat_interactive_effort: '乱写' }) === 'high'
)
check(
  '智能体默认深度思考按名称匹配：效率/轻简模式关、专家模式开、其余不干预',
  mod.defaultThinkingForAgent({ name: '效率模式' }) === false &&
    mod.defaultThinkingForAgent({ name: '轻简模式' }) === false &&
    mod.defaultThinkingForAgent({ name: '专家模式' }) === true &&
    mod.defaultThinkingForAgent({ name: '别的' }) === null
)
const tInteractiveOff = mod.requestThinking('interactive', false, 'high', 'off')
check(
  '交互模式选「关闭」：思考关掉，且下发强度退回 low（部分服务端会校验取值合法性）',
  tInteractiveOff.thinkingEnabled === false && tInteractiveOff.reasoningEffort === 'low'
)
const tInteractiveLow = mod.requestThinking('interactive', false, 'high', 'low')
check(
  '交互模式选「快速」：思考开着、强度 low（不受全局 thinking 开关影响）',
  tInteractiveLow.thinkingEnabled === true && tInteractiveLow.reasoningEffort === 'low'
)
const tWork = mod.requestThinking('work', false, 'max', 'low')
check(
  '工作模式：思考**恒定按全局开关**、强度取工作档位（交互档位不干扰）',
  tWork.thinkingEnabled === false && tWork.reasoningEffort === 'max'
)
const tChat = mod.requestThinking('chat', true, 'max', 'off')
check(
  '聊天模式：只带全局思考开关，不带强度（聊天协议没有强度概念）',
  tChat.thinkingEnabled === true && tChat.reasoningEffort === undefined
)
check(
  'isLoopMode 只把工作/交互算作 Agent Loop',
  mod.isLoopMode('work') && mod.isLoopMode('interactive') && !mod.isLoopMode('chat')
)

// --- 会话形态判定（真实事故：冷启动只设智能体不设形态 → 交互模式变纯对话） ---
check(
  '虚拟智能体的 id 就是形态：agentId=interactive 配 mode=chat 时必须判成交互',
  mod.resolveConversationMode('interactive', 'chat') === 'interactive' &&
    mod.resolveConversationMode('work', 'chat') === 'work',
  `${mod.resolveConversationMode('interactive', 'chat')} / ${mod.resolveConversationMode('work', 'chat')}`
)
check(
  '真实智能体上仍按会话自己记的形态（工作/交互模式会话不算丢）',
  mod.resolveConversationMode('guncat-3.1-flash', 'interactive') === 'interactive' &&
    mod.resolveConversationMode('guncat-3.1-flash', 'work') === 'work' &&
    mod.resolveConversationMode('guncat-3.1-flash', 'chat') === 'chat'
)
check(
  '形态缺失/非法时回落到聊天（不猜）',
  mod.resolveConversationMode('', '') === 'chat' &&
    mod.resolveConversationMode('guncat-3.1-flash', 'nonsense') === 'chat'
)
check(
  '虚拟智能体的 id 判定与模式映射一致（interactive/work 都不是真实智能体）',
  mod.isVirtualAgentId('interactive') &&
    mod.isVirtualAgentId('work') &&
    !mod.isVirtualAgentId('guncat-3.1-flash') &&
    mod.modeForAgentId('interactive') === 'interactive'
)

// --- 空态文案：必须是智能体自己的 description（用户报障：端口自己编了一段） ---
const proAgent = {
  id: 'guncat-3.0-pro',
  name: '专家模式',
  description: 'Guncat 3.0-Pro：最强大的专家级单体化超级智能体，融合多轮搜索与多步推理。',
  shortDescription: 'Guncat 3.0-Pro',
  icon: 'icons/guncat-3.0-pro.png',
  category: '通用智能体',
  prompt: ''
}
const chatEmpty = mod.renderEmptyState('chat', proAgent)
check(
  '聊天模式空态：标题下面是**智能体自己的 description**（agents.json 那段）',
  chatEmpty.includes('最强大的专家级单体化超级智能体'),
  chatEmpty.includes('最强大的专家级') ? '用的是 description' : '文案不对'
)
check(
  '聊天模式空态：不再出现端口自己编的「三协议流式对话」与「提示：在左下角设置…」',
  !chatEmpty.includes('三协议流式对话') && !chatEmpty.includes('提示：在左下角'),
  '旧文案已清除'
)
check(
  '聊天模式空态：没有 description 时退回原版兜底句「选择一个智能体开始对话」',
  mod.renderEmptyState('chat', { ...proAgent, description: '' }).includes(
    '选择一个智能体开始对话'
  )
)
check(
  '交互/工作模式空态：两句说明在**第一个句号后强制换行**（原版 replace 的口径）',
  mod.renderEmptyState('interactive', null).includes(
    '回答即界面，可视可交互。<br/>适用于生活中的大部分场景。'
  ) &&
    mod.renderEmptyState('work', null).includes('端到端交付成果。') &&
    !mod.renderEmptyState('interactive', null).includes('提示：')
)

// --- 侧栏折叠：列宽必须跟着侧栏自己走（用户报障：折叠后留一条又宽又空的白栏） ---
//
// 事故形状：`collapsed` 是 Sidebar 的局部 state，而外壳 `.app` 把侧栏那一列写死成 252px ——
// 折叠只换了内容，列宽没变，于是留下一条空栏。现在列宽是 auto，宽度由 `.sidebar` /
// `.sidebar--rail` 自己声明（252 / 56），两侧必须成对存在。
const rendererCss = fs.readFileSync(
  path.join(root, 'src/renderer/src/styles.css'),
  'utf8'
)
check(
  '侧栏列宽跟着侧栏走：外壳 auto + 展开 252 + 折叠 56（缺一个就会折叠失败）',
  /\.app \{[\s\S]{0,400}?grid-template-columns: auto minmax\(0, 1fr\)/.test(rendererCss) &&
    /\.app\.with-workspace \{[\s\S]{0,200}?grid-template-columns: auto minmax\(0, 1fr\) 286px/.test(
      rendererCss
    ) &&
    /\.sidebar \{[\s\S]{0,300}?width: 252px/.test(rendererCss) &&
    /\.sidebar--rail \{[\s\S]{0,200}?width: 56px/.test(rendererCss)
)

check(
  '正文栏宽度：对话 / 输入栏 / 附件条 / 提示行四处共用 --content-max（桌面铺开，不再是窄屏 800）',
  /--content-max: min\(1440px, 100%\)/.test(rendererCss) &&
    (rendererCss.match(/max-width: var\(--content-max\)/g) ?? []).length === 4 &&
    !/max-width: 800px/.test(rendererCss)
)

// --- 智能体图标：尺寸不能被 `.agent-avatar` 的 20px 吃掉（用户两轮报障） ---
//
// 事故形状：`.agent-avatar` 类里写着 width/height: 20px（侧栏那一档的尺寸），
// 而 CSS 类的优先级高于 `<img width="48">` 这种表现属性 —— 空态里 48 的图标被压成 20。
// 虚拟智能体走 SVG（没有这个类）所以是正常大小，于是「同一排图标有的大有的小」。
const realAgent = {
  id: 'guncat-3.1-flash',
  name: '轻简模式',
  description: '',
  shortDescription: '',
  icon: 'icons/guncat-3.1-flash.png',
  category: '通用智能体',
  prompt: ''
}
const glyphReal = mod.renderAgentGlyph(realAgent, 48, true)
check(
  '真实智能体的图标：尺寸写进 style（CSS 类的 20px 不能覆盖）',
  glyphReal.includes('style="width:48px;height:48px') ||
    /style="[^"]*width:48px[^"]*height:48px/.test(glyphReal),
  glyphReal.replace(/\s+/g, ' ').slice(0, 180)
)
check(
  '真实智能体的图标按墨迹占比放大（轻简模式 96x96 只有 80% 墨迹）',
  /transform:scale\(1\.2/.test(glyphReal),
  (glyphReal.match(/transform:scale\([^)]*\)/) ?? ['(无缩放)'])[0]
)
check(
  '虚拟智能体的描边图标同样按占比放大（viewBox 自带留白）',
  mod.renderAgentGlyph({ ...realAgent, id: 'interactive', icon: '' }, 48, true).includes(
    'width="58"'
  )
)
check(
  '不做归一化时两种图标都按传入尺寸（侧栏 20px 那一档）',
  mod.renderAgentGlyph(realAgent, 20, false).includes('width:20px;height:20px') &&
    mod.renderAgentGlyph({ ...realAgent, id: 'work', icon: '' }, 20, false).includes('width="20"')
)

// --- 图片灯箱 + 正文图片可点（原版 ImageLightbox 此前整条链路缺失） ---
console.log('\n29. 图片灯箱')
const lightboxOpen = mod.renderLightbox(true)
check('有图时渲染全屏遮罩', lightboxOpen.includes('lightbox') && lightboxOpen.includes('lightbox__img'))
check('大图带 Contain 规格与圆角（靠 class，样式在 CSS 里）', lightboxOpen.includes('data:image/png;base64'))
check('右上角有关闭钮', lightboxOpen.includes('lightbox__close'))
check('没有图时整块不渲染', mod.renderLightbox(false).length === 0)
check(
  '地址放行规则：data:image 放行、javascript: 与 data:text/html 一律拒绝',
  mod.safeUrlTransform('data:image/png;base64,iVBORw0KGgo=') !== '' &&
    mod.safeUrlTransform('https://example.com/a.png') !== '' &&
    mod.safeUrlTransform('docs/a.png') !== '' &&
    mod.safeUrlTransform('javascript:alert(1)') === '' &&
    mod.safeUrlTransform('data:text/html,<script>alert(1)</script>') === '',
  `js=${mod.safeUrlTransform('javascript:alert(1)') || '(拒绝)'}`
)

const mdWithImage = mod.renderMarkdownImage()
check(
  '正文里的图片可点放大（原版 RichTextView 的 onImageTap → 灯箱）',
  mdWithImage.includes('msg__img') && mdWithImage.includes('季度趋势'),
  mdWithImage.slice(mdWithImage.indexOf('<img'), mdWithImage.indexOf('<img') + 80)
)

// --- 设置面板（对齐原版 views/SettingsPanel.ets） ---
console.log('\n30. 设置面板')
const settingsHtml = mod.renderSettings()
const settingsText = decode(settingsHtml)
check(
  '面板整体可渲染（标题 + 表单主体）',
  settingsHtml.includes('dialog__body') && settingsText.includes('设置')
)
check(
  '三个可折叠小节都在：高级模型参数 / 本地联网搜索 / 多模态解析 API',
  settingsText.includes('高级模型参数') &&
    settingsText.includes('本地联网搜索') &&
    settingsText.includes('多模态解析 API (可选)')
)
check(
  '小节缺省全部收起（高级参数与多模态字段首帧不出现）',
  !settingsText.includes('数值越低回答越确定') && !settingsText.includes('先行解析附件'),
  '开合状态由 data-open 与条件渲染共同决定'
)
check(
  '开合指示是 SVG 图标而不是几何符号（check-emoji 会拦 ▲ / ▼）',
  settingsHtml.includes('settings-section__caret') &&
    !settingsHtml.includes('▲') &&
    !settingsHtml.includes('▼')
)
check(
  'Base URL 占位符按当前接入方式给出',
  settingsHtml.includes('https://api.openai.com/v1 或 https://api.deepseek.com')
)
check(
  '底部接入方式提示就是原版 completions 那一段',
  settingsText.includes('通用API接入方式') &&
    settingsText.includes('建议切换 Responses API 或 Anthropic API 选项')
)

const copyC = mod.settingsCopy('openai-completions', 'bing')
const copyR = mod.settingsCopy('openai-responses', 'tavily')
const copyA = mod.settingsCopy('anthropic-messages', 'metaso')
check(
  'completions：Base URL / 模型占位符逐字对齐原版',
  copyC.baseUrl === 'https://api.openai.com/v1 或 https://api.deepseek.com' &&
    copyC.model === 'deepseek-chat / deepseek-reasoner / gpt-...',
  `${copyC.baseUrl} | ${copyC.model}`
)
check(
  'responses：Base URL / 模型占位符逐字对齐原版',
  copyR.baseUrl === 'https://api.deepseek.com 或 https://ark.cn-beijing.volces.com/api/v3' &&
    copyR.model === 'deepseek-v4-flash / deepseek-v4-pro / ep-xxx',
  `${copyR.baseUrl} | ${copyR.model}`
)
check(
  'anthropic：Base URL / 模型占位符逐字对齐原版',
  copyA.baseUrl === 'https://api.anthropic.com/v1 或 https://api.deepseek.com' &&
    copyA.model === 'deepseek-v4-pro / deepseek-v4-flash / claude-...',
  `${copyA.baseUrl} | ${copyA.model}`
)
check(
  '三段底部提示随接入方式变化，且都是原版 getHint() 的文案',
  copyC.hint !== copyR.hint &&
    copyC.hint !== copyA.hint &&
    copyR.hint.includes('OpenAI Responses') &&
    copyA.hint.includes('Anthropic Messages')
)
check(
  '未知接入方式也退回一份占位符与提示（面板不能空着）',
  mod.providerCopy('nope').baseUrl !== '' && mod.providerCopy('nope').hint !== ''
)
check(
  '搜索提示按引擎 id 给（Bing / Tavily / Exa / Firecrawl / Metaso / 其它）',
  copyC.searchHint === 'Bing 无需 API Key, 直接爬取搜索结果页; 请求失败自动回落 cn.bing.com。' &&
    mod.searchEngineHint('tavily') === '默认 Base URL: https://api.tavily.com' &&
    mod.searchEngineHint('exa') === '默认 Base URL: https://api.exa.ai' &&
    mod.searchEngineHint('firecrawl') === '默认 Base URL: https://api.firecrawl.dev' &&
    mod.searchEngineHint('metaso') === '密钥在 metaso.cn 开放平台获取, 端点固定为 metaso.cn/api/v1/search。' &&
    mod.searchEngineHint('nope') === '在对应平台获取 API Key 后填入。'
)

const mmNorm = mod.normalizeMultimodal({
  baseUrl: '   ',
  apiKey: '  mk  ',
  model: '',
  preparseEnabled: false
})
check(
  '多模态空 Base URL / 模型名回落到默认值（空串会让「先行解析附件」直接失效）',
  mmNorm.baseUrl === 'https://open.bigmodel.cn/api/paas/v4' &&
    mmNorm.model === 'glm-4.6v-flash' &&
    mmNorm.apiKey === 'mk' &&
    mmNorm.preparseEnabled === false,
  `${mmNorm.baseUrl} / ${mmNorm.model}`
)
const mmKeep = mod.normalizeMultimodal({
  baseUrl: ' https://mm.example.com/v1 ',
  apiKey: '',
  model: ' glm-4v-flash ',
  preparseEnabled: true
})
check(
  '多模态填了值就按填的存（只 trim，不覆盖）',
  mmKeep.baseUrl === 'https://mm.example.com/v1' && mmKeep.model === 'glm-4v-flash'
)
const apiNorm = mod.normalizeApiConfig({
  provider: ' openai-completions ',
  baseUrl: '  https://api.deepseek.com  ',
  apiKey: ' sk-x ',
  model: ' deepseek-chat ',
  temperature: 0.7,
  topP: 0,
  maxTokens: 0,
  extraParams: '  {"a": 1}  ',
  autoSuffix: true
})
check(
  '保存前所有字符串 trim（对齐原版 buildConfig）',
  apiNorm.provider === 'openai-completions' &&
    apiNorm.baseUrl === 'https://api.deepseek.com' &&
    apiNorm.apiKey === 'sk-x' &&
    apiNorm.model === 'deepseek-chat' &&
    apiNorm.extraParams === '{"a": 1}' &&
    apiNorm.temperature === 0.7
)

// --- 提问卡片（ask_user_question）：工具会真的挂起，这张卡是「工具能不能用」的一半 ---
//
// 事故形状：这个工具曾被整个删掉 —— 因为原版的 AskUserCard.ets 没移植，工具挂起后
// 没有任何作答入口，只能等 5 分钟超时。恢复工具就必须把卡片一起恢复，
// 所以这里把单选/多选两种形态的产物与行为都钉住。
console.log('\n31. 提问卡片（ask_user_question）')
const askSingle = mod.renderAskCard(false)
const askMulti = mod.renderAskCard(true)
const askSingleText = decode(askSingle)
const askMultiText = decode(askMulti)

check('卡片标题是原版的「需要你的决定」', askSingleText.includes('需要你的决定'))
check('问题原文一字不差地显示出来', askSingleText.includes('这份季度复盘要交成什么？'))
check(
  '选项 chips 全部渲染出来',
  askSingleText.includes('内部汇报稿') &&
    askSingleText.includes('对外发布稿') &&
    askSingleText.includes('先给我看看大纲')
)
check('有「跳过，由智能体自行决定」这条出路', askSingleText.includes('跳过，由智能体自行决定'))
check('有提交按钮', askSingle.includes('askcard__submit') && askSingleText.includes('提交'))
check('有可选的文字补充输入', askSingle.includes('askcard__note'))
check(
  '单选形态：标记是圆点、右侧写「单选」',
  askSingle.includes('data-shape="dot"') && askSingleText.includes('单选')
)
check(
  '多选形态：标记是方框、右侧写「可多选」',
  askMulti.includes('data-shape="box"') && askMultiText.includes('可多选')
)
check(
  '两种形态的产物确实不同（不会把多选画成单选）',
  askSingle !== askMulti && !askSingle.includes('data-shape="box"')
)
check(
  '未勾选时两种形态的按钮都只是「提交」（数量只在多选且选中后出现）',
  mod.askSubmitLabel(false, 0) === '提交' &&
    mod.askSubmitLabel(false, 2) === '提交' &&
    mod.askSubmitLabel(true, 0) === '提交' &&
    mod.askSubmitLabel(true, 2) === '提交(2 项)',
  mod.askSubmitLabel(true, 2)
)
check(
  '单选：再点另一个是**替换**（不能同时选中两项）',
  JSON.stringify(mod.askToggleSelection(['内部汇报稿'], '对外发布稿', false)) ===
    JSON.stringify(['对外发布稿'])
)
check(
  '多选：再点另一个是**累加**',
  JSON.stringify(mod.askToggleSelection(['内部汇报稿'], '对外发布稿', true)) ===
    JSON.stringify(['内部汇报稿', '对外发布稿'])
)
check(
  '两种形态都支持取消勾选',
  JSON.stringify(mod.askToggleSelection(['内部汇报稿'], '内部汇报稿', false)) === '[]' &&
    JSON.stringify(mod.askToggleSelection(['内部汇报稿'], '内部汇报稿', true)) === '[]'
)
check(
  '卡片挂在时间线末尾（工作模式的 loop-timeline 那条路径也在渲染它）',
  mod.renderAskSlot().includes('loop-timeline')
)
check(
  '卡片产物里没有 emoji / 装饰符号',
  !/[\u2190-\u21ff\u2300-\u23ff\u2460-\u24ff\u25a0-\u25ff\u2600-\u27bf\u2b00-\u2bff\ufe0f\u{1f000}-\u{1faff}]/u.test(
    askSingle + askMulti
  )
)

console.log('\n32. @文件引用（输入框的候选弹层）')

const wsFile = (p) => ({ name: p, path: p, isDirectory: false, size: 10, modifiedAt: 0 })
const wsDir = (p) => ({ name: p, path: p, isDirectory: true, size: 0, modifiedAt: 0 })

check(
  '正在敲的 @ 片段会被识别（@ 的位置 + 已敲的路径片段）',
  JSON.stringify(mod.mentionDetect('改一下 @src/a.t', 12)) ===
    JSON.stringify({ start: 4, caret: 12, query: 'src/a.t' })
)
check(
  '刚敲下 @ 也算引用起点（此时列工作区里的文件供挑选）',
  mod.mentionDetect('参考 @', 4)?.query === ''
)
check(
  '@ 已经敲完（后面跟了空格）就不再打扰：引用结束，弹层该收起来',
  mod.mentionDetect('@a.md 改一下', 11) === null
)
check(
  '邮箱与 URL 里的 @ 不弹层（与内核同一口径，界面弹了内核也不认）',
  mod.mentionDetect('联系 someone@example.com', 24) === null &&
    mod.mentionDetect('见 https://x.io/@y', 17) === null
)
check(
  '光标移到引用之后（或句子中间）就不再弹（引用已经敲完了）',
  mod.mentionDetect('改一下 @a.md 和', 13) === null && mod.mentionDetect('改一下', 3) === null
)
check(
  '候选排序：文件名前缀 > 文件名包含 > 路径包含；目录不进候选（内核不附目录正文）',
  JSON.stringify(
    mod.mentionRank(
      [wsFile('my_report.md'), wsFile('report.md'), wsFile('reporting/data.csv'), wsDir('report')],
      'report'
    )
  ) === JSON.stringify(['report.md', 'my_report.md', 'reporting/data.csv'])
)
check(
  '空查询按层级由浅到深给，浅的在前（刚敲 @ 时最想要的就在最上面）',
  JSON.stringify(mod.mentionRank([wsFile('deep/a/b.md'), wsFile('top.md')], '')) ===
    JSON.stringify(['top.md', 'deep/a/b.md'])
)

const mentionPaths = ['src/a.ts', 'src/b.ts', 'README.md']
const popupHtml = mod.renderMentionPopup(mentionPaths, 1)
check(
  '弹层列出候选路径，高亮项就是键盘当前位置',
  popupHtml.includes('src/a.ts') && popupHtml.includes('src/b.ts') &&
    popupHtml.includes('README.md') && popupHtml.includes('mention__row--active') &&
    popupHtml.split('mention__row--active').length === 2
)
check(
  '弹层把键盘用法写在脸上（不写用户只会以为 @ 是打进去的字）',
  decode(popupHtml).includes('Enter/Tab 插入') && decode(popupHtml).includes('Esc 关闭')
)
check(
  '没有匹配候选时整层不渲染（空框比「什么都没有」的弹层更让人困惑）',
  mod.renderMentionPopup([], 0) === ''
)
check(
  '候选行数有上限（工作区几千个文件时不能把屏幕铺满）',
  (mod.renderMentionPopup(Array.from({ length: 40 }, (_, i) => 'f' + i + '.md'), 0).match(
    /class="mention__row/g
  ) || []).length === 8
)

const workComposer = mod.renderComposer('work')
check(
  '工作/交互模式的占位文案告诉用户能 @（这是个发现性问题，不写就等于没有）',
  workComposer.includes('@ 引用工作区文件') &&
    mod.renderComposer('interactive').includes('@ 引用工作区文件')
)
check(
  '聊天模式不提 @（那边没有工作区语义，素材入口是附件直传）',
  !mod.renderComposer('chat').includes('@ 引用工作区文件')
)
check(
  '弹层产物里没有 emoji / 装饰符号',
  !/[\u2190-\u21ff\u2300-\u23ff\u2460-\u24ff\u25a0-\u25ff\u2600-\u27bf\u2b00-\u2bff\ufe0f\u{1f000}-\u{1faff}]/u.test(
    popupHtml
  )
)

// --- 凭据落盘加密的用户口径（说错一个词，用户的安全假设就整个反过来） ---
const credOn = mod.credentialCopy({ available: true, undecryptable: [] })
const credOff = mod.credentialCopy({ available: false, undecryptable: [] })
const credLostOn = mod.credentialCopy({ available: true, undecryptable: ['guncat/apiKey'] })
const credLostOff = mod.credentialCopy({ available: false, undecryptable: ['guncat/apiKey'] })
const credUnknown = mod.credentialCopy(undefined)
check(
  '保险库可用：明说加密保存，且不谎称存在明文',
  credOn.includes('加密保存') &&
    credOn.includes('不含明文密钥') &&
    !credOn.includes('明文存在配置文件')
)
check(
  '保险库不可用：如实写「明文」，不能拿「仅存本机」糊过去',
  credOff.includes('明文存在配置文件') &&
    !credOff.includes('不含明文密钥') &&
    credOff.includes('没有可用的凭据保险库')
)
check(
  '保险库不可用也给出去路（配好钥匙串会自动转加密，不是让用户自己改代码）',
  credOff.includes('会自动改为加密保存')
)
check(
  '解不开的项要点名到具体键，否则用户只知道「Key 无效」不知道该重填哪一项',
  credLostOn.includes('guncat/apiKey') &&
    credLostOn.includes('解不开') &&
    credLostOff.includes('guncat/apiKey') &&
    credLostOff.includes('解不开')
)
check(
  '没有解不开的项时不提「解不开」（不能把一次性事故写成常驻警告）',
  !credOn.includes('解不开') && !credOff.includes('解不开')
)
check(
  '状态还没读到（首帧/旧进程）时退回中性文案，不宣称加密',
  credUnknown === '仅保存在本机应用数据目录，不会上传'
)
check(
  '两种状态都强调不上传（用户最怕的是密钥出境）',
  credOn.includes('不会上传') && credOff.includes('明文存在配置文件里（只有这台机器能读到）')
)
check(
  '设置面板首帧就把中性文案渲染出来（SSR 下 settings 还没到）',
  decode(mod.renderSettings()).includes('仅保存在本机应用数据目录，不会上传')
)

console.log(`\n渲染验证：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('失败项：')
  for (const f of failures) {
    console.log(`  - ${f}`)
  }
  process.exitCode = 1
}
