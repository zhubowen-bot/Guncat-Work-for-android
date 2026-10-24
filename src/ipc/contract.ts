// 主进程 ↔ 渲染进程的 IPC 契约。
// 主进程是业务状态的唯一权威（对话、工作区、Agent Loop 都在主进程跑），
// 渲染进程只持有镜像并通过事件保持同步，因此这里定义的都是可结构化克隆的纯数据 DTO。

export const INVOKE = {
  /** 设置：读取全部配置 */
  settingsLoad: 'settings:load',
  settingsSaveApiConfig: 'settings:saveApiConfig',
  settingsSaveApiProfiles: 'settings:saveApiProfiles',
  settingsSaveMultimodalConfig: 'settings:saveMultimodalConfig',
  settingsSaveFlag: 'settings:saveFlag',
  /** 字符串型偏好（朗读音色/语速等） */
  settingsSaveString: 'settings:saveString',
  /** 本地联网搜索的引擎目录（渲染层据此渲染选项，不必自己维护一份引擎表） */
  settingsSearchEngines: 'settings:searchEngines',
  /**
   * 选择要发送给模型的附件（图片 / 文档）。
   * 原版输入区有回形针与预览条；桌面端此前**完全没有附件入口** ——
   * ChatSendRequest.attachmentPaths 这个字段一直存在，却从来没有人赋值。
   */
  attachmentsPick: 'attachments:pick',
  /**
   * 工作模式执行中插话（原版流式时的「发送(插话)」按钮）。
   * 不打断当前请求，文本在下一轮开始前并入消息，返回是否被接受。
   */
  workSteer: 'work:steer',
  /** 会话的任务统计与当前目标（原版 DetailsPanelView 的统计卡 + 目标卡） */
  conversationStats: 'conversation:stats',
  /**
   * 本会话的产物汇总（原版对话流末尾的 Codex 风格 Changes 卡）。
   * 汇总逻辑是已移植的 `core/common/WorkArtifacts.WorkArtifactUtil.collect`，
   * 在桌面端此前**零引用**（连 core 内部都没人 import）。
   */
  conversationArtifacts: 'conversation:artifacts',
  /**
   * 表格提取（原版 AgentDrawerView 的「表格提取」→ pages/TableOcrPage）。
   * 原版这是**唯一一个不依赖大模型对话的独立工具页**，桌面端此前完全不存在：
   * `TableOcrService` 零引用，也没有任何界面入口。
   */
  tableOcrPickImage: 'tableOcr:pickImage',
  tableOcrRun: 'tableOcr:run',
  /**
   * 配置方案（多套 API 配置）。原版 SettingsPanel 顶部的「配置方案 / 配置名称」就是它；
   * 桌面端此前 ApiProfileDto、saveApiProfiles 通道、StorageManager 的读写**全都在**，
   * 只有渲染层从来没有调用点 —— 用户无法保存/切换第二套配置。
   */
  settingsSelectApiProfile: 'settings:selectApiProfile',
  settingsAddApiProfile: 'settings:addApiProfile',
  settingsDeleteApiProfile: 'settings:deleteApiProfile',
  settingsSaveCurrentApiProfile: 'settings:saveCurrentApiProfile',
  /** 智能体 */
  agentsList: 'agents:list',

  /** 对话 */
  conversationsLoad: 'conversations:load',
  conversationsCreate: 'conversations:create',
  conversationsDelete: 'conversations:delete',
  conversationsRename: 'conversations:rename',

  /** 聊天 */
  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatRegenerate: 'chat:regenerate',
  /** 交互模式：把控件状态（尾标记）写回消息并持久化 */
  messagePatch: 'chat:patchMessage',

  /** 工作模式 / 交互模式 */
  workRun: 'work:run',
  workAbort: 'work:abort',
  workAnswer: 'work:answer',

  /** 沙箱工作区 */
  workspaceList: 'workspace:list',
  /** 单层目录列举（侧栏懒加载文件树；path 为空串表示根目录） */
  workspaceListDir: 'workspace:listDir',
  workspaceTreeText: 'workspace:treeText',
  workspaceUpload: 'workspace:upload',
  workspaceRead: 'workspace:read',
  workspaceDelete: 'workspace:delete',
  workspaceClear: 'workspace:clear',
  workspaceExportZip: 'workspace:exportZip',
  workspaceOpenInFolder: 'workspace:openInFolder',
  /**
   * 工作区根信息（面板显示真实路径；自定义目录时禁用「清空工作区」）。
   */
  workspaceInfo: 'workspace:info',
  /** 弹出原生目录选择器，返回选中的目录（取消返回 null） */
  workspacePickDirectory: 'workspace:pickDirectory',
  /** 把会话工作区切到任意目录（dir=null 恢复默认沙箱） */
  workspaceSetCustom: 'workspace:setCustom',
  /**
   * 设置本会话的命令审批档位（'ask' | 'ask-risk' | 'auto'）。
   * 存会话元数据（与 workspacePath 同样持久化），返回更新后的 workspace:info 负载。
   */
  workspaceSetCommandPermission: 'workspace:setCommandPermission',
  /** 用系统默认程序打开工作区内的某个文件（越界校验与 read 同一条路） */
  workspaceOpenFile: 'workspace:openFile',
  /** 在文件管理器中定位工作区内的某个文件（shell.showItemInFolder） */
  workspaceReveal: 'workspace:reveal',
  /**
   * 按字节读取工作区文件（返回 data URL），给图片等二进制内容的内置预览用。
   * 此前 workspace:read 只会按 utf8 读文本，图片一律「读取二进制失败」，
   * 面板里点开一张图只能看到报错 —— 「打开」而不是「看源码」是用户的基本预期。
   */
  workspaceReadBinary: 'workspace:readBinary',

  /** 应用信息 */
  appInfo: 'app:info',
  /**
   * 启动诊断：渲染进程主动上报自己走到了哪一步。
   * 「页面加载完成」是主进程能自己看到的最远一步；再往里（React 有没有挂载成功、
   * 有没有真的产出帧）主进程完全看不见 —— 白屏恰恰发生在那段盲区里。
   */
  appRendererStage: 'app:rendererStage',

  /** 端侧增强：文件收件（拖拽 / 系统「打开方式」/ 命令行参数） */
  intakeImport: 'intake:import',
  /**
   * 端侧增强：弹出系统文件选择框，把选中的文件导入工作区。
   *
   * 为什么必须有这条：鸿蒙版 WorkspaceBar 的头部有一个显眼的「上传」按钮
   * （空态文案就是「工作区为空, 点击"上传"添加文件」）。桌面版此前只有
   * 「拖拽到窗口」这一条路 —— 而拖拽在界面上没有任何提示，用户根本找不到入口。
   */
  intakePickFiles: 'intake:pickFiles',
  /** 端侧增强：把一条回答导出为 Word */
  messageExportDocx: 'message:exportDocx',
  /**
   * 统一的「导出 / 分享」通道：工作区压缩包、单个工作区文件、一条回答的 Word，
   * 全部走这一条。save 会弹系统保存位置选择（用户可自选目录、可取消），
   * share 调起系统分享面板或直接指向微信。
   */
  fileTransfer: 'file:transfer',
  /** 端侧增强：语音输入（录音 → 转写） */
  asrTranscribe: 'asr:transcribe'
} as const

