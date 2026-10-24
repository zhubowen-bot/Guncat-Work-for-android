// SSR 渲染验证的入口：把一份有代表性的界面程序渲染成 HTML 字符串。
// 由 scripts/render-check.mjs 打包执行。
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { GuncatUiBlock } from '@renderer/guncat-ui/GuncatUiBlock'
import { ToolCallRow } from '@renderer/components/Disclosure'
import { GuncatUiParts } from '@core/common/GuncatUiParts'
import { CommandGuard } from '@core/service/CommandGuard'
import { Constants } from '@core/common/Constants'
import { docxFileName } from '@renderer/fileName'
import {
  WORK_AGENT_ID,
  INTERACTIVE_AGENT_ID,
  agentIdForMode,
  agentOfConversation,
  buildAgentList,
  conversationMeta,
  conversationTitle,
  engineIdOfConversation,
  formatTimeLabel,
  modeForAgentId
} from '@renderer/conversations'
import {
  formatDuration,
  formatStats,
  groupTurns,
  processTitle,
  stripMarkdown,
  toolArgsSummary,
  toolDisplayName,
  toolIconKind,
  toolStatus,
  turnStats
} from '@renderer/turns'
import {
  IconBrain,
  IconClose,
  IconDownload,
  IconInteractive,
  IconMic,
  IconSend,
  IconSettings,
  IconStopCircle,
  IconTrash,
  IconWork
} from '@renderer/icons'
import { AgentItem, ConvItem, Sidebar } from '@renderer/components/Sidebar'
import { GroupedTurn, Timeline, WorkTurn } from '@renderer/components/Timeline'
import { Markdown } from '@renderer/components/Markdown'
import { safeUrlTransform } from '@renderer/components/Markdown'
import { normalizeMermaidSource } from '@renderer/components/CodeBlock'
import { Composer } from '@renderer/components/Composer'
import {
  detectMention,
  MentionPopup,
  MENTION_MAX_ROWS,
  rankMentionCandidates,
  type MentionQuery
} from '@renderer/components/MentionPopup'
import { AttachmentBar } from '@renderer/components/AttachmentBar'
import {
  SettingsDialog,
  credentialHint,
  normalizeApiConfig,
  normalizeMultimodal,
  providerCopy,
  searchEngineHint
} from '@renderer/components/SettingsDialog'
import {
  COMMAND_PERMISSIONS,
  TaskGoalCard,
  TaskStatsCard,
  WorkspacePanel,
  formatElapsedSec,
  formatWorkTime,
  instructionSetupHint,
  workspaceFileIcon
} from '@renderer/components/WorkspacePanel'
import { useStore } from '@renderer/store'
import { LightboxView } from '@renderer/components/ImageLightbox'
import { AskUserCard, askConfirmLabel, askToggle } from '@renderer/components/AskUserCard'
import { TableOcrPanel } from '@renderer/components/TableOcrDialog'
import { WorkArtifactsCard } from '@renderer/components/WorkArtifactsCard'
import { AssistantBody, marqueeText } from '@renderer/components/MessageView'
import { EmptyState } from '@renderer/components/EmptyState'
import { AgentGlyph } from '@renderer/components/AgentGlyph'
import type {
  CredentialStateDto,
  MessageDto,
  PickedAttachmentDto,
  WorkspaceEntryDto
} from '@ipc/contract'

/** 导出文件名推导 —— 纯函数，可直接断言 */
export { docxFileName }

/**
 * 链接/图片地址的放行规则。react-markdown 默认会把 `data:` 剥掉，
 * 而桌面端的图片正是 data URL —— 这条规则错了，正文里的图会**静默消失**。
 */
export { safeUrlTransform }

/** 会话列表与引擎选择的纯函数（对应原版 DswSidebar.getConvTitle / selectAgent） */
export {
  WORK_AGENT_ID,
  INTERACTIVE_AGENT_ID,
  agentIdForMode,
  agentOfConversation,
  buildAgentList,
  conversationMeta,
  conversationTitle,
  engineIdOfConversation,
  formatTimeLabel,
  modeForAgentId
}

/**
 * 开关与档位的纯函数（对应原版 ChatViewModel 的 defaultThinkingForAgent /
 * loopEffortForRequest / loopThinkingEnabled）—— 这几条是「默认值写错就悄悄变慢
 * 或悄悄不思考」的地方，单独导出来钉住。
 */
export {
  defaultThinkingForAgent,
  interactiveEffortFromPrefs,
  isLoopMode,
  requestThinking,
  workEffortFromPrefs
} from '@renderer/store'

