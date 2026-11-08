// 无头冒烟验证：在纯 Node 下跑通移植过来的业务内核。
//
// 为什么需要它：Electron 的 GUI 在本机沙箱里无法启动（进程被宿主作业对象拒绝），
// 但应用真正有风险的部分是「从鸿蒙移植过来的 3.5 万行业务逻辑」，
// 而不是 Electron 外壳。这个脚本把内核按真实调用链跑一遍，
// 用可复现的方式证明移植是活的。
//
// 运行：node scripts/run-smoke.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { initAppPaths } from '../src/core/platform/appPaths'
import { appContext, common } from '../src/core/platform/kit/AbilityKit'
import { AgentLoader } from '../src/core/service/AgentLoader'
import { WorkFileService } from '../src/core/service/WorkFileService'
import { WorkToolRunner } from '../src/core/service/WorkToolRunner'
import { WorkSkillService } from '../src/core/service/WorkSkillService'
import { PluginHotLoader } from '../src/core/service/PluginHotLoader'
import type { PluginManifestResult } from '../src/core/common/PluginManifestLoader'
import { filesDir, cacheDir, tempDir } from '../src/core/platform/appPaths'
import { StorageManager } from '../src/core/data/StorageManager'
import { ChatService, resolveEndpointUrl, buildChatCompletionsBody,
  buildAnthropicBody, extractAnthropicUsage, deriveStreamStats } from '../src/core/service/ChatService'
import { AgentLoopService, LoopMessage, ToolImageAttachment,
  LoopTurnCallbacks } from '../src/core/service/AgentLoopService'
import { SSEAdapterFactory } from '../src/core/service/SSEAdapterFactory'
import { ToolCallAccumulator } from '../src/core/service/ToolCallStream'
import { RetryPolicy } from '../src/core/common/RetryPolicy'
import { AbortSignal as LoopAbortSignal } from '../src/core/common/Types'
import { ApiConfig } from '../src/core/model/ApiConfig'
import { Conversation } from '../src/core/model/Conversation'
import { Message } from '../src/core/model/Message'
import { ToolRegistry } from '../src/core/common/ToolRegistry'
import { GuncatUiPrompt } from '../src/core/common/GuncatUiPrompt'
import { GuncatUiLibrary } from '../src/core/common/GuncatUiLibrary'
import { PromptBuilder } from '../src/core/common/PromptBuilder'
import { InteractiveTiers } from '../src/core/common/InteractiveTiers'
import { InteractiveTierPrompts } from '../src/core/common/InteractiveTierPrompts'
import { InteractiveTierPrompt } from '../src/core/common/InteractiveTierPrompt'
import { GuncatUiLang } from '../src/core/common/GuncatUiLang'
import { Constants } from '../src/core/common/Constants'
import { PersonalInstruction } from '../src/core/model/PersonalInstruction'
import { PersonalInstructionPrompt } from '../src/core/common/PersonalInstructionPrompt'
import { PersonalInstructionStore } from '../src/core/service/PersonalInstructionStore'
import { Agent } from '../src/core/model/Agent'
import {
  addUsageRecordToLedger,
  aggregateUsageRange,
  buildUsageCsv,
  buildUsageHeatmap,
  createEmptyUsageLedger,
  cropUsageLedger
} from '../src/core/common/UsageAggregate'
import {
  USD_CNY_RATE,
  priceDeepSeekUsage
} from '../src/core/common/UsagePricing'
import {
  beijingDateKey,
  buildUsageRecord,
  mergeUsageObjects,
  normalizeUsageTokens,
  usagePeriodAt,
  usageTotalInputTokens
} from '../src/core/common/UsageProtocol'
import type { UsageLedgerFile, UsageRecord } from '../src/core/common/UsageTypes'
import { UsageService } from '../src/core/service/UsageService'
import { DataPipeline } from '../src/core/common/DataPipeline'
import { runJs } from '../src/core/platform/native/libguncatjs'
import { http as guncatHttp } from '../src/core/platform/kit/NetworkKit'
import {
  installPdfJsBackend,
  renderPdfPageToPng,
  itemsToText,
  itemsToObjects
} from '../src/core/platform/native/pdfBackend'

/**
 * 造一个最小但结构完整的 PDF（未压缩内容流 + Helvetica + WinAnsi）。
 *
 * 为什么要自己造：工作区与上游鸿蒙项目里都没有现成的 PDF 文件，而「PDF 解析」
 * 恰恰是最需要回归保护的一段（它曾经对任何 PDF 都报「文档结构损坏」）。
 * 夹具只用 ASCII —— WinAnsi 单字节编码写不进中文，硬塞进去会得到乱码，
 * 反而让断言变得不可信。
 */