export const EVENT = 'guncat:event'

/**
 * 渲染进程上报的启动阶段。
 *
 * 三者都是「白屏」，但原因完全不同，必须分开：
 *   mounted —— React 挂载成功（界面树已进 DOM）
 *   painted —— 浏览器已产出首帧
 *   error   —— React 在挂载/渲染时抛异常（没有这一步，主进程只会看到一片安静）
 */
export type RendererStage = 'mounted' | 'painted' | 'error'

// ===== 设置 =====

export interface ApiConfigDto {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  topP: number
  maxTokens: number
  extraParams: string
  /**
   * 是否自动补全协议路径后缀（/chat/completions、/responses、/v1/messages…）。
   * 关闭后严格按填写的 Base URL 发起请求，适合非标准路径的自建网关/代理。
   *
   * 对齐原版 SettingsPanel 的「协议路径后缀补全」开关。此前这个字段**没有进 DTO**，
   * 后果是静默的：渲染层看不到它，而 fromApiConfigDto 每次都把它重置成默认的 true ——
   * 用户（或从原版迁移过来的配置）关掉它以后，只要在桌面端点一次「保存」，设置就被悄悄丢掉。
   */
  autoSuffix: boolean
}

export interface ApiProfileDto {
  id: string
  name: string
  config: ApiConfigDto
  multimodalConfig: MultimodalConfigDto
}