/**
 * 「会话该按哪个形态打开」的判定（`resolveConversationMode`）。
 * 这条纯函数是被一次真实事故逼出来的：冷启动只设了智能体、没设形态，
 * 于是出现「交互模式智能体 + 聊天形态」—— 界面走聊天分支、
 * 请求走 chat:send、聊天路径又取智能体自己的 prompt（虚拟智能体没有 prompt），
 * 用户看到的是「没有提示词、纯对话」。所以这里逐个组合钉住。
 */
export {
  isVirtualAgentId,
  resolveConversationMode
} from '@renderer/conversations'

/** 回合归组与工具行展示的纯函数（对应原版 buildWorkTimeline / WorkStepFormat） */
export {
  formatDuration,
  formatStats,
  groupTurns,
  processTitle,
  stripMarkdown,
  toolArgsSummary,
  toolDisplayName,
  toolIconKind,
  toolStatus,
  turnStats
}

export { renderIcons }

/**
 * 工作模式的单回合渲染（原版 section='full'）：思考条 / 正文 / 工具行**逐轮直接陈列**，
 * 不做整回合收纳。这与交互模式的 GroupedTurn 是两套布局，必须分别钉住。
 */
export function renderWorkTurn(running = false): string {
  return renderToStaticMarkup(
    createElement(WorkTurn, {
      turn: groupTurns(SHELL_MESSAGES)[0],
      running,
      onEditToInput: () => {}
    })
  )
}

/** 交互模式的单回合渲染（原版 section='grouped'）：整个回合收进一条活动折叠栏。
 *  pendingBody=true 模拟「正文还没开始输出」的流式中间态 —— 此时折叠栏默认展开。 */
export function renderGroupedTurn(running = false, pendingBody = false): string {
  let messages = SHELL_MESSAGES
  if (pendingBody) {
    messages = SHELL_MESSAGES.map((m) => (m.id === 'm3' ? { ...m, content: '', displayContent: '' } : m))
  }
  return renderToStaticMarkup(
    createElement(GroupedTurn, {
      turn: groupTurns(messages)[0],
      running,
      lastAssistantId: 'm3',
      onEditToInput: () => {}
    })
  )
}

/** 被手动停止的回合：折叠栏标题应当是「已停止」而不是「已完成」（原版 isStopped） */
export function renderGroupedTurnStopped(): string {
  const messages = SHELL_MESSAGES.map((m) =>
    m.id === 'm3' ? { ...m, content: `${m.content}\n\n任务已手动停止` } : m
  )
  return renderToStaticMarkup(
    createElement(GroupedTurn, {
      turn: groupTurns(messages)[0],
      running: false,
      lastAssistantId: 'm3',
      onEditToInput: () => {}
    })
  )
}

/** 只有思考、没有工具调用的回合：活动折叠栏也必须出现（原版 hasActivity 的口径） */
export function renderGroupedTurnThinkingOnly(): string {
  const messages = [
    {
      id: 'u1',
      role: 'user',
      content: '想想怎么做',
      displayContent: '想想怎么做',
      reasoning: '',
      createdAt: 0,
      attachments: [],
      toolCalls: [],
      tokenSpeed: -1,
      cacheHitRate: -1
    },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      displayContent: '',
      reasoning: '先看看目录结构，再决定从哪儿下手…',
      createdAt: 1,
      attachments: [],
      toolCalls: [],
      tokenSpeed: -1,
      cacheHitRate: -1
    }
  ] as typeof SHELL_MESSAGES
  return renderToStaticMarkup(
    createElement(GroupedTurn, {
      turn: groupTurns(messages)[0],
      running: false,
      lastAssistantId: 'a1',
      onEditToInput: () => {}
    })
  )
}

/** 思考跑马灯取文本末尾 400 字并压成单行（原版 getMarqueeText） */
export { marqueeText }
export { workspaceFileIcon }

/**
 * 工作区面板（SSR 下 zustand 读初始状态：没有会话、工作区为空）。
 * 用户报障「工作区上传文件找不到入口」——这里钉住那个入口在**空态**下也存在。
 */
export function renderWorkspacePanel(): string {
  return renderToStaticMarkup(createElement(WorkspacePanel))
}

/**
 * 命令审批档位行的数据（面板那个下拉的三档）。
 * 连同 core 的权威档位表一起返回，是为了让断言能钉住「界面上写出去的档位，主进程真的认」——
 * 两边各抄一份字面量的话，早晚会漂成一个 UI 有、执行层不认的档位。
 */
export function commandPermissionRows(): {
  rows: { value: string; label: string; hint: string }[]
  guardPermissions: string[]
} {
  return { rows: COMMAND_PERMISSIONS, guardPermissions: CommandGuard.PERMISSIONS }
}

/**
 * 项目指令行的文案，连同 core 的候选文件名清单一起返回：钉住「界面告诉用户哪些文件会被读」
 * 与「内核实际读的那几个名字」严格同源 —— 抄两份字面量，迟早会漂成界面写着 README.md、
 * 内核根本不认，用户按界面写完发现没生效。
 */