function makeTestPdf(lines: string[]): Buffer {
  const content = lines.map((t, i) => `BT /F1 24 Tf 72 ${720 - i * 40} Td (${t}) Tj ET`).join('\n')
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  ]
  // xref 的偏移必须逐字节准确，否则解析器会判结构损坏 —— 这也正是夹具自身的有效性检查
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefPos = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    out += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}${detail !== '' ? ' — ' + detail : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail !== '' ? ' — ' + detail : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

async function main(): Promise<void> {
  const root = path.join(os.tmpdir(), `guncat-smoke-${Date.now()}`)
  const resourcesRoot = path.resolve('resources')
  initAppPaths({ dataRoot: root, resourcesRoot })
  const ctx = appContext()

  console.log(`数据目录: ${root}`)
  console.log(`资源目录: ${resourcesRoot}`)

  // ===== 1. 平台路径 =====
  section('1. 平台适配层 · 应用路径')
  check('filesDir 已创建', fs.existsSync(ctx.filesDir), ctx.filesDir)
  check('tempDir 已创建', fs.existsSync(ctx.tempDir))
  check('resourceManager 可读 agents.json', ctx.resourceManager.getRawFileContentSync('agents.json').length > 0)

  // ===== 插件热加载 =====
  //
  // `WorkToolRunner` 早就会分发插件工具、随包也有 plugins/plugin_list.json，
  // 但一直没有加载器 —— 于是插件工具一律返回「插件未实现」。
  // 这里用一份临时的插件目录把「读清单 → 解析 → 注册进 ToolRegistry」这条链跑通。
  section('插件热加载（plugin_list.json → ToolRegistry）')
  const pluginRoot = path.join(root, 'plugin-resources')
  fs.mkdirSync(path.join(pluginRoot, 'plugins'), { recursive: true })
  fs.writeFileSync(
    path.join(pluginRoot, 'plugins', 'plugin_list.json'),
    JSON.stringify(['demo.json', 'broken.json', 'missing.json']),
    'utf8'
  )
  fs.writeFileSync(
    path.join(pluginRoot, 'plugins', 'demo.json'),
    JSON.stringify({
      id: 'demo_plugin',
      version: '1',
      category: 'plugin',
      permissions: [],
      tools: [
        {
          name: 'demo_plugin_tool',
          description: '示例插件工具',
          parameters: { type: 'object', properties: {} },
          readOnly: true,
          mutating: false,
          timeoutMs: 5000,
          maxRetries: 1
        }
      ],
      skills: []
    }),
    'utf8'
  )
  // 一份解析不了的 manifest：应当只影响这一个插件
  fs.writeFileSync(path.join(pluginRoot, 'plugins', 'broken.json'), '{ 这不是 JSON', 'utf8')
  // 直接用一份指向临时插件目录的上下文（appContext 是进程级单例，不能再换根目录）
  const pluginCtx = new common.UIAbilityContext(filesDir(), cacheDir(), tempDir(), pluginRoot)
  const pluginResults: PluginManifestResult[] = await PluginHotLoader.loadAll(pluginCtx)
  check(
    '插件清单里声明的插件被加载（loadAll 此前零调用点）',
    PluginHotLoader.loadedCount() === 1,
    PluginHotLoader.loadedSummary()
  )
  check(
    '插件工具真的注册进了工具表（否则调用时只会返回「插件未实现」）',
    ToolRegistry.defs('').some((d) => (d as unknown as Record<string, unknown>).name === 'demo_plugin_tool'),
    PluginHotLoader.loadedSummary()
  )
  check(
    '坏掉的 manifest 只让那一个插件失败，不影响其他',
    pluginResults.filter((r) => !r.ok).length === 2 &&
      pluginResults.some((r) => r.error.indexOf('parse_failed') === 0) &&
      pluginResults.some((r) => r.error.indexOf('read_failed') === 0),
    pluginResults.map((r) => r.error || 'ok').join(' | ')
  )
  PluginHotLoader.unloadAll()
  check('卸载后工具表里不再有插件工具（unloadAll 幂等）', PluginHotLoader.loadedCount() === 0)
  const noListCtx = new common.UIAbilityContext(filesDir(), cacheDir(), tempDir(), root)
  const noList: PluginManifestResult[] = await PluginHotLoader.loadAll(noListCtx)
  check('没有插件清单时视为没有插件（不抛错、不阻断启动）', noList.length === 0)


  // ===== 2. 智能体加载（rawfile → 文件系统） =====
  section('2. 智能体加载（rawfile 适配）')
  const agents = await AgentLoader.loadAllAgents(ctx)
  check('智能体数量 > 0', agents.length > 0, `${agents.length} 个`)
  const named = agents.filter((a) => a.name !== '')
  check('智能体均有名称', named.length === agents.length)
  const withPrompt = agents.filter((a) => a.systemPrompt.length > 200)
  check('智能体提示词已加载', withPrompt.length > 0, `${withPrompt.length}/${agents.length} 个提示词 > 200 字`)

  // ===== 3. 工具注册表 =====
  section('3. 内置工具表')
  const toolDefs = WorkFileService.toolDefs(false)
  const toolNames = toolDefs.map((d) => String((d as Record<string, unknown>)['name'] ?? ''))
  check('工具数量 > 0', toolDefs.length > 0, `${toolDefs.length} 个`)
  for (const required of ['write_file', 'read_file', 'list_files', 'run_js', 'transform_file', 'todo_write']) {
    check(`包含核心工具 ${required}`, toolNames.includes(required))
  }
  const interactive = AgentLoopService.interactiveToolDefs(false)
  check(
    '交互模式工具面被裁剪（少于工作模式）',
    interactive.length > 0 && interactive.length < toolDefs.length,
    `工作 ${toolDefs.length} → 交互 ${interactive.length}`
  )

  // ===== 4. 技能库 =====
  section('4. 技能库（rawfile 技能文档）')
  // 技能是「用到才同步进注册中心」的：先取目录文本触发一次扫描
  const skillText = WorkSkillService.listText()
  check('技能目录文本非空', skillText.length > 0, `${skillText.length} 字`)
  const skills = ToolRegistry.skillList()
  check('技能已同步进工具注册中心', skills.length > 0, `${skills.length} 项`)
  const loaded = await WorkSkillService.load(ctx, 'data', 'SKILL.md')
  check('可按需加载技能正文', loaded.length > 100, `data/SKILL.md ${loaded.length} 字`)

  // ===== 5. 沙箱工作区文件操作 =====
  section('5. 沙箱工作区')
  const convId = 'smoke-conv-1'
  WorkFileService.ensureWorkspace(ctx, convId)
  const wsRoot = WorkFileService.workspaceRoot(ctx, convId)
  check('工作区目录已建立', fs.existsSync(wsRoot), wsRoot)

  const write = await WorkToolRunner.execute(
    ctx,
    convId,
    'write_file',
    JSON.stringify({ path: 'notes/demo.txt', content: 'line1\nline2\nline3\n' })
  )
  check('write_file 成功', write.ok, write.output.slice(0, 120))

  const read = await WorkToolRunner.execute(ctx, convId, 'read_file', JSON.stringify({ path: 'notes/demo.txt' }))
  check('read_file 读回原文', read.ok && read.output.includes('line2'), read.output.slice(0, 80))

  const list = await WorkToolRunner.execute(ctx, convId, 'list_files', JSON.stringify({ path: '.' }))
  check('list_files 能列出产物', list.ok && list.output.includes('notes'))

  const tree = WorkFileService.listWorkspaceTree(ctx, convId)
  check('工作区树可用', tree.includes('notes'))

  // ===== 6. run_js 沙箱（node:vm 替代 JSVM） =====
  section('6. run_js 沙箱（node:vm 实现）')
  const js = await WorkToolRunner.execute(
    ctx,
    convId,
    'run_js',
    JSON.stringify({ code: 'const xs=[1,2,3,4]; const s=xs.reduce((a,b)=>a+b,0); ' + '"合计 " + s' })
  )
  check('run_js 执行成功', js.ok, js.output.split('\n').slice(0, 2).join(' | '))
  check('run_js 返回最后表达式值', js.output.includes('合计 10'))

  // 输入文件桥接（注意 files 的 schema 类型是 string，支持逗号分隔或 JSON 数组）
  const jsFiles = await WorkToolRunner.execute(
    ctx,
    convId,
    'run_js',
    JSON.stringify({
      files: 'notes/demo.txt',
      code: 'inputs["notes/demo.txt"].split("\\n").filter(Boolean).length'
    })
  )
  check('run_js 可读工作区输入文件', jsFiles.ok && jsFiles.output.includes('3'), jsFiles.output.slice(0, 90))

  // write() 落盘
  const jsWrite = await WorkToolRunner.execute(
    ctx,
    convId,
    'run_js',
    JSON.stringify({ code: 'write("out/gen.txt", "来自 run_js"); "written"' })
  )
  check('run_js write() 落盘', jsWrite.ok && fs.existsSync(path.join(wsRoot, 'out/gen.txt')))

  // 死循环必须被真正中断（上游用 JSVM 时做不到）
  const startedAt = Date.now()
  const loop = await runJs('while(true){}', {
    inputs: {},
    stdoutLimitKb: 8,
    outputFileLimitKb: 64,
    outputTotalLimitKb: 128,
    maxOutputFiles: 4
  })
  const elapsed = Date.now() - startedAt
  check('run_js 死循环被引擎中断而非挂死', !loop.ok && elapsed < 25_000, `${elapsed}ms, error=${loop.error.slice(0, 40)}`)

  // ===== 7. 数据管道（transform_file 底层） =====
  section('7. 数据管道 DataPipeline')
  const table = DataPipeline.parseInput('a,b\n1,2\n3,4', 'csv', ',', '')
  check('DataPipeline 可解析 CSV', table !== null && table.rows.length === 3, `${table.rows.length} 行`)
  const csvOut = DataPipeline.toCsvRows(table, true)
  check('DataPipeline 可回写 CSV', csvOut.length === 3 && csvOut[0].join(',') === 'a,b')

  // ===== 8. 持久化往返 =====
  section('8. 对话持久化往返')
  const conv = Conversation.create(agents[0]?.id ?? '', '冒烟测试', 'work')
  conv.messages.push(Message.ofUser('m1', '你好', '你好', []))
  conv.messages.push(Message.ofAssistant('m2', '收到'))
  await StorageManager.saveConversations(ctx, [conv])
  const reloaded = await StorageManager.loadConversations(ctx)
  check('对话数量往返一致', reloaded.length === 1)
  check('消息内容往返一致', reloaded[0]?.messages.length === 2 && reloaded[0]?.messages[1]?.content === '收到')
  check('模式字段往返一致', reloaded[0]?.mode === 'work')

  // ===== 9. 三协议端点解析 =====
  section('9. 三协议端点解析')
  const cases: Array<[string, string, string]> = [
    ['openai-completions', 'https://api.deepseek.com', '/chat/completions'],
    ['openai-responses', 'https://api.deepseek.com', '/responses'],
    ['anthropic-messages', 'https://api.deepseek.com/anthropic', '/messages']
  ]
  for (const [provider, baseUrl, suffix] of cases) {
    const cfg = new ApiConfig()
    cfg.provider = provider
    cfg.baseUrl = baseUrl
    const url = resolveEndpointUrl(cfg, ChatService ? (await import('../src/core/service/ChatService')).getProtocol(provider) : provider)
    check(`${provider} 端点拼接`, url.endsWith(suffix), url)
  }

  // ===== 10. 交互模式语言（guncat-ui lang） =====
  section('10. 交互模式语言解析')
  const basicProgram = 'root = Card([TextContent("你好")])'
  const parsedBasic = GuncatUiLang.parse(basicProgram)
  check('guncat-ui lang 可解析', parsedBasic !== null)

  // ===== 11. 工作区打包 =====
  section('11. 工作区 zip 打包')
  const zip = WorkFileService.zipWorkspace(ctx, convId)
  check('zipWorkspace 产出字节', zip.byteLength > 0, `${zip.byteLength} 字节`)
  check('zip 魔数正确', zip[0] === 0x50 && zip[1] === 0x4b, 'PK')

  // ===== 12. Word/Excel 生成器（export 层） =====
  section('12. Office 生成器')
  const { DocxBuilder } = await import('../src/core/export/DocxBuilder')
  const { DocParser } = await import('../src/core/export/DocModel')
  const docJson = JSON.stringify({
    title: '冒烟',
    blocks: [{ type: 'paragraph', text: '正文内容' }]
  })
  const doc = DocParser.parse(docJson)
  check('DocModel 可解析 Doc JSON', doc !== null && doc.blocks.length > 0, `${doc.blocks.length} 块`)
  const docxBytes = await DocxBuilder.buildDocxBytes(doc, {
    resolve: async () => null
  } as never)
  check('DocxBuilder 产出 zip 字节', docxBytes.byteLength > 0 && docxBytes[0] === 0x50, `${docxBytes.byteLength} 字节`)

  // 公式回归: 命令后的上下标必须绑定到命令原子(\\mu_0 / \\bar{I}^2 曾被吞成空 m:t)
  const { OmmlConverter } = await import('../src/core/export/OmmlConverter')
  OmmlConverter.beginAudit()
  const muXml = OmmlConverter.inline('\\mu_0')
  const alphaXml = OmmlConverter.inline('\\alpha_2')
  const barXml = OmmlConverter.inline('\\bar{I}^2')
  const mathAudit = OmmlConverter.takeAudit()
  check('\\mu_0 生成下标', muXml.includes('<m:sSub>') && muXml.includes('>0<'), muXml)
  check('\\alpha_2 生成下标', alphaXml.includes('<m:sSub>') && alphaXml.includes('>2<'), alphaXml)
  check('\\bar{I}^2 上标绑定到重音组', barXml.includes('<m:sSup>') && barXml.includes('>2<'), barXml)
  check('\\bar 只生成一层上划线', (barXml.match(/<m:bar>/g) ?? []).length === 1 &&
    !barXml.includes('<m:acc>'), barXml)
  check('正常公式不产生空 m:t', !muXml.includes('<m:t/>') && !alphaXml.includes('<m:t/>'), muXml)
  check('正常公式无未识别命令', mathAudit.unknownCommands.length === 0, mathAudit.unknownCommands.join(','))

  // 真机自检报告里的 8 类公式问题(与鸿蒙版共用同一解析器)
  const bmatrixXml = OmmlConverter.inline('\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}')
  const casesXml = OmmlConverter.inline('\\begin{cases} x & y \\\\ z & w \\end{cases}')
  const alignedXml = OmmlConverter.inline('\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}')
  const mathbbXml = OmmlConverter.inline('\\mathbb{R}^n')
  const mathrmXml = OmmlConverter.inline('\\mathrm{m/s^2}')
  const normXml = OmmlConverter.inline('\\|\\mathbf{x}\\|_2')
  const floorXml = OmmlConverter.inline('\\lfloor x\\rfloor')
  const midXml = OmmlConverter.inline('\\mid')
  const transposeXml = OmmlConverter.inline('\\mathbf{w}^T')
  const arraySpecXml = OmmlConverter.inline('\\begin{array}{ll} a & b \\\\ c & d \\end{array}')
  const tagXml = OmmlConverter.inline('\\tag{1} x')
  check('bmatrix 右定界符正确', bmatrixXml.includes('<m:endChr m:val="]"/>'), bmatrixXml)
  check('cases 生成左大括号', casesXml.includes('<m:begChr m:val="{"/>') &&
    casesXml.includes('<m:endChr m:val=""/>'), casesXml)
  check('aligned 使用 eqArr', alignedXml.includes('<m:eqArr>'), alignedXml)
  check('mathbb 保留双线体与上标', mathbbXml.includes('ℝ') && mathbbXml.includes('<m:sSup>'), mathbbXml)
  check('mathrm 解析组内上标', mathrmXml.includes('<m:sSup>') && !mathrmXml.includes('^'), mathrmXml)
  check('范数双竖线且下标绑定', normXml.includes('‖') && normXml.includes('<m:sSub>'), normXml)
  check('lfloor/rfloor 映射为符号', floorXml.includes('⌊') && floorXml.includes('⌋'), floorXml)
  check('mid 映射为符号', midXml.includes('∣'), midXml)
  check('mathbf 后的上标不再丢失', transposeXml.includes('<m:sSup>'), transposeXml)
  check('array 列格式不泄漏', !arraySpecXml.includes('ll'), arraySpecXml)
  check('tag 参数被消费', !tagXml.includes('tag'), tagXml)

  // 自检: 未知命令必须拒绝写盘, 而不是静默生成坏文件
  const { DocxAudit } = await import('../src/core/export/DocxAudit')
  const badAudit = DocxAudit.scan('<w:document><w:p><m:oMath><m:r><m:t>\\foo</m:t></m:r></m:oMath></w:p></w:document>',
    ['foo'], [], 1)
  let rejected = false
  try {
    badAudit.assertClean()
  } catch (e) {
    rejected = true
  }
  check('未知命令被自检拒绝', rejected, badAudit.report())

  const { XlsxBuilder } = await import('../src/core/export/XlsxBuilder')
  const { XlsxParser } = await import('../src/core/export/XlsxModel')
  const workbookJson = JSON.stringify({
    sheets: [{ name: 'S1', rows: [['a', 'b'], [1, 2]] }]
  })
  const workbook = XlsxParser.parse(workbookJson)
  check('XlsxModel 可解析 Workbook JSON', workbook !== null && workbook.sheets.length > 0)
  const xlsxBytes = XlsxBuilder.buildXlsxBytes(workbook)
  check('XlsxBuilder 产出 zip 字节', xlsxBytes.byteLength > 0 && xlsxBytes[0] === 0x50, `${xlsxBytes.byteLength} 字节`)

  const { PptxBuilder } = await import('../src/core/export/PptxBuilder')
  const { DeckParser } = await import('../src/core/export/DeckModel')
  const deckJson = JSON.stringify({
    title: '冒烟演示',
    slides: [{ layout: 'cover', title: '你好', subtitle: '世界' }]
  })
  const deck = DeckParser.parse(deckJson)
  check('DeckModel 可解析 Deck JSON', deck !== null && deck.slides.length > 0)
  const pptxBytes = await PptxBuilder.buildPptxBytes(deck, {
    resolve: async () => null
  } as never)
  check('PptxBuilder 产出 zip 字节', pptxBytes.byteLength > 0 && pptxBytes[0] === 0x50, `${pptxBytes.byteLength} 字节`)

  // ===== 13. 交互模式：解析 → 绑定 → 动作 → 回传 =====
  section('13. 交互模式（guncat-ui lang 全链路）')
  const { GuncatUiLang: UiLang, UiNode: UiNodeRef } = await import('@core/common/GuncatUiLang')
  const { GuncatUiRuntime: UiRuntime } = await import('@core/common/GuncatUiRuntime')
  const { GuncatUiState: UiState, GuncatUiTrailer: UiTrailer } = await import(
    '@core/common/GuncatUiRuntime'
  )
  const { GuncatUiParts: UiParts } = await import('@core/common/GuncatUiParts')

  const PROGRAM = [
    '$amount = 30',
    'root = Card([',
    '  CardHeader("季度复盘", "示例界面"),',
    '  TextContent("金额 " + $amount + " 万"),',
    '  Slider("amount", "discrete", 0, 200, 5, [30], "金额", $amount),',
    '  MetricIndicatorInline("" + $amount * 2, "两倍"),',
    '  Button("按 30 天口径重算", @ToAssistant("按 30 天口径重算"))',
    '])'
  ].join('\n')

  const uiProgram = UiLang.parse(PROGRAM)
  check('程序解析无错误', uiProgram.errors.length === 0, uiProgram.errors.join('；'))
  check('入口 root 已解析', uiProgram.root !== null && uiProgram.root.type === 'Card')
  // 绑定变量的键名带 $ 前缀（与语句 id 一致）
  check(
    '$变量默认值已收集',
    uiProgram.state['$amount'] === 30,
    `keys=${Object.keys(uiProgram.state).join(',')}`
  )

  const root0 = UiLang.render(uiProgram, null)
  const cardChildren = (root0 === null ? [] : ((root0.props['children'] as unknown[]) ?? [])) as Array<{
    type: string
    props: Record<string, unknown>
  }>
  check('Card 子元素数量正确', cardChildren.length === 5, `${cardChildren.length} 个`)
  check(
    '表达式已求值（金额 30 万）',
    String(cardChildren[1].props['text']) === '金额 30 万',
    String(cardChildren[1].props['text'])
  )

  // 改绑定值 → 重新物化：表达式必须按新值重算
  const uiState = UiState.of(uiProgram, null)
  uiState.set('$amount', 45 as unknown as object)
  const root1 = UiLang.render(uiProgram, uiState.values)
  const cardChildren1 = (root1 === null ? [] : ((root1.props['children'] as unknown[]) ?? [])) as Array<{
    type: string
    props: Record<string, unknown>
  }>
  check(
    '改绑定值后表达式重算（金额 45 万）',
    String(cardChildren1[1].props['text']) === '金额 45 万',
    String(cardChildren1[1].props['text'])
  )
  check(
    '派生表达式同步更新（45*2=90）',
    String(cardChildren1[3].props['value']) === '90',
    String(cardChildren1[3].props['value'])
  )

  // 动作：@ToAssistant 需要被收集成回传文案
  const buttonSteps = UiNodeRef.actionSteps(cardChildren1[4] as never, 'action')
  check('按钮动作可解析', buttonSteps.length > 0, `${buttonSteps.length} 步`)
  check('回传文案取自 @ToAssistant', UiRuntime.collectMessages(buttonSteps)[0] === '按 30 天口径重算')

  // 状态尾标记往返
  const stateJson = JSON.stringify({ $amount: 45 })
  const withTrailer = UiTrailer.append(PROGRAM, stateJson)
  const splitTrailer = UiTrailer.split(withTrailer)
  check('尾标记可剥离', splitTrailer.body.trim() === PROGRAM.trim())
  check('尾标记可还原状态', splitTrailer.stateJson === stateJson && splitTrailer.hasState)
  const restoredState = UiState.of(uiProgram, UiState.fromJson(splitTrailer.stateJson))
  check('状态恢复后覆盖默认值', restoredState.num('$amount', 0) === 45, `amount=${restoredState.num('$amount', 0)}`)

  // 正文拆分：Markdown + 界面程序混合
  const mixed = '先看一段说明。\n\n```guncat-ui\n' + PROGRAM + '\n```\n'
  const uiParts = UiParts.build(mixed, true)
  check('拆分出界面片段', uiParts.hasUi && uiParts.segments.some((s) => s.type === 'ui'))
  check('纯文本已剥离程序', !uiParts.textOnly.includes('root = Card'), uiParts.textOnly.slice(0, 40))
  check('文本片段保留说明文字', uiParts.textOnly.includes('先看一段说明'))
  const uiSeg = uiParts.segments.find((s) => s.type === 'ui')
  check('界面片段带标题', uiSeg !== undefined && uiSeg.title === '季度复盘', uiSeg?.title ?? '')

  // 表单回传：字段值 + 提交诉求打包
  const FORM = [
    'root = Card([',
    '  Form("参数设置", Buttons([Button("重新计算", @ToAssistant("换口径重算"))]), [',
    '    FormControl("口径", Select("scope", [SelectItem("customers", "按客户"), SelectItem("orders", "按订单")], "请选择", {}, $scope)),',
    '    FormControl("周期", Slider("days", "discrete", 7, 90, 1, [30], "天数", $days))',
    '  ])',
    '])'
  ].join('\n')
  const formProgram = UiLang.parse(FORM)
  const formRoot = UiLang.render(formProgram, null)
  const formEl = ((formRoot?.props['children'] as unknown[])[0] ?? null) as never
  const formState = UiState.of(formProgram, null)
  formState.set('$scope', 'orders' as unknown as object)
  formState.set('$days', 45 as unknown as object)
  const formBody = UiRuntime.formMessage(formEl, formState)
  check(
    '表单字段值可收集',
    formBody.includes('orders') && formBody.includes('45'),
    formBody.replace(/\n/g, ' | ')
  )
  const interaction = UiRuntime.interactionText('参数设置', formBody)
  check('回传文案带交互界面标记', interaction.startsWith('【交互界面回传】'), interaction.split('\n')[0])

  // 图表数据：series/labels 能取出
  const CHART = [
    's1 = Series("本季", [120, 132, 101])',
    's2 = Series("上季", [90, 110, 95])',
    'root = Card([BarChart(["1月","2月","3月"], [s1, s2], "grouped", "月份", "万元", 200)])'
  ].join('\n')
  const chartProgram = UiLang.parse(CHART)
  const chartRoot = UiLang.render(chartProgram, null)
  const chartEl = ((chartRoot?.props['children'] as unknown[])[0] ?? null) as {
    type: string
    props: Record<string, unknown>
  } | null
  check('图表元素类型正确', chartEl !== null && chartEl.type === 'BarChart')
  check('图表 labels 可取出', (chartEl?.props['labels'] as string[])?.join(',') === '1月,2月,3月')
  check('图表 series 可取出', ((chartEl?.props['series'] as unknown[]) ?? []).length === 2)

  // 容错：流式中间态（未闭合）也应能解析出部分内容
  const partial = UiLang.parse('root = Card([TextContent("半句")')
  check('未闭合程序可容错解析', partial.root !== null, `incomplete=${partial.incomplete}`)

  // 未知组件：按上游约定「丢弃并给出诊断」，但不能影响同一块里的其它组件
  const unknownProgram = UiLang.parse('root = Card([NoSuchComp("x"), TextContent("还在")])')
  const unknownRoot = UiLang.render(unknownProgram, null)
  const unknownChildren = (unknownRoot?.props['children'] as unknown[]) ?? []
  check('未知组件被丢弃并给出诊断', unknownProgram.errors.length > 0, unknownProgram.errors.join('；'))
  check('未知组件不影响同一块的其它组件', unknownChildren.length === 1, `${unknownChildren.length} 个子元素`)

  // 文本字段截断：模型偶尔漏转义引号 / 用单引号包英文撇号 / 路径以反斜杠结尾。
  // 这些都不该让副标题只剩前半句，更不该吞掉后面的组件。
  const quoteCases: Array<{ name: string; source: string; subtitle: string }> = [
    {
      name: '正文引号漏转义',
      source: 'root = Card([h, b])\nh = CardHeader("标题", "本月"增长"明显")\nb = TextContent("后续")',
      subtitle: '本月"增长"明显'
    },
    {
      name: '单引号里的英文撇号',
      source: "root = Card([h, b])\nh = CardHeader('标题', 'It's a test, with more text')\nb = TextContent('后续')",
      subtitle: "It's a test, with more text"
    },
    {
      name: '引号后跟逗号',
      source: 'root = Card([h, b])\nh = CardHeader("标题", "He said "Hi," then left")\nb = TextContent("后续")',
      subtitle: 'He said "Hi," then left'
    },
    {
      name: 'Windows 路径以反斜杠结尾',
      source: 'root = Card([h, b])\nh = CardHeader("路径", "C:\\Users\\name\\")\nb = TextContent("后续")',
      subtitle: 'C:\\Users\\name\\'
    }
  ]
  for (const item of quoteCases) {
    const parsed = UiLang.parse(item.source)
    const rendered = UiLang.render(parsed, null)
    const children = (rendered?.props['children'] as unknown[]) ?? []
    const header = children[0] as never
    const subtitle = header === undefined ? '' : UiNodeRef.str(header, 'subtitle', '')
    const tail = children[1] as never
    check(`${item.name}：副标题不截断`, subtitle === item.subtitle, JSON.stringify(subtitle))
    check(`${item.name}：后续组件仍在`, children.length === 2 && UiNodeRef.str(tail, 'text', '') === '后续')
  }

  // 全角逗号/括号：模型中文输出里很常见，旧词法器会直接跳过分隔符并把后一个参数丢掉
  const fullWidthProgram = UiLang.parse(
    'root = Card([h, b])\nh = CardHeader（"标题"，"副标题后半"）\nb = TextContent("后续")'
  )
  const fullWidthRoot = UiLang.render(fullWidthProgram, null)
  const fullWidthChildren = (fullWidthRoot?.props['children'] as unknown[]) ?? []
  const fullWidthHeader = fullWidthChildren[0] as never
  check(
    '全角逗号/括号不再丢副标题',
    fullWidthHeader !== undefined && UiNodeRef.str(fullWidthHeader, 'subtitle', '') === '副标题后半',
    fullWidthHeader === undefined ? '无标题' : UiNodeRef.str(fullWidthHeader, 'subtitle', '')
  )
  check(
    '全角分隔符之后的组件仍在',
    fullWidthChildren.length === 2 && UiNodeRef.str(fullWidthChildren[1] as never, 'text', '') === '后续'
  )

  // 顶层 + 拼接跨行（模型把长字符串拆成两行）
  const continuation = UiLang.parse('sub = "前半" +\n  "后半"\nroot = Card([h])\nh = CardHeader("标题", sub)')
  const continuationRoot = UiLang.render(continuation, null)
  const continuationHeader = ((continuationRoot?.props['children'] as unknown[]) ?? [])[0] as never
  check(
    '顶层 + 拼接跨行不丢后半句',
    continuationHeader !== undefined && UiNodeRef.str(continuationHeader, 'subtitle', '') === '前半后半',
    continuationHeader === undefined ? '无标题' : UiNodeRef.str(continuationHeader, 'subtitle', '')
  )

  // 单个文本字段不再被 4000 字上限悄悄砍掉
  const longTail = '结尾锚点'
  const longProgram = UiLang.parse(
    'root = Card([t])\nt = TextContent("' + '甲'.repeat(5000) + longTail + '")'
  )
  const longRoot = UiLang.render(longProgram, null)
  const longChildren = (longRoot?.props['children'] as unknown[]) ?? []
  const longChild = longChildren.length > 0 ? (longChildren[0] as never) : null
  const longText = longChild === null ? '' : UiNodeRef.str(longChild, 'text', '')
  check('长文本字段保留到结尾锚点', longText.endsWith(longTail), `${longText.length} 字`)

  // ===== 15. Office 工具链（走真实的工具分发，而不是直接调生成器） =====
  section('15. Office 工具链（WorkToolRunner 端到端）')

  const callTool = async (name: string, args: Record<string, unknown>) =>
    WorkToolRunner.execute(ctx, convId, name, JSON.stringify(args), null)

  // --- Word：Markdown → .docx → 读回 ---
  const docxWrite = await callTool('write_docx', {
    path: 'out/报告.docx',
    markdown: '# 季度报告\n\n正文第一段。\n\n- 要点一\n- 要点二\n\n| 区域 | 营收 |\n| --- | --- |\n| 华东 | 820 |\n',
    title: '季度报告'
  })
  check('write_docx 成功', docxWrite.ok, docxWrite.output.slice(0, 120))
  check('docx 文件已落盘', fs.existsSync(path.join(wsRoot, 'out/报告.docx')))
  const docxFileBytes = fs.existsSync(path.join(wsRoot, 'out/报告.docx'))
    ? fs.readFileSync(path.join(wsRoot, 'out/报告.docx'))
    : Buffer.alloc(0)
  check('docx 是合法 zip(PK 魔数)', docxFileBytes.length > 0 && docxFileBytes[0] === 0x50, `${docxFileBytes.length} 字节`)

  const docxRead = await callTool('read_docx', { path: 'out/报告.docx' })
  check('read_docx 可读回', docxRead.ok, docxRead.output.slice(0, 100))
  check('读回内容无损（含标题）', docxRead.output.includes('季度报告'))

  // --- Word 公式：命令上下标 + 生成后自检 + 坏公式拒绝写盘 ---
  const formulaWrite = await callTool('write_docx', {
    path: 'out/公式.docx',
    doc: JSON.stringify({
      title: '公式',
      blocks: [
        { type: 'paragraph', text: '$\\mu_0$、$\\alpha_2$、$\\bar{I}^2$、$Uₐ$' },
        { type: 'paragraph', text: '$$\\sum_{i=1}^{n} x_i$$' }
      ]
    })
  })
  check('公式文档生成成功', formulaWrite.ok, formulaWrite.output.slice(0, 160))
  check('返回值含公式自检证据', formulaWrite.output.includes('空 m:t 节点 0') &&
    formulaWrite.output.includes('oMathPara 父元素合规'), formulaWrite.output)
  const badFormulaPath = path.join(wsRoot, 'out/坏公式.docx')
  const badFormulaWrite = await callTool('write_docx', {
    path: 'out/坏公式.docx',
    doc: JSON.stringify({
      title: '坏公式',
      blocks: [{ type: 'paragraph', text: '$\\foo{x}$' }]
    })
  })
  check('未识别命令被拒绝写盘', !badFormulaWrite.ok && !fs.existsSync(badFormulaPath),
    badFormulaWrite.output.slice(0, 160))

  // --- Excel：Workbook JSON → .xlsx → 读回 ---
  const xlsxWrite = await callTool('write_xlsx', {
    path: 'out/营收.xlsx',
    workbook: JSON.stringify({
      name: '营收表',
      sheets: [
        {
          name: '月度',
          rows: [
            ['区域', '1月', '2月', '合计'],
            ['华东', 120, 132, '=SUM(B2:C2)'],
            ['华南', 90, 110, '=SUM(B3:C3)']
          ],
          // formats 是按列的格式数组（每列一项）
          formats: ['text', 'int', 'int', 'money'],
          colWidths: [10, 8, 8, 12],
          freeze: true
        }
      ]
    }),
    style: 'default'
  })
  check('write_xlsx 成功', xlsxWrite.ok, xlsxWrite.output.slice(0, 120))
  const xlsxRead = await callTool('read_xlsx', { path: 'out/营收.xlsx' })
  check('read_xlsx 可读回', xlsxRead.ok, xlsxRead.output.slice(0, 100))
  check('读回含公式与数据', xlsxRead.output.includes('=SUM(B2:C2)') && xlsxRead.output.includes('华东'))

  // --- PPT：Deck JSON → .pptx → 读回 ---
  const pptxWrite = await callTool('write_pptx', {
    path: 'out/汇报.pptx',
    deck: JSON.stringify({
      title: '季度汇报',
      slides: [
        { layout: 'cover', title: '季度汇报', subtitle: '2024 Q3' },
        { layout: 'content', title: '核心结论', bullets: ['营收增长 18%', '毛利持平'] }
      ]
    })
  })
  check('write_pptx 成功', pptxWrite.ok, pptxWrite.output.slice(0, 120))
  const pptxRead = await callTool('read_ppt', { path: 'out/汇报.pptx' })
  check('read_ppt 可读回', pptxRead.ok, pptxRead.output.slice(0, 100))
  check('读回含页标题', pptxRead.output.includes('核心结论'))

  // --- 结构化编辑算子：改完再读回，确认算子真的落到文件里 ---
  const docxEdit = await callTool('edit_docx', {
    path: 'out/报告.docx',
    ops: JSON.stringify([{ op: 'replace_text', find: '正文第一段', replace: '正文已被改写' }])
  })
  check('edit_docx 可应用算子', docxEdit.ok, docxEdit.output.slice(0, 100))
  const docxRead2 = await callTool('read_docx', { path: 'out/报告.docx' })
  check('edit_docx 改动已持久化', docxRead2.output.includes('正文已被改写'))

  const xlsxEdit = await callTool('edit_xlsx', {
    path: 'out/营收.xlsx',
    ops: JSON.stringify([{ op: 'set_cell', sheet: '月度', row: 1, col: 2, value: 999 }])
  })
  check('edit_xlsx 可应用算子', xlsxEdit.ok, xlsxEdit.output.slice(0, 100))
  const xlsxRead2 = await callTool('read_xlsx', { path: 'out/营收.xlsx' })
  check('edit_xlsx 改动已持久化', xlsxRead2.output.includes('999'))

  const pptxEdit = await callTool('edit_ppt', {
    path: 'out/汇报.pptx',
    ops: JSON.stringify([{ op: 'set_title', title: '已改标题' }])
  })
  check('edit_ppt 可应用算子', pptxEdit.ok, pptxEdit.output.slice(0, 100))

  // --- transform_file：真实数据管道（过滤 + 派生列）+ 导出 xlsx ---
  fs.writeFileSync(
    path.join(wsRoot, 'out/people.csv'),
    'name,age,city\n张三,17,上海\n李四,25,北京\n王五,31,上海\n',
    'utf8'
  )
  const tfPreview = await callTool('transform_file', {
    input: 'out/people.csv',
    steps: JSON.stringify([
      { op: 'filter', expr: "col('age') >= 18" },
      { op: 'derive', name: '年份', expr: "2024 - col('age')" }
    ])
  })
  check('transform_file 预览成功', tfPreview.ok, tfPreview.output.slice(0, 120))
  check('过滤条件生效（17 岁被剔除）', !tfPreview.output.includes('张三'))
  check('派生列生效', tfPreview.output.includes('年份') || tfPreview.output.includes('1999'))
  check('未给 output 时不落盘', !fs.existsSync(path.join(wsRoot, 'out/people_out.csv')))

  const tfWrite = await callTool('transform_file', {
    input: 'out/people.csv',
    steps: JSON.stringify([{ op: 'filter', expr: "col('age') >= 18" }]),
    output: 'out/people_clean.csv'
  })
  check('transform_file 可写盘', tfWrite.ok && fs.existsSync(path.join(wsRoot, 'out/people_clean.csv')))
  const cleaned = fs.readFileSync(path.join(wsRoot, 'out/people_clean.csv'), 'utf8')
  check('写盘内容正确（保留表头 + 2 行）', cleaned.includes('name,age,city') && cleaned.includes('李四') && !cleaned.includes('张三'))

  const tfXlsx = await callTool('transform_file', {
    input: 'out/people.csv',
    steps: JSON.stringify([{ op: 'filter', expr: "col('age') >= 18" }]),
    output: 'out/people_clean.xlsx'
  })
  check('transform_file 可导出 xlsx', tfXlsx.ok && fs.existsSync(path.join(wsRoot, 'out/people_clean.xlsx')))

  // --- 只读工具链：search_files 能搜到刚生成的 Office 产物 ---
  const searchOffice = await callTool('search_files', { query: '华东' })
  check('search_files 可搜 Office 产物文本', searchOffice.ok, searchOffice.output.slice(0, 100))

  // --- 文件管理类工具 ---
  const listOut = await callTool('list_files', { path: 'out' })
  check('list_files 列出产物目录', listOut.ok && listOut.output.includes('报告.docx'))
  const mkdir = await callTool('create_dir', { path: 'out/nested' })
  check('create_dir 成功', mkdir.ok, mkdir.output.slice(0, 80))
  const move = await callTool('move_file', { from: 'out/people_clean.csv', to: 'out/nested/moved.csv' })
  check('move_file 成功', move.ok && fs.existsSync(path.join(wsRoot, 'out/nested/moved.csv')))
  const del = await callTool('delete_file', { path: 'out/nested/moved.csv' })
  check('delete_file 成功', del.ok && !fs.existsSync(path.join(wsRoot, 'out/nested/moved.csv')))

  // --- todo_write：长程任务清单 ---
  const todo = await callTool('todo_write', {
    todos: JSON.stringify([{ id: '1', content: '读素材', status: 'completed' }, { id: '2', content: '出报表', status: 'in_progress' }])
  })
  check('todo_write 成功', todo.ok, todo.output.slice(0, 80))

  // ===== 16. 技能系统（工具链入口） =====
  section('16. 技能系统工具（list_skills / load_skill）')
  const listSkills = await callTool('list_skills', {})
  check('list_skills 成功', listSkills.ok, listSkills.output.slice(0, 100))
  check('技能清单含主 Skill', listSkills.output.includes('ppt') && listSkills.output.includes('docx'))
  check('技能清单含数据管道技能', listSkills.output.includes('data'))

  const loadPpt = await callTool('load_skill', { name: 'ppt' })
  check('load_skill(ppt) 成功', loadPpt.ok, loadPpt.output.slice(0, 100))
  check('技能正文已加载', loadPpt.output.length > 2000, `${loadPpt.output.length} 字`)

  // 参考文件：主 Skill 的 reference/ 子目录（docx 技能带 6 篇参考文档）
  const loadBranch = await callTool('load_skill', { name: 'docx', file: 'reference/doc-dsl.md' })
  check('可按路径加载技能参考文档', loadBranch.ok, loadBranch.output.slice(0, 90))

  const loadBadFile = await callTool('load_skill', { name: 'data', file: 'reference/recipes.md' })
  check('缺失的参考文件给出可用清单', !loadBadFile.ok && loadBadFile.output.includes('SKILL.md'), loadBadFile.output.slice(0, 70))

  const loadMissing = await callTool('load_skill', { name: 'no-such-skill' })
  check('不存在的技能给出明确错误', !loadMissing.ok, loadMissing.output.slice(0, 80))

  // ===== 17. PDF（用户报障：三个 PDF 工具对任何来源都报「文档结构损坏」） =====
  //
  // 根因不是文件坏了，而是平台适配层的 PDF 后端**从来没被装上** ——
  // backend === null 时 loadDocument 只能返回 PARSE_ERROR_FORMAT，
  // 而它的文案正是「PDF 格式解析失败(文档结构损坏)」。这一节把整条链路钉住。
  section('17. PDF 解析（PDF.js 后端）')
  installPdfJsBackend()
  const pdfDir = path.join(wsRoot, 'docs')
  fs.mkdirSync(pdfDir, { recursive: true })
  fs.writeFileSync(
    path.join(pdfDir, 'probe.pdf'),
    makeTestPdf([
      'Guncat Work PDF smoke line one',
      'second line with digits 12345',
      'third line about revenue'
    ])
  )

  const parsed = await WorkToolRunner.execute(
    ctx,
    convId,
    'parse_document',
    JSON.stringify({ path: 'docs/probe.pdf' })
  )
  check(
    'parse_document 不再报「文档结构损坏」（这是后端缺席的症状，不是文件问题）',
    parsed.ok && !parsed.output.includes('文档结构损坏'),
    parsed.output.slice(0, 120)
  )
  check('parse_document 取到第一行正文', parsed.output.includes('Guncat Work PDF smoke line one'))
  check('parse_document 行不粘连（hasEOL 让相邻行各占一行）', parsed.output.includes('\n'))

  const searched = await WorkToolRunner.execute(
    ctx,
    convId,
    'search_pdf',
    JSON.stringify({ path: 'docs/probe.pdf', query: 'digits' })
  )
  check('search_pdf 命中关键词', searched.ok && searched.output.includes('digits'), searched.output.slice(0, 120))
  check('search_pdf 给出页码', searched.ok && searched.output.includes('第 1 页'), searched.output.slice(0, 80))

  const searchMiss = await WorkToolRunner.execute(
    ctx,
    convId,
    'search_pdf',
    JSON.stringify({ path: 'docs/probe.pdf', query: '这个关键词不存在于文档中' })
  )
  check('search_pdf 无命中时如实报告', searchMiss.ok && !searchMiss.output.includes('文档结构损坏'))

  const parseMissing = await WorkToolRunner.execute(
    ctx,
    convId,
    'parse_document',
    JSON.stringify({ path: 'docs/没有这个文件.pdf' })
  )
  check('不存在的 PDF 给出「文件不存在」而不是「结构损坏」', !parseMissing.ok, parseMissing.output.slice(0, 80))

  // 页面渲染：走纯函数（不经过 Electron 的 nativeImage），因此无头环境也能真的验证像素产出
  const png = await renderPdfPageToPng(path.join(pdfDir, 'probe.pdf'), 1, 600)
  check('PDF 页面可渲染成图（PNG 字节非空）', png.length > 1000, `${png.length} 字节`)
  check(
    '渲染产物确实是 PNG（魔数校验）',
    png[0] === 0x89 && png.toString('ascii', 1, 4) === 'PNG'
  )
  check(
    '渲染尺寸按目标宽等比缩放',
    png.readUInt32BE(16) === 600,
    `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`
  )

  // 两个纯函数的边界：行标记与坐标映射
  check(
    'itemsToText：只有 hasEOL 才换行',
    itemsToText([
      { str: '甲' },
      { str: '乙', hasEOL: true },
      { str: '丙' }
    ]) === '甲乙\n丙'
  )
  check(
    'itemsToObjects：x/y 取自变换矩阵的 e/f（y 从页底算，与鸿蒙侧一致）',
    (() => {
      const objs = itemsToObjects([{ str: '甲', transform: [1, 0, 0, 1, 72, 700], width: 10, height: 12 }])
      return objs.length === 1 && objs[0].x === 72 && objs[0].y === 700
    })()
  )

  // ===== 18. SVG 栅格化 =====
  //
  // 用户报障：「write_svg 能保存 SVG 源码，但预览栅格化在本机失败，导致 docx/pptx 也不能引用 svg」。
  // 根因是那条栅格化走的是 Electron 的 nativeImage —— 它**只解码位图**，喂 SVG 必然失败。
  // 现在改走 @napi-rs/canvas（底层 resvg）。这一节把预览与两条引用路径都钉住。
  section('18. SVG 栅格化（write_svg 预览 / docx 与 pptx 引用 svg）')
  const svgSource =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">' +
    '<rect width="200" height="100" rx="12" fill="#0A7AFF"/>' +
    '<circle cx="60" cy="50" r="24" fill="#ffffff"/>' +
    '<path d="M110 30 L170 50 L110 70 Z" fill="#FFD166"/></svg>'
  const svgWrite = await callTool('write_svg', { path: 'art/badge.svg', svg: svgSource, width: 512 })
  check('write_svg 成功', svgWrite.ok, svgWrite.output.slice(0, 140))
  check(
    'write_svg 这次真的生成了预览 PNG（此前这一步必然失败）',
    svgWrite.ok && svgWrite.output.includes('预览已生成'),
    svgWrite.output.split('\n').slice(1, 3).join(' | ')
  )
  const previewFile = path.join(wsRoot, 'art/badge_preview.png')
  check('预览 PNG 已落盘', fs.existsSync(previewFile))
  const previewBytes = fs.existsSync(previewFile) ? fs.readFileSync(previewFile) : Buffer.alloc(0)
  check('预览是合法 PNG（魔数）', previewBytes.length > 100 && previewBytes.toString('ascii', 1, 4) === 'PNG')
  check(
    '预览宽度按 width 参数、高度按 viewBox 等比',
    previewBytes.readUInt32BE(16) === 512 && previewBytes.readUInt32BE(20) === 256,
    `${previewBytes.readUInt32BE(16)}x${previewBytes.readUInt32BE(20)}`
  )

  // ===== 18b. view_image：真图必须带 dataUrl，假图必须报错 =====
  //
  // 用户报障：有效 PNG 只得到一句固定文案、模型收不到任何像素；而 131 字节纯文本
  // 改名 .png 也照样“成功”。根因有两层，这里分别钉住：
  //   1) 工具侧不再“扩展名对了就成功”，必须按字节探测/解码出真实图片；
  //   2) 循环侧必须把 imageDataUrl 作为下一条 user 多模态消息追加进历史。
  section('18b. view_image 内容校验与视觉注入')
  const viewValid = await callTool('view_image', { path: 'art/badge_preview.png' })
  check('view_image 对真实 PNG 成功', viewValid.ok, viewValid.output.slice(0, 160))
  check(
    'view_image 返回了真实图片 dataUrl（而不是只有成功文案）',
    viewValid.imageDataUrl.startsWith('data:image/png;base64,') && viewValid.imageDataUrl.length > 1000,
    `${viewValid.imageDataUrl.length} 字符`
  )
  check(
    '成功文案包含真实尺寸（来自解码结果）',
    viewValid.output.includes('512×256'),
    viewValid.output.slice(0, 160)
  )

  // 伪装的“图片”：纯文本改名 .png，必须在工具层被拒绝
  fs.writeFileSync(path.join(wsRoot, 'art/fake_image.png'), 'this is plain text, not a png\n', 'utf8')
  const viewFake = await callTool('view_image', { path: 'art/fake_image.png' })
  check('view_image 拒绝纯文本伪装的 .png', !viewFake.ok, viewFake.output.slice(0, 160))
  check('伪装文件不会返回 dataUrl', viewFake.imageDataUrl === '')
  check(
    '伪装文件报错说明原因（不是静默成功）',
    viewFake.output.includes('不是有效的图片'),
    viewFake.output.slice(0, 160)
  )

  // 只有 PNG 魔数/文件头的半截假图也必须失败（缺 IDAT/IEND）
  fs.writeFileSync(
    path.join(wsRoot, 'art/truncated.png'),
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
    ])
  )
  const viewTruncated = await callTool('view_image', { path: 'art/truncated.png' })
  check('view_image 拒绝只有文件头的截断 PNG', !viewTruncated.ok, viewTruncated.output.slice(0, 160))

  // 循环侧注入：模拟工具执行完后的历史，确认图片进入 LoopMessage 且与工具结果相邻
  const injectionMessages: LoopMessage[] = [
    LoopMessage.system('system'),
    LoopMessage.assistant('', [])
  ]
  const attachment: ToolImageAttachment = new ToolImageAttachment()
  attachment.toolName = 'view_image'
  attachment.argsJson = '{"path":"art/badge_preview.png"}'
  attachment.imageDataUrl = viewValid.imageDataUrl
  attachment.note = viewValid.output
  const injected = AgentLoopService.appendToolImageMessages(injectionMessages, [attachment])
  check('循环把工具图片追加为一条 user 消息', injected === 1 && injectionMessages.length === 3)
  check(
    '注入消息带图片 dataUrl 且说明里保留真实路径',
    injectionMessages[2].role === 'user' &&
      injectionMessages[2].imageDataUrl === viewValid.imageDataUrl &&
      injectionMessages[2].content.includes('art/badge_preview.png'),
    injectionMessages[2].content.slice(0, 100)
  )
  check(
    '没有图片时不动历史（不破坏前缀缓存）',
    AgentLoopService.appendToolImageMessages(injectionMessages, []) === 0 &&
      injectionMessages.length === 3
  )

  // pptx 直接引用 .svg：走 imageResolver 的自动栅格化
  const pptxSvg = await callTool('write_pptx', {
    path: 'out/图形汇报.pptx',
    deck: JSON.stringify({
      title: '图形汇报',
      slides: [{ layout: 'image', title: '徽标', image: 'art/badge.svg' }]
    })
  })
  check('write_pptx 可引用 .svg（自动栅格化）', pptxSvg.ok, pptxSvg.output.slice(0, 120))
  const pptxSvgBytes = fs.existsSync(path.join(wsRoot, 'out/图形汇报.pptx'))
    ? fs.readFileSync(path.join(wsRoot, 'out/图形汇报.pptx'))
    : Buffer.alloc(0)
  check(
    'pptx 里确实嵌入了图片（zip 内含 ppt/media）',
    pptxSvgBytes.includes(Buffer.from('ppt/media/'))
  )

  // docx 引用预览 PNG（工具说明要求 docx 引用预览而不是 .svg）
  const docxSvg = await callTool('write_docx', {
    path: 'out/图形报告.docx',
    markdown: '# 图形\n\n![徽标](art/badge_preview.png)\n'
  })
  check('write_docx 可引用预览 PNG', docxSvg.ok, docxSvg.output.slice(0, 120))
  const docxSvgBytes = fs.existsSync(path.join(wsRoot, 'out/图形报告.docx'))
    ? fs.readFileSync(path.join(wsRoot, 'out/图形报告.docx'))
    : Buffer.alloc(0)
  check('docx 里确实嵌入了图片（zip 内含 word/media）', docxSvgBytes.includes(Buffer.from('word/media/')))

  // ===== 19. HTTP 读空闲超时 =====
  //
  // 回归防线：平台层的 buildSignal 曾经把鸿蒙的「读空闲超时」当成一次性整段超时
  // （请求开始后 N 毫秒无条件 abort）。而端口代码传的正是读空闲语义 ——
  // 工作模式 300000、聊天 180000，于是**只要一轮流式超过 5 分钟就必然以网络错误中断**，
  // 哪怕数据一直在流。这一节用本地服务把两种情形分别钉住。
  section('19. HTTP 读空闲超时（长流式不该被掐断）')
  const nodeHttp = await import('node:http')

  async function startStreamServer(
    gapMs: number,
    blocks: number,
    stall: boolean
  ): Promise<{ server: import('node:http').Server; url: string }> {
    const server = nodeHttp.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      if (stall) {
        // 先给一块再静止：证明「有没有数据」才是判据，而不是「有没有开始」
        res.write('first')
        return
      }
      let sent = 0
      const timer = setInterval(() => {
        res.write('chunk' + String(sent))
        sent++
        if (sent >= blocks) {
          clearInterval(timer)
          res.end()
        }
      }, gapMs)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    return { server, url: 'http://127.0.0.1:' + String(port) + '/' }
  }

  function stopServer(server: import('node:http').Server): void {
    // 停滞那条的 socket 还挂着，先掐连接再关，避免冒烟脚本卡在 close 上
    server.closeAllConnections?.()
    server.close()
  }

  // A) 总时长（约 720ms）远超读超时（300ms），但块与块之间只隔 60ms —— 读空闲语义下这是正常长流式
  //
  // 允许多试两次：这一段验证的是**超时语义**，不是连通性。本机上偶发过
  // 「fetch failed / 0 块」的连接层抖动（上一轮的 socket 还没完全释放），
  // 那与读超时无关。只在**完全没收到任何数据**时才重试，语义断言不受影响。
  let errorA = ''
  let chunksA: string[] = []
  let endedA = false
  let tries = 0
  while (tries < 3) {
    tries++
    const streamed = await startStreamServer(60, 12, false)
    const httpA = guncatHttp.createHttp()
    chunksA = []
    endedA = false
    errorA = ''
    httpA.on('dataReceive', (data: ArrayBuffer) => {
      chunksA.push(Buffer.from(data).toString('utf8'))
    })
    httpA.on('dataEnd', () => {
      endedA = true
    })
    try {
      await httpA.requestInStream(streamed.url, {
        method: guncatHttp.RequestMethod.GET,
        readTimeout: 300,
        connectTimeout: 3000
      })
    } catch (e) {
      errorA = String((e as Error)?.message ?? e)
    }
    stopServer(streamed.server)
    if (errorA === '' || chunksA.length > 0) {
      break
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
  }
  check(
    '长流式：总时长超过读超时、但一直在读 —— 不该被中断',
    errorA === '' && endedA,
    `${chunksA.length} 块 / 第 ${tries} 次 / 错误=${errorA === '' ? '无' : errorA.slice(0, 50)}`
  )
  const expectedA = Array.from({ length: 12 }, (_v, i) => 'chunk' + String(i)).join('')
  check('长流式：数据一块不落', chunksA.join('') === expectedA, `${chunksA.join('').length} 字节`)

  // B) 拿到响应头后不再发数据 —— 这才应该由读空闲超时掐断
  const stalled = await startStreamServer(0, 0, true)
  const httpB = guncatHttp.createHttp()
  let endedB = false
  httpB.on('dataEnd', () => {
    endedB = true
  })
  let errorB = ''
  const beganAt = Date.now()
  try {
    await httpB.requestInStream(stalled.url, {
      method: guncatHttp.RequestMethod.GET,
      readTimeout: 300,
      connectTimeout: 3000
    })
  } catch (e) {
    errorB = String((e as Error)?.message ?? e)
  }
  const waitedB = Date.now() - beganAt
  check(
    '停滞的连接：读空闲超时会掐断它（不能一直挂着）',
    errorB !== '' && waitedB < 5000,
    `${waitedB}ms / 错误=${errorB.slice(0, 50)}`
  )
  check('掐断时仍然派发 dataEnd，端口代码不会停在半途', endedB)
  stopServer(stalled.server)

  // ===== 20. 跨轮思考重放（带 tools 时历史 reasoning 必须回传）=====
  section('20. 跨轮思考重放')
  // 场景：第一轮回答带思考与签名；第二轮重建历史时如果只搬正文，模型就丢了判断依据。
  // DeepSeek 的规则：请求携带 tools 时，历史轮次的 reasoning_content 都要回传。
  const replayHistory: Message[] = []
  replayHistory.push(Message.ofUser('u1', '第一问', '第一问', []))
  const a1: Message = Message.ofAssistant('a1', '第一轮结论')
  a1.reasoning = '第一轮思考'
  a1.thinkingSignature = 'sig-1'
  replayHistory.push(a1)
  const a2: Message = Message.ofAssistant('a2', '')
  a2.reasoning = '只有思考的一步'
  replayHistory.push(a2)
  replayHistory.push(Message.ofUser('u2', '第二问', '第二问', []))

  const replayLoop: LoopMessage[] = AgentLoopService.historyMessages(replayHistory)
  check(
    '历史重建保留 assistant 思考',
    replayLoop.some((m) => m.role === 'assistant' && m.reasoning.includes('第一轮思考'))
  )
  check(
    '历史重建保留思考签名',
    replayLoop.some((m) => m.role === 'assistant' && m.thinkingSignature === 'sig-1')
  )
  check(
    '只有思考、没有正文的步骤不被丢掉',
    replayLoop.some((m) => m.role === 'assistant' && m.reasoning.includes('只有思考的一步'))
  )
  check(
    '相邻 assistant 步骤合并为一条（thinking 才能保持在内容首位）',
    replayLoop.filter((m) => m.role === 'assistant').length === 1
  )

  const replayCfg: ApiConfig = new ApiConfig()
  replayCfg.provider = 'openai-completions'
  replayCfg.model = 'deepseek-flash'
  const replayTools: Record<string, Object>[] = [
    { name: 'demo', description: 'demo', parameters: { type: 'object', properties: {} } }
  ]
  const loopAny = AgentLoopService as unknown as {
    buildCompletionsBody: (config: ApiConfig, messages: LoopMessage[], tools: Record<string, Object>[],
      thinkingEnabled: boolean, reasoningEffort: string, webSearchEnabled: boolean,
      jsonMode?: boolean) => Record<string, Object>
    buildAnthropicBody: (config: ApiConfig, messages: LoopMessage[], tools: Record<string, Object>[],
      thinkingEnabled: boolean, reasoningEffort: string,
      webSearchEnabled: boolean) => Record<string, Object>
  }

  const withToolsMsgs = loopAny.buildCompletionsBody(
    replayCfg, replayLoop, replayTools, true, 'high', false)['messages'] as Record<string, Object>[]
  check(
    'completions：带 tools 时回传 reasoning_content',
    withToolsMsgs.some((m) => m['role'] === 'assistant' &&
      typeof m['reasoning_content'] === 'string' &&
      (m['reasoning_content'] as string).includes('第一轮思考'))
  )
  check(
    'completions：只有思考的步骤也有 reasoning_content',
    withToolsMsgs.some((m) => m['role'] === 'assistant' &&
      typeof m['reasoning_content'] === 'string' &&
      (m['reasoning_content'] as string).includes('只有思考的一步'))
  )
  const noToolsMsgs = loopAny.buildCompletionsBody(
    replayCfg, replayLoop, [], true, 'high', false)['messages'] as Record<string, Object>[]
  check(
    'completions：不带 tools 时不拼 reasoning_content',
    noToolsMsgs.every((m) => m['reasoning_content'] === undefined)
  )

  const hasThinkingBlock = (msgs: Record<string, Object>[], text: string): boolean =>
    msgs.some((m) => {
      if (m['role'] !== 'assistant') {
        return false
      }
      const content: Object = m['content']
      if (!(content instanceof Array)) {
        return false
      }
      return (content as Record<string, Object>[]).some(
        (b) => b['type'] === 'thinking' && typeof b['thinking'] === 'string' &&
          (b['thinking'] as string).includes(text))
    })
  const hasSignature = (msgs: Record<string, Object>[], signature: string): boolean =>
    msgs.some((m) => {
      const content: Object = m['content']
      if (!(content instanceof Array)) {
        return false
      }
      return (content as Record<string, Object>[]).some(
        (b) => b['type'] === 'thinking' && b['signature'] === signature)
    })

  const loopAnthropicMsgs = loopAny.buildAnthropicBody(
    replayCfg, replayLoop, replayTools, true, 'high', false)['messages'] as Record<string, Object>[]
  check('anthropic：历史思考以 thinking 块回传',
    hasThinkingBlock(loopAnthropicMsgs, '第一轮思考'))
  check('anthropic：签名随 thinking 块携带', hasSignature(loopAnthropicMsgs, 'sig-1'))
  check('anthropic：只有思考的步骤也回传 thinking',
    hasThinkingBlock(loopAnthropicMsgs, '只有思考的一步'))
  const loopAnthropicNoThinkMsgs = loopAny.buildAnthropicBody(
    replayCfg, replayLoop, replayTools, false, 'high', false)['messages'] as Record<string, Object>[]
  check('anthropic：思考关闭时不塞 thinking 块',
    !hasThinkingBlock(loopAnthropicNoThinkMsgs, '第一轮思考'))

  // 聊天模式走另一套构建器：历史 Message 直接进请求，同样不能只带正文。
  const chatAnthropicMsgs = buildAnthropicBody(
    replayCfg, null, replayHistory, '', true, false)['messages'] as Record<string, Object>[]
  check('聊天 anthropic：历史正文回答的思考回传',
    hasThinkingBlock(chatAnthropicMsgs, '第一轮思考'))
  check('聊天 anthropic：空正文的思考也不丢',
    hasThinkingBlock(chatAnthropicMsgs, '只有思考的一步'))
  const chatCompletionMsgs = buildChatCompletionsBody(
    replayCfg, null, replayHistory, '', true, false)['messages'] as Record<string, Object>[]
  check(
    '聊天 completions：正文回答回传 reasoning_content',
    chatCompletionMsgs.some((m) => m['role'] === 'assistant' && m['reasoning_content'] === '第一轮思考')
  )

  // ===== 21. 半截流不能当正常结束 =====
  //
  // 用户报障：长任务偶尔「安静地停了」，没有任何报错，发“继续”又能接着跑。
  // 根因是 2xx + dataEnd 就 resolve，不检查 finish_reason/message_stop/response.completed；
  // 连接被网络/代理掐断时，半截正文被当成最终回答收尾，状态还是 ok。
  section('21. 半截 SSE 必须重试（不能安静停下）')

  const completionAdapter = SSEAdapterFactory.build('openai-completions', new ToolCallAccumulator())
  check(
    'SSE 终止：completions 的 finish_reason 被识别',
    completionAdapter.extractComplete(
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    )
  )
  check(
    'SSE 终止：completions 半截流（finish_reason=null）不算结束',
    !completionAdapter.extractComplete(
      JSON.stringify({ choices: [{ delta: { content: '半截' }, finish_reason: null }] })
    )
  )
  const anthropicAdapter = SSEAdapterFactory.build('anthropic', new ToolCallAccumulator())
  check('SSE 终止：anthropic 的 message_stop 被识别',
    anthropicAdapter.extractComplete('{"type":"message_stop"}'))
  check('SSE 终止：anthropic 的 stop_reason 被识别',
    anthropicAdapter.extractComplete('{"type":"message_delta","delta":{"stop_reason":"end_turn"}}'))
  const responsesAdapter = SSEAdapterFactory.build('responses', new ToolCallAccumulator())
  check('SSE 终止：responses 的 response.completed 被识别',
    responsesAdapter.extractComplete('{"type":"response.completed"}'))
  check('SSE 终止：anthropic 普通正文块不算结束',
    !anthropicAdapter.extractComplete('{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}'))

  // Retry-After 不能被 8s 的指数退避封顶截断（429 常常要求等 30~60s）
  const retryPolicy = new RetryPolicy(2, 500, 8000, 0.2,
    ['rate_limit', 'server', 'transport', 'empty'], 60000)
  check('Retry-After：30s 原样等待，不被 8s 截断',
    retryPolicy.decide('rate_limit', 0, 30000, 0.5).delayMs === 30000)
  check('Retry-After：超过 60s 时封顶 60s',
    retryPolicy.decide('rate_limit', 0, 300000, 0.5).delayMs === 60000)

  // 端到端：第一次只吐半截就断（没有 finish_reason、没有 [DONE]），第二次完整。
  // 期望：第一次被判定为中断并重试，最终拿到第二次的完整回答。
  let truncAttempts = 0
  const truncServer = nodeHttp.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      truncAttempts++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (truncAttempts === 1) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '半截回答' } }] }) + '\n\n')
        res.end()
        return
      }
      res.write('data: ' + JSON.stringify({
        choices: [{ delta: { content: '完整回答' }, finish_reason: 'stop' }]
      }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => truncServer.listen(0, '127.0.0.1', () => resolve()))
  const truncAddress = truncServer.address()
  const truncPort = typeof truncAddress === 'object' && truncAddress !== null ? truncAddress.port : 0
  const truncCfg = new ApiConfig()
  truncCfg.provider = 'openai-completions'
  truncCfg.baseUrl = 'http://127.0.0.1:' + String(truncPort)
  truncCfg.apiKey = 'sk-trunc-test'
  truncCfg.model = 'trunc-model'
  truncCfg.autoSuffix = true
  const truncCallbacks = new LoopTurnCallbacks()
  let truncRetries = 0
  truncCallbacks.onRetry = (): void => {
    truncRetries++
  }
  const truncTurn = await AgentLoopService.runTurnWithRetry(
    truncCfg,
    [LoopMessage.system('你是测试助手'), LoopMessage.user('请回答')],
    true,
    'high',
    false,
    truncCallbacks,
    new LoopAbortSignal(),
    true,
    2
  )
  check('半截流被判定为中断并自动重试', truncRetries === 1, String(truncRetries))
  check('两次请求都到了服务端', truncAttempts === 2, String(truncAttempts))
  check('重试后拿到完整回答（不是半截）', truncTurn.content === '完整回答', truncTurn.content)
  stopServer(truncServer)

  // ===== 22. 用量与成本统计 =====
  //
  // 这些断言只依赖纯逻辑：协议归一化、峰谷边界、日聚合、裁剪、CSV、热力图。
  // 不联网、不启动 Electron，跑的就是生产代码本身。
  section('22. 用量与成本 · 三协议归一化与峰谷')

  const beijingMs = (year: number, month: number, day: number, hour: number, minute: number): number =>
    Date.UTC(year, month - 1, day, hour - 8, minute)

  const anthStart = {
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 1000,
        output_tokens: 0
      }
    }
  }
  const anthDelta = { type: 'message_delta', usage: { output_tokens: 200 } }
  const anthMerged = mergeUsageObjects(
    mergeUsageObjects(null, extractAnthropicUsage(JSON.stringify(anthStart))),
    extractAnthropicUsage(JSON.stringify(anthDelta))
  )
  const anthTokens = normalizeUsageTokens('anthropic', anthMerged).tokens
  check('Anthropic 命中 = cache_read', anthTokens.inputHit === 1000, String(anthTokens.inputHit))
  check('Anthropic 未命中 = input_tokens（不含缓存）', anthTokens.inputMiss === 100, String(anthTokens.inputMiss))
  check('Anthropic 写入 = cache_creation', anthTokens.cacheWrite === 50, String(anthTokens.cacheWrite))
  check('Anthropic 输出 = output_tokens', anthTokens.output === 200, String(anthTokens.output))
  check('Anthropic message_start 的 usage 不再被丢弃',
    extractAnthropicUsage(JSON.stringify(anthStart)) !== null)
  check('Anthropic 上下文预算使用总输入（命中+未命中+写入）',
    usageTotalInputTokens('anthropic', anthMerged) === 1150,
    String(usageTotalInputTokens('anthropic', anthMerged)))
  const anthStats = deriveStreamStats(anthMerged, 1000, 'anthropic')
  check('Anthropic 速度按输出 tokens 计算', Math.abs(anthStats[0] - 200) < 0.001, String(anthStats[0]))
  check('Anthropic 缓存命中率包含缓存读取',
    anthStats[1] > 0.86 && anthStats[1] < 0.87, String(anthStats[1]))

  const respTokens = normalizeUsageTokens('responses', {
    input_tokens: 1200,
    output_tokens: 300,
    input_tokens_details: { cached_tokens: 800 }
  }).tokens
  check('Responses 命中 = cached_tokens', respTokens.inputHit === 800, String(respTokens.inputHit))
  check('Responses 未命中 = input_tokens - cached',
    respTokens.inputMiss === 400, String(respTokens.inputMiss))
  check('Responses 输出 = output_tokens', respTokens.output === 300, String(respTokens.output))

  const compTokens = normalizeUsageTokens('completions', {
    prompt_tokens: 1000,
    prompt_cache_hit_tokens: 600,
    prompt_cache_miss_tokens: 400,
    completion_tokens: 200
  }).tokens
  check('Completions 优先使用 prompt_cache_hit/miss',
    compTokens.inputHit === 600 && compTokens.inputMiss === 400 && compTokens.output === 200,
    JSON.stringify(compTokens))
  const compFallback = normalizeUsageTokens('completions', {
    prompt_tokens: 1000,
    prompt_tokens_details: { cached_tokens: 250 },
    completion_tokens: 100
  }).tokens
  check('Completions 回落 prompt_tokens - cached',
    compFallback.inputHit === 250 && compFallback.inputMiss === 750 && compFallback.output === 100,
    JSON.stringify(compFallback))

  const ocRaw = {
    prompt_tokens: 1200,
    completion_tokens: 300,
    cost: 0,
    opencode: {
      billing_source: 'go',
      list_cost: 0.00412,
      allowance: 0.00412,
      tokens: {
        input: 1200,
        output: 300,
        reasoning: 120,
        cache_read: 8000,
        cache_write_5m: 0,
        cache_write_1h: 0
      }
    }
  }
  const ocTokens = normalizeUsageTokens('anthropic', ocRaw).tokens
  check('OpenCode 优先 usage.opencode.tokens',
    ocTokens.inputHit === 8000 && ocTokens.inputMiss === 1200 && ocTokens.output === 300,
    JSON.stringify(ocTokens))
  const ocRecord = buildUsageRecord(
    'anthropic',
    ocRaw,
    'https://opencode.ai/inference/go',
    'deepseek-v4.1-flash',
    beijingMs(2026, 11, 5, 10, 0),
    { success: true }
  )
  check('OpenCode 按 Base URL 识别，不按模型名套 DeepSeek 峰谷价', ocRecord.provider === 'opencode-go')
  check('OpenCode Go 套餐内 cost 可以为 0', ocRecord.costUsd === 0)
  check('OpenCode allowance 单独记账', ocRecord.allowanceUsd === 0.00412, String(ocRecord.allowanceUsd))
  check('OpenCode list_cost 作为等价成本',
    ocRecord.listCostUsd === 0.00412 && ocRecord.equivalentUsd === 0.00412)
  check('OpenCode billing_source=go', ocRecord.billingSource === 'go')

  const peakCost = priceDeepSeekUsage(
    'deepseek-flash',
    'peak',
    { inputHit: 1000000, inputMiss: 1000000, cacheWrite: 0, output: 1000000 },
    0
  )
  const offpeakCost = priceDeepSeekUsage(
    'deepseek-flash',
    'offpeak',
    { inputHit: 1000000, inputMiss: 1000000, cacheWrite: 0, output: 1000000 },
    0
  )
  const proCost = priceDeepSeekUsage(
    'deepseek-v4-pro',
    'peak',
    { inputHit: 1000000, inputMiss: 1000000, cacheWrite: 0, output: 1000000 },
    0
  )
  check('Flash 高峰价：0.04 + 2 + 8 = 10.04 元',
    Math.abs(peakCost.costCny - 10.04) < 0.000001, String(peakCost.costCny))
  check('Flash 空闲价是高峰的一半', Math.abs(offpeakCost.costCny - 5.02) < 0.000001, String(offpeakCost.costCny))
  check('Pro 高峰价：0.3 + 9 + 27 = 36.3 元',
    Math.abs(proCost.costCny - 36.3) < 0.000001, String(proCost.costCny))
  const searchCost = priceDeepSeekUsage(
    'deepseek-flash',
    'peak',
    { inputHit: 0, inputMiss: 0, cacheWrite: 0, output: 0 },
    1000
  )
  check('服务端搜索按 5 元 / 1000 次单独计价',
    Math.abs(searchCost.costCny - 5) < 0.000001, String(searchCost.costCny))

  const thursday = (hour: number, minute: number): number => beijingMs(2026, 11, 5, hour, minute)
  check('峰谷边界 08:59 = 空闲', usagePeriodAt(thursday(8, 59)) === 'offpeak')
  check('峰谷边界 09:00 = 高峰', usagePeriodAt(thursday(9, 0)) === 'peak')
  check('峰谷边界 11:59 = 高峰', usagePeriodAt(thursday(11, 59)) === 'peak')
  check('峰谷边界 12:00 = 空闲', usagePeriodAt(thursday(12, 0)) === 'offpeak')
  check('峰谷边界 13:59 = 空闲', usagePeriodAt(thursday(13, 59)) === 'offpeak')
  check('峰谷边界 14:00 = 高峰', usagePeriodAt(thursday(14, 0)) === 'peak')
  check('峰谷边界 17:59 = 高峰', usagePeriodAt(thursday(17, 59)) === 'peak')
  check('峰谷边界 18:00 = 空闲', usagePeriodAt(thursday(18, 0)) === 'offpeak')
  check('周末全天空闲', usagePeriodAt(beijingMs(2026, 11, 7, 10, 0)) === 'offpeak')
  check('法定节假日全天空闲', usagePeriodAt(beijingMs(2026, 10, 1, 10, 0)) === 'offpeak')
  check('跨天请求按开始时间归属 23:59',
    beijingDateKey(beijingMs(2026, 11, 5, 23, 59)) === '2026-11-05')
  check('跨天请求按开始时间归属 00:00',
    beijingDateKey(beijingMs(2026, 11, 6, 0, 0)) === '2026-11-06')
  check('UTC+8 日期归属（UTC 16:30 = 北京时间次日 00:30）',
    beijingDateKey(Date.UTC(2026, 10, 5, 16, 30)) === '2026-11-06')

  section('22b. 用量与成本 · 日聚合 / 裁剪 / CSV / 热力图')

  const dsLedger: UsageLedgerFile = createEmptyUsageLedger()
  const dsRaw = {
    input_tokens: 100,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 50,
    output_tokens: 200
  }
  const recordAt = (startedAt: number, model: string = 'deepseek-flash'): UsageRecord =>
    buildUsageRecord(
      'anthropic',
      dsRaw,
      'https://api.deepseek.com/anthropic',
      model,
      startedAt,
      { success: true, sessionId: 'ses_smoke' }
    )
  const r1 = recordAt(thursday(10, 0))
  const r2 = recordAt(thursday(10, 30))
  const r3 = recordAt(thursday(20, 0), 'deepseek-v4-pro')
  addUsageRecordToLedger(dsLedger, r1, beijingDateKey(r1.startedAt), usagePeriodAt(r1.startedAt))
  addUsageRecordToLedger(dsLedger, r2, beijingDateKey(r2.startedAt), usagePeriodAt(r2.startedAt))
  addUsageRecordToLedger(dsLedger, r3, beijingDateKey(r3.startedAt), usagePeriodAt(r3.startedAt))
  const dayAgg = aggregateUsageRange(dsLedger.days, 'all', '2026-11-05', '2026-11-05')
  check('日聚合同日同模型累加', dayAgg.requests === 3, String(dayAgg.requests))
  check('日聚合 token 累加', dayAgg.inputHit === 3000, String(dayAgg.inputHit))
  check('日聚合总额与 providerTotals 同步',
    dsLedger.totals.requests === 3 &&
      dsLedger.providerTotals['deepseek'] !== undefined &&
      dsLedger.providerTotals['deepseek'].requests === 3)
  check('高峰与空闲分桶',
    dsLedger.days['2026-11-05']['deepseek']['deepseek-flash'].peak !== undefined &&
      dsLedger.days['2026-11-05']['deepseek']['deepseek-v4-pro'].offpeak !== undefined)

  const missingRecord = buildUsageRecord(
    'anthropic',
    null,
    'https://api.deepseek.com/anthropic',
    'deepseek-flash',
    thursday(10, 0),
    { success: true }
  )
  check('缺失 usage 被标记且 token/cost 为 0',
    missingRecord.missingUsage === true &&
      missingRecord.inputHit === 0 &&
      missingRecord.inputMiss === 0 &&
      missingRecord.costUsd === 0)
  addUsageRecordToLedger(dsLedger, missingRecord, '2026-11-05', 'peak')
  check('缺失 usage 单独计数', dsLedger.totals.missingUsage === 1, String(dsLedger.totals.missingUsage))

  const beforeCropRequests: number = dsLedger.totals.requests
  dsLedger.days['2024-01-01'] = {
    deepseek: {
      'deepseek-flash': {
        peak: {
          ...JSON.parse(JSON.stringify(dsLedger.days['2026-11-05']['deepseek']['deepseek-flash'].peak))
        }
      }
    }
  }
  const removed = cropUsageLedger(dsLedger, '2026-11-05', 400)
  check('超过 400 天的日桶被裁剪', removed === 1 && dsLedger.days['2024-01-01'] === undefined, String(removed))
  check('裁剪不影响全量累计值', dsLedger.totals.requests === beforeCropRequests)

  const csv = buildUsageCsv(dsLedger)
  check('CSV 带 UTF-8 BOM', csv.charCodeAt(0) === 0xfeff)
  check('CSV 含表头与日期/服务商/模型', csv.includes('日期,服务商,模型') && csv.includes('DeepSeek') && csv.includes('deepseek-flash'))
  check('CSV 含高峰与空闲行', csv.includes('高峰') && csv.includes('空闲'))
  check('CSV 含折算人民币列', csv.includes('折算费用(CNY)'))

  const heat = buildUsageHeatmap(dsLedger.days, 'all', 'cost', '2026-11-05')
  check('热力图固定 53 周', heat.weeks.length === 53, String(heat.weeks.length))
  check('热力图每周 7 天', heat.weeks.every((week) => week.days.length === 7))
  check('热力图周一为第一行',
    new Date(Date.UTC(
      Number(heat.weeks[0].days[0].date.substring(0, 4)),
      Number(heat.weeks[0].days[0].date.substring(5, 7)) - 1,
      Number(heat.weeks[0].days[0].date.substring(8, 10))
    )).getUTCDay() === 1)
  const todayCell = heat.weeks.flatMap((week) => week.days).find((cell) => cell.date === '2026-11-05')
  check('热力图今天有数据且不是未来', todayCell !== undefined && !todayCell.future && todayCell.value > 0)
  check('热力图月份标签非空', heat.monthLabels.length > 0)

  const dsCfg = new ApiConfig()
  dsCfg.provider = 'openai-completions'
  dsCfg.baseUrl = 'https://api.deepseek.com'
  dsCfg.model = 'deepseek-flash'
  const dsBody = buildChatCompletionsBody(dsCfg, null, [], 'hi', false, false)
  const dsStreamOptions = dsBody['stream_options'] as Record<string, Object> | undefined
  check('DeepSeek 流式请求补 stream_options.include_usage',
    dsStreamOptions !== undefined && dsStreamOptions['include_usage'] === true)
  const customCfg = new ApiConfig()
  customCfg.provider = 'openai-completions'
  customCfg.baseUrl = 'https://example.com/v1'
  customCfg.model = 'custom-model'
  const customBody = buildChatCompletionsBody(customCfg, null, [], 'hi', false, false)
  check('自建兼容网关不强行添加 stream_options',
    customBody['stream_options'] === undefined)
  const loopDsBody = loopAny.buildCompletionsBody(
    dsCfg, [LoopMessage.user('hi')], [], false, 'high', false)
  const loopDsStreamOptions = loopDsBody['stream_options'] as Record<string, Object> | undefined
  check('Agent Loop 的 completions 同样补 include_usage',
    loopDsStreamOptions !== undefined && loopDsStreamOptions['include_usage'] === true)
  check('美元/人民币折算使用固定汇率', USD_CNY_RATE > 0)

  // 真实账本往返：recordDirect → 日桶 → flush → overview。
  UsageService.beginRun('ses_smoke_usage')
  UsageService.recordDirect(
    'https://api.deepseek.com/anthropic',
    'deepseek-flash',
    'anthropic',
    beijingMs(2026, 11, 5, 10, 0),
    { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 },
    true,
    'ses_smoke_usage'
  )
  UsageService.flush()
  const runTotals = UsageService.runTotals('ses_smoke_usage')
  check('本轮统计上下文累计 tokens 与请求数',
    runTotals.requests === 1 && runTotals.tokens === 35, JSON.stringify(runTotals))
  UsageService.endRun('ses_smoke_usage')
  const overview = await UsageService.overview()
  check('UsageService 落盘后 overview 能读到日桶',
    overview.totals.requests >= 1 && overview.days.length >= 1,
    String(overview.totals.requests))
  check('UsageService 数据文件在应用私有目录',
    UsageService.dataFilePath().includes('usage-ledger.json') &&
      fs.existsSync(UsageService.dataFilePath()))
  UsageService.flush()

  // ===== 23. 交互模式 · 能力调度（九档提示词） =====
  //
  // 这组断言守四件事：
  //   1) 九档元数据是单一事实源（顺序/默认/回退/思考强度/追加工具都合法）；
  //   2) 轻简档 = 旧的交互模式提示词**逐字节**不变（默认档行为与速度不受本次功能影响）；
  //   3) 八档主体真的从 resources 加载进来了，且过得了迁移质量门（H1 归零 / 有适配标注 / 净增 / 无占位）；
  //   4) 工具面按档位只增不删，长程维护类工具在任何档位都不下发。
  section('23. 交互模式 · 能力调度（九档提示词）')
  const tierIds: string[] = InteractiveTiers.ALL.map((t) => t.id)
  check('九档齐全且顺序固定',
    tierIds.join(',') === 'lite,efficiency,expert,classic,paper,legal,research,sift,eval',
    tierIds.join(','))
  check('档位 id 唯一', new Set(tierIds).size === tierIds.length)
  check('默认档为轻简，空串/未知值回退轻简',
    InteractiveTiers.DEFAULT_ID === 'lite' &&
      InteractiveTiers.normalize('') === 'lite' &&
      InteractiveTiers.normalize('nope') === 'lite' &&
      InteractiveTiers.normalize('expert') === 'expert')
  const liteTier = InteractiveTiers.byId('lite')
  check('轻简档没有档位主体文件（它就是原交互模式提示词）', liteTier.promptFile === '')
  const bodyTiers = InteractiveTiers.ALL.filter((t) => t.promptFile !== '')
  check('八档都登记了档位主体文件',
    bodyTiers.length === 8 && bodyTiers.every((t) => t.sourceFile !== '' && t.defaultEffort !== ''),
    bodyTiers.map((t) => t.promptFile).join(', '))
  check('默认思考强度都在 off/low/high 域内',
    InteractiveTiers.ALL.every((t) => InteractiveTiers.isValidEffort(t.defaultEffort)))
  check('档位追加工具只允许 record_search / todo_write',
    InteractiveTiers.ALL.every((t) => t.extraTools.every(
      (n) => n === 'record_search' || n === 'todo_write')))

  // 八份档位主体从 resources 读入内存注册表（与 SessionManager.bootstrap 同一条路径）
  await AgentLoader.loadInteractiveTierPrompts(ctx)
  const loadedTierIds: string[] = InteractiveTierPrompts.loadedIds()
  check('八份档位主体已加载', loadedTierIds.length === 8,
    loadedTierIds.join(', ') + ` / ${bodyTiers.length}`)
  check('轻简档不登记主体（body 为空）', InteractiveTierPrompts.body('lite') === '')

  // 迁移质量门：H1 归零（H1 由代码层档位声明承担）、适配标注可 grep、无占位、只加不删、内容锚点
  const tierGate = { h1: 0, markers: 0, placeholders: 0, growth: 0, anchors: 0 }
  for (const tier of bodyTiers) {
    const body: string = InteractiveTierPrompts.body(tier.id)
    const srcPath = path.join(resourcesRoot, tier.sourceFile)
    if (!fs.existsSync(srcPath)) {
      check(`档位主体源文件存在 ${tier.id}`, false, srcPath)
      continue
    }
    const src: string = fs.readFileSync(srcPath, 'utf8')
    if (body.split('\n').filter((l) => /^# /.test(l)).length === 0) {
      tierGate.h1++
    }
    const markers: number = (body.match(/交互模式适配/g) ?? []).length
    if (markers >= 3) {
      tierGate.markers++
    }
    if (!/TODO|待补充|【待适配】/.test(body)) {
      tierGate.placeholders++
    }
    if (body.length > src.length * 1.02) {
      tierGate.growth++
    }
    const first3 = src.split('\n').filter((l) => l.trim() !== '').slice(0, 3)
    if (first3.filter((l) => body.includes(l.trim())).length >= 2) {
      tierGate.anchors++
    }
  }
  check('迁移质量门 · 八档主体 H1 全部归零', tierGate.h1 === 8, `${tierGate.h1}/8`)
  check('迁移质量门 · 每档至少 3 处「交互模式适配」标注', tierGate.markers === 8, `${tierGate.markers}/8`)
  check('迁移质量门 · 没有 TODO/待补充 占位', tierGate.placeholders === 8, `${tierGate.placeholders}/8`)
  check('迁移质量门 · 主体只加不删（净增 > 2%）', tierGate.growth === 8, `${tierGate.growth}/8`)
  check('迁移质量门 · 原文内容锚点保留（前 3 个非空行至少 2 行逐字出现）',
    tierGate.anchors === 8, `${tierGate.anchors}/8`)

  // 组装：轻简档必须与旧四段组装逐字节一致（这是"默认档行为不变"的硬证据）
  const tierSkills: string = WorkSkillService.interactiveIndex()
  const liteToolIndex: string =
    PromptBuilder.buildToolNameIndex(AgentLoopService.interactiveToolDefs(false, 'lite'))
  const liteOld: string = PromptBuilder.assembleInteractiveSystemPrompt(
    GuncatUiPrompt.promptSection(), tierSkills, liteToolIndex, GuncatUiPrompt.INTERACTIVE_DUTY)
  const liteNew: string =
    InteractiveTierPrompt.assemble('lite', '', tierSkills, liteToolIndex)
  check('轻简档组装结果 = 旧四段组装（逐字节相同）', liteOld === liteNew,
    `${liteOld.length} vs ${liteNew.length}`)
  check('轻简档第一段仍是「最高优先级 · 快」宪法',
    liteNew.startsWith('# 最高优先级 · 快（本模式第一纪律）'))
  check('AgentLoopService 的轻简提示词与组装函数同源',
    AgentLoopService.buildInteractiveSystemPrompt('lite') === liteNew)
  const liteSegs = InteractiveTierPrompt.segments('lite', '', tierSkills, liteToolIndex)
  const expertSegs = InteractiveTierPrompt.segments('expert', InteractiveTierPrompts.body('expert'),
    tierSkills, PromptBuilder.buildToolNameIndex(AgentLoopService.interactiveToolDefs(false, 'expert')))
  check('轻简档 15 段 / 其余八档 16 段（多一段档位主体）',
    liteSegs.length === 15 && expertSegs.length === 16,
    `lite ${liteSegs.length} / expert ${expertSegs.length}`)
  check('段拼接 = assemble 结果（导出结构与运行时分叉会被抓到）',
    expertSegs.filter((s) => s.text !== '').map((s) => s.text).join('\n\n') ===
      InteractiveTierPrompt.assemble('expert', InteractiveTierPrompts.body('expert'),
        tierSkills, PromptBuilder.buildToolNameIndex(AgentLoopService.interactiveToolDefs(false, 'expert'))))

  const expertPrompt: string = AgentLoopService.buildInteractiveSystemPrompt('expert')
  check('专家档提示词以档位声明开头（唯一的一级标题）',
    expertPrompt.startsWith('# 专家 · 能力调度档位（交互模式 · 移植自 Guncat 3.0-Pro）'))
  check('专家档提示词包含档位主体正文',
    expertPrompt.includes(InteractiveTierPrompts.body('expert').slice(0, 200)))
  // 顺序断言用「每层一段独有文本」当锚点，避免依赖标题措辞
  const orderMarkers: string[] = [
    '# 专家 · 能力调度档位',                 // ① 档位声明
    '## 语法规则',                           // ③ 界面语言契约
    '## 组件清单',                           // ④ 组件清单
    '## 交互模式适配 · 本档位运行环境',       // ⑩ 档位主体
    '# 工作区（素材区 + 产出区）',            // ⑪ 环境底座 · 工作区
    '# 可用工具（本档位工具面',               // ⑫ 环境底座 · 工具面
    '现在开始：先按本档位纪律',               // ⑮ 起手式
    '# 交互模式职责（交付形态'                // ⑯ 职责收尾
  ]
  const orderAt: number[] = orderMarkers.map((h) => expertPrompt.indexOf(h))
  check('组装顺序：档位声明 → 界面契约 → 档位主体 → 环境底座 → 职责收尾',
    orderAt.every((n, i) => n >= 0 && (i === 0 || n > orderAt[i - 1])),
    orderAt.join(','))
  check('档位口径丰富度：12~20+ 不设上限',
    expertPrompt.includes('12~20+ 个组件是常态, 不设上限'))
  check('轻简档丰富度仍是「典型 8~14、够用为准」',
    liteNew.includes('典型 8~14 个组件是常态') && !liteNew.includes('12~20+ 个组件是常态'))

  // 缺主体时的降级：清空注册表后构建一个还没缓存过的档位 → 必须回退轻简档，绝不交付空壳档位
  InteractiveTierPrompts.clear()
  const fallbackPrompt: string = AgentLoopService.buildInteractiveSystemPrompt('sift')
  check('档位主体缺失时回退轻简档（不交付空壳提示词）',
    fallbackPrompt === liteNew && !fallbackPrompt.includes('Guncat Srch-Sift'))
  await AgentLoader.loadInteractiveTierPrompts(ctx)

  // 工具面：基础 27 个 + 档位只追加
  const baseWhitelist: string[] =
    ToolRegistry.interactiveWhitelist(InteractiveTiers.LITE_ID)
  check('交互模式基础工具面仍是 27 个', baseWhitelist.length === 27, String(baseWhitelist.length))
  const tierToolCounts: Record<string, number> = {}
  let additive = true
  for (const tier of InteractiveTiers.ALL) {
    const list: string[] = ToolRegistry.interactiveWhitelist(tier.id)
    tierToolCounts[tier.id] = list.length
    const prefixSame = baseWhitelist.every((n, i) => list[i] === n)
    const extrasOk = tier.extraTools.every((n) => list.indexOf(n) !== -1) &&
      list.length === baseWhitelist.length + tier.extraTools.filter(
        (n) => baseWhitelist.indexOf(n) === -1).length
    if (!prefixSame || !extrasOk) {
      additive = false
    }
  }
  check('档位工具面 = 基础白名单 + 追加（只增不删、顺序稳定）', additive)
  check('轻简 / 论文转换仍是 27 个工具',
    tierToolCounts['lite'] === 27 && tierToolCounts['paper'] === 27)
  check('效率 / 经典 / 信息筛滤 28 个（+record_search）',
    tierToolCounts['efficiency'] === 28 && tierToolCounts['classic'] === 28 &&
      tierToolCounts['sift'] === 28)
  check('专家 / 法律 / 深度研究 / LLM评估 29 个（+record_search +todo_write）',
    tierToolCounts['expert'] === 29 && tierToolCounts['legal'] === 29 &&
      tierToolCounts['research'] === 29 && tierToolCounts['eval'] === 29)

  const allToolDefs: Record<string, Object>[] = WorkFileService.toolDefs(false)
  const allToolNames: string[] =
    allToolDefs.map((d) => String((d as Record<string, unknown>)['name'] ?? ''))
  check('追加工具在真实工具表里存在（record_search / todo_write 不是空气）',
    allToolNames.includes('record_search') && allToolNames.includes('todo_write'))
  const liteDefs: Record<string, Object>[] =
    AgentLoopService.toolDefsForMode('interactive', false, 'lite') as Record<string, Object>[]
  const expertDefs: Record<string, Object>[] =
    AgentLoopService.toolDefsForMode('interactive', false, 'expert') as Record<string, Object>[]
  const defNames = (defs: Record<string, Object>[]): string[] =>
    defs.map((d) => String((d as Record<string, unknown>)['name'] ?? ''))
  const liteNames = defNames(liteDefs)
  const expertNames = defNames(expertDefs)
  check('轻简档下发的工具定义里没有 todo_write / record_search',
    !liteNames.includes('todo_write') && !liteNames.includes('record_search'),
    liteNames.join(','))
  check('专家档下发的工具定义含 record_search + todo_write',
    expertNames.includes('record_search') && expertNames.includes('todo_write'),
    `${expertNames.length} 个`)
  check('专家档工具定义 = 轻简档 + 两个追加工具',
    expertNames.length === liteNames.length + 2 &&
      liteNames.every((n) => expertNames.includes(n)),
    `${liteNames.length} → ${expertNames.length}`)
  check('工作模式工具面不受档位影响（返回 null = 全量）',
    AgentLoopService.toolDefsForMode('work', false, 'expert') === null)
  const alwaysDropped: string[] = [
    'goal_create', 'goal_get', 'goal_update', 'schedule_create', 'schedule_list',
    'schedule_delete', 'subagent', 'session_search', 'ask_user_question', 'edit',
    'str_replace_editor', 'delete_file', 'move_file'
  ]
  check('长程 / 维护类工具在任何档位都不下发',
    InteractiveTiers.ALL.every((t) => {
      const dropped: string[] = ToolRegistry.interactiveDropped(allToolDefs, t.id)
      return alwaysDropped.every((n) => dropped.indexOf(n) !== -1)
    }))

  // 组件清单：分组名与 definitions() 的 g1~g9 逐字一致（修掉 '列表' vs '列表与追问' 的整组丢失）
  const compSection: string = GuncatUiLibrary.promptSection()
  check('组件清单包含「列表与追问」分组（此前整组从提示词里消失）',
    compSection.includes('### 列表与追问'))
  check('ListBlock / ListItem 已进入组件清单',
    compSection.includes('`ListBlock(') && compSection.includes('`ListItem('))
  check('RadarChart 已登记且进入清单（多维对比不再指向不存在的组件）',
    compSection.includes('`RadarChart('))
  check('每个分组都出现在组件清单里（分组名与 definitions 一致）',
    GuncatUiLibrary.GROUP_ORDER.every((g) => compSection.includes('### ' + g)),
    GuncatUiLibrary.GROUP_ORDER.join('/'))
  check('promptHidden 组件不出现在提示词清单里',
    !compSection.includes('`FollowUpBlock(') && !compSection.includes('`FollowUpItem('))

  // ===== 24. 个性化指令（模型 / 提示词 / 持久化 / 三协议注入） =====
  //
  // 这组断言守四件事：
  //   1) 数据模型：create 立即 trim/clamp（名称 40 / 正文 8000，按字符不按字节）、
  //      脏存档逐条容错、displayName/summary/indexOfId/sortScopesByOrder 的稳定口径；
  //   2) 提示词拼装：按生效范围过滤、personal-instruction 包裹与属性转义、正文原样保留、
  //      16000 总预算的截断口径、appendSection 的「前缀逐字节不变」；
  //   3) 持久化：serialize→parseList 与 save→load 两条往返路径互逆，空列表落盘为 '[]'；
  //   4) 三协议注入：克隆 Agent 后 completions / anthropic / responses 请求体的系统提示
  //      以原提示逐字节为前缀、以个性化段结尾；无生效条目时请求体 JSON 与未注入前完全相同。
  section('24. 个性化指令')

  // ---- 24.1 数据模型 ----
  check('个性化指令 · 模型 · 约束常量与鸿蒙版一致（名称 40 / 正文 8000 / 总预算 16000）',
    PersonalInstruction.MAX_NAME_CHARS === 40 &&
      PersonalInstruction.MAX_CONTENT_CHARS === 8000 &&
      PersonalInstructionPrompt.MAX_TOTAL_CHARS === 16000)

  const piTrimmed = PersonalInstruction.create(
    '  冒烟名称  ', '  正文内容  ', ['work', ' work ', '', 'interactive', 'work'])
  check('个性化指令 · 模型 · create 去首尾空白、范围去重去空且保留勾选顺序',
    piTrimmed.name === '冒烟名称' && piTrimmed.content === '正文内容' &&
      piTrimmed.scopes.join(',') === 'work,interactive', piTrimmed.scopes.join(','))
  check('个性化指令 · 模型 · create 生成 pi- 前缀 id 且 updatedAt>0',
    piTrimmed.id.startsWith('pi-') && piTrimmed.id.length > 3 && piTrimmed.updatedAt > 0,
    piTrimmed.id)

  const piLongName = PersonalInstruction.create('名'.repeat(50), '正文', ['work'])
  check('个性化指令 · 模型 · 名称按字符截断到 40（中文不被截坏）',
    piLongName.name.length === 40 && piLongName.name === '名'.repeat(40),
    `${piLongName.name.length} 字`)
  const piChinese8000 = '中'.repeat(8000)
  check('个性化指令 · 模型 · 正文 8000 个中文字符原样保留（按字符不按字节）',
    PersonalInstruction.create('', piChinese8000, ['work']).content === piChinese8000)
  check('个性化指令 · 模型 · 正文 8001 个中文字符截断为 8000',
    PersonalInstruction.create('', '中'.repeat(8001), ['work']).content === '中'.repeat(8000))
  check('个性化指令 · 模型 · clampText 去空白并按字符截断',
    PersonalInstruction.clampText('  前后  ', 40) === '前后' &&
      PersonalInstruction.clampText('中'.repeat(41), 40) === '中'.repeat(40))
  check('个性化指令 · 模型 · normalizeScopes 去重去空保序',
    PersonalInstruction.normalizeScopes(['b', 'a', ' b ', '', 'a']).join(',') === 'b,a')

  const piDirtyJson: string = JSON.stringify([
    { id: 'a', name: ' 名字 ', content: '# 用英文回答\n\n正文', scopes: ['interactive', 'work', 'interactive', ' work '], updatedAt: 12345 },
    { id: '  ', content: '缺 id', scopes: ['work'], updatedAt: 1 },
    { id: 'b', content: '   ', scopes: ['work'], updatedAt: 2 },
    { id: 'c', content: '非字符串范围', scopes: 'work', updatedAt: 3 },
    { id: 'd', content: '缺时间', scopes: ['work'] },
    { id: 5, content: 'id 不是字符串', scopes: [] },
    null,
    42,
    ['数组条目'],
    { id: 'e', name: 123, content: '名称不是字符串', scopes: ['guncat-3.0-flash'], updatedAt: 9 },
    { id: 'f', content: '时间非法', scopes: ['work'], updatedAt: -5 }
  ])
  const piParsed = PersonalInstruction.parseList(piDirtyJson)
  check('个性化指令 · 模型 · parseList 丢弃缺 id / 空正文 / 非对象条目，保留可救条目',
    piParsed.length === 5 && piParsed.map((it) => it.id).join(',') === 'a,c,d,e,f',
    `${piParsed.length} 条: ${piParsed.map((it) => it.id).join(',')}`)
  check('个性化指令 · 模型 · parseList 名称去空白、范围去重保序、updatedAt 原值保留',
    piParsed[0].name === '名字' && piParsed[0].scopes.join(',') === 'interactive,work' &&
      piParsed[0].updatedAt === 12345,
    `${piParsed[0].name}|${piParsed[0].scopes.join(',')}|${piParsed[0].updatedAt}`)
  check('个性化指令 · 模型 · 非数组 scopes 按空范围处理', piParsed[1].scopes.length === 0)
  check('个性化指令 · 模型 · 缺 updatedAt / 非法 updatedAt 回填为当前时间（>0）',
    piParsed[2].updatedAt > 0 && piParsed[4].updatedAt > 0,
    `${piParsed[2].updatedAt}/${piParsed[4].updatedAt}`)
  check('个性化指令 · 模型 · 非字符串 name 按空名称处理', piParsed[3].name === '')
  check('个性化指令 · 模型 · parseList 对空串 / 坏 JSON / 非数组 JSON 返回空列表',
    PersonalInstruction.parseList('').length === 0 &&
      PersonalInstruction.parseList('   ').length === 0 &&
      PersonalInstruction.parseList('{not json').length === 0 &&
      PersonalInstruction.parseList('{"items":[]}').length === 0 &&
      PersonalInstruction.parseList('null').length === 0)
  check('个性化指令 · 模型 · fromJson 缺 id / 空正文返回 null',
    PersonalInstruction.fromJson({ content: '有正文' }) === null &&
      PersonalInstruction.fromJson({ id: 'x' }) === null &&
      PersonalInstruction.fromJson({ id: 'x', content: '   ' }) === null)

  const piFromLong = PersonalInstruction.fromJson({ id: 'x', content: '中'.repeat(8001) })
  check('个性化指令 · 模型 · fromJson 对超长正文同样截断到 8000',
    piFromLong !== null && piFromLong.content === '中'.repeat(8000))
  const piRoundTrip = PersonalInstruction.fromJson(piParsed[0].toJson())
  check('个性化指令 · 模型 · toJson → fromJson 往返保留 id/名称/正文/范围/时间',
    piRoundTrip !== null && piRoundTrip.id === piParsed[0].id &&
      piRoundTrip.name === piParsed[0].name && piRoundTrip.content === piParsed[0].content &&
      piRoundTrip.scopes.join(',') === piParsed[0].scopes.join(',') &&
      piRoundTrip.updatedAt === piParsed[0].updatedAt)

  const piNameItem = PersonalInstruction.create('  列表名  ', '正文', ['work'])
  const piHeadingItem = PersonalInstruction.create('', '# 用英文回答\n\n正文内容', ['work'])
  const piListHeadItem = PersonalInstruction.create('', '- 列表首行\n第二行', ['work'])
  const piPlainHeadItem = PersonalInstruction.create('', '\n\n  普通首行  \n第二行', ['work'])
  const piEmptyItem = new PersonalInstruction()
  piEmptyItem.content = '\n\n   \n'
  const piLongLineItem = PersonalInstruction.create('', 'a'.repeat(30), ['work'])
  check('个性化指令 · 模型 · displayName 有名称时去空白返回名称',
    piNameItem.displayName() === '列表名')
  check('个性化指令 · 模型 · displayName 无名称取正文首行并去 Markdown 记号',
    piHeadingItem.displayName() === '用英文回答' &&
      piListHeadItem.displayName() === '列表首行' &&
      piPlainHeadItem.displayName() === '普通首行',
    `${piHeadingItem.displayName()}|${piListHeadItem.displayName()}|${piPlainHeadItem.displayName()}`)
  check('个性化指令 · 模型 · displayName 首行过长截断 24 字',
    piLongLineItem.displayName() === 'a'.repeat(24), `${piLongLineItem.displayName().length} 字`)
  check('个性化指令 · 模型 · displayName 空内容回退「未命名指令」',
    piEmptyItem.displayName() === '未命名指令', piEmptyItem.displayName())

  const piSummaryItem = PersonalInstruction.create('', '第一行\n第二行   有空格\t制表', ['work'])
  check('个性化指令 · 模型 · summary 把换行/连续空白压成一个空格',
    piSummaryItem.summary() === '第一行 第二行 有空格 制表', JSON.stringify(piSummaryItem.summary()))
  const piSummaryLong = PersonalInstruction.create('', 'a'.repeat(100), ['work'])
  check('个性化指令 · 模型 · summary 超长截断 80 字',
    piSummaryLong.summary() === 'a'.repeat(80), `${piSummaryLong.summary().length} 字`)

  const piItemInteractive = PersonalInstruction.create('', '永远用中文回答。', ['interactive'])
  const piItemWork = PersonalInstruction.create(
    '工作偏好', '每次交付都附自检清单。', ['work', 'guncat-smoke-engine'])
  const piItemEngine = PersonalInstruction.create('称呼', '称呼我为「指挥官」。', ['guncat-smoke-engine'])
  const piItems: PersonalInstruction[] = [piItemInteractive, piItemWork, piItemEngine]
  check('个性化指令 · 模型 · indexOfId 命中下标 / 未知 id 与空列表返回 -1',
    PersonalInstruction.indexOfId(piItems, piItemWork.id) === 1 &&
      PersonalInstruction.indexOfId(piItems, 'pi-not-exist') === -1 &&
      PersonalInstruction.indexOfId([], piItemWork.id) === -1)
  check('个性化指令 · 模型 · sortScopesByOrder 按 交互→工作→引擎 排序，未知 scope 保留在末尾',
    PersonalInstruction.sortScopesByOrder(
      ['guncat-old-removed', 'guncat-3.0-flash', 'work', 'interactive'],
      ['interactive', 'work', 'guncat-3.0-flash']
    ).join(',') === 'interactive,work,guncat-3.0-flash,guncat-old-removed')
  check('个性化指令 · 模型 · hasScope 命中/未命中',
    piItemWork.hasScope('work') && !piItemWork.hasScope('interactive'))

  // ---- 24.2 提示词拼装 ----
  const piBlankItem = new PersonalInstruction()
  piBlankItem.content = '   '
  piBlankItem.scopes = ['work']
  check('个性化指令 · 提示词 · matches 对空 scope / 空正文 / 未勾选范围返回 false',
    !PersonalInstructionPrompt.matches(piItemWork, '') &&
      !PersonalInstructionPrompt.matches(piBlankItem, 'work') &&
      !PersonalInstructionPrompt.matches(piItemWork, 'interactive') &&
      PersonalInstructionPrompt.matches(piItemWork, 'work'))
  const piWorkEffective = PersonalInstructionPrompt.effective('work', piItems)
  const piEngineEffective = PersonalInstructionPrompt.effective('guncat-smoke-engine', piItems)
  check('个性化指令 · 提示词 · effective 只保留生效条目并保持存储顺序',
    piWorkEffective.length === 1 && piWorkEffective[0].id === piItemWork.id &&
      piEngineEffective.length === 2 &&
      piEngineEffective[0].id === piItemWork.id && piEngineEffective[1].id === piItemEngine.id,
    `work ${piWorkEffective.length} / engine ${piEngineEffective.length}`)
  check('个性化指令 · 提示词 · effective 对空 scope / 未知 scope 返回空数组',
    PersonalInstructionPrompt.effective('', piItems).length === 0 &&
      PersonalInstructionPrompt.effective('unknown-engine', piItems).length === 0)

  const piMdItem = PersonalInstruction.create('', '# 标题\n\n- 条目一\n- **加粗**', ['work'])
  check('个性化指令 · 提示词 · wrap 无名称时开头是裸标签',
    PersonalInstructionPrompt.wrap(piItemInteractive)
      .startsWith('<' + PersonalInstructionPrompt.TAG + '>\n'))
  check('个性化指令 · 提示词 · wrap 有名称时开头带 name 属性',
    PersonalInstructionPrompt.wrap(piItemWork)
      .startsWith('<personal-instruction name="工作偏好">\n'))
  check('个性化指令 · 提示词 · wrap 正文原样保留（Markdown 与换行逐字节不变）',
    PersonalInstructionPrompt.wrap(piMdItem) ===
      '<personal-instruction>\n' + piMdItem.content + '\n</personal-instruction>')
  check('个性化指令 · 提示词 · escapeAttribute 转义 & < > " 且中文原样',
    PersonalInstructionPrompt.escapeAttribute('A"<&>中文') === 'A&quot;&lt;&amp;&gt;中文',
    PersonalInstructionPrompt.escapeAttribute('A"<&>中文'))
  const piQuotedNameItem = PersonalInstruction.create('A"<&>', '正文', ['work'])
  check('个性化指令 · 提示词 · 名称属性里的特殊字符被转义',
    PersonalInstructionPrompt.wrap(piQuotedNameItem)
      .startsWith('<personal-instruction name="A&quot;&lt;&amp;&gt;">\n'))

  check('个性化指令 · 提示词 · 无生效条目时 section 返回空串',
    PersonalInstructionPrompt.section('', piItems) === '' &&
      PersonalInstructionPrompt.section('unknown-engine', piItems) === '' &&
      PersonalInstructionPrompt.section('work', []) === '')
  const piWorkSection = PersonalInstructionPrompt.section('work', piItems)
  const piEngineSection = PersonalInstructionPrompt.section('guncat-smoke-engine', piItems)
  check('个性化指令 · 提示词 · section 以段标题开头且段说明紧随其后',
    piWorkSection.startsWith(
      PersonalInstructionPrompt.SECTION_TITLE + '\n' + PersonalInstructionPrompt.SECTION_INTRO),
    piWorkSection.slice(0, 24))
  check('个性化指令 · 提示词 · section 在标题/说明与每个块之间留一个空行',
    piEngineSection ===
      PersonalInstructionPrompt.SECTION_TITLE + '\n' +
      PersonalInstructionPrompt.SECTION_INTRO + '\n\n' +
      PersonalInstructionPrompt.wrap(piItemWork) + '\n\n' +
      PersonalInstructionPrompt.wrap(piItemEngine) &&
      (piEngineSection.match(/\n\n/g) ?? []).length === 2,
    `${(piEngineSection.match(/\n\n/g) ?? []).length} 处空行分隔`)
  check('个性化指令 · 提示词 · section 只拼当前 scope 的条目',
    piEngineSection.includes('自检清单') && piEngineSection.includes('指挥官') &&
      !piEngineSection.includes('永远用中文'))

  const piBigA = PersonalInstruction.create('', 'x'.repeat(8000), ['work'])
  const piBigB = PersonalInstruction.create('', 'x'.repeat(8000), ['work'])
  const piBigC = PersonalInstruction.create('', 'THIRD-ITEM-SENTINEL', ['work'])
  const piCapped = PersonalInstructionPrompt.section('work', [piBigA, piBigB, piBigC])
  // 段 = 标题 + '\n' + 说明 + ('\n\n' + 块)×N + ['\n\n' + 备注]，据此从测量值反推块总长
  const piCappedBlocks: number = piCapped.length -
    (PersonalInstructionPrompt.SECTION_TITLE.length + 1 +
      PersonalInstructionPrompt.SECTION_INTRO.length) -
    6 - PersonalInstructionPrompt.TRUNCATED_NOTE.length
  check('个性化指令 · 提示词 · 超 16000 预算时截断并追加 TRUNCATED_NOTE',
    piCapped.includes(PersonalInstructionPrompt.TRUNCATED_NOTE) &&
      piCapped.endsWith('\n' + PersonalInstructionPrompt.TRUNCATED_NOTE))
  check('个性化指令 · 提示词 · 截断后两条块合计正好用满 16000 预算',
    piCappedBlocks === PersonalInstructionPrompt.MAX_TOTAL_CHARS, String(piCappedBlocks))
  check('个性化指令 · 提示词 · 第一条完整、第二条截断、第三条不再出现',
    piCapped.includes(PersonalInstructionPrompt.wrap(piBigA)) &&
      !piCapped.includes('THIRD-ITEM-SENTINEL') &&
      (piCapped.match(/<personal-instruction>/g) ?? []).length === 2)
  const piSecondRoom: number =
    PersonalInstructionPrompt.MAX_TOTAL_CHARS - PersonalInstructionPrompt.wrap(piBigA).length
  check('个性化指令 · 提示词 · 第二条在剩余额度处按字符截断（不做标签补齐）',
    (piCapped.match(/x/g) ?? []).length ===
      8000 + (piSecondRoom - '<personal-instruction>\n'.length),
    `${(piCapped.match(/x/g) ?? []).length} 个 x`)

  const piBasePrompt = 'BASE_PROMPT\n第二行原样保留'
  check('个性化指令 · 提示词 · appendSection 空段返回原串（=== 相等）',
    PersonalInstructionPrompt.appendSection(piBasePrompt, '') === piBasePrompt)
  check('个性化指令 · 提示词 · appendSection 空前缀直接返回段',
    PersonalInstructionPrompt.appendSection('', 'SECTION') === 'SECTION' &&
      PersonalInstructionPrompt.appendSection('   \n ', 'SECTION') === 'SECTION')
  const piAppended = PersonalInstructionPrompt.appendSection(piBasePrompt, 'SECTION')
  check('个性化指令 · 提示词 · appendSection 非空前缀严格为「原串 + \\n\\n + 段」',
    piAppended === piBasePrompt + '\n\n' + 'SECTION', JSON.stringify(piAppended))
  check('个性化指令 · 提示词 · appendSection 前缀逐字节不变',
    piAppended.slice(0, piBasePrompt.length) === piBasePrompt &&
      piAppended.indexOf(piBasePrompt) === 0)
  check('个性化指令 · 提示词 · append = appendSection(section)，无生效条目时原样返回',
    PersonalInstructionPrompt.append(piBasePrompt, 'work', piItems) ===
      PersonalInstructionPrompt.appendSection(
        piBasePrompt, PersonalInstructionPrompt.section('work', piItems)) &&
      PersonalInstructionPrompt.append(piBasePrompt, 'unknown-engine', piItems) === piBasePrompt &&
      PersonalInstructionPrompt.append('', 'work', piItems) ===
        PersonalInstructionPrompt.section('work', piItems))
  check('个性化指令 · 提示词 · fixedScopeLabel 两个模式有固定中文名',
    PersonalInstructionPrompt.fixedScopeLabel(Constants.INTERACTIVE_AGENT_ID) === '交互模式' &&
      PersonalInstructionPrompt.fixedScopeLabel(Constants.WORK_AGENT_ID) === '工作模式' &&
      PersonalInstructionPrompt.fixedScopeLabel('guncat-smoke-engine') === '')

  // ---- 24.3 持久化（复用 smoke 已建好的 ctx） ----
  const piStoreA = PersonalInstruction.create(
    '格式', '# 交付格式\n1. 先给结论\n2. 再给依据', ['interactive', 'guncat-smoke-engine'])
  const piStoreB = PersonalInstruction.create('', '回答尽量短。', ['work'])
  await PersonalInstructionStore.save(ctx, [piStoreA, piStoreB])
  const piLoaded = await PersonalInstructionStore.load(ctx)
  check('个性化指令 · 持久化 · save → load 条目数与顺序一致',
    piLoaded.length === 2 && piLoaded[0].id === piStoreA.id && piLoaded[1].id === piStoreB.id,
    `${piLoaded.length} 条`)
  check('个性化指令 · 持久化 · save → load 字段逐项一致（含 scopes 顺序）',
    piLoaded[0].name === '格式' && piLoaded[0].content === piStoreA.content &&
      piLoaded[0].scopes.join(',') === 'interactive,guncat-smoke-engine' &&
      piLoaded[0].updatedAt === piStoreA.updatedAt &&
      piLoaded[1].name === '' && piLoaded[1].content === '回答尽量短。')
  check('个性化指令 · 持久化 · 键名 = Constants.LS_KEY_PERSONAL_INSTRUCTIONS',
    Constants.LS_KEY_PERSONAL_INSTRUCTIONS === 'guncat_personal_instructions')
  const piSerialized = PersonalInstructionStore.serialize(piLoaded)
  const piReparsed = PersonalInstruction.parseList(piSerialized)
  check('个性化指令 · 持久化 · serialize → parseList 互逆（字段与范围顺序不变）',
    piReparsed.length === 2 && piReparsed[0].id === piStoreA.id &&
      piReparsed[0].name === piStoreA.name && piReparsed[0].content === piStoreA.content &&
      piReparsed[0].scopes.join(',') === piStoreA.scopes.join(',') &&
      piReparsed[0].updatedAt === piStoreA.updatedAt,
    `${piSerialized.length} 字节`)
  check('个性化指令 · 持久化 · 空列表 serialize 为 "[]" 且可解析回空数组',
    PersonalInstructionStore.serialize([]) === '[]' &&
      PersonalInstruction.parseList('[]').length === 0)
  await PersonalInstructionStore.save(ctx, [])
  const piClearedRaw = await StorageManager.loadString(
    ctx, Constants.LS_KEY_PERSONAL_INSTRUCTIONS, '__missing__')
  check('个性化指令 · 持久化 · 空列表落盘为 "[]"（读回不是空串）',
    piClearedRaw === '[]', JSON.stringify(piClearedRaw))
  check('个性化指令 · 持久化 · 清空后 load 回空列表（不污染其它断言）',
    (await PersonalInstructionStore.load(ctx)).length === 0)

  // ---- 24.4 三协议注入 ----
  // 拼法与 SessionManager.agentWithPersonalInstructions 完全一致：
  // 复制一份 Agent（Object.assign），只改副本的 systemPrompt，原智能体对象不动。
  const piCfg: ApiConfig = new ApiConfig()
  piCfg.provider = 'openai-completions'
  piCfg.baseUrl = 'https://api.deepseek.com'
  piCfg.model = 'deepseek-flash'

  const piEngineAgent: Agent = Agent.of(
    'guncat-smoke-engine', '冒烟引擎', '回归测试用智能体', 'chat', 'prompts/smoke.md',
    '你是冒烟测试引擎。\n回答保持简洁。')
  const piInjectedSection: string =
    PersonalInstructionPrompt.section('guncat-smoke-engine', piItems)
  const piInjectedAgent: Agent = Object.assign(new Agent(), piEngineAgent)
  piInjectedAgent.systemPrompt = PersonalInstructionPrompt.appendSection(
    piEngineAgent.systemPrompt, piInjectedSection)
  const piExpectedPrompt: string = piEngineAgent.systemPrompt + '\n\n' + piInjectedSection

  check('个性化指令 · 注入 · 克隆不污染原智能体（原 systemPrompt 逐字节不变）',
    piInjectedAgent !== piEngineAgent &&
      piEngineAgent.systemPrompt === '你是冒烟测试引擎。\n回答保持简洁。' &&
      piInjectedAgent.systemPrompt !== piEngineAgent.systemPrompt)
  check('个性化指令 · 注入 · 段只含该引擎生效的条目',
    piInjectedSection.includes('自检清单') && piInjectedSection.includes('指挥官') &&
      !piInjectedSection.includes('永远用中文'))

  const piChatBody = buildChatCompletionsBody(piCfg, piInjectedAgent, [], '你好', false, false)
  const piChatMessages = piChatBody['messages'] as Record<string, Object>[]
  const piChatSystem = piChatMessages[0]['content'] as string
  check('个性化指令 · 注入 · completions 第 0 条仍是 system 消息',
    piChatMessages[0]['role'] === 'system', String(piChatMessages[0]['role']))
  check('个性化指令 · 注入 · completions 系统提示 = 原提示逐字节 + 空行 + 段',
    piChatSystem === piExpectedPrompt && piChatSystem.endsWith(piInjectedSection))
  check('个性化指令 · 注入 · completions 系统提示前缀逐字节不变',
    piChatSystem.slice(0, piEngineAgent.systemPrompt.length) === piEngineAgent.systemPrompt)

  const piAnthropicBody = buildAnthropicBody(piCfg, piInjectedAgent, [], '', false, false)
  const piAnthropicSystem = piAnthropicBody['system'] as string
  check('个性化指令 · 注入 · anthropic body.system = 原提示逐字节 + 段',
    piAnthropicSystem === piExpectedPrompt && piAnthropicSystem.endsWith(piInjectedSection))
  check('个性化指令 · 注入 · anthropic 系统提示前缀逐字节不变',
    piAnthropicSystem.slice(0, piEngineAgent.systemPrompt.length) ===
      piEngineAgent.systemPrompt)

  // ChatService 的 responses 构建器（buildResponsesBody）没有导出，按任务约定不改生产代码导出。
  // 这里改用 AgentLoopService 已注册的同协议构建器（与现有 smoke 访问私有静态方法的写法一致）
  // 验证「LoopMessage.system 的正文 → body.instructions」这一字段映射；聊天模式那份构建器
  // 的来源另用源码静态核对兜底（见下一条）。
  const piLoopBodies = AgentLoopService as unknown as {
    buildResponsesBody: (config: ApiConfig, messages: LoopMessage[],
      tools: Record<string, Object>[], thinkingEnabled: boolean, reasoningEffort: string,
      webSearchEnabled: boolean, jsonMode?: boolean) => Record<string, Object>
  }
  const piResponsesBody = piLoopBodies.buildResponsesBody(
    piCfg,
    [LoopMessage.system(piInjectedAgent.systemPrompt), LoopMessage.user('你好')],
    [], false, 'low', false)
  const piResponsesInstructions = piResponsesBody['instructions'] as string
  check('个性化指令 · 注入 · responses body.instructions = 原提示逐字节 + 段',
    piResponsesInstructions === piExpectedPrompt &&
      piResponsesInstructions.endsWith(piInjectedSection))
  check('个性化指令 · 注入 · responses 系统提示前缀逐字节不变',
    piResponsesInstructions.slice(0, piEngineAgent.systemPrompt.length) ===
      piEngineAgent.systemPrompt)
  check('个性化指令 · 注入 · responses 不再把 system 重复塞进 input',
    (piResponsesBody['input'] as Record<string, Object>[])
      .every((m) => m['role'] !== 'system'))

  const piChatServiceSource: string =
    fs.readFileSync(path.resolve('src/core/service/ChatService.ts'), 'utf8')
  check('个性化指令 · 注入 · ChatService responses 构建器仍从 agent.systemPrompt 取 instructions（源码静态核对）',
    piChatServiceSource.includes('function buildResponsesBody(') &&
      piChatServiceSource.includes("body['instructions'] = agent.systemPrompt"))

  // 反面：scope 不匹配 = 一条都不生效 → 系统提示与请求体必须与未注入前逐字节一致
  const piUnmatchedSection: string =
    PersonalInstructionPrompt.section('pi-no-such-engine', piItems)
  check('个性化指令 · 注入 · 无生效条目时段为空串', piUnmatchedSection === '')
  const piUnchangedPrompt: string =
    PersonalInstructionPrompt.appendSection(piEngineAgent.systemPrompt, piUnmatchedSection)
  check('个性化指令 · 注入 · 无生效条目时 appendSection 返回原串（=== 相等）',
    piUnchangedPrompt === piEngineAgent.systemPrompt)
  const piUnchangedAgent: Agent = Object.assign(new Agent(), piEngineAgent)
  piUnchangedAgent.systemPrompt = piUnchangedPrompt
  check('个性化指令 · 注入 · 无生效条目时 completions 请求体逐字节一致（JSON.stringify 比较）',
    JSON.stringify(buildChatCompletionsBody(piCfg, piEngineAgent, [], '你好', false, false)) ===
      JSON.stringify(buildChatCompletionsBody(piCfg, piUnchangedAgent, [], '你好', false, false)))
  check('个性化指令 · 注入 · 无生效条目时 anthropic 请求体逐字节一致（JSON.stringify 比较）',
    JSON.stringify(buildAnthropicBody(piCfg, piEngineAgent, [], '', false, false)) ===
      JSON.stringify(buildAnthropicBody(piCfg, piUnchangedAgent, [], '', false, false)))
  check('个性化指令 · 注入 · 无生效条目时 responses 请求体逐字节一致（JSON.stringify 比较）',
    JSON.stringify(piLoopBodies.buildResponsesBody(
      piCfg, [LoopMessage.system(piEngineAgent.systemPrompt), LoopMessage.user('你好')],
      [], false, 'low', false)) ===
      JSON.stringify(piLoopBodies.buildResponsesBody(
        piCfg, [LoopMessage.system(piUnchangedPrompt), LoopMessage.user('你好')],
        [], false, 'low', false)))

  // ===== 结果 =====
  console.log(`\n${'─'.repeat(58)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) {
    console.log('失败项：')
    for (const f of failures) {
      console.log(`  - ${f}`)
    }
  }
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\n冒烟验证异常终止：')
  console.error(e)
  process.exit(1)
})
