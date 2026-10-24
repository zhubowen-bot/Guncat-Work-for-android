// 渲染进程状态镜像。
//
// 主进程是业务权威，这里只保存「展示所需」的投影：
// 会话摘要列表、当前会话的完整消息、运行态标志与工作区清单。
// 所有变更都来自 (a) 用户操作的 invoke 返回，或 (b) 主进程推来的事件。
import { create } from 'zustand'
import { useSpeech } from './speech/speechStore'
import {
  INTERACTIVE_AGENT_ID,
  agentIdForMode,
  buildAgentList,
  engineIdOfConversation,
  isVirtualAgentId,
  modeForAgentId,
  resolveConversationMode
} from './conversations'
import type {
  AgentDto,
  AgentMode,
  AppSettingsDto,
  ConversationDto,
  ConversationStatsDto,
  ConversationSummaryDto,
  WorkArtifactsDto,
  GuncatEvent,
  MessageDto,
  WorkspaceEntryDto
} from '@ipc/contract'

export interface Notice {
  level: 'info' | 'warn' | 'error'
  text: string
  at: number
}

/**
 * 一条挂起等待作答的提问（原版 ChatViewModel.pendingAsk 的桌面端投影）。
 *
 * 有它才有提问卡片：主进程里的 ask_user_question 工具此刻正 await 在
 * AskUserBridge 上，界面拿到的只是这个「问题 + 选项」的描述；
 * 用户点提交/跳过时再用 requestId 把答案送回去唤醒那条工具。
 */
export interface PendingAskState {
  conversationId: string
  requestId: string
  question: string
  options: string[]
  multiSelect: boolean
}

// 偏好键（与主进程 Constants 里的键名一致）
const PREF_EFFORT_WORK = 'guncat_reasoning_effort'
const PREF_EFFORT_INTERACTIVE = 'guncat_interactive_effort'
const PREF_THINKING = 'guncat_thinking_enabled'
const PREF_WEB_SEARCH = 'guncat_web_search_enabled'

/**
 * 从偏好里取工作模式的推理强度。
 *
 * 逐字对齐原版 ChatViewModel.ets:280-281：
 * `loadString(LS_KEY_REASONING_EFFORT, 'high')` 之后只认 'max' / 'low'，其余一律回 'high'
 * —— 也就是说「均衡」是缺省档，而存档里不需要真的写 'high'。
 */
export function workEffortFromPrefs(prefs: Record<string, string> | undefined): string {
  const raw = prefs?.[PREF_EFFORT_WORK] ?? ''
  return raw === 'max' || raw === 'low' ? raw : 'high'
}

/**
 * 交互模式的推理强度。
 *
 * 逐字对齐原版 ChatViewModel.ets:282-285：默认值是 **'low'**（首答速度优先，
 * 交付物是界面而不是长篇分析），只认 'off' / 'low'，其余回 'high'。
 * 这里容易写错成和交互模式一样默认 'high' —— 那会让首答明显变慢。
 */
export function interactiveEffortFromPrefs(prefs: Record<string, string> | undefined): string {
  const raw = prefs?.[PREF_EFFORT_INTERACTIVE]
  if (raw === undefined) {
    return 'low'
  }
  return raw === 'off' || raw === 'low' ? raw : 'high'
}

/**
 * 智能体默认的深度思考开关（对齐原版 ChatViewModel.ets:614-624 的 defaultThinkingForAgent）。
 * 按**名称**匹配而不是 id：改名时不必回来改逻辑。返回 null 表示「这个智能体没有默认值」。
 */
export function defaultThinkingForAgent(agent: AgentDto | null): boolean | null {
  const name = agent?.name ?? ''
  if (name === '效率模式' || name === '轻简模式') {
    return false
  }
  if (name === '专家模式') {
    return true
  }
  return null
}

/** 某形态是否 Agent Loop（工作 / 交互）：这两种形态下深度思考恒为开，档位才是开关 */
export function isLoopMode(mode: string): boolean {
  return mode === 'work' || mode === 'interactive'
}

/**
 * 一次请求真正要下发的思考参数（对齐原版 loopEffortForRequest / loopThinkingEnabled）。
 *
 * · 工作模式：思考开关就是全局 `thinkingEnabled`（界面上不显示它，由智能体默认值决定），
 *   强度取工作档位；
 * · 交互模式：档位「关闭(off)」= 思考关闭，此时**下发值退回 'low'**
 *   （原版注释：部分服务端即使 thinking=disabled 也会校验 reasoning_effort 的合法性）；
 * · 聊天模式：走深度思考开关，不带强度（聊天协议没有强度概念）。
 */
export function requestThinking(
  mode: AgentMode,
  thinkingEnabled: boolean,
  workEffort: string,
  interactiveEffort: string
): { thinkingEnabled: boolean; reasoningEffort: string | undefined } {
  if (mode === 'interactive') {
    return {
      thinkingEnabled: interactiveEffort !== 'off',
      reasoningEffort: interactiveEffort === 'off' ? 'low' : interactiveEffort
    }
  }
  if (mode === 'work') {
    return { thinkingEnabled, reasoningEffort: workEffort }
  }
  return { thinkingEnabled, reasoningEffort: undefined }
}