export function instructionRowCopy(): { hint: string; files: string[] } {
  return { hint: instructionSetupHint(), files: Constants.WORK_INSTRUCTION_FILES }
}

/**
 * @ 引用的输入态判定：界面「哪些字符算一个还没敲完的文件引用」必须与内核
 * WorkspaceMentionService.extract 同一口径，否则会出现界面弹了候选、发出去内核却不认，
 * 或反过来（用户看着 @a.md 打完了，模型收到的只是原文）。
 */
export function mentionDetect(text: string, caret: number): MentionQuery | null {
  return detectMention(text, caret)
}

/** @ 候选排序（界面侧的过滤逻辑，纯函数） */
export function mentionRank(files: WorkspaceEntryDto[], query: string): string[] {
  return rankMentionCandidates(files, query, MENTION_MAX_ROWS)
}

/** @ 引用弹层的静态渲染（供断言行、高亮项、说明行都在） */
export function renderMentionPopup(paths: string[], active: number): string {
  return renderToStaticMarkup(createElement(MentionPopup, { paths, active, onPick: () => {} }))
}

/** 工作区文件行的扩展名图标：返回「扩展名 → 渲染出来的 SVG」映射，供断言分类是否生效 */
export function renderWorkspaceFileIcons(): Record<string, string> {
  const names = ['a.png', 'a.pdf', 'a.zip', 'a.py', 'a.mp4', 'a.mp3', 'a.unknown']
  const out: Record<string, string> = {}
  for (const name of names) {
    out[name] = renderToStaticMarkup(workspaceFileIcon(name))
  }
  return out
}

/**
 * 工具行（展开状态）。点开的形态是**互斥**的，对齐原版 WorkTurnView：
 * edit/str_replace_editor 有 diff 就只给 diff 卡，todo_write 只给清单卡，其余才给原始 IO。
 */
export function renderToolRow(
  name: string,
  argsJson: string,
  result: string,
  diff = '',
  durationMs = 320
): string {
  return renderToStaticMarkup(
    createElement(ToolCallRow, {
      defaultExpanded: true,
      call: {
        id: 'call-1',
        name,
        argsJson,
        result,
        status: durationMs < 0 ? 'running' : 'ok',
        startedAt: 0,
        finishedAt: 0,
        durationMs,
        diff
      }
    })
  )
}

/**
 * 执行中的工具行（转圈 + 三分状态文案）。
 * 注意：展开箭头原版是**无条件渲染**的（审计报告一度写错成「运行中隐藏」，这里按源码校正）。
 * `started` 用来区分「已开始执行」（执行中…）与「本轮结束但耗时仍为负」（已中断）。
 */
export function renderToolRowRunning(
  variant: 'chat' | 'loop' = 'loop',
  streaming = true,
  started = true
): string {
  return renderToStaticMarkup(
    createElement(ToolCallRow, {
      variant,
      streaming,
      call: {
        id: 'call-running',
        name: 'read_file',
        argsJson: '{"path":"docs/a.md"}',
        result: '',
        status: 'running',
        startedAt: 0,
        finishedAt: 0,
        durationMs: -1,
        started,
        preparing: false,
        diff: ''
      }
    })
  )
}

/** 排队等待中的工具行（参数已生成、还没轮到执行 → 「等待中…」） */
export function renderToolRowQueued(): string {
  return renderToStaticMarkup(
    createElement(ToolCallRow, {
      variant: 'loop',
      streaming: true,
      call: {
        id: 'call-queued',
        name: 'write_file',
        argsJson: '{"path":"a.md"}',
        result: '',
        status: 'running',
        startedAt: 0,
        finishedAt: 0,
        durationMs: -1,
        started: false,
        preparing: false,
        diff: ''
      }
    })
  )
}

/**
 * 任务统计卡 / 目标卡（原版 DetailsPanelView 的统计卡与目标卡）。
 * 传进来的是一份「有数据」的统计，便于断言四项指标与目标卡都渲染出来。
 * 参数口径对齐 WorkspacePanel.TaskStatsCard：用时是**整数秒**（原版 elapsedSec）。
 */
export function renderTaskStats(): string {
  return renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(TaskStatsCard, {
        elapsedSec: 83,
        speed: 42.35,
        cacheHit: 0.812,
        toolCalls: 7
      }),
      createElement(TaskGoalCard, {
        goal: { objective: '把季度报表补齐并导出', status: 'active', rounds: 3, maxRounds: 40 }
      })
    )
  )
}

/** 没有数据时统计卡仍然在（值显示「—」），目标卡不渲染 */
export function renderTaskStatsEmpty(): string {
  return renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(TaskStatsCard, { elapsedSec: 0, speed: -1, cacheHit: -1, toolCalls: 0 }),
      createElement(TaskGoalCard, { goal: null })
    )
  )
}