export interface MultimodalConfigDto {
  baseUrl: string
  apiKey: string
  model: string
  preparseEnabled: boolean
}

/**
 * 本地联网搜索的引擎目录（由主进程给出，见 settings:searchEngines）。
 *
 * 为什么不让渲染层直接 import LocalWebSearch 里的常量与判断函数：
 * 那个模块依赖 `@kit.NetworkKit`（真正的网络实现只在主进程侧），
 * 而渲染层的 vite 配置里根本没有 `@kit.*` 别名 —— 引进来会直接构建失败。
 * 由主进程把「有哪些引擎、各自要不要 Key/BaseUrl」报出来，既避免重复定义，也不会漂移。
 */
/**
 * 会话的任务统计与当前目标。
 *
 * 对齐原版 DetailsPanelView 的统计卡（任务用时 / 输出速度 / 缓存命中 / 工具调用轮数）
 * 与目标卡（GoalService.read）。桌面端此前全库 `elapsed` 零命中，
 * `GoalService.read` 在渲染层与主进程也都没有调用点 —— 跑长任务时看不到「跑了多久、目标是什么」。
 */
export interface ConversationStatsDto {
  /** 最近一次任务用时（毫秒；0 = 还没跑过或正在跑） */
  elapsedMs: number
  /** 平均输出速度（字符/秒；-1 = 无数据） */
  speed: number
  /** 平均缓存命中率（0..1；-1 = 无数据） */
  cacheHit: number
  /** 最近一次任务的工具调用轮数 */
  rounds: number
  /** 当前目标；没有目标时为 null */
  goal: GoalDto | null
}

export interface GoalDto {
  objective: string
  status: string
  rounds: number
  maxRounds: number
}

/** diff 缩略的一行（对应原版 WorkArtifactsCard 的 ArtifactDiffRow） */
export interface ArtifactDiffRowDto {
  type: string
  text: string
}

/** 产物汇总里的一个文件 */
export interface ArtifactFileDto {
  path: string
  /** 是否有可展示的行级 diff（Office/二进制产物没有） */
  hasDiff: boolean
  adds: number
  dels: number
  /** 最多 8 行的 diff 缩略（对齐原版 diffPreviewRows 的上限） */
  rows: ArtifactDiffRowDto[]
}

/** 产物汇总卡的数据（对应 core 的 WorkArtifactSummary） */
export interface WorkArtifactsDto {
  files: ArtifactFileDto[]
  totalAdds: number
  totalDels: number
}

export interface TableOcrImageDto {
  path: string
  name: string
  size: number
  /** 预览缩略图（data URL）；生成失败时为空串 */
  thumbnail: string
}

export interface TableOcrResultDto {
  /** 已清洗的 `<table>` 片段（只保留表格结构与 colspan/rowspan） */
  html: string
  /** 实际使用的模型（界面上说清「用的是哪套配置」） */
  model: string
}

/** 表格提取可选的模型来源（原版 TableOcrPage 从配置方案里列模型） */
export interface TableOcrModelDto {
  /** 传回给主进程的标识（模型名） */
  id: string
  label: string
  baseUrl: string
}

export interface SearchEngineDto {
  id: string
  label: string
  needsApiKey: boolean
  supportsBaseUrl: boolean
}

/**
 * 附件的解析状态。
 *
 * 对齐原版 FileItem.status：选完文件卡片立刻出现（`parsing`），随后逐个解析，
 * 解析完改成 `ready`（已就绪）或 `error`（解析失败，整卡红底）。
 * 解析中的附件**不允许发送** —— 原版 sendMessage 里有「文件解析中，请稍候」的守卫。
 */
export type AttachmentParseStatus = 'parsing' | 'ready' | 'error'

/**
 * 选中的附件（发送前）。
 * 只带「怎么显示」「文件在哪」与「解析到哪一步了」。真正的读取与解析放在主进程
 * （多模态配置、API Key 都在那边），解析结果经 `attachment:parsed` 事件回报。
 */