/**
 * 导出 / 分享弹层要处置的对象。
 *
 * 三选一：messageId（一条回答 → Word）、path（工作区里的单个文件）、两者都空（打包工作区）。
 * name 是建议文件名；title 只用于弹层标题。
 */
export interface TransferSubject {
  kind: 'workspace' | 'file' | 'message'
  conversationId: string
  path?: string
  messageId?: string
  name: string
  title: string
}

interface State {
  ready: boolean
  /** 真实智能体（agents.json，IPC 原样） */
  agents: AgentDto[]
  /** 引擎列表 = 两个虚拟智能体（工作 / 交互）+ 真实智能体，侧栏「引擎」区直接渲染它 */
  engines: AgentDto[]
  /** 当前选中的引擎 id（可能是 work / interactive 这两个虚拟智能体） */
  activeAgentId: string
  summaries: ConversationSummaryDto[]
  activeId: string | null
  active: ConversationDto | null
  mode: AgentMode
  running: boolean
  thinkingEnabled: boolean
  /**
   * 工作模式的推理强度：'max' | 'high' | 'low'（缺省 'high'）。
   * 交互模式另有 `interactiveEffort` —— 两个档位各存一个偏好键，互不影响（与原版一致）。
   */
  reasoningEffort: string
  /** 交互模式的推理强度：'high' | 'low' | 'off'（缺省 **'low'**，首答速度优先） */
  interactiveEffort: string
  webSearchEnabled: boolean
  settings: AppSettingsDto | null
  workspace: WorkspaceEntryDto[]
  /**
   * 当前会话的任务统计与目标（工作区面板的统计卡 / 目标卡）。
   * 原版在 DetailsPanelView 里显示任务用时、输出速度、缓存命中、工具轮数与当前目标；
   * 桌面端此前只有「N 个文件 / N 个目录 / N 次工具调用」，且是全会话累计。
   */
  stats: ConversationStatsDto | null
  /**
   * 本会话的产物汇总（对话流末尾的 Changes 卡）。
   * 数据由主进程用已移植的 `WorkArtifactUtil.collect` 算出来 —— 那个模块此前零引用。
   */
  artifacts: WorkArtifactsDto | null
  notice: Notice | null
  settingsOpen: boolean
  /**
   * 右侧工作区面板是否展开。
   * 原版侧栏底部就有「工作区」入口，且只看 `isWide && detailsOpen`、**不判模式** ——
   * 聊天模式下来路（拖拽 / 命令行 / 第二实例）落进该会话工作区的文件同样能在这里看到。
   */
  workspaceOpen: boolean
  /** 表格提取弹层是否打开（原版是一个独立页面，桌面端没有 pages/ 概念） */
  tableOcrOpen: boolean
  /**
   * 灯箱里正在看的大图（data URL）；空串表示没打开。
   * 原版 ImageLightbox 由 ChatPage 挂载、气泡的 onImageTap 打开；桌面端此前整条链路都缺。
   */
  lightboxUrl: string
  /**
   * 工作区预览弹层正在展示的文件（null = 没打开）。
   *
   * 侧栏文件列表与对话流末尾的产物汇总卡都往这里写。这份状态**必须**是共享的：
   * 曾经两处各持一份组件本地状态、弹层又按「面板展开时只由面板渲染」二选一，
   * 产物卡的点击落在没人渲染的那份状态上 —— 点文件名和点「预览」都没有反应。
   * 会话 id 一起存进来，是为了让「默认程序打开 / 显示位置」始终作用在**打开那一刻**
   * 所属的那个工作区上，而不是切换会话后的当前工作区。
   */
  workspacePreview: { conversationId: string; path: string } | null
  /**
   * 自动置底的「冻结」截止时间戳。界面块里的**本地状态回传**（拖动/勾选/填表）
   * 不该把页面拽到底部 —— 原版为此专门分了两类回传：
   * `action`=需要模型重算（会滚到底）、`state`=只本地调参（不动滚动位置）。
   */
  scrollFreezeUntil: number
  /** 「填入输入框 / 重新编辑」请求：由消息操作行写入，输入框消费后清空 */
  pendingDraft: { text: string; at: number } | null
  /**
   * 当前挂起的提问（无 = null）。非空时时间线末尾渲染提问卡片 ——
   * 原版 ChatPage 也是在时间线末尾渲染 AskUserCard，三种形态共用一条时间线，
   * 所以卡片对工作/交互/聊天三种模式都可见。
   */
  pendingAsk: PendingAskState | null