/** 会话工作时间与用时格式（整数秒 / MM:SS / HH:MM:SS） */
export function renderDurations(): string[] {
  return [formatElapsedSec(0), formatElapsedSec(83), formatWorkTime(83), formatWorkTime(3723)]
}

/**
 * 图片灯箱（原版 ImageLightbox.ets）。两张对照：有 url 时渲染遮罩 + 大图 + 关闭钮，
 * 没有 url 时整块不渲染。
 */
export function renderLightbox(open = true): string {
  return renderToStaticMarkup(
    createElement(LightboxView, {
      url: open ? 'data:image/png;base64,iVBORw0KGgo=' : '',
      onClose: () => {}
    })
  )
}

/**
 * 表格提取面板（原版唯一不依赖对话的独立工具页）。
 * 直接渲染纯展示层：弹层由 store 控制，而 SSR 的 server snapshot 取的是 store
 * **初始状态**（zustand v5 的行为），没法靠 setState 打开，所以这里绕过 store 测面板本身。
 */
export function renderTableOcr(): string {
  return renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(TableOcrPanel, {
        models: [
          { id: 'glm-4v-flash', label: 'glm-4v-flash（多模态解析）' },
          { id: 'doubao-vision', label: 'doubao-vision（生产）' }
        ],
        model: 'glm-4v-flash',
        image: null,
        result: null,
        busy: false,
        onModelChange: () => {},
        onPick: () => {},
        onRecognize: () => {},
        onCopy: () => {},
        onClose: () => {}
      })
    )
  )
}

/** 有图有结果时的面板（表格预览与复制入口） */
export function renderTableOcrResult(): string {
  return renderToStaticMarkup(
    createElement(TableOcrPanel, {
      models: [{ id: 'glm-4v-flash', label: 'glm-4v-flash（多模态解析）' }],
      model: 'glm-4v-flash',
      image: { path: 'C:/tmp/表格.png', name: '表格.png', size: 2048, thumbnail: '' },
      result: { html: '<table><tr><th>季度</th><th>收入</th></tr><tr><td>Q1</td><td>120</td></tr></table>', model: 'glm-4v-flash' },
      busy: false,
      onModelChange: () => {},
      onPick: () => {},
      onRecognize: () => {},
      onCopy: () => {},
      onClose: () => {}
    })
  )
}

/**
 * 产物汇总卡（原版对话流末尾的 Codex 风格 Changes 卡）。
 * 默认展开列文件；每个文件的行级改动**默认收起** —— 这两条都要能断言到。
 */
export function renderArtifacts(): string {
  return renderToStaticMarkup(
    createElement(WorkArtifactsCard, {
      artifacts: {
        files: [
          {
            path: 'reports/季度复盘.docx',
            hasDiff: false,
            adds: 0,
            dels: 0,
            rows: []
          },
          {
            path: 'src/core/main.ts',
            hasDiff: true,
            adds: 3,
            dels: 1,
            rows: [
              { type: 'same', text: 'const a = 1' },
              { type: 'del', text: 'const b = 2' },
              { type: 'add', text: 'const b = 3' },
              { type: 'add', text: 'const c = 4' }
            ]
          }
        ],
        totalAdds: 3,
        totalDels: 1
      },
      onPreview: () => {}
    })
  )
}

/** 没有产物时整张卡不渲染 */
export function renderArtifactsEmpty(): string {
  return renderToStaticMarkup(
    createElement(WorkArtifactsCard, {
      artifacts: { files: [], totalAdds: 0, totalDels: 0 },
      onPreview: () => {}
    })
  )
}

/**
 * 产物卡「点开文件」这条链路的接线检查。
 *
 * 事故形状：工作模式下点产物汇总卡里的文件名或「预览」没有任何反应。
 * 根因是两个入口各持一份**组件本地**预览状态，弹层又按「面板展开时只由面板渲染」二选一 ——
 * 产物卡的点击落在了一份没人渲染的状态上。现在目标收进 store，两处写的都是同一个动作。
 *
 * 这里断言状态层而不是渲染层：SSR 的 server snapshot 读的是 store 初始值，
 * setState 打不开弹层（灯箱那边同样为此单独导出了纯展示层），所以直接调 store 动作。
 */
