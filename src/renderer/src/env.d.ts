// 渲染进程可见的 preload 接口类型。
// 只声明用到的部分，避免把 Electron 类型带进渲染进程的编译范围。
import type {
  AgentDto,
  ApiConfigDto,
  ApiProfileDto,
  AppInfoDto,
  AppSettingsDto,
  ChatRegenerateRequest,
  ChatSendRequest,
  ConversationDto,
  ConversationSummaryDto,
  GuncatEvent,
  ConversationStatsDto,
  MultimodalConfigDto,
  PickedAttachmentDto,
  RendererStage,
  TableOcrImageDto,
  TableOcrResultDto,
  TransferRequestDto,
  TransferResultDto,
  WorkArtifactsDto,
  SearchEngineDto,
  WorkspaceBinaryDto,
  WorkspaceEntryDto,
  WorkspaceInfoDto,
  WorkAnswerRequest,
  WorkRunRequest
} from '@ipc/contract'

export interface GuncatApi {
  settings: {
    load(): Promise<AppSettingsDto>
    saveApiConfig(dto: ApiConfigDto): Promise<void>
    saveApiProfiles(profiles: ApiProfileDto[]): Promise<void>
    /** 配置方案：选中（会同时把该方案写回运行时生效的配置） */
    selectApiProfile(profileId: string): Promise<void>
    /** 配置方案：新建（复制当前配置，返回新方案） */
    addApiProfile(): Promise<ApiProfileDto>
    /** 配置方案：删除（至少保留一份） */
    deleteApiProfile(profileId: string): Promise<void>
    /** 配置方案：一次性保存当前方案（名称 + API 配置 + 多模态配置） */
    saveCurrentApiProfile(
      name: string,
      config: ApiConfigDto,
      multimodal: MultimodalConfigDto
    ): Promise<void>
    saveMultimodalConfig(dto: MultimodalConfigDto): Promise<void>
    saveFlag(key: string, value: boolean): Promise<void>
    saveString(key: string, value: string): Promise<void>
    /** 本地联网搜索的引擎目录（渲染层据此渲染选项，不必自己维护一份引擎表） */
    searchEngines(): Promise<SearchEngineDto[]>
  }
  agents: {
    list(): Promise<AgentDto[]>
  }
  conversations: {
    list(): Promise<ConversationSummaryDto[]>
    get(id: string): Promise<ConversationDto | null>
    create(agentId: string, mode: string): Promise<ConversationDto>
    remove(id: string): Promise<void>
    rename(id: string, title: string): Promise<void>
  }
  chat: {
    send(request: ChatSendRequest): Promise<void>
    abort(conversationId: string): Promise<void>
    regenerate(request: ChatRegenerateRequest): Promise<void>
    patchMessage(conversationId: string, messageId: string, content: string): Promise<void>
  }
  work: {
    run(request: WorkRunRequest): Promise<void>
    abort(conversationId: string): Promise<void>
    /** 回答一次挂起的 ask_user_question；false = 提问已不在挂起列表里（界面应直接收卡片） */
    answer(request: WorkAnswerRequest): Promise<boolean>
  }
  workspace: {
    list(conversationId: string): Promise<WorkspaceEntryDto[]>
    /** 单层目录列举（懒加载文件树）；path 为空串 = 工作区根 */
    listDir(conversationId: string, path: string): Promise<WorkspaceEntryDto[]>
    treeText(conversationId: string): Promise<string>
    read(conversationId: string, path: string): Promise<{ text: string; truncated: boolean }>
    /** 按字节读取（data URL），图片等二进制的内置预览用 */
    readBinary(conversationId: string, path: string): Promise<WorkspaceBinaryDto>
    /** 用系统默认程序打开工作区文件 */
    openFile(conversationId: string, path: string): Promise<void>
    /** 在文件管理器中定位该文件 */
    reveal(conversationId: string, path: string): Promise<void>
    remove(conversationId: string, path: string): Promise<void>
    /** 清空工作区；主进程会先弹原生确认框，用户取消时返回 cleared:false */
    clear(conversationId: string): Promise<{ cleared: boolean }>
    openInFolder(conversationId: string): Promise<void>
    exportZip(conversationId: string): Promise<{ saved: boolean; path?: string }>
    /** 当前工作区根目录状态（自定义目录时 isCustom=true） */
    info(conversationId: string): Promise<WorkspaceInfoDto>
    /** 原生目录选择器；取消返回 null */
    pickDirectory(): Promise<string | null>
    /** 切换工作区目录；dir=null 恢复默认沙箱 */
    setCustom(conversationId: string, dir: string | null): Promise<WorkspaceInfoDto>
    /** 命令审批档位：'ask' 每条都问 | 'ask-risk' 危险才问 | 'auto' 模型先审（默认）| 'full-access' 完全权限（硬禁仍生效） */
    setCommandPermission(conversationId: string, permission: string): Promise<WorkspaceInfoDto>
  }
  app: {
    info(): Promise<AppInfoDto>
    /** 启动诊断：上报「React 已挂载 / 已产出首帧 / 渲染出错」 */
    reportStage(stage: RendererStage, detail?: string): Promise<void>
  }
  intake: {
    importPaths(
      conversationId: string,
      paths: string[]
    ): Promise<{ names: string[]; imported: number; failed: string[] }>
    /** 弹系统文件选择框并导入（工作区面板的「上传」按钮）；source='camera' 直接调起相机 */
    pickFiles(
      conversationId: string,
      source?: 'file' | 'camera' | 'gallery'
    ): Promise<{ names: string[]; imported: number; failed: string[]; canceled: boolean }>
  }
  /** 聊天模式的附件：选文件（立刻返回 parsing；解析结果经 attachment:parsed 事件回报） */
  attachments: {
    pick(source?: 'file' | 'camera' | 'gallery'): Promise<PickedAttachmentDto[]>
  }
  /** 工作模式执行中插话；返回是否被接受（false 时应改走普通发送） */
  steer(conversationId: string, text: string): Promise<boolean>
  /** 会话的任务统计与当前目标（工作区面板的统计卡与目标卡） */
  stats(conversationId: string): Promise<ConversationStatsDto>
  /** 本会话的产物汇总（对话流末尾的 Changes 卡） */
  artifacts(conversationId: string): Promise<WorkArtifactsDto>
  /** 表格提取：选图 → 识别 → 返回清洗过的 <table> 片段 */
  tableOcr: {
    pickImage(): Promise<TableOcrImageDto | null>
    run(imagePath: string, model: string): Promise<TableOcrResultDto>
  }
  messages: {
    exportDocx(
      conversationId: string,
      messageId: string,
      suggestedName?: string
    ): Promise<{ saved: boolean; path?: string }>
  }
  /**
   * 统一的导出 / 分享入口：工作区压缩包 / 单个工作区文件 / 一条回答的 Word。
   * save 一定先经过系统保存位置选择（可取消、可自选目录）；share 调起分享。
   */
  transfer(request: TransferRequestDto): Promise<TransferResultDto>
  files: {
    pathForFile(file: File): string
  }
  asr: {
    transcribe(audio: Uint8Array, mime: string): Promise<{ ok: boolean; text: string; error: string }>
    /** Android 原生识别（端侧优先）；桌面端没有这一项 */
    native?: {
      status: 'on-device' | 'system'
      start(): Promise<{ ok: boolean; text: string; error: string }>
      stop(): void
    }
  }
  /** 系统 TTS（Android 宿主提供；桌面端没有这一项，朗读退回 Web Speech API） */
  speech?: {
    supported: boolean
    speak(text: string, rate: number): void
    stop(): void
  }
  onEvent(listener: (event: GuncatEvent) => void): () => void
}

declare global {
  interface Window {
    guncat: GuncatApi
  }
}

export {}