export interface PickedAttachmentDto {
  path: string
  name: string
  size: number
  /** 图片的小缩略图（data URL）；非图片为空串，渲染层退回显示文件名 */
  thumbnail: string
  /** 解析状态；pick 返回时必然是 parsing，之后由事件推进 */
  status: AttachmentParseStatus
  /** 解析失败的原因（status === 'error' 时给卡片 tooltip 用） */
  error?: string
}

export interface AppSettingsDto {
  apiConfig: ApiConfigDto | null
  apiProfiles: ApiProfileDto[]
  /** 当前选中的配置方案 id（对齐原版 Constants.LS_KEY_CURRENT_API_PROFILE_ID） */
  currentApiProfileId: string
  multimodalConfig: MultimodalConfigDto
  flags: Record<string, boolean>
  /** 字符串型偏好（朗读音色/语速等） */
  prefs: Record<string, string>
  /**
   * 凭据落盘的真实状态（见 core/platform/kit/ArkData 的落盘加密说明）。
   * available=false 时密钥是明文写在配置文件里的，设置面板必须如实显示 ——
   * 不能让用户以为「设置里填了 Key」就等于「Key 被保护了」。
   */
  credentialState: CredentialStateDto
}

export interface CredentialStateDto {
  /** 本机是否提供安全存储（Windows DPAPI / macOS Keychain / Linux 钥匙串） */
  available: boolean
  /** 解不开的配置项（换过机器 / 钥匙串被清空），形如 default/guncat_api_config */
  undecryptable: string[]
}

// ===== 智能体 =====

export interface AgentDto {
  id: string
  name: string
  description: string
  shortDescription: string
  icon: string
  category: string
  prompt: string
}

// ===== 对话 =====

export interface ToolCallRecordDto {
  id: string
  name: string
  argsJson: string
  result: string
  status: string
  startedAt: number
  finishedAt: number
  /**
   * 工具耗时（毫秒）。**负数表示还没跑完** —— 这是原版 `WorkStepFormat` 全链路的判据
   * （决定图标位显示转圈还是类别图标、右侧显示耗时还是「失败」、要不要给展开箭头）。
   */
  durationMs: number
  /**
   * 是否已**真正开始执行**（内核在执行前标记）。
   * 与 `durationMs < 0` 配合决定工具行右端显示哪一句：
   * `started` → 「执行中…」、否则 → 「等待中…」（原版 WorkTurnView.stepStatusLabel）。
   */
  started?: boolean
  /**
   * 模型是否还在**生成这个调用的参数**（原版在流式回调里置位）。
   * 桌面端的内核目前只在参数生成完成时回调一次，因此这个字段实际上恒为 false ——
   * 界面上的「生成调用中…」分支保留着，等内核补上流式增量回调即可点亮。
   */
  preparing?: boolean
  diff: string
}

export interface AttachmentDto {
  id: string
  name: string
  type: string
  dataUrl: string
  thumbnail: string
  parsedText: string
  fileId: string
}

export interface MessageDto {
  id: string
  role: string
  content: string
  displayContent: string
  reasoning: string
  attachments: AttachmentDto[]
  toolCalls: ToolCallRecordDto[]
  timestamp: number
  tokenSpeed: number
  cacheHitRate: number
  /** 交互模式：guncat-ui 界面程序源码（阶段二接入渲染） */
  uiProgram?: string
  /** 交互模式的控件状态尾标记（阶段二） */
  uiState?: string
}

export interface ConversationDto {
  id: string
  title: string
  agentId: string
  mode: string
  createdAt: number
  updatedAt: number
  messages: MessageDto[]
}

/** 会话列表用的轻量投影（不带消息体） */
export interface ConversationSummaryDto {
  id: string
  title: string
  agentId: string
  mode: string
  updatedAt: number
  messageCount: number
  lastPreview: string
}

// ===== 请求 =====

export type AgentMode = 'chat' | 'work' | 'interactive'

export interface ChatSendRequest {
  conversationId: string
  text: string
  mode: AgentMode
  thinkingEnabled: boolean
  webSearchEnabled: boolean
  attachmentPaths?: string[]
}