export function workspacePreviewWiring(): {
  opened: { conversationId: string; path: string } | null
  clearedAfterClose: boolean
  ignoredWithoutConversation: boolean
} {
  useStore.setState({ activeId: 'conv-1', workspacePreview: null })
  useStore.getState().openWorkspaceFile('reports/季度复盘.docx')
  const opened = useStore.getState().workspacePreview
  useStore.getState().closeWorkspaceFile()
  const clearedAfterClose = useStore.getState().workspacePreview === null
  useStore.setState({ activeId: null, workspacePreview: null })
  useStore.getState().openWorkspaceFile('a.md')
  const ignoredWithoutConversation = useStore.getState().workspacePreview === null
  return { opened, clearedAfterClose, ignoredWithoutConversation }
}

/**
 * 侧栏（SSR 下 zustand 读初始状态：引擎与会话都是空的）。
 * 空列表也能钉住几件与数据无关的事：引擎区分成两段、聊天段默认折叠、底部有工作区入口。
 */
export function renderSidebar(): string {
  return renderToStaticMarkup(createElement(Sidebar))
}

/**
 * 设置面板（对齐原版 views/SettingsPanel.ets）。
 *
 * 为什么能在这里渲染：面板平时由 store 的 settingsOpen 控制，而 SSR 下 zustand
 * 只会读到初始状态（false），整块不渲染 —— 所以 SettingsDialog 把「开合」提成了
 * 可选 props，显式传 open 就能把首帧形态钉住（三个小节默认收起等）。
 * useEffect 在 SSR 里不执行，因此不会真的去调 window.guncat。
 */
export function renderSettings(): string {
  return renderToStaticMarkup(createElement(SettingsDialog, { open: true }))
}

/**
 * 设置面板里随接入方式 / 引擎变化的文案。
 * 逐字对齐原版 getBaseUrlPlaceholder / getModelPlaceholder / getHint /
 * getSearchEngineHint —— 这些字串是用户判断「该填什么」的唯一线索。
 */
export function settingsCopy(
  providerId: string,
  engineId: string
): {
  label: string
  baseUrl: string
  model: string
  hint: string
  suffix: string
  searchHint: string
} {
  const p = providerCopy(providerId)
  return {
    label: p.label,
    baseUrl: p.baseUrlPlaceholder,
    model: p.modelPlaceholder,
    hint: p.hint,
    suffix: p.suffix,
    searchHint: searchEngineHint(engineId)
  }
}

export { normalizeApiConfig, normalizeMultimodal, providerCopy, searchEngineHint }
export { modelChoices } from '@renderer/modelChoices'

/**
 * 密钥存储说明的文案。安全口径必须能被断言：保险库可用时才是「加密保存」，
 * 不可用时要如实写出「明文」，解不开的项要点名 —— 这三种形态差一个词，
 * 用户对「Key 存在哪、安不安全」的判断就整个反过来。
 */
export function credentialCopy(state: CredentialStateDto | undefined): string {
  return credentialHint(state)
}

/**
 * 输入区。附件入口（回形针）只在聊天模式给 —— 工作/交互模式的素材入口是工作区，
 * 两条路是不同的事，这里把这条分界钉住。
 */
export function renderComposer(mode: string, running = false): string {
  return renderToStaticMarkup(
    createElement(Composer, {
      running,
      mode,
      onSend: () => {},
      onSteer: async () => true,
      onAbort: () => {}
    })
  )
}

/**
 * 附件预览条在三种解析状态下的渲染（对齐原版 ChatPage.ets:958-1042）。
 *
 * 为什么单独导出一个「纯 props」版本：Composer 要读 store、还要订阅 IPC 事件，
 * SSR 里两样都拿不到；而这次对齐真正的口径恰恰全在展示层 ——
 * 「解析中... / 解析失败 / 已就绪」三段文案、失败整卡淡红底、解析中不显示删除钮。
 * 状态只能靠夹具喂进来，所以把预览条抽成纯展示组件再逐态断言（同 TableOcrPanel 的做法）。
 */
export function renderAttachmentBar(status: 'parsing' | 'ready' | 'error'): string {
  const att: PickedAttachmentDto = {
    path: 'C:/tmp/季度报表.png',
    name: '季度报表.png',
    size: 204800,
    // 解析中还没有缩略图（缩略图在解析结果里），此时卡片退回显示文件名；
    // 已就绪/失败的卡片则显示缩略图 —— 这两条展示路径都要能断言到。
    thumbnail: status === 'parsing' ? '' : 'data:image/png;base64,iVBORw0KGgo=',
    status,
    ...(status === 'error' ? { error: '多模态接口返回 401 Unauthorized' } : {})
  }
  return renderToStaticMarkup(
    createElement(AttachmentBar, { attachments: [att], onRemove: () => {} })
  )
}

/** Markdown 渲染：断言脚注回跳不是第三方默认的「↩」符号 */
export function renderMarkdown(): string {
  return renderToStaticMarkup(
    createElement(Markdown, { text: '正文有一处脚注[^1]。\n\n[^1]: 这是脚注内容。\n' })
  )
}