  init(): Promise<void>
  reloadSummaries(): Promise<void>
  selectConversation(id: string): Promise<void>
  createConversation(): Promise<ConversationDto>
  deleteConversation(id: string): Promise<void>
  /** 切换引擎（原版侧栏「引擎」区）：选中即切到该引擎的最新会话，没有就新建 */
  selectAgent(agentId: string): Promise<void>
  setMode(mode: AgentMode): void
  setThinking(value: boolean): void
  setReasoningEffort(value: string): void
  setInteractiveEffort(value: string): void
  /** 按当前智能体重置深度思考默认值（效率/轻简模式关、专家模式开） */
  applyAgentThinkingDefault(): Promise<void>
  setWebSearch(value: boolean): void
  openSettings(open: boolean): void
  toggleWorkspace(open?: boolean): void
  /** 手机端左侧会话抽屉（桌面端侧栏常驻，这个状态不产生视觉影响） */
  sidebarOpen: boolean
  openSidebar(): void
  closeSidebar(): void
  openTableOcr(open: boolean): void
  /** 打开/关闭大图查看（传空串即关闭） */
  openLightbox(url: string): void
  /** 在工作区预览弹层里打开一个文件（路径相对会话工作区根） */
  openWorkspaceFile(path: string): void
  /** 关闭工作区预览弹层 */
  closeWorkspaceFile(): void
  /**
   * 导出 / 分享弹层（工作区打包、单文件、一条回答的 Word）。
   * 打开弹层只是「问一句怎么处置」，真正落盘/分享在 runTransfer 里。
   */
  transferSubject: TransferSubject | null
  openTransfer(subject: TransferSubject): void
  closeTransfer(): void
  runTransfer(subject: TransferSubject, action: 'save' | 'share'): Promise<void>
  /** 在接下来这段时间内不要自动置底（界面块的本地状态回传用） */
  freezeAutoScroll(ms: number): void
  reloadSettings(): Promise<void>
  send(text: string, attachmentPaths?: string[]): Promise<void>
  /**
   * 执行中插话（工作/交互模式）。返回 true 表示已进插话队列、下一轮生效；
   * false 表示当前并没有在跑，调用方应改走普通发送。
   */
  steer(text: string): Promise<boolean>
  /** 重新生成最后一条回答 */
  regenerate(): Promise<void>
  /** 交互模式：把界面控件的绑定值写回消息并持久化 */
  patchMessageContent(messageId: string, content: string): Promise<void>
  abort(): Promise<void>
  loadWorkspace(): Promise<void>
  loadStats(): Promise<void>
  loadArtifacts(): Promise<void>
  deleteWorkspaceEntry(path: string): Promise<void>
  clearWorkspace(): Promise<void>
  exportWorkspace(): Promise<void>
  openWorkspaceFolder(): Promise<void>
  pushNotice(level: Notice['level'], text: string): void
  dismissNotice(): void
  /** 把一段文本填进输入框（消息操作行的「编辑 / 重新编辑」） */
  fillDraft(text: string): void
  consumeDraft(): void
  /** 提交一次提问卡片（原版 ChatViewModel.answerAsk） */
  answerAsk(requestId: string, selections: string[], note: string): Promise<void>
  /** 跳过提问，由智能体自行决定（原版 ChatViewModel.cancelAsk） */
  cancelAsk(requestId: string): Promise<void>
  /** 端侧增强：把外部文件导入当前会话工作区 */
  intakeFiles(paths: string[]): Promise<void>
  /** 端侧增强：弹系统文件选择框并导入（工作区面板的「上传」按钮） */
  pickWorkspaceFiles(source?: 'file' | 'camera' | 'gallery'): Promise<void>
}

function applyEvent(state: State, event: GuncatEvent): Partial<State> {
  switch (event.type) {
    case 'conversation:created':
      return {
        summaries: [summaryOf(event.conversation), ...state.summaries],
        activeId: event.conversation.id,
        active: event.conversation,
        activeAgentId: engineIdOfConversation(event.conversation),
        mode: event.conversation.mode as AgentMode
      }

    case 'conversation:sync':
      // 「重新生成」把末尾若干条消息删掉了：增量事件表达不了删除，用整份会话替换
      if (state.active === null || state.active.id !== event.conversation.id) {
        return {}
      }
      return {
        active: event.conversation,
        summaries: state.summaries.map((s) =>
          s.id === event.conversation.id ? summaryOf(event.conversation) : s
        )
      }

    case 'conversation:deleted': {
      const summaries = state.summaries.filter((s) => s.id !== event.conversationId)
      const wasActive = state.activeId === event.conversationId
      return {
        summaries,
        activeId: wasActive ? null : state.activeId,
        active: wasActive ? null : state.active
      }
    }

    case 'conversation:title':
      return {
        summaries: state.summaries.map((s) =>
          s.id === event.conversationId ? { ...s, title: event.title } : s
        ),
        active:
          state.active !== null && state.active.id === event.conversationId
            ? { ...state.active, title: event.title }
            : state.active
      }

    case 'message:added': {
      if (state.active === null || state.active.id !== event.conversationId) {
        return {}
      }
      return { active: { ...state.active, messages: [...state.active.messages, event.message] } }
    }

    case 'message:patched': {
      if (state.active === null || state.active.id !== event.conversationId) {
        return {}
      }
      return {
        active: {
          ...state.active,
          messages: state.active.messages.map((m) =>
            m.id === event.messageId ? { ...m, ...event.patch } : m
          )
        }
      }
    }

    case 'tool:started':
    case 'tool:finished':
      return patchToolCall(state, event.conversationId, event.messageId, event.call)

    case 'turn:started':
      return state.active !== null && state.active.id === event.conversationId
        ? { running: true }
        : {}

    case 'turn:finished':
      return state.active !== null && state.active.id === event.conversationId
        ? { running: false }
        : { running: false }

    case 'notice':
      return { notice: { level: event.level, text: event.text, at: Date.now() } }

    // 提问挂起：只认当前会话的（多会话后台跑任务时，别的会话的提问不该弹在本会话里）
    case 'ask:user':
      if (state.active === null || state.active.id !== event.conversationId) {
        return {}
      }
      return {
        pendingAsk: {
          conversationId: event.conversationId,
          requestId: event.requestId,
          question: event.question,
          options: event.options ?? [],
          // 老事件没有这个字段（契约里是后补的）时按单选处理
          multiSelect: event.multiSelect === true
        }
      }

    // 提问落定（作答 / 跳过 / 超时 / 被中止）：卡片必须收掉。
    // 只按 requestId 比对：同一会话里连续两次提问会拿到不同的 requestId，
    // 用会话比对的话第二次提问会被上一次的 done 事件误收。
    case 'ask:done':
      if (state.pendingAsk === null || state.pendingAsk.requestId !== event.requestId) {
        return {}
      }
      return { pendingAsk: null }

    default:
      return {}
  }
}