export interface WorkRunRequest {
  conversationId: string
  text: string
  mode: AgentMode
  thinkingEnabled: boolean
  webSearchEnabled: boolean
  /**
   * 推理强度：'max' | 'high' | 'low'（原版按形态分档：工作 Max/High/Low，交互 High/Low/Off）。
   * 不传时由主进程按 thinkingEnabled 推默认值 —— 此前是**写死** 'high'/'none'，
   * 于是工作模式永远拿不到 Max 档，也没法选 Low 提速。
   */
  reasoningEffort?: string
}

/** 推理强度的合法取值（对齐 AgentLoopService 下发给三种协议的取值） */
export const REASONING_EFFORTS: string[] = ['max', 'high', 'low', 'none']

/**
 * 回答一次挂起的 ask_user_question（对应原版 ChatViewModel.answerAsk / cancelAsk）。
 *
 * 只有一个通道而不是「作答/取消」两条：两者的差别只是一个 canceled 标志，
 * 分成两条通道会让主进程侧多一份重复的「requestId 找不到」错误处理。
 */
export interface WorkAnswerRequest {
  conversationId: string
  /** AskUserBridge 分配的提问 id（由 ask:user 事件带来） */
  requestId: string
  /** true = 用户点了「跳过，由智能体自行决定」（此时 selections/note 无意义） */
  canceled?: boolean
  /** 用户勾选的选项；自由作答（无 options）时为空数组 */
  selections?: string[]
  /** 用户补充的文字，可空 */
  note?: string
}

/**
 * 重新生成最后一条回答（对应原版消息操作行的「重答」）。
 *
 * 语义：把最后一条用户消息之后的 assistant 消息全部丢弃（那次失败的/被中止的输出
 * 就地消失，而不是在它下面再叠一条），然后用同一个问题重跑一次。
 */
export interface ChatRegenerateRequest {
  conversationId: string
  thinkingEnabled: boolean
  webSearchEnabled: boolean
}

export interface ConversationRef {
  conversationId: string
}

export interface WorkspaceRef {
  conversationId: string
}

/**
 * 导出/分享的一次请求。
 *
 * 为什么不复用 workspace:exportZip / message:exportDocx：那两条命令的语义是
 * 「立刻写进默认下载目录」，用户既没有确认环节也选不了位置（Android 上表现为
 * 点一下就提示「已导出」，连文件落在哪都不知道）。这里把「要哪份文件」与
 * 「怎么处置」拆开：save 一定先经过系统保存位置选择，share 一定先给出分享去向。
 *
 * 三选一确定内容：path（工作区相对路径）→ messageId（导出该条回答）→ 两者都空（打包工作区）。
 */
export interface TransferRequestDto {
  conversationId: string
  /** 工作区内的相对路径；空串/undefined 表示「打包整个工作区」 */
  path?: string
  /** 把某条回答导出为 Word（与 path 互斥） */
  messageId?: string
  /** 建议文件名（保存对话框的默认名、分享时的标题） */
  suggestedName?: string
  action: 'save' | 'share'
  /** share 的去向：system = 系统分享面板；wechat = 直接微信（不可用时退回系统面板） */
  target?: 'system' | 'wechat'
}

export interface TransferResultDto {
  /**
   * saved   已写入用户选定的位置
   * shared  已调起分享（微信 / 系统面板）
   * canceled 用户在保存位置选择里取消
   * error   失败（message 里是原因）
   */
  status: 'saved' | 'shared' | 'canceled' | 'error'
  /** 保存成功后的展示路径；桌面是绝对路径，Android 是「下载/Guncat Work/x」这类友好位置 */
  path?: string
  /** 需要额外告诉用户的一句话（分享去向、失败原因等） */
  message?: string
}

export interface WorkspacePathRef {
  conversationId: string
  path: string
}

export interface WorkspaceEntryDto {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: number
}

/** workspace:readBinary 的返回体（图片等二进制的内置预览） */
export interface WorkspaceBinaryDto {
  /** 直接可进 <img src> 的 data URL */
  dataUrl: string
  mimeType: string
  size: number
}