/** 正文里的图片（可点放大）。单独一张样例，避免动上面那份「三重重能力」样例。 */
export function renderMarkdownImage(): string {
  const text = ['看看这张图：', '', '![季度趋势](data:image/png;base64,iVBORw0KGgo=)', ''].join('\n')
  return renderToStaticMarkup(createElement(Markdown, { text }))
}

/**
 * Markdown 的三项重能力（用户报障：mermaid 画不出、代码块不正常、LaTeX 不渲染）。
 * 逐项覆盖：行内/块级公式、带语言的围栏代码块（含高亮）、mermaid 围栏、裸围栏。
 */
export function renderMarkdownFeatures(): string {
  const text = [
    '行内公式 $E = mc^2$ 就写在这里。',
    '',
    '$$',
    '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
    '$$',
    '',
    '```python',
    'def hello(name):',
    '    return f"hi {name}"',
    '```',
    '',
    '```mermaid',
    'flowchart TD',
    '  A[开始] --> B[结束]',
    '```',
    '',
    '```',
    '没有语言标记的围栏',
    '```',
    ''
  ].join('\n')
  return renderToStaticMarkup(createElement(Markdown, { text }))
}

/**
 * 送进 mermaid 之前的源码修复。模型经常把箭头写成 Unicode 长箭头（视觉上几乎一样），
 * mermaid 读不懂就整张退回源码 —— 替换规则与「标签内的箭头不许动」都在这儿断言。
 */
export function mermaidSourceFixed(source: string): string {
  return normalizeMermaidSource(source)
}

/**
 * 侧栏条目 + 工作模式单个回合的 SSR 渲染。
 *
 * 为什么渲染这两个「纯 props 组件」而不是整页：
 *   zustand v5 在 SSR 里刻意读 getInitialState()（保证水合一致），
 *   所以整页 SSR 只会看到 store 的初始值，塞不进夹具状态。
 *   把布局里最需要钉住的两块（会话条目、回合归组）做成 props 驱动，
 *   就能在无头环境里断言「标题落到 DOM 上了没有」「一个任务下是不是只有一个过程区」——
 *   恰好就是用户报障的第 2 条和第 5 条。
 */
export function renderShell(running = false): string {
  const engines = buildAgentList(AGENT_FIXTURE)
  const now = new Date(2024, 8, 10, 15, 30, 0).getTime()

  const convRows = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(ConvItem, {
        summary: {
          id: 'conv-a',
          title: '做一个季度销售复盘',
          agentId: 'guncat-3.1-flash',
          mode: 'work',
          updatedAt: new Date(2024, 8, 10, 9, 5, 0).getTime(),
          messageCount: 3,
          lastPreview: '这是最终答复'
        },
        engines,
        active: true,
        now,
        onSelect: () => {},
        onDelete: () => {}
      }),
      // 移植早期的脏数据：标题被写成了引擎名
      createElement(ConvItem, {
        summary: {
          id: 'conv-b',
          title: '轻简模式',
          agentId: 'guncat-3.1-flash',
          mode: 'chat',
          updatedAt: 0,
          messageCount: 0,
          lastPreview: ''
        },
        engines,
        active: false,
        now,
        onSelect: () => {},
        onDelete: () => {}
      }),
      createElement(AgentItem, { agent: engines[0], active: false, onSelect: () => {} }),
      createElement(AgentItem, { agent: engines[1], active: true, onSelect: () => {} })
    )
  )

  const timeline = renderToStaticMarkup(
    createElement(
      'div',
      { className: 'loop-timeline' },
      createElement(WorkTurn, {
        turn: groupTurns(SHELL_MESSAGES)[0],
        running,
        onEditToInput: () => {}
      })
    )
  )

  return convRows + timeline
}

const AGENT_FIXTURE = [
  {
    id: 'guncat-3.1-flash',
    name: '轻简模式',
    description: '日常聊天智能体',
    shortDescription: 'Guncat 3.1-Flash',
    icon: '',
    category: '通用智能体',
    prompt: ''
  }
]

function shellMessage(
  id: string,
  role: string,
  content: string,
  extra: Record<string, unknown> = {}
): MessageDto {
  return {
    id,
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
  } as MessageDto
}

/** 一个用户请求 + 两轮 assistant（工具行只在第一轮）+ 最终答复 */
const SHELL_MESSAGES: MessageDto[] = [
  shellMessage('m0', 'user', '做一个季度销售复盘'),
  shellMessage('m1', 'assistant', '先把数据读进来', {
    reasoning: '需要先看原始数据',
    toolCalls: [
      {
        id: 't1',
        name: 'read_file',
        argsJson: '{"path":"sales.csv"}',
        result: 'ok',
        status: 'ok',
        startedAt: 0,
        finishedAt: 0,
        diff: ''
      }
    ]
  }),
  shellMessage('m2', 'assistant', '这是中间结论'),
  shellMessage('m3', 'assistant', '这是最终答复', { tokenSpeed: 20, cacheHitRate: 0.5 })
]