function patchToolCall(
  state: State,
  conversationId: string,
  messageId: string,
  call: import('@ipc/contract').ToolCallRecordDto
): Partial<State> {
  if (state.active === null || state.active.id !== conversationId) {
    return {}
  }
  return {
    active: {
      ...state.active,
      messages: state.active.messages.map((m: MessageDto) => {
        if (m.id !== messageId) {
          return m
        }
        const existing = m.toolCalls.findIndex((c) => c.id === call.id)
        const toolCalls =
          existing >= 0
            ? m.toolCalls.map((c) => (c.id === call.id ? { ...c, ...call } : c))
            : [...m.toolCalls, call]
        return { ...m, toolCalls }
      })
    }
  }
}

function summaryOf(conv: ConversationDto): ConversationSummaryDto {
  const last = conv.messages[conv.messages.length - 1]
  return {
    id: conv.id,
    title: conv.title,
    agentId: conv.agentId,
    mode: conv.mode,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    lastPreview: last?.content?.slice(0, 60) ?? ''
  }
}
export const useStore = create<State>((set, get) => {
  async function refreshSummaries(): Promise<void> {
    const summaries = await window.guncat.conversations.list()
    set({ summaries })
  }

  return {
    ready: false,
    agents: [],
    engines: [],
    activeAgentId: '',
    summaries: [],
    activeId: null,
    active: null,
    mode: 'chat',
    running: false,
    thinkingEnabled: false,
    reasoningEffort: 'high',
    interactiveEffort: 'low',
    // 原版默认**开启**服务端联网搜索（LS_KEY_WEB_SEARCH_ENABLED 的缺省值是 true）
    webSearchEnabled: true,
    settings: null,
    workspace: [],
    stats: null,
    artifacts: null,
    notice: null,
    settingsOpen: false,
    workspaceOpen:
      typeof window === 'undefined' || !window.matchMedia('(max-width: 860px)').matches,
    sidebarOpen: false,
    tableOcrOpen: false,
    lightboxUrl: '',
    workspacePreview: null,
    transferSubject: null,
    scrollFreezeUntil: 0,
    pendingDraft: null,
    pendingAsk: null,

    async init() {
      window.guncat.onEvent((event: GuncatEvent) => {
        set((state) => applyEvent(state, event))
        if (event.type === 'workspace:changed' && get().activeId === event.conversationId) {
          void get().loadWorkspace()
        }
        // 一轮结束：统计卡（用时/速度/命中/轮数）与目标卡都该刷新
        if (event.type === 'turn:finished' && get().activeId === event.conversationId) {
          void get().loadStats()
          void get().loadArtifacts()
        }
        // 外部文件到达（拖拽 / 命令行 / 系统「打开方式」）→ 导入当前会话工作区
        if (event.type === 'files:pending') {
          void get().intakeFiles(event.paths)
        }
      })
      await Promise.all([useSpeech.getState().init()])
      const [agents, summaries, settings] = await Promise.all([
        window.guncat.agents.list(),
        window.guncat.conversations.list(),
        window.guncat.settings.load()
      ])
      const engines = buildAgentList(agents)
      // 冷启动落点（对齐原版 ChatViewModel.ets:323-363）：
      // (1) 固定进入**交互模式**，不是最后一个真实智能体；
      // (2) 每次重新打开应用都从「新对话」开始 —— 若该智能体最新一条对话已经非空，
      //    就新建一条，而不是把用户丢回上次的长会话里（空会话则直接复用）。
      const interactiveAgent =
        engines.find((a) => a.id === INTERACTIVE_AGENT_ID) ??
        engines.find((a) => isVirtualAgentId(a.id)) ??
        engines[0]
      const fallbackAgent = agents.find((a) => !isVirtualAgentId(a.id))
      const startAgentId = interactiveAgent?.id ?? fallbackAgent?.id ?? ''
      set({
        agents,
        engines,
        activeAgentId: startAgentId,
        // **形态必须跟着智能体一起设**。漏掉这一行的后果（真实踩过）：
        // 冷启动后 activeAgentId 是交互模式智能体、而 mode 还停在初值 'chat'，
        // 于是界面走聊天分支、发送走 chat:send —— 而聊天路径的系统提示词取自
        // 智能体自己的 prompt，两个虚拟智能体根本没有 prompt，模型拿到的是一份
        // **空提示词**，直接当裸 API 用（用户看到的正是「没有提示词、纯对话」）。
        mode: resolveConversationMode(startAgentId, 'chat'),
        summaries,
        settings,
        // 深度思考与两个档位都从偏好里恢复（缺省值与原版一致：关 / high / low）
        thinkingEnabled: settings.prefs?.[PREF_THINKING] === 'true',
        reasoningEffort: workEffortFromPrefs(settings.prefs),
        interactiveEffort: interactiveEffortFromPrefs(settings.prefs),
        webSearchEnabled: settings.prefs?.[PREF_WEB_SEARCH] !== 'false',
        ready: true
      })

      // 该智能体最新的一条对话（按 updatedAt 取最大，不依赖列表返回顺序）
      const ownConversations = summaries.filter((s) => s.agentId === startAgentId)
      const latestForAgent = ownConversations.reduce<ConversationSummaryDto | undefined>(
        (newest, item) => (newest === undefined || item.updatedAt > newest.updatedAt ? item : newest),
        undefined
      )
      if (latestForAgent !== undefined && latestForAgent.messageCount === 0) {
        // 已经是空会话：直接复用，不再堆一条新的（对齐原版 findLatestConversationForAgent 的复用分支）
        await get().selectConversation(latestForAgent.id)
      } else {
        await get().createConversation()
      }
      // 冷启动也按当前智能体重置一次深度思考默认值（效率/轻简模式关、专家模式开）
      await get().applyAgentThinkingDefault()
    },

    async reloadSummaries() {
      await refreshSummaries()
    },

    async selectConversation(id) {
      set({ sidebarOpen: false })
      const conv = await window.guncat.conversations.get(id)
      // 落盘「当前会话」（对齐原版 openConversation：只写不读，避免存档停在过期的会话 id 上）
      void window.guncat.settings.saveString('guncat_current_conv', id)
      // 形态以**会话的智能体**为准（`resolveConversationMode` 里写了为什么）：
      // 这也顺手自愈了历史上被写坏的「交互模式智能体 + 聊天形态」会话。
      const mode = resolveConversationMode(
        conv === null ? '' : engineIdOfConversation(conv),
        (conv?.mode as string) ?? ''
      )
      set({
        activeId: id,
        active: conv,
        activeAgentId: conv === null ? get().activeAgentId : engineIdOfConversation(conv),
        mode,
        running: false
      })
      // 对齐原版 openConversation 的两条联动：
      //   (1) 打开的若是**空**会话，按智能体重置深度思考默认值；
      //   (2) 打开的是 Agent Loop 会话（工作/交互）时，把全局深度思考强制为开 ——
      //      「关闭」只属于交互模式的档位，不该被上一次聊天模式的开关带着走。
      if (conv !== null && conv.messages.length === 0) {
        await get().applyAgentThinkingDefault()
      }
      if (isLoopMode(mode) && !get().thinkingEnabled) {
        await get().setThinking(true)
      }
      await get().loadWorkspace()
      await get().loadStats()
      await get().loadArtifacts()
    },

    async createConversation() {
      // 空会话等价于新会话：先把它清掉，避免列表里堆一串没有任何内容的会话
      // （对齐原版 cleanupEmptyConversation）。工作区里有文件时保留 ——
      // 删会话只是把 id 从列表里抹掉，用户会看不到那些文件。
      const current = get().active
      if (current !== null && current.messages.length === 0 && get().workspace.length === 0) {
        await window.guncat.conversations.remove(current.id)
        set({ activeId: null, active: null })
      }
      const agentId = get().activeAgentId
      // 形态由智能体推出，**不要**直接读 get().mode —— 两者一旦不同步（见 init 里的说明），
      // 这里就会造出一条 agentId 与 mode 互相矛盾的会话，而且它会一直留在列表里。
      const mode = resolveConversationMode(agentId, get().mode)
      const conv = await window.guncat.conversations.create(agentId, mode)
      // 新建对话时按智能体重置深度思考（效率/轻简模式关、专家模式开）；
      // Agent Loop 形态则强制为开（此时界面上不显示该开关，档位才是开关）
      await get().applyAgentThinkingDefault()
      if (isLoopMode(get().mode) && !get().thinkingEnabled) {
        await get().setThinking(true)
      }
      // conversation:created 事件已把状态写好，这里只补工作区
      await get().loadWorkspace()
      return conv
    },

    async deleteConversation(id) {
      await window.guncat.conversations.remove(id)
      const remaining = get().summaries.filter((s) => s.id !== id)
      if (get().activeId === id) {
        if (remaining.length > 0) {
          await get().selectConversation(remaining[0].id)
        } else {
          set({ activeId: null, active: null, workspace: [] })
        }
      }
    },

    async selectAgent(agentId) {
      const engine = get().engines.find((a) => a.id === agentId)
      if (engine === undefined) {
        return
      }
      await window.guncat.settings.saveString('guncat_current_agent', agentId)
      const mode = modeForAgentId(agentId)
      set({ activeAgentId: agentId, mode })
      // 切到该引擎的最新会话；没有就新建（原版 selectAgent 的行为）
      const summaries = get().summaries
      const latest =
        summaries.find((s) => engineIdOfConversation(s) === agentId) ??
        (isVirtualAgentId(agentId)
          ? summaries.find((s) => s.agentId === agentId)
          : undefined)
      if (latest !== undefined) {
        await get().selectConversation(latest.id)
      } else {
        await get().createConversation()
      }
      // 切智能体后按它的名称重置深度思考默认值（效率/轻简模式关、专家模式开）；
      // Agent Loop 形态再强制为开
      await get().applyAgentThinkingDefault()
      if (isLoopMode(get().mode) && !get().thinkingEnabled) {
        await get().setThinking(true)
      }
    },

    setMode(mode) {
      // 形态与引擎是同一件事的两种说法（原版：形态切换就是切到对应虚拟智能体），
      // 因此这里走 selectAgent，顺带把会话也切过去，避免「界面显示工作模式、
      // 实际发到聊天模式会话」这种错位。
      //
      // 两道守卫逐字对齐原版 ChatViewModel.ets:666-697 的 setInteractiveMode / setWorkMode：
      //   (1) 已经在目标形态里 → 什么都不做（原版这是为了「点当前档不把你带走」）；
      //   (2) 正在生成或正在解析附件 → 提示并拒绝（切走会让用户以为任务没了）。
      if (mode === get().mode) {
        return
      }
      if (get().running) {
        get().pushNotice('warn', '请等待当前任务完成后再切换模式')
        return
      }
      const target = agentIdForMode(mode, get().agents, get().activeAgentId)
      if (target === '') {
        set({ mode })
        const active = get().active
        if (active !== null) {
          set({ active: { ...active, mode } })
        }
        return
      }
      void get().selectAgent(target)
    },

    setThinking(value) {
      set({ thinkingEnabled: value })
      void window.guncat.settings.saveString(PREF_THINKING, value ? 'true' : 'false')
    },

    /**
     * 按当前智能体重置深度思考开关（效率模式/轻简模式关、专家模式开）。
     * 对齐原版 applyAgentThinkingDefault：只有在智能体**有**默认值时才动这个开关，
     * 否则保留用户自己选的状态（不能因为切了个没默认值的智能体就把它抹掉）。
     */
    async applyAgentThinkingDefault() {
      const agent = get().engines.find((a) => a.id === get().activeAgentId) ?? null
      const def = defaultThinkingForAgent(agent)
      if (def === null || def === get().thinkingEnabled) {
        return
      }
      set({ thinkingEnabled: def })
      await window.guncat.settings.saveString(PREF_THINKING, def ? 'true' : 'false')
    },

    setReasoningEffort(value) {
      set({ reasoningEffort: value })
      void window.guncat.settings.saveString(PREF_EFFORT_WORK, value)
    },

    setInteractiveEffort(value) {
      set({ interactiveEffort: value })
      void window.guncat.settings.saveString(PREF_EFFORT_INTERACTIVE, value)
    },

    setWebSearch(value) {
      set({ webSearchEnabled: value })
      void window.guncat.settings.saveString(PREF_WEB_SEARCH, value ? 'true' : 'false')
    },

    openSettings(open) {
      set({ settingsOpen: open })
    },

    openSidebar() {
      set({ sidebarOpen: true })
    },

    closeSidebar() {
      set({ sidebarOpen: false })
    },

    toggleWorkspace(open) {
      set((state) => ({ workspaceOpen: open ?? !state.workspaceOpen }))
    },

    openTableOcr(open) {
      set({ tableOcrOpen: open })
    },

    openLightbox(url) {
      set({ lightboxUrl: url })
    },

    openWorkspaceFile(path) {
      const conversationId = get().activeId
      if (conversationId === null) {
        return
      }
      set({ workspacePreview: { conversationId, path } })
    },

    closeWorkspaceFile() {
      set({ workspacePreview: null })
    },

    openTransfer(subject) {
      set({ transferSubject: subject })
    },

    closeTransfer() {
      set({ transferSubject: null })
    },

    /**
     * 真正的导出 / 分享。
     *
     * 关键口径：save 一定先经过系统保存位置选择（桌面是保存对话框，Android 是
     * ACTION_CREATE_DOCUMENT）—— 这既是用户要的「确认流程」，也让他们自己决定
     * 文件落在哪。share 一律交给系统分享面板（面板里可以直接选微信）。
     * 取消不再提示「已导出」，失败如实报错。
     */
    async runTransfer(subject, action) {
      set({ transferSubject: null })
      const conversationId: string = subject.conversationId || get().activeId || ''
      if (conversationId === '') {
        get().pushNotice('warn', '还没有可导出的会话')
        return
      }
      const verb: string = action === 'share' ? '分享' : '保存'
      // 打包/生成 Word 需要一点时间，先给一句「在准备」，避免点了没反应
      get().pushNotice('info', `正在准备${verb}：${subject.name}`)
      try {
        const result = await window.guncat.transfer({
          conversationId,
          path: subject.path,
          messageId: subject.messageId,
          suggestedName: subject.name,
          action
        })
        if (result.status === 'saved') {
          const where: string = result.path ?? subject.name
          get().pushNotice(
            'info',
            result.message !== undefined ? `${result.message}：${where}` : `已保存到 ${where}`
          )
          return
        }
        if (result.status === 'shared') {
          get().pushNotice('info', result.message ?? '已打开分享')
          return
        }
        if (result.status === 'canceled') {
          // 用户自己取消的，不需要提示（提示反而像出错了）
          return
        }
        get().pushNotice('error', `${verb}失败：${result.message ?? '未知原因'}`)
      } catch (e) {
        get().pushNotice('error', `${verb}失败：${String(e instanceof Error ? e.message : e)}`)
      }
    },

    freezeAutoScroll(ms) {
      set({ scrollFreezeUntil: Date.now() + ms })
    },

    async reloadSettings() {
      const settings = await window.guncat.settings.load()
      set({ settings })
    },

    async send(text, attachmentPaths) {
      // 发送前的配置校验（对齐原版 ChatPage.ets:1676-1691）：没有 API Key 时
      // 不只是弹一句提示，而是**顺手把设置面板打开** —— 用户下一步就是要填它。
      const settings = get().settings
      if (settings === null || settings.apiConfig === null || settings.apiConfig.apiKey === '') {
        get().pushNotice('warn', '请先配置 API Key')
        set({ settingsOpen: true })
        return
      }
      // 正在生成时的两条分支（对齐原版 sendMessage 的守卫顺序）：
      //   工作模式 → 直接变成插话（用户不必先找那颗「插话」按钮，输入框回车即可）；
      //   其他形态 → 一问一答没有「下一轮」可挂，提示等待。
      if (get().running) {
        if (get().mode === 'work') {
          await get().steer(text)
          return
        }
        get().pushNotice('warn', 'AI 正在回复中，请稍候')
        return
      }
      let activeId = get().activeId
      if (activeId === null) {
        const conv = await get().createConversation()
        activeId = conv.id
      }
      // 形态以**当前智能体**为准，不直接信任 get().mode：两者一旦不同步，
      // 交互模式会走 chat:send，而聊天路径的提示词来自智能体自己的 prompt ——
      // 虚拟智能体没有 prompt，模型会拿到一份空提示词（用户报障的原形）。
      const mode = resolveConversationMode(get().activeAgentId, get().mode)
      // 思考参数按形态算：工作模式思考恒开（界面上不显示该开关）、交互模式的
      // 「关闭(off)」档位同时把思考关掉并把下发强度退回 'low'。见 requestThinking。
      const thinking = requestThinking(
        mode,
        get().thinkingEnabled,
        get().reasoningEffort,
        get().interactiveEffort
      )
      const request = {
        conversationId: activeId,
        text,
        mode,
        thinkingEnabled: thinking.thinkingEnabled,
        webSearchEnabled: get().webSearchEnabled,
        // 附件只在聊天模式直传；工作/交互模式的素材入口是工作区（上传/拖拽）
        attachmentPaths: mode === 'chat' ? (attachmentPaths ?? []) : [],
        // 推理强度只对 Agent Loop 的两种形态有意义（原版也是这么分档的）
        reasoningEffort: thinking.reasoningEffort
      }
      set({ running: true })
      try {
        if (mode === 'chat') {
          await window.guncat.chat.send(request)
        } else {
          await window.guncat.work.run(request)
        }
      } finally {
        set({ running: false })
        await refreshSummaries()
      }
    },

    async steer(text) {
      const activeId = get().activeId
      if (activeId === null) {
        return false
      }
      const value = text.trim()
      if (value === '') {
        return false
      }
      try {
        return await window.guncat.steer(activeId, value)
      } catch (e) {
        get().pushNotice('error', `插话失败：${String(e)}`)
        return false
      }
    },

    async regenerate() {      const activeId = get().activeId
      if (activeId === null) {
        return
      }
      set({ running: true })
      try {
        await window.guncat.chat.regenerate({
          conversationId: activeId,
          thinkingEnabled: get().thinkingEnabled,
          webSearchEnabled: get().webSearchEnabled
        })
      } finally {
        set({ running: false })
        await refreshSummaries()
      }
    },

    async abort() {
      const activeId = get().activeId
      if (activeId === null) {
        return
      }
      await window.guncat.chat.abort(activeId)
    },

    async patchMessageContent(messageId, content) {
      const activeId = get().activeId
      if (activeId === null) {
        return
      }
      await window.guncat.chat.patchMessage(activeId, messageId, content)
    },

    async loadWorkspace() {
      const activeId = get().activeId
      if (activeId === null) {
        set({ workspace: [] })
        return
      }
      try {
        const entries = await window.guncat.workspace.list(activeId)
        set({ workspace: entries })
      } catch {
        set({ workspace: [] })
      }
    },

    async loadStats() {
      const activeId = get().activeId
      if (activeId === null) {
        set({ stats: null })
        return
      }
      try {
        set({ stats: await window.guncat.stats(activeId) })
      } catch {
        set({ stats: null })
      }
    },

    async loadArtifacts() {
      const activeId = get().activeId
      if (activeId === null) {
        set({ artifacts: null })
        return
      }
      try {
        set({ artifacts: await window.guncat.artifacts(activeId) })
      } catch {
        set({ artifacts: null })
      }
    },

    async deleteWorkspaceEntry(path) {
      const activeId = get().activeId
      if (activeId === null) {
        return
      }
      await window.guncat.workspace.remove(activeId, path)
      await get().loadWorkspace()
    },

    async clearWorkspace() {
      const activeId = get().activeId
      if (activeId === null) {
        return
      }
      // 确认弹窗在主进程（原生对话框）；用户取消时 cleared=false，什么都不做
      const result = await window.guncat.workspace.clear(activeId)
      if (result.cleared) {
        await get().loadWorkspace()
        get().pushNotice('info', '工作区已清空')
      }
    },

    async exportWorkspace() {
      const activeId = get().activeId
      if (activeId === null) {
        return
      }
      // 旧入口保留给可能的调用方，但语义已改成「先让用户选保存位置」
      await get().runTransfer(
        {
          kind: 'workspace',
          conversationId: activeId,
          name: `guncat-workspace-${activeId}.zip`,
          title: '导出工作区'
        },
        'save'
      )
    },

    async openWorkspaceFolder() {
      const activeId = get().activeId
      if (activeId === null) {
        return
      }
      await window.guncat.workspace.openInFolder(activeId)
    },

    pushNotice(level, text) {
      set({ notice: { level, text, at: Date.now() } })
    },

    dismissNotice() {
      set({ notice: null })
    },

    fillDraft(text) {
      set({ pendingDraft: { text, at: Date.now() } })
    },

    consumeDraft() {
      set({ pendingDraft: null })
    },

    // ===== 提问卡片（原版 ChatViewModel.answerAsk / cancelAsk） =====
    //
    // 两处都先本地收卡片、再发通道：
    // 主进程那边工具被唤醒后会继续跑，ask:done 事件随后就到；
    // 但「点了提交 → 卡片还在 → 用户又点一次」的窗口哪怕只有一瞬也很难看，
    // 而窗口里重复提交是安全的（第二次回去时提问已经落定，主进程返回 false）。
    async answerAsk(requestId, selections, note) {
      const ask = get().pendingAsk
      set({ pendingAsk: null })
      const ok = await window.guncat.work.answer({
        conversationId: ask?.conversationId ?? get().activeId ?? '',
        requestId,
        canceled: false,
        selections,
        note
      })
      if (!ok) {
        // 提问已经落定（超时/被中止）：卡片保持收起，但要让用户知道这一下没生效
        get().pushNotice('warn', '这条提问已经结束，回答没有送出')
      }
    },

    async cancelAsk(requestId) {
      const ask = get().pendingAsk
      set({ pendingAsk: null })
      await window.guncat.work.answer({
        conversationId: ask?.conversationId ?? get().activeId ?? '',
        requestId,
        canceled: true,
        selections: [],
        note: ''
      })
    },

    async intakeFiles(paths) {
      if (paths.length === 0) {
        return
      }
      let activeId = get().activeId
      // 还没有会话时先建一个（同时切到工作模式，工作区才是模型的文件入口）
      if (activeId === null) {
        const conv = await get().createConversation()
        activeId = conv.id
      }
      try {
        const result = await window.guncat.intake.importPaths(activeId, paths)
        await get().loadWorkspace()
        const parts: string[] = []
        if (result.imported > 0) {
          parts.push(`已导入 ${result.imported} 个文件到工作区：${result.names.join('、')}`)
        }
        if (result.failed.length > 0) {
          parts.push(`${result.failed.length} 个未导入`)
        }
        get().pushNotice(
          result.imported > 0 ? 'info' : 'warn',
          parts.join('；') || '没有可导入的文件'
        )
      } catch (e) {
        get().pushNotice('error', `导入失败：${String(e)}`)
      }
    },

    /**
     * 工作区面板的「上传」按钮：弹系统文件选择框，把选中的文件导入当前会话工作区。
     * 与拖拽走同一条落盘链路，只是换成用户找得到的入口（原版 WorkspaceBar 的「上传」）。
     */
    async pickWorkspaceFiles(source: 'file' | 'camera' | 'gallery' = 'file') {
      let activeId = get().activeId
      // 还没会话就先建一个，否则对话框选完文件却无处可放
      if (activeId === null) {
        const conv = await get().createConversation()
        activeId = conv.id
      }
      try {
        const result = await window.guncat.intake.pickFiles(activeId, source)
        if (result.canceled) {
          return
        }
        await get().loadWorkspace()
        const parts: string[] = []
        if (result.imported > 0) {
          parts.push(`已导入 ${result.imported} 个文件：${result.names.join('、')}`)
        }
        if (result.failed.length > 0) {
          parts.push(`${result.failed.length} 个未导入`)
        }
        get().pushNotice(
          result.imported > 0 ? 'info' : 'warn',
          parts.join('；') || '没有可导入的文件'
        )
      } catch (e) {
        get().pushNotice('error', `上传失败：${String(e)}`)
      }
    }
  }
})