/** workspace:info 的返回体：当前工作区根目录的状态 */
export interface WorkspaceInfoDto {
  root: string
  /** true = 用户自选目录（不是应用托管的沙箱） */
  isCustom: boolean
  /** 目录当前是否仍存在（自定义目录被移动/删除时为 false，界面要如实提示） */
  exists: boolean
  /**
   * 本会话的命令审批档位：'ask' 每条都问 | 'ask-risk' 危险才问（默认）|
   * 'auto' 自动审批（危险命令先交模型审阅，它拦下或没结论仍弹卡）| 'full-access' 完全权限（不审不问）。
   * 由 run_command 工具消费（见 core/service/CommandService 与 core/service/ApprovalReviewService），
   * 界面在面板里给一个选择行。
   * 四档都改不动 CommandGuard 的硬禁表 —— 毁灭性操作在任何档位下直接拒绝，连批准的机会都没有。
   */
  commandPermission: string
  /**
   * 工作区根目录下真实存在的项目指令文件（AGENTS.md / CLAUDE.md / GUNCAT.md，按优先级）。
   * 这些内容每轮随运行时快照注入（core/service/WorkspaceInstructionsService），
   * 面板据此如实显示「这个目录有没有约定要交给代理」，没有则是空数组。
   */
  instructionFiles: string[]
}

// ===== 事件（主进程 → 渲染进程） =====

export type GuncatEvent =
  | { type: 'conversation:created'; conversation: ConversationDto }
  | { type: 'conversation:deleted'; conversationId: string }
  | { type: 'conversation:title'; conversationId: string; title: string }
  /**
   * 会话内容被整体改写（目前只有「重新生成」：末尾若干条消息被丢弃）。
   * 与 message:added/patched 这类增量事件不同，渲染进程收到它应当用整份会话替换本地投影。
   */
  | { type: 'conversation:sync'; conversation: ConversationDto }
  | { type: 'message:added'; conversationId: string; message: MessageDto }
  | { type: 'message:patched'; conversationId: string; messageId: string; patch: Partial<MessageDto> }
  | { type: 'tool:started'; conversationId: string; messageId: string; call: ToolCallRecordDto }
  | { type: 'tool:finished'; conversationId: string; messageId: string; call: ToolCallRecordDto }
  | { type: 'turn:started'; conversationId: string; messageId: string }
  | { type: 'turn:finished'; conversationId: string; messageId: string; status: 'ok' | 'error' | 'aborted'; error?: string }
  | { type: 'workspace:changed'; conversationId: string }
  | { type: 'files:intaken'; conversationId: string; names: string[]; imported: number; failed: string[] }
  /** 外部文件到达（命令行 / 系统「打开方式」/ 第二实例），等渲染进程决定导入哪个会话 */
  | { type: 'files:pending'; paths: string[] }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  /**
   * 某个附件解析完成（成功或失败）。
   *
   * 为什么要有这条：`attachments:pick` 是**立刻**返回的（卡片马上出现在预览条上，
   * 原版口径），解析在主进程后台逐个进行；没有这条事件，卡片就会永远停在「解析中...」，
   * 用户既不知道能不能发，也看不到失败原因。
   */
  | { type: 'attachment:parsed'; path: string; status: 'ready' | 'error'; error?: string }
  /**
   * ask_user_question 工具挂起在等用户作答（工具执行期间，轮次还没结束）。
   *
   * 这条事件以前只在契约里躺着、全库没有发送方 —— 因为那个工具被整个删掉了。
   * 恢复后由 SessionManager 从 AskUserBridge 的生命周期回调里发出来；
   * requestId 就是 AskUserBridge 里的提问 id，作答时要原样回传。
   */
  | {
      type: 'ask:user'
      conversationId: string
      requestId: string
      question: string
      options: string[]
      /** 是否多选：界面据此画「可多选」并允许勾多个（原版 PendingAsk.multiSelect） */
      multiSelect: boolean
    }
  /**
   * 提问已落定（用户作答 / 点「跳过」/ 超时 / 轮次被中止），界面该收起卡片了。
   * 必须有这条：卡片是跟着挂起的工具走的，工具一旦不再挂起，卡片留在屏幕上
   * 就会让用户对着一个「点了也没用」的按钮反复点。
   */
  | {
      type: 'ask:done'
      conversationId: string
      requestId: string
      outcome: 'answered' | 'canceled'
    }

export interface AppInfoDto {
  version: string
  dataRoot: string
  resourcesRoot: string
  platform: string
  electron: string
}