/** 把全部图标渲染成 HTML：断言统一规格（viewBox / currentColor / 无 emoji） */
function renderIcons(): string {
  return renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(IconWork, { size: 20 }),
      createElement(IconInteractive, { size: 20 }),
      createElement(IconMic, {}),
      createElement(IconSend, {}),
      createElement(IconStopCircle, {}),
      createElement(IconDownload, {}),
      createElement(IconTrash, {}),
      createElement(IconSettings, {}),
      createElement(IconClose, {}),
      createElement(IconBrain, {})
    )
  )
}


const PROGRAM = [
  '$amount = 30',
  'root = Card([',
  '  CardHeader("季度销售复盘", "2024 Q3"),',
  '  TextContent("金额 " + $amount + " 万"),',
  '  MetricIndicatorInline("1,284", "同比", {direction: "up", value: 18.6}),',
  '  Slider("amount", "discrete", 0, 200, 5, [30], "金额", $amount),',
  '  BarChart(["1月","2月","3月"], [Series("本季", [120, 132, 101]), Series("上季", [90, 110, 95])], "grouped", "月份", "万元", 200),',
  '  Table([Col("区域", ["华东","华南"]), Col("营收", [820, 464], "number")]),',
  '  Tabs([TabItem("a", "概览", [TextContent("概览内容")]), TabItem("b", "明细", [TextContent("明细内容")])]),',
  '  Accordion([AccordionItem("k", "更多说明", [TextContent("折叠里的字")])]),',
  '  Steps([StepsItem("立项","已完成"), StepsItem("开发","进行中")]),',
  '  TagBlock(["标签甲","标签乙"]),',
  '  Callout("warn", "注意", "这是一条提醒"),',
  '  CodeBlock("json", "{\\"a\\": 1}"),',
  '  PieChart(["A","B"], [60, 40], "donut"),',
  '  EntityList([{left: "合计", right: "1,284"}]),',
  '  Form("参数", Buttons([Button("重算", @ToAssistant("换口径重算"))]), [',
  '    FormControl("口径", Select("scope", [SelectItem("customers","按客户")], "请选择", {}, $scope)),',
  '    FormControl("周期", Slider("days","discrete",7,90,1,[30],"天数",$days))',
  '  ]),',
  '  Button("仅本地按钮", @ToAssistant("点了按钮"))',
  '])'
].join('\n')

const FENCE = '```'

/**
 * 只含雷达图的界面程序 —— 用于钉住「提示词推荐的 RadarChart 真的有实现」。
 * 这条不是装饰：内核几何（UiChartGeom.radar*）早就移植好了，提示词也一直推荐它，
 * 但渲染层与组件库此前都没有它，模型照提示词写出来会被当未知组件丢掉。
 */
export function renderRadarChart(): string {
  const program = [
    'root = Card([',
    '  CardHeader("多维对比", "雷达图"),',
    '  RadarChart(["价格","性能","续航","外观"], [Series("A 机型", [80, 92, 60, 74]), Series("B 机型", [95, 70, 88, 66])])',
    '])'
  ].join('\n')
  return renderToStaticMarkup(
    createElement(GuncatUiBlock, {
      content: program,
      interactive: true,
      onSend: () => {}
    })
  )
}

export function renderProgram(): string {
  const content = '说明文字在前。\n\n' + FENCE + 'guncat-ui\n' + PROGRAM + '\n' + FENCE + '\n'
  return renderToStaticMarkup(
    createElement(GuncatUiBlock, {
      content,
      interactive: true,
      onSend: () => {}
    })
  )
}

/** 裸程序（不带围栏、不带前置说明），验证围栏可选 */
export function renderBare(): string {
  return renderToStaticMarkup(
    createElement(GuncatUiBlock, {
      content: PROGRAM,
      interactive: false,
      onSend: () => {}
    })
  )
}

/**
 * 界面块的可交互性开关（原版 `interactive() = complete && !locked`）。
 * 传 false 就是「历史界面块 / 执行中的界面」应当有的样子：控件 disabled。
 */
export function renderUiProgramBlock(interactive: boolean): string {
  return renderToStaticMarkup(
    createElement(GuncatUiBlock, {
      content: PROGRAM,
      interactive,
      onSend: () => {}
    })
  )
}

/**
 * 复现 MessageView 的组合方式：纯文本片段走 Markdown，界面片段走 GuncatUiBlock。
 * 界面块本身只负责界面，正文里的说明文字由外层渲染 —— 这条组合关系值得单独钉住。
 */
export function renderComposed(): string {
  const content = '说明文字在前。\n\n' + FENCE + 'guncat-ui\n' + PROGRAM + '\n' + FENCE + '\n'
  const parts = GuncatUiParts.build(content, true)
  const text = createElement('div', { className: 'msg__body' }, parts.textOnly)
  const block = createElement(GuncatUiBlock, {
    content,
    interactive: true,
    onSend: () => {}
  })
  return renderToStaticMarkup(createElement('div', null, text, block))
}

/**
 * 排查用：把一段模型回答**按交互模式真实的渲染路径**（useBody → AssistantBody）渲染出来，
 * 用于回答「模型给的是界面程序，界面块到底有没有被认出来」。
 */
export function renderAssistantBody(content: string): string {
  return renderToStaticMarkup(
    createElement(AssistantBody, {
      message: {
        id: 'probe',
        role: 'assistant',
        content,
        displayContent: content,
        reasoning: '',
        createdAt: 0,
        attachments: [],
        toolCalls: [],
        tokenSpeed: -1,
        cacheHitRate: -1
      } as never,
      interactive: true
    })
  )
}

/** 排查用：空态（说明文案对不对齐原版，全靠这里看） */
export function renderEmptyState(mode: string, engine: unknown): string {
  return renderToStaticMarkup(
    createElement(EmptyState, { mode: mode as never, engine: engine as never })
  )
}

/** 排查用：单个智能体标识的产物（空态图标大小归一化要看得见才敢说对） */export function renderAgentGlyph(
  agent: unknown,
  size: number,
  inkNormalize: boolean
): string {
  return renderToStaticMarkup(
    createElement(AgentGlyph, {
      agent: agent as never,
      size,
      inkNormalize
    })
  )
}

/** 排查用：`GuncatUiParts.build` 对一段内容的判定结果（hasUi / textOnly / 程序文本） */
export function inspectUiParts(content: string): unknown {
  const parts = GuncatUiParts.build(content, true)
  return {
    hasUi: parts.hasUi,
    textOnly: parts.textOnly.slice(0, 80),
    segments: parts.segments.length,
    kinds: parts.segments.map((s) => s.type)
  }
}

/** 排查用：按**交互模式**渲染一整条时间线（用户报障时用它看看到底渲染出了什么） */
export function renderInteractiveTimeline(program: string): string {
  const messages = [
    {
      id: 'u1',
      role: 'user',
      content: '给我做一个销售看板',
      displayContent: '给我做一个销售看板',
      reasoning: '',
      createdAt: 0,
      attachments: [],
      toolCalls: [],
      tokenSpeed: -1,
      cacheHitRate: -1
    },
    {
      id: 'a1',
      role: 'assistant',
      content: program,
      displayContent: program,
      reasoning: '',
      createdAt: 1,
      attachments: [],
      toolCalls: [],
      tokenSpeed: -1,
      cacheHitRate: -1
    }
  ] as never
  return renderToStaticMarkup(
    createElement(Timeline, {
      messages,
      mode: 'interactive',
      running: false,
      lastAssistantId: 'a1',
      onEditToInput: () => {}
    })
  )
}

// ===== 提问卡片（ask_user_question） =====
//
// 工具真的会挂起等待作答，所以这张卡是「工具能不能用」的一半：没有它就只能等 5 分钟超时。
// 单选/多选两种形态的差别不只是文案 —— 选项标记的形状、能不能同时选中多项、
// 提交按钮要不要带数量，都要逐条钉住。

/** 提问卡片：multiSelect 决定单选（圆点）/ 多选（方框）两种形态 */
export function renderAskCard(multiSelect: boolean): string {
  return renderToStaticMarkup(
    createElement(AskUserCard, {
      ask: {
        requestId: 'ask_test_1',
        question: '这份季度复盘要交成什么？',
        options: ['内部汇报稿', '对外发布稿', '先给我看看大纲'],
        multiSelect
      },
      onAnswer: () => {},
      onCancel: () => {}
    })
  )
}

/** 排查用：提问卡片在时间线末尾的落位（AskAtTimelineEnd 的挂载点） */
export function renderAskSlot(): string {
  return renderToStaticMarkup(
    createElement(Timeline, {
      messages: [] as never,
      mode: 'work',
      running: true,
      lastAssistantId: '',
      onEditToInput: () => {}
    })
  )
}

/** 纯函数：单选/多选的勾选行为（SSR 点不了按钮，只能在这里断言） */
export function askToggleSelection(
  selected: string[],
  option: string,
  multiSelect: boolean
): string[] {
  return askToggle(selected, option, multiSelect)
}

/** 纯函数：提交按钮文案（多选且已勾选时才带数量） */
export function askSubmitLabel(multiSelect: boolean, count: number): string {
  return askConfirmLabel(multiSelect, count)
}
