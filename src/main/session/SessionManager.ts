// SessionManager：主进程的业务权威。
//
// 它持有全部会话（内存中的 Conversation 模型 + 落盘持久化），
// 驱动「聊天模式」的三协议流式对话与「工作模式」的 Agent Loop，
// 并把状态变化以事件形式推给渲染进程。
//
// 对应鸿蒙版的 viewmodel/ChatViewModel.ets —— 那里 ViewModel 同时承担
// UI 状态与循环驱动；桌面端把循环驱动留在主进程，UI 状态由渲染进程的 store 负责，
// 因此这里只保留「业务」那一半。
import { appContext } from '@core/platform/kit/AbilityKit'
import { secretStorageState } from '@core/platform/kit/ArkData'
import fs from 'node:fs'
import path from 'node:path'
import { StorageManager } from '@core/data/StorageManager'
import { FileService, type PickedFile } from '@core/service/FileService'
import { DocxBuilder } from '@core/export/DocxBuilder'
import { AgentLoader } from '@core/service/AgentLoader'
import { ChatService } from '@core/service/ChatService'
import {
  AgentLoopService,
  LoopMessage,
  LoopTurnResult,
  LoopTurnCallbacks,
  LoopError,
  ToolImageAttachment
} from '@core/service/AgentLoopService'
import { WorkToolRunner } from '@core/service/WorkToolRunner'
import { ToolExecResult, WorkFileService } from '@core/service/WorkFileService'
import { SubagentService } from '@core/service/SubagentService'
import { ApprovalReviewService } from '@core/service/ApprovalReviewService'
import { Conversation } from '@core/model/Conversation'
import { Message } from '@core/model/Message'
import { Attachment } from '@core/model/Attachment'
import { ApiConfig } from '@core/model/ApiConfig'
import { ApiProfile } from '@core/model/ApiProfile'
import { ApiProfileSeeder } from './ApiProfileSeeder'
import { LLMProtocol } from '@core/common/LLMProtocol'
import { MultimodalConfig } from '@core/model/MultimodalConfig'
import { Agent } from '@core/model/Agent'
import { ToolCallRecord } from '@core/model/ToolCallRecord'
import { StreamCallbacks, AbortSignal } from '@core/common/Types'
import { Constants } from '@core/common/Constants'
import { LoopDecisions } from '@core/common/LoopDecisions'
import { ContextBudget } from '@core/common/ContextBudget'
import type { BudgetAnchor } from '@core/common/ContextBudget'
import type { BudgetHeadFactory } from '@core/common/ContextBudget'
import { generateMessageId } from '@core/common/Utils'
import { GuncatUiParts } from '@core/common/GuncatUiParts'
import { GuncatUiLang } from '@core/common/GuncatUiLang'
import { GuncatUiRuntime, GuncatUiTrailer } from '@core/common/GuncatUiRuntime'
import { ToolExecutionGuard } from '@core/common/ToolExecutionGuard'
import { parseArgsObject, parseSearchQuery, readArgString } from '@core/common/ToolArgs'
import {
  LOCAL_SEARCH_TOOL_NAME,
  LocalSearchOutcome,
  LocalWebSearch,
  SearchEngineSettings,
  isLocalSearchToolName
} from '@core/service/LocalWebSearch'
import { WEB_FETCH_TOOL_NAME, HarnessTools } from '@core/service/HarnessTools'
import { AskUserBridge, PendingAsk, AskPhase } from '@core/service/AskUserBridge'
import { CommandGuard } from '@core/service/CommandGuard'
import { CommandService } from '@core/service/CommandService'
import { ScheduleService } from '@core/service/ScheduleService'
import { GoalService } from '@core/service/GoalService'
import { WorkspaceInstructionsService } from '@core/service/WorkspaceInstructionsService'
import { WorkspaceMentionService } from '@core/service/WorkspaceMentionService'
import {
  WorkArtifactFile,
  WorkArtifactSummary,
  WorkArtifactUtil
} from '@core/common/WorkArtifacts'
import { FileDiff } from '@core/common/DiffUtil'
import { PluginHotLoader } from '@core/service/PluginHotLoader'
import type { PluginManifestResult } from '@core/common/PluginManifestLoader'
// 附件链路：MultimodalService（先行解析）与 FileUploadService（Files API）此前是零引用的
// 已移植能力，见 makeAttachments 的说明。
import { MultimodalService } from '@core/service/MultimodalService'
import { FileUploadService } from '@core/service/FileUploadService'
import { image } from '@core/platform/kit/ImageKit'

import type {
  AgentDto,
  AppSettingsDto,
  ApiConfigDto,
  ApiProfileDto,
  ArtifactDiffRowDto,
  ChatRegenerateRequest,
  ChatSendRequest,
  ConversationDto,
  ConversationStatsDto,
  ConversationSummaryDto,
  GuncatEvent,
  MessageDto,
  MultimodalConfigDto,
  ToolCallRecordDto,
  WorkArtifactsDto,
  WorkRunRequest,
  WorkspaceInfoDto
} from '../../ipc/contract'
import { REASONING_EFFORTS } from '../../ipc/contract'

type Emit = (event: GuncatEvent) => void

/** 每个会话同一时刻只允许一个前台任务 */
class RunHandle {
  abort: AbortSignal = new AbortSignal()
  busy: boolean = false
}

/** 单次附件解析的结果：attachment 为 null 表示这个文件不可用，error 说明原因 */
interface ParsedAttachment {
  attachment: Attachment | null
  error: string
}

/** 缓存条目：配置指纹 + 那次解析的结果（保持对象身份，便于复用） */
interface CachedAttachment extends ParsedAttachment {
  sig: string
}

/** 一批附件解析所需的配置与它们的配置指纹（一次读取，供整批复用） */
interface AttachmentParseContext {
  mm: MultimodalConfig
  api: ApiConfig | null
  sig: string
}

/**
 * 上下文预算管理要用到的「本轮环境」（原本在原版里是 ViewModel 的实例字段）。
 * 单独收成一个对象，是为了让 compactWorkHistoryIfNeeded 只依赖显式参数，
 * 便于阅读「它到底动了哪些状态」。
 */
interface WorkCompactionEnv {
  config: ApiConfig
  request: WorkRunRequest
  reasoningEffort: string
  abort: AbortSignal
}

/**
 * 摘要压缩后重建消息数组时的头部构造工厂。
 * core/common 不认识 LoopMessage（不让 common 反向依赖 service），所以由主进程侧注入。
 */
const LOOP_HEAD_FACTORY: BudgetHeadFactory<LoopMessage> = {
  system: (content: string): LoopMessage => LoopMessage.system(content),
  user: (content: string): LoopMessage => LoopMessage.user(content)
}

export class SessionManager {
  private emit: Emit
  private conversations: Conversation[] = []
  private agents: Agent[] = []
  private runs: Map<string, RunHandle> = new Map()
  private loaded: boolean = false

  constructor(emit: Emit) {
    this.emit = emit
    // ask_user_question 的桥 → 界面通道。
    //
    // 为什么装在构造函数里: 提问可能在任何一个会话的任意一轮里挂起, 而桥是纯逻辑模块、
    // 不认识 Electron。把生命周期翻译成事件的唯一位置就是这里(emit 的订阅者见 main/index.ts)。
    // 生命周期两种相位:
    //   'ask'     → ask:user(界面画卡片; 带 multiSelect, 否则单选/多选画不出来)
    //   'settled' → ask:done(界面收卡片; outcome 按有没有答案区分「已回答」与「已跳过/超时」)
    AskUserBridge.setNotifier((item: PendingAsk, phase: AskPhase, answered: boolean): void => {
      if (phase === 'ask') {
        this.emit({
          type: 'ask:user',
          conversationId: item.conversationId,
          requestId: item.id,
          question: item.question,
          options: item.options,
          multiSelect: item.multiSelect
        })
        return
      }
      this.emit({
        type: 'ask:done',
        conversationId: item.conversationId,
        requestId: item.id,
        outcome: answered ? 'answered' : 'canceled'
      })
    })
  }

  private ctx(): Context {
    return appContext()
  }

  // ===== 生命周期 =====

  async bootstrap(): Promise<void> {
    if (this.loaded) {
      return
    }
    const ctx: Context = this.ctx()
    // 技能库与工具表都是按需惰性同步的（见 WorkSkillService.ensureToolSkills），
    // 这里只做智能体加载与对话读取。
    this.agents = await AgentLoader.loadAllAgents(ctx)
    try {
      this.conversations = await StorageManager.loadConversations(ctx)
    } catch {
      this.conversations = []
    }
    // 自愈历史上被写坏的「虚拟智能体 + 聊天形态」会话：早期版本在冷启动时只设了智能体、
    // 没设形态，于是建出了一批 agentId='interactive'/'work' 而 mode='chat' 的会话 ——
    // 打开它们会走聊天分支、拿空提示词。以 agentId 为准修回来（虚拟智能体的 id 就是形态）。
    for (const conv of this.conversations) {
      const fixed: string =
        conv.agentId === Constants.MODE_WORK
          ? Constants.MODE_WORK
          : conv.agentId === Constants.MODE_INTERACTIVE
            ? Constants.MODE_INTERACTIVE
            : ''
      if (fixed !== '' && conv.mode !== fixed) {
        conv.mode = fixed
      }
    }
    // 一次性档位迁移：老版本里 'auto' 的含义是「危险命令也不问人」，那其实是**完全权限**而不是
    // 自动审批；新版本把那个语义改名为 'full-access'，'auto' 让给「模型先审、拦下才找人」。
    // 存过 auto 的老会话按**语义**落到 full-access —— 行为一点没变，新语义不会悄悄接管老会话，
    // 想要模型审阅得由用户在面板里自己选。（判定见 migrateCommandPermission）
    let permMigrated: number = 0
    for (const conv of this.conversations) {
      if (SessionManager.migrateCommandPermission(conv)) {
        permMigrated++
      }
    }
    if (permMigrated > 0) {
      await this.persist()
    }
    // 会话级 core 状态回填：workspacePath 注册进 core 的路径咽喉点（之后所有工具/面板/导出
    // 都按它取根目录，目录已失效的跳过注册），commandPermission 注册进命令审批档位表。
    // 两者同构：core 不认识 Electron，这些「按会话不同的设置」只能由主进程按会话带上。
    for (const conv of this.conversations) {
      if (conv.workspacePath !== '') {
        if (fs.existsSync(conv.workspacePath) && fs.statSync(conv.workspacePath).isDirectory()) {
          WorkFileService.setWorkspaceOverride(conv.id, conv.workspacePath)
        }
      }
      if (conv.commandPermission !== '') {
        CommandService.setPermission(conv.id, conv.commandPermission)
      }
    }
    // 本地联网搜索配置同样在启动时绑定一次：渲染层虽然会在 init 里读一次设置，
    // 但那是一次 IPC 往返，理论上可以在它之前就跑起一轮工作 —— 那时工具会拿到默认配置。
    await this.bindLocalSearchConfig(ctx)
    // 插件热加载（对齐原版 ChatViewModel.init 的顺序）：没有这一步，
    // 随包的资源 / 插件清单不会被读，插件工具一律返回「插件未实现」。
    // 单个插件失败不影响启动。
    try {
      const results: PluginManifestResult[] = await PluginHotLoader.loadAll(ctx)
      const failed: PluginManifestResult[] = results.filter((r) => !r.ok)
      // 没有插件、也没有失败时不弹提示：手机上一启动就飘一条「未加载插件」只会让人以为出错。
      if (failed.length > 0) {
        this.emit({
          type: 'notice',
          level: 'warn',
          text:
            PluginHotLoader.loadedSummary() +
            `；${failed.length} 个加载失败：${failed.map((r) => r.error).join(', ')}`
        })
      } else if (PluginHotLoader.loadedCount() > 0) {
        this.emit({ type: 'notice', level: 'info', text: PluginHotLoader.loadedSummary() })
      }
    } catch {
      // 插件目录/清单不存在都走「没有插件」，不该拖住应用启动
    }
    this.loaded = true
  }

  listAgents(): AgentDto[] {
    return this.agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      shortDescription: a.shortDescription,
      icon: a.icon,
      category: a.category,
      prompt: a.systemPrompt
    }))
  }

  // ===== 设置 =====

  async loadSettings(): Promise<AppSettingsDto> {
    const ctx: Context = this.ctx()
    // 配置方案列表（首次运行会播种预置方案，老版本则把已有的 DeepSeek 方案合并进预置）。
    // 必须先读方案：播种/合并可能会重写下面两个运行时键，之后再读才拿到最终值。
    const { profiles, currentId } = await this.readApiProfiles(ctx)
    const apiConfig: ApiConfig | null = await StorageManager.loadApiConfig(ctx).catch(
      (): ApiConfig | null => null
    )
    const multimodalConfig: MultimodalConfig = await StorageManager.loadMultimodalConfig(ctx).catch(
      (): MultimodalConfig => MultimodalConfig.default()
    )
    // 本地联网搜索：把持久化的配置**绑定**给工具层。
    // LocalWebSearch.settings 是进程级单例，不 bind 的话永远停在默认值（Bing / 默认条数），
    // 用户配的引擎与 Key 一律不生效 —— 原版在 ChatViewModel.init 里做了这一步，桌面端漏了。
    await this.bindLocalSearchConfig(ctx)
    return {
      apiConfig: apiConfig === null ? null : SessionManager.toApiConfigDto(apiConfig),
      apiProfiles: profiles.map((p) => SessionManager.toApiProfileDto(p)),
      currentApiProfileId: currentId,
      multimodalConfig: SessionManager.toMultimodalDto(multimodalConfig),
      flags: {},
      prefs: await this.loadStringPrefs(),
      credentialState: secretStorageState()
    }
  }

  // ===== 配置方案（多套 API 配置） =====

  /**
   * 读配置方案列表与当前选中项。
   *
   * 两层迁移：
   *   1. 首次运行（或从只有「单份配置」的旧版本升级）时，把已有的 apiConfig / multimodalConfig
   *      迁移成一份方案 —— 老用户的 Key 不会因为引入了方案机制而消失；
   *   2. 预置方案只播种一次（Constants.LS_KEY_API_PROFILES_SEEDED 标记）：把旧配置里
   *      指向 api.deepseek.com 的方案合并进预置 Deepseek，并补上 Opencode Go。
   *      用户之后删掉预置方案，下次启动不会再冒出来。
   */
  private async readApiProfiles(ctx: Context): Promise<{ profiles: ApiProfile[]; currentId: string }> {
    let profiles: ApiProfile[] = await StorageManager.loadApiProfiles(ctx).catch(
      (): ApiProfile[] => []
    )
    if (profiles.length === 0) {
      const legacyApi: ApiConfig = await StorageManager.loadApiConfig(ctx).catch(
        (): ApiConfig => ApiConfig.default()
      ) ?? ApiConfig.default()
      const legacyMm: MultimodalConfig = await StorageManager.loadMultimodalConfig(ctx).catch(
        (): MultimodalConfig => MultimodalConfig.default()
      )
      profiles = [ApiProfile.fromLegacy('默认配置', legacyApi ?? ApiConfig.default(), legacyMm)]
      await StorageManager.saveApiProfiles(ctx, profiles).catch(() => {
        // 迁移失败不阻断：本次仍按这份内存里的方案工作
      })
    }
    const saved: string = await StorageManager.loadString(
      ctx,
      Constants.LS_KEY_CURRENT_API_PROFILE_ID,
      ''
    ).catch((): string => '')
    let currentId: string = profiles.some((p) => p.id === saved) ? saved : profiles[0].id

    const seeded: string = await StorageManager.loadString(
      ctx,
      Constants.LS_KEY_API_PROFILES_SEEDED,
      ''
    ).catch((): string => '')
    if (seeded !== Constants.API_PROFILES_SEED_VERSION) {
      const result = ApiProfileSeeder.seed(profiles, currentId)
      profiles = result.profiles
      currentId = result.currentId
      await StorageManager.saveApiProfiles(ctx, profiles)
      // 播种可能把当前方案合并成了预置 Deepseek：运行时键必须跟着换，
      // 否则界面上选中了 Deepseek，发请求却还在用旧的协议/地址。
      const selected: ApiProfile | undefined = profiles.find((p) => p.id === currentId)
      if (selected !== undefined) {
        await StorageManager.saveApiConfig(ctx, selected.apiConfig)
        await StorageManager.saveMultimodalConfig(ctx, selected.multimodalConfig)
      }
      await StorageManager.saveString(
        ctx,
        Constants.LS_KEY_CURRENT_API_PROFILE_ID,
        currentId
      )
      await StorageManager.saveString(
        ctx,
        Constants.LS_KEY_API_PROFILES_SEEDED,
        Constants.API_PROFILES_SEED_VERSION
      )
    }
    return { profiles, currentId }
  }

  /** 当前生效的配置方案（id 对不上时退回第一份，保证永远有一个可用方案） */
  private async currentProfile(ctx: Context): Promise<ApiProfile> {
    const { profiles, currentId } = await this.readApiProfiles(ctx)
    return profiles.find((p) => p.id === currentId) ?? profiles[0]
  }

  /**
   * 让某个方案成为运行时生效的配置。
   *
   * 关键点：桌面端的聊天/工作轮次都是从**旧的两个键**（guncat_api_config / guncat_mm_config）
   * 读配置的（见 sendChat / runWork / regenerateChat），所以切换方案必须把方案内容写回那两个键，
   * 否则界面上切了、真正发请求时用的还是上一套。
   */
  private async applyProfile(ctx: Context, profile: ApiProfile): Promise<void> {
    await StorageManager.saveApiConfig(ctx, profile.apiConfig)
    await StorageManager.saveMultimodalConfig(ctx, profile.multimodalConfig)
    await StorageManager.saveString(ctx, Constants.LS_KEY_CURRENT_API_PROFILE_ID, profile.id)
  }

  /** 把运行时配置回写进当前方案（用户点「保存」时走这条） */
  private async writeBackToProfile(
    ctx: Context,
    apiDto: ApiConfigDto,
    mmDto: MultimodalConfigDto,
    name?: string
  ): Promise<void> {
    const { profiles, currentId } = await this.readApiProfiles(ctx)
    const index: number = profiles.findIndex((p) => p.id === currentId)
    if (index < 0) {
      return
    }
    const profile: ApiProfile = profiles[index]
    if (name !== undefined && name.trim() !== '') {
      profile.name = name.trim()
    }
    profile.apiConfig = SessionManager.fromApiConfigDto(apiDto)
    profile.multimodalConfig = SessionManager.fromMultimodalDto(mmDto)
    await StorageManager.saveApiProfiles(ctx, profiles)
  }

  async selectApiProfile(profileId: string): Promise<void> {
    const ctx: Context = this.ctx()
    const { profiles } = await this.readApiProfiles(ctx)
    const profile: ApiProfile | undefined = profiles.find((p) => p.id === profileId)
    if (profile === undefined) {
      return
    }
    await this.applyProfile(ctx, profile)
  }

  /**
   * 在某个配置方案里切换当前模型（一个服务商多个模型）。
   * 模型不在清单里时顺手补进去：用户从顶栏选中的模型不应该只存在于运行时键里，
   * 下次切走再切回来就找不到了。
   */
  async selectApiProfileModel(profileId: string, model: string): Promise<void> {
    const ctx: Context = this.ctx()
    const { profiles } = await this.readApiProfiles(ctx)
    const profile: ApiProfile | undefined = profiles.find((p) => p.id === profileId)
    if (profile === undefined) {
      return
    }
    const wanted: string = model.trim()
    if (wanted !== '') {
      profile.apiConfig.model = wanted
      profile.apiConfig.models = ApiConfig.normalizeModels(profile.apiConfig.models, wanted)
      await StorageManager.saveApiProfiles(ctx, profiles)
    }
    await this.applyProfile(ctx, profile)
  }

  /**
   * 新建一个配置方案。
   *
   * 与原版的一点差异（有意为之）：原版新建的是**空白配置**并立刻应用，
   * 用户若随后取消编辑，生效的配置就已经是空的了。桌面端改为**复制当前配置**再改名，
   * 这样任何时刻都有一套能用的配置，不会出现「加了个配置方案，聊天就发不出去了」。
   */
  async addApiProfile(): Promise<ApiProfileDto> {
    const ctx: Context = this.ctx()
    const { profiles, currentId } = await this.readApiProfiles(ctx)
    const current: ApiProfile | undefined = profiles.find((p) => p.id === currentId)
    const created: ApiProfile = ApiProfile.create(`新配置 ${profiles.length + 1}`)
    if (current !== undefined) {
      created.apiConfig = current.apiConfig
      created.multimodalConfig = current.multimodalConfig
    }
    profiles.push(created)
    await StorageManager.saveApiProfiles(ctx, profiles)
    await this.applyProfile(ctx, created)
    return SessionManager.toApiProfileDto(created)
  }

  async deleteApiProfile(profileId: string): Promise<void> {
    const ctx: Context = this.ctx()
    const { profiles, currentId } = await this.readApiProfiles(ctx)
    // 至少留一份：全删掉会让应用没有任何可用配置
    if (profiles.length <= 1) {
      return
    }
    const remaining: ApiProfile[] = profiles.filter((p) => p.id !== profileId)
    if (remaining.length === profiles.length) {
      return
    }
    await StorageManager.saveApiProfiles(ctx, remaining)
    if (profileId === currentId) {
      // 删掉的正是当前方案：切到剩下的第一份，并把它的内容写回运行时键
      await this.applyProfile(ctx, remaining[0])
    }
  }

  /** 一次性保存当前方案（名称 + API 配置 + 多模态配置）—— 设置面板的「保存」按钮 */
  async saveCurrentApiProfile(
    name: string,
    apiDto: ApiConfigDto,
    mmDto: MultimodalConfigDto
  ): Promise<void> {
    const ctx: Context = this.ctx()
    // 先跑一次读取：首次保存时预置方案的播种/合并会重写运行时键，
    // 排在保存之后就会把用户刚填的值盖回预置模板。
    await this.readApiProfiles(ctx)
    await StorageManager.saveApiConfig(ctx, SessionManager.fromApiConfigDto(apiDto))
    await StorageManager.saveMultimodalConfig(ctx, SessionManager.fromMultimodalDto(mmDto))
    await this.writeBackToProfile(ctx, apiDto, mmDto, name)
  }

  async saveApiConfig(dto: ApiConfigDto): Promise<void> {
    const ctx: Context = this.ctx()
    await this.readApiProfiles(ctx)
    await StorageManager.saveApiConfig(ctx, SessionManager.fromApiConfigDto(dto))
    // 同步回当前方案：不同步的话「保存」只改了运行时键，
    // 下次切走再切回来（或重启后按方案应用）就会退回到旧值
    const mm: MultimodalConfig = await StorageManager.loadMultimodalConfig(ctx).catch(
      (): MultimodalConfig => MultimodalConfig.default()
    )
    await this.writeBackToProfile(ctx, dto, SessionManager.toMultimodalDto(mm))
  }

  async saveApiProfiles(profiles: ApiProfileDto[]): Promise<void> {
    const models: ApiProfile[] = profiles.map((p) => {
      const profile: ApiProfile = new ApiProfile()
      profile.id = p.id
      profile.name = p.name
      profile.apiConfig = SessionManager.fromApiConfigDto(p.config)
      profile.multimodalConfig = SessionManager.fromMultimodalDto(p.multimodalConfig)
      return profile
    })
    await StorageManager.saveApiProfiles(this.ctx(), models)
  }

  async saveMultimodalConfig(dto: MultimodalConfigDto): Promise<void> {
    const ctx: Context = this.ctx()
    await this.readApiProfiles(ctx)
    await StorageManager.saveMultimodalConfig(ctx, SessionManager.fromMultimodalDto(dto))
    const api: ApiConfig | null = await StorageManager.loadApiConfig(ctx).catch(
      (): ApiConfig | null => null
    )
    await this.writeBackToProfile(
      ctx,
      SessionManager.toApiConfigDto(api ?? ApiConfig.default()),
      dto
    )
  }

  async saveFlag(key: string, value: boolean): Promise<void> {
    await StorageManager.saveBoolean(this.ctx(), key, value)
  }

  async saveString(key: string, value: string): Promise<void> {
    await StorageManager.saveString(this.ctx(), key, value)
  }

  /** 字符串型偏好：朗读音色/语速、语音转写配置等（鸿蒙侧存在 Preferences，桌面端同构） */
  private static readonly STRING_PREF_KEYS: string[] = [
    'reader_voice',
    'reader_rate',
    'reader_enabled',
    'asr_baseUrl',
    'asr_apiKey',
    'asr_model',
    // 本地联网搜索配置（整体 JSON）。原版由 SettingsPanel 编辑、ChatViewModel 落盘；
    // 桌面端此前既没读也没下发，LocalWebSearch.bind() 从来没有调用者 ——
    // 结果是「本地联网搜索」那套配置（引擎 / 各引擎 Key / maxResults）在桌面上形同不存在。
    Constants.LS_KEY_LOCAL_SEARCH_CONFIG,
    // 推理强度（按形态分两个键，与原版一致）。渲染层的档位选择器读写它们。
    Constants.LS_KEY_REASONING_EFFORT,
    Constants.LS_KEY_INTERACTIVE_EFFORT,
    // 表格提取记住的模型选择（原版 TableOcrPage 的 LS_KEY_TABLE_OCR_PROVIDER）
    Constants.LS_KEY_TABLE_OCR_PROVIDER,
    // 深度思考 / 联网搜索开关：渲染层的开关直接落盘，重启后要能读回来。
    // 此前这两个开关只存在于内存里，重启就回到缺省 —— 而原版的缺省是「联网搜索开」。
    Constants.LS_KEY_THINKING_ENABLED,
    Constants.LS_KEY_WEB_SEARCH_ENABLED,
    // 当前智能体 / 当前会话：原版每次切换都会落盘（其他路径只读不依赖，但存档不该停在过期的对象上）
    Constants.LS_KEY_CURRENT_AGENT_ID,
    Constants.LS_KEY_CURRENT_CONV_ID
  ]

  private async loadStringPrefs(): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const key of SessionManager.STRING_PREF_KEYS) {
      try {
        const value: string = await StorageManager.loadString(this.ctx(), key, '')
        if (value !== '') {
          out[key] = value
        }
      } catch {
        // 单个偏好读取失败不影响其它设置
      }
    }
    return out
  }

  /**
   * 读持久化的本地联网搜索配置并绑定给工具层。
   * 读取失败（首次运行 / JSON 坏了）时绑定默认配置而不是不绑 —— 不绑会让工具停在
   * 「进程启动时的默认值」上，行为随调用顺序变化，比明确用默认值更难排查。
   */
  private async bindLocalSearchConfig(ctx: Context): Promise<void> {
    let settings: SearchEngineSettings = new SearchEngineSettings()
    try {
      const json: string = await StorageManager.loadString(
        ctx,
        Constants.LS_KEY_LOCAL_SEARCH_CONFIG,
        ''
      )
      settings = SearchEngineSettings.parse(json)
    } catch {
      // 用默认配置
    }
    LocalWebSearch.bind(settings)
  }

  /** 保存本地联网搜索配置（同时立即生效，不必重启） */
  async saveLocalSearchConfig(json: string): Promise<void> {
    await StorageManager.saveString(
      this.ctx(),
      Constants.LS_KEY_LOCAL_SEARCH_CONFIG,
      json
    )
    LocalWebSearch.bind(SearchEngineSettings.parse(json))
  }

  // ===== 对话 =====

  listConversations(): ConversationSummaryDto[] {
    return this.conversations
      .map((c) => SessionManager.toSummary(c))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getConversation(id: string): ConversationDto | null {
    const conv: Conversation | undefined = this.find(id)
    return conv === undefined ? null : SessionManager.toDto(conv)
  }

  private find(id: string): Conversation | undefined {
    return this.conversations.find((c) => c.id === id)
  }

  private mustFind(id: string): Conversation {
    const conv: Conversation | undefined = this.find(id)
    if (conv === undefined) {
      throw new Error(`会话不存在: ${id}`)
    }
    return conv
  }

  async createConversation(agentId: string, mode: string): Promise<ConversationDto> {
    // 标题留空 —— 对齐鸿蒙原版 ChatViewModel.startNewConversation：
    //   Conversation.create(this.currentAgent.id, '', mode)
    // 标题由「第一条用户消息」推导（见 sendChat / runWork 里的 deriveTitle），
    // 侧栏在标题为空时回退显示「与 X 的对话」。
    //
    // 历史事故：这里原先传的是 agent.name，而标题推导的守卫只认 ''/'新对话'，
    // 于是引擎名被当成标题焊死在会话上 —— 用户看到的正是「每一条会话都叫轻简模式」。
    //
    // 形态与智能体必须自洽：两个虚拟智能体（work / interactive）的 id **就是**形态，
    // 它们的系统提示词由主进程按 mode 现拼（虚拟智能体自己没有 prompt）。
    // 一旦渲染层传来矛盾组合（例如 agentId='interactive' + mode='chat'），会话会被建坏：
    // 界面走聊天分支、请求走 chat:send、而聊天路径取的是智能体自己的 prompt（空）——
    // 用户看到的就是「没有提示词、纯对话」。这里以 agentId 为准兜一道，坏数据进不来。
    const normalizedMode: string =
      agentId === Constants.MODE_WORK
        ? Constants.MODE_WORK
        : agentId === Constants.MODE_INTERACTIVE
          ? Constants.MODE_INTERACTIVE
          : mode
    const conv: Conversation = Conversation.create(agentId, '', normalizedMode)
    this.conversations.push(conv)
    await this.persist()
    const dto: ConversationDto = SessionManager.toDto(conv)
    this.emit({ type: 'conversation:created', conversation: dto })
    return dto
  }

  async deleteConversation(id: string): Promise<void> {
    const index: number = this.conversations.findIndex((c) => c.id === id)
    if (index < 0) {
      return
    }
    this.conversations.splice(index, 1)
    // 会话没了，它拉起的后台命令也没有归属了 —— 连同进程树一起收掉，
    // 审批档位与「本次任务全部允许」的授权也一并清掉（id 不会复用，但别把注册表留成垃圾）。
    CommandService.releaseConversation(id)
    ApprovalReviewService.release(id)
    try {
      WorkFileService.deleteWorkspace(this.ctx(), id)
    } catch {
      // 工作区清理失败不阻塞会话删除
    }
    await this.persist()
    this.emit({ type: 'conversation:deleted', conversationId: id })
  }

  async renameConversation(id: string, title: string): Promise<void> {
    const conv: Conversation = this.mustFind(id)
    conv.title = title
    await this.persist()
    this.emit({ type: 'conversation:title', conversationId: id, title })
  }

  /**
   * 交互模式：把界面控件的绑定值（状态尾标记）写回消息正文并落盘。
   * 只更新 content/displayContent，不触发模型请求。
   */
  async patchMessageContent(conversationId: string, messageId: string, content: string): Promise<void> {
    const conv: Conversation | undefined = this.find(conversationId)
    if (conv === undefined) {
      return
    }
    const msg: Message | undefined = conv.messages.find((m) => m.id === messageId)
    if (msg === undefined) {
      return
    }
    msg.content = content
    msg.displayContent = content
    await this.persist()
    this.patchMessage(conversationId, messageId, { content, displayContent: content })
  }

  private async persist(): Promise<void> {
    try {
      await StorageManager.saveConversations(this.ctx(), this.conversations)
    } catch (e) {
      this.emit({ type: 'notice', level: 'warn', text: `对话保存失败: ${String(e)}` })
    }
  }

  // ===== 运行态控制 =====

  private handle(conversationId: string): RunHandle {
    let handle: RunHandle | undefined = this.runs.get(conversationId)
    if (handle === undefined) {
      handle = new RunHandle()
      this.runs.set(conversationId, handle)
    }
    return handle
  }

  isBusy(conversationId: string): boolean {
    return this.handle(conversationId).busy
  }

  abort(conversationId: string): void {
    const handle: RunHandle = this.handle(conversationId)
    handle.abort.aborted = true
    // 两个服务各自持有活跃请求注册表，都要中断
    ChatService.abort()
    AgentLoopService.abort()
    // 挂起中的 ask_user_question 立即落定(以取消收场)。
    //
    // 这一步不能省：工具此刻正 await 在 AskUserBridge 里，只看 abort 标志它是不会
    // 自己醒过来的 —— 用户点了「停止」，工具却还挂在那儿等一个永远不会来的答案，
    // 轮次就永远结束不了（原版 stopStreaming 里同样是先 cancelAll 再收尾）。
    AskUserBridge.cancelAll()
  }

  // ===== 插话（工作模式执行中补充要求） =====
  //
  // 审计发现：原版流式时输入区同时给「发送(插话)」与「停止」两个按钮，
  // 插话走 workSteerQueue、在**下一轮开始前**注入；桌面端全库 `steer` 零命中，
  // 提交时 `if (running) return`，长任务跑到一半想补充要求只能中止重来。
  //
  // 实现上不做「打断当前请求」——原版也不打断：文本进队列，本轮工具跑完、
  // 下一轮开始前作为一条 user 消息并入 messages，模型自然就看到新要求了。

  private steerQueue: Map<string, string[]> = new Map()

  /**
   * 插话。返回是否被接受 —— 不在跑的时候返回 false，
   * 调用方应当改走普通发送（否则文本会挂在队列里等下一次任务）。
   */
  steerWork(conversationId: string, text: string): boolean {
    const conv: Conversation | undefined = this.find(conversationId)
    if (conv === undefined || !this.handle(conversationId).busy) {
      return false
    }
    const trimmed: string = text.trim()
    if (trimmed === '') {
      return false
    }
    const queue: string[] = this.steerQueue.get(conversationId) ?? []
    queue.push(trimmed)
    this.steerQueue.set(conversationId, queue)

    // 立刻落到会话里，让用户看得见「已经说进去了」（模型在下一轮读到同一段文本）
    const userMsg: Message = Message.ofUser(generateMessageId(), trimmed, trimmed, [])
    conv.messages.push(userMsg)
    this.emit({
      type: 'message:added',
      conversationId,
      message: SessionManager.toMessageDto(userMsg)
    })
    this.emit({ type: 'notice', level: 'info', text: '已插话，将在下一轮生效' })
    return true
  }

  /** 取出并清空插话队列（每轮开始前调用） */
  private drainSteer(conversationId: string): string[] {
    const queue: string[] = this.steerQueue.get(conversationId) ?? []
    if (queue.length > 0) {
      this.steerQueue.delete(conversationId)
    }
    return queue
  }

  // ===== 任务统计与当前目标（原版 DetailsPanelView 的统计卡 + 目标卡） =====

  /** 每个会话最近一次任务的计时/速度/命中/轮数 */
  private runStats: Map<
    string,
    { startedAt: number; finishedAt: number; rounds: number; speeds: number[]; hits: number[] }
  > = new Map()

  private beginRunStats(conversationId: string): void {
    this.runStats.set(conversationId, {
      startedAt: Date.now(),
      finishedAt: 0,
      rounds: 0,
      speeds: [],
      hits: []
    })
  }

  private recordRunRound(conversationId: string, speed: number, hit: number): void {
    const stats = this.runStats.get(conversationId)
    if (stats === undefined) {
      return
    }
    stats.rounds++
    if (speed > 0) {
      stats.speeds.push(speed)
    }
    if (hit >= 0) {
      stats.hits.push(hit)
    }
  }

  private finishRunStats(conversationId: string): void {
    const stats = this.runStats.get(conversationId)
    if (stats !== undefined && stats.finishedAt === 0) {
      stats.finishedAt = Date.now()
    }
  }

  /**
   * 会话的任务统计 + 当前目标。
   * 长度/速度/命中取最近一次任务的平均值（原版统计卡的口径）；
   * 目标是工作区里的 `.goal.json`，模型用 create_goal 建的。
   */
  conversationStats(conversationId: string): ConversationStatsDto {
    const stats = this.runStats.get(conversationId)
    const average = (values: number[]): number =>
      values.length === 0 ? -1 : values.reduce((a, b) => a + b, 0) / values.length
    const goal = GoalService.read(this.workspaceRoot(conversationId))
    return {
      elapsedMs:
        stats === undefined || stats.finishedAt === 0 ? 0 : stats.finishedAt - stats.startedAt,
      speed: stats === undefined ? -1 : average(stats.speeds),
      cacheHit: stats === undefined ? -1 : average(stats.hits),
      rounds: stats === undefined ? 0 : stats.rounds,
      goal:
        goal === null
          ? null
          : {
              objective: goal.objective,
              status: goal.status,
              rounds: goal.rounds,
              maxRounds: goal.maxRounds
            }
    }
  }

  // ===== 定时提醒推进 =====
  //
  // 审计发现：ScheduleService.tick 在桌面端**零调用点** ——
  // 模型调 schedule_create 会成功返回、并对用户说「5 分钟后提醒你」，到点什么都不发生。
  // 这是最糟的一类问题：不是功能缺失，而是**静默失效**，用户只会认为应用失灵。
  //
  // 原版由 ChatPage 的 1 秒定时器调 tickSchedules()，到期把「【定时提醒】…」注入为
  // 一条用户消息并启动工作循环。桌面端把这件事放在主进程（会话与循环都在这里）。

  private scheduleTimer: ReturnType<typeof setInterval> | null = null

  /** 启动每秒推进。重复调用无副作用。 */
  startScheduleTicker(): void {
    if (this.scheduleTimer !== null) {
      return
    }
    this.scheduleTimer = setInterval(() => {
      this.tickSchedules()
    }, 1000)
    // 不因为这个定时器把进程吊住（关窗后仍能正常退出）
    this.scheduleTimer.unref?.()
  }

  stopScheduleTicker(): void {
    if (this.scheduleTimer !== null) {
      clearInterval(this.scheduleTimer)
      this.scheduleTimer = null
    }
  }

  /**
   * 推进所有工作/交互形态会话的提醒。
   *
   * 与原版的一处差异（有意为之）：原版只看**当前**会话，切走了提醒就不会响；
   * 桌面端逐会话推进 —— 提醒存在各自的工作区里，用户切到别的会话期间到期的提醒同样该响。
   * 会话正在跑时不推进（原版是塞进插话队列；插话通道还没移植，这里改成「这一拍跳过」，
   * 提醒不会丢：ScheduleService.tick 只在真的触发时才推进到期时间）。
   */
  private tickSchedules(): void {
    for (const conv of this.conversations) {
      if (conv.mode !== 'work' && conv.mode !== 'interactive') {
        continue
      }
      if (this.handle(conv.id).busy) {
        continue
      }
      try {
        ScheduleService.tick(this.workspaceRoot(conv.id), (message: string): void => {
          void this.fireSchedule(conv.id, message)
        })
      } catch {
        // 单个会话的提醒文件坏了不影响其它会话
      }
    }
  }

  /** 提醒到期：注入一条用户消息，并在没在跑时自动唤醒工作循环（对齐原版 tickSchedules） */
  private async fireSchedule(conversationId: string, message: string): Promise<void> {
    const conv: Conversation | undefined = this.find(conversationId)
    if (conv === undefined) {
      return
    }
    const text: string = `【定时提醒】${message}`
    const userMsg: Message = Message.ofUser(generateMessageId(), text, text, [])
    conv.messages.push(userMsg)
    this.emit({
      type: 'message:added',
      conversationId,
      message: SessionManager.toMessageDto(userMsg)
    })
    this.emit({ type: 'notice', level: 'info', text: `定时提醒已触发：${message}` })
    await this.persist()

    const config: ApiConfig | null = await StorageManager.loadApiConfig(this.ctx()).catch(
      (): ApiConfig | null => null
    )
    if (config === null || config.apiKey === '' || config.model === '') {
      // 没配置就没法自动继续；消息已经落进会话，用户打开就能看到
      this.emit({
        type: 'notice',
        level: 'warn',
        text: '定时提醒已触发，但还没配置 API，无法自动继续'
      })
      return
    }
    const thinkingEnabled: boolean = await StorageManager.loadBoolean(
      this.ctx(),
      Constants.LS_KEY_THINKING_ENABLED,
      false
    ).catch((): boolean => false)
    try {
      await this.runWork({
        conversationId,
        text,
        mode: conv.mode as 'work' | 'interactive',
        thinkingEnabled,
        webSearchEnabled: false
      })
    } catch (e: unknown) {
      // runWork 自己会把失败通过 turn:finished 报出去；这里只保证定时器不因此中断
      this.emit({
        type: 'notice',
        level: 'error',
        text: `定时提醒唤醒失败：${e instanceof Error ? e.message : String(e)}`
      })
    }
  }

  // ===== 聊天模式 =====

  async sendChat(request: ChatSendRequest): Promise<void> {
    const conv: Conversation = this.mustFind(request.conversationId)
    const handle: RunHandle = this.handle(conv.id)
    if (handle.busy) {
      this.emit({ type: 'notice', level: 'warn', text: '当前会话正在生成中，请先停止' })
      return
    }

    const config: ApiConfig | null = await StorageManager.loadApiConfig(this.ctx()).catch(
      (): ApiConfig | null => null
    )
    if (config === null || config.apiKey === '' || config.model === '') {
      this.emit({ type: 'notice', level: 'error', text: '请先在设置里配置 API Key 与模型' })
      return
    }
    // OpenCode Go 要求按对话稳定的 x-opencode-session；同一会话的所有请求（含自动审查）共用它
    config.sessionId = LLMProtocol.conversationSessionId(conv.id)

    const attachments: Attachment[] = await this.makeAttachments(request.attachmentPaths ?? [])
    const userMsg: Message = Message.ofUser(
      generateMessageId(),
      request.text,
      request.text,
      attachments
    )
    conv.messages.push(userMsg)
    this.emit({ type: 'message:added', conversationId: conv.id, message: SessionManager.toMessageDto(userMsg) })

    const agent: Agent | undefined = this.agents.find((a) => a.id === conv.agentId)
    // 首条用户消息用它作为会话标题
    if (SessionManager.needsDerivedTitle(conv.title, agent !== undefined ? agent.name : '')) {
      const title: string = SessionManager.deriveTitle(request.text)
      if (title !== '' && title !== conv.title) {
        conv.title = title
        this.emit({ type: 'conversation:title', conversationId: conv.id, title })
      }
    }

    await this.runChatTurn(
      conv,
      config,
      agent,
      request.text,
      request.thinkingEnabled,
      request.webSearchEnabled
    )
  }

  /**
   * 重新生成：丢掉最后一条用户消息之后的所有 assistant 消息，再用同一个问题重跑。
   * 与「重发」不同 —— 失败的/被中止的那次输出就地消失，不会在它下面再叠一条。
   */
  async regenerateChat(request: ChatRegenerateRequest): Promise<void> {
    const conv: Conversation = this.mustFind(request.conversationId)
    const handle: RunHandle = this.handle(conv.id)
    if (handle.busy) {
      this.emit({ type: 'notice', level: 'warn', text: '当前会话正在生成中，请先停止' })
      return
    }

    const config: ApiConfig | null = await StorageManager.loadApiConfig(this.ctx()).catch(
      (): ApiConfig | null => null
    )
    if (config === null || config.apiKey === '' || config.model === '') {
      this.emit({ type: 'notice', level: 'error', text: '请先在设置里配置 API Key 与模型' })
      return
    }
    config.sessionId = LLMProtocol.conversationSessionId(conv.id)

    let lastUserIndex: number = -1
    for (let i: number = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') {
        lastUserIndex = i
        break
      }
    }
    if (lastUserIndex < 0) {
      this.emit({ type: 'notice', level: 'warn', text: '这条会话还没有可重新生成的问题' })
      return
    }
    const prompt: string = conv.messages[lastUserIndex].content
    conv.messages = conv.messages.slice(0, lastUserIndex + 1)
    await this.persist()
    // 整份会话同步给渲染进程：增量事件表达不了「消息被删掉」这件事
    this.emit({ type: 'conversation:sync', conversation: SessionManager.toDto(conv) })

    const agent: Agent | undefined = this.agents.find((a) => a.id === conv.agentId)
    await this.runChatTurn(
      conv,
      config,
      agent,
      prompt,
      request.thinkingEnabled,
      request.webSearchEnabled
    )
  }

  /**
   * 执行聊天模式的流式输出（sendChat / regenerateChat 共用）。
   *
   * 这是**多轮**的（移植原版 ChatViewModel.runChatStream 3196-3332）：
   * 模型可以在回答里调用本机工具 —— local_web_search / search_web（本机直连搜索引擎）
   * 与 web_fetch（抓网页）都在本机执行，结果回灌后**继续下一轮**，
   * 直到模型给出不带新工具调用的最终回答。
   *
   * 为什么必须多轮：单轮时工具调用就只是「模型说了一句它想搜索」，谁也执行不了它 ——
   * 用户看到的是一条只有调用请求、没有任何内容的回答，而且模型永远拿不到结果。
   *
   * 「问一句答一句」的既有行为不受影响：本轮没有工具调用时循环立刻结束（只跑一轮），
   * 附件、tokenSpeed/cacheHitRate、turn:finished 状态语义都与改动前一致。
   */
  private async runChatTurn(
    conv: Conversation,
    config: ApiConfig,
    agent: Agent | undefined,
    prompt: string,
    thinkingEnabled: boolean,
    webSearchEnabled: boolean
  ): Promise<void> {
    const handle: RunHandle = this.handle(conv.id)
    const assistantMsg: Message = Message.ofAssistant(generateMessageId(), '')
    conv.messages.push(assistantMsg)
    this.emit({
      type: 'message:added',
      conversationId: conv.id,
      message: SessionManager.toMessageDto(assistantMsg)
    })
    this.emit({ type: 'turn:started', conversationId: conv.id, messageId: assistantMsg.id })

    const history: Message[] = conv.messages.slice(0, -1)
    handle.busy = true
    handle.abort = new AbortSignal()

    const callbacks: StreamCallbacks = new StreamCallbacks()
    // 正文跨轮累积（原版 assistantMsg.content += delta 的同一口径）：
    // 每轮的增量接在上一轮之后，工具标注插在中间，用户看到的是一条完整回答
    let streamed: string = ''
    callbacks.onToken = (text: string): void => {
      streamed += text
      this.patchMessage(conv.id, assistantMsg.id, { content: streamed, displayContent: streamed })
    }
    callbacks.onReasoning = (text: string): void => {
      this.patchMessage(conv.id, assistantMsg.id, { reasoning: text })
    }
    callbacks.onUsage = (speed: number, hit: number): void => {
      this.patchMessage(conv.id, assistantMsg.id, { tokenSpeed: speed, cacheHitRate: hit })
    }
    // 请求失败必须落到消息与状态里（原版 handleStreamError 3394-3408）。
    // 不接这个回调的后果很具体：`ChatService.streamChat` 是**吞掉异常**再回调的，
    // 所以聊天模式一旦网络/鉴权失败，用户看到的是一条**空白回答**、
    // `turn:finished` 还报 'ok'，连失败原因都没有 —— 看上去像「模型不想说话」。
    callbacks.onError = (text: string): void => {
      failure = text === '' ? '请求失败' : text
      this.patchMessage(conv.id, assistantMsg.id, {
        content: streamed === '' ? `⚠️ ${failure}` : `${streamed}\n\n⚠️ ${failure}`,
        displayContent: streamed === '' ? `⚠️ ${failure}` : `${streamed}\n\n⚠️ ${failure}`
      })
    }

    // 本轮请求要带的历史与「新用户文本」：
    //   首轮 = 既有历史 + 本次提问（与改动前完全一致）；
    //   续轮 = 整份 conv.messages（含带工具结果的 assistant 消息）+ 空文本
    //         —— 对齐原版 currentHistory = conv.messages / currentUserText = ''。
    // 端口的历史是 Message[] 而不是 LoopMessage：工具结果由 ChatService 按
    // Message.toolCalls 生成 role:'tool' 消息回灌（见 ChatService.buildXxxBody），
    // 所以这里不需要另建一份 LoopMessage 历史。
    let currentHistory: Message[] = history
    let currentPrompt: string = prompt
    let round: number = 0

    let failure: string = ''
    try {
      // 多轮循环：只有「本轮产生了新的工具调用」才会进入下一轮
      while (true) {
        round++
        const result = await ChatService.streamChat(
          config,
          agent ?? null,
          currentHistory,
          currentPrompt,
          thinkingEnabled,
          webSearchEnabled,
          callbacks,
          handle.abort
        )
        // Anthropic 思考模式下，带 tool_use 的 assistant 消息回传下一轮时必须带思考块签名
        // （不持久化，仅本次运行内存内有效 —— 见 Message.thinkingSignature 的说明）
        assistantMsg.thinkingSignature = result.thinkingSignature

        // 中断：与改动前一致，不再继续（收尾由下面的 finally 统一处理）
        if (handle.abort.aborted) {
          break
        }

        // 退出判据只看**本轮**新产生的调用：assistantMsg.toolCalls 是跨轮累计的
        // （旧调用要保留下来供回灌与展示），若拿它判断，模型给出最终回答的那一轮
        // 也永远满足「有工具调用」，循环就再也退不出去了。
        const roundCalls: ToolCallRecord[] = result.toolCalls
        if (roundCalls.length === 0) {
          break
        }
        // 防失控保险：轮次达到上限时停止继续搜索（原版的提示语与位置都不变 ——
        // 这一轮的调用**不再执行**，因为超过上限本身就意味着该收手了）
        if (round >= Constants.CHAT_SEARCH_MAX_ROUNDS) {
          streamed +=
            '\n\n 已连续搜索 ' +
            Constants.CHAT_SEARCH_MAX_ROUNDS.toString() +
            ' 轮(防失控保险), 停止继续搜索。'
          break
        }

        // 累计进本条 assistant 消息：下一轮请求要把**所有轮**的调用与结果一起回灌，
        // 只留本轮调用会让上一轮的 tool 结果失去归属（协议校验失败）
        for (const call of roundCalls) {
          assistantMsg.toolCalls.push(call)
        }
        // 工具调用先行落到时间线上（执行前后各推一次，UI 显示「等待中… → 执行中…」）
        for (const call of roundCalls) {
          this.emit({
            type: 'tool:started',
            conversationId: conv.id,
            messageId: assistantMsg.id,
            call: SessionManager.toToolDto(call)
          })
        }

        // 串行执行本轮的本地调用（与工作模式一致：同一轮的调用按序执行，结果回填到同一批记录）
        for (const call of roundCalls) {
          if (handle.abort.aborted) {
            break
          }
          // 模型参数已经生成完，进入执行态；本轮已执行过的（result 非空）直接跳过
          call.preparing = false
          if (call.result !== '') {
            continue
          }
          call.started = true
          this.emit({
            type: 'tool:started',
            conversationId: conv.id,
            messageId: assistantMsg.id,
            call: SessionManager.toToolDto(call)
          })
          // 真实计时：工具行右端要显示耗时（原版与工作模式同口径）
          const execStart: number = Date.now()
          // 新旧工具名都认（isLocalSearchToolName 覆盖 search_web 这个旧名）：
          // 历史消息里模型自己写过的旧名调用仍要能执行，否则会被判成未知工具
          if (isLocalSearchToolName(call.name)) {
            const query: string = parseSearchQuery(call.argsJson)
            const outcome: LocalSearchOutcome = await ToolExecutionGuard.run(
              LocalWebSearch.searchWeb(query, handle.abort),
              Constants.WORK_TOOL_TIMEOUT_MS,
              handle.abort,
              (): LocalSearchOutcome =>
                SessionManager.searchOutcomeWithError('本机搜索执行超时', true, false),
              (): LocalSearchOutcome =>
                SessionManager.searchOutcomeWithError('本机搜索已取消', false, true)
            )
            call.durationMs = Date.now() - execStart
            call.timeout = outcome.timeout
            call.cancelled = outcome.cancelled
            if (outcome.ok) {
              call.isError = false
              call.result = outcome.contentForAI
              streamed +=
                '\n\n 进行了一次本机联网搜索(' + outcome.engineLabel + ')：' + query + '\n'
            } else {
              call.isError = true
              call.result = '搜索失败: ' + outcome.errorMessage
              streamed += '\n\n 本机联网搜索失败：' + outcome.errorMessage + '\n'
            }
          } else if (call.name === WEB_FETCH_TOOL_NAME) {
            const args: Record<string, Object> = parseArgsObject(call.argsJson)
            const url: string = readArgString(args, 'url')
            const fetchResult: ToolExecResult = await ToolExecutionGuard.run(
              HarnessTools.toolWebFetch(args),
              Constants.WORK_TOOL_TIMEOUT_MS,
              handle.abort,
              (): ToolExecResult => SessionManager.toolResultError('web_fetch 执行超时', true, false),
              (): ToolExecResult => SessionManager.toolResultError('web_fetch 执行已取消', false, true)
            )
            call.durationMs = Date.now() - execStart
            call.timeout = fetchResult.timeout
            call.cancelled = fetchResult.cancelled
            call.isError = !fetchResult.ok
            call.result = fetchResult.output
            // 成功与失败都要在正文里可见：用户得知道模型到底去读了哪个网页
            streamed += fetchResult.ok
              ? '\n\n 读取了一次网页：' + (url === '' ? '(未提供 url)' : url) + '\n'
              : '\n\n 读取网页失败：' + (url === '' ? '(未提供 url)' : url) + '\n'
          } else {
            // 未知工具回填一条**错误结果**送回模型让它自己纠正（原版行为）。
            // 静默丢弃会让模型以为自己没调用过，下一轮还会原样再调一次。
            call.durationMs = 0
            call.isError = true
            call.result =
              '未知工具: ' +
              call.name +
              '(聊天模式仅支持 ' +
              LOCAL_SEARCH_TOOL_NAME +
              ' / ' +
              WEB_FETCH_TOOL_NAME +
              ')'
          }
          this.emit({
            type: 'tool:finished',
            conversationId: conv.id,
            messageId: assistantMsg.id,
            call: SessionManager.toToolDto(call)
          })
        }

        // 正文里插入了工具标注，先把当前正文同步给界面（下一轮的 token 会接着往后追加）
        this.patchMessage(conv.id, assistantMsg.id, {
          content: streamed,
          displayContent: streamed
        })
        await this.persist()

        // 下一轮：历史包含带工具结果的 assistant 消息（conv.messages 末条），不追加用户消息
        currentHistory = conv.messages
        currentPrompt = ''
      }
    } catch (e) {
      failure = (e as Error)?.message ?? String(e)
    } finally {
      handle.busy = false
      // 收尾时把失败原因落到正文里（`onError` 已经即时刷过一次，但那一次可能被
      // 后续的流式增量覆盖掉，这里以最终态再钉一遍）。正文为空就直接写这句，
      // 否则空一行再接 —— 与原版 handleStreamError 的两分支一致。
      if (failure !== '') {
        const text: string = streamed === '' ? `⚠️ ${failure}` : `${streamed}\n\n⚠️ ${failure}`
        assistantMsg.content = text
        assistantMsg.displayContent = text
      } else {
        assistantMsg.content = streamed
        assistantMsg.displayContent = streamed
      }
      await this.persist()
      if (handle.abort.aborted) {
        this.emit({ type: 'turn:finished', conversationId: conv.id, messageId: assistantMsg.id, status: 'aborted' })
      } else if (failure !== '') {
        this.emit({
          type: 'turn:finished',
          conversationId: conv.id,
          messageId: assistantMsg.id,
          status: 'error',
          error: failure
        })
      } else {
        this.emit({ type: 'turn:finished', conversationId: conv.id, messageId: assistantMsg.id, status: 'ok' })
        // 首轮交付后用 LLM 生成会话标题（原版 maybeGenerateTitle 的触发条件：
        // 最终答复非空且本轮没有被中止）。失败静默，不阻塞任何东西。
        if (streamed !== '') {
          this.maybeGenerateTitle(conv, SessionManager.lastUserText(conv), streamed)
        }
      }
    }
  }

  /**
   * 本机联网搜索的「超时/取消」兜底结果（与 LocalSearchOutcome 的成功路径同一形状）。
   * 护栏不抛异常、只回落一个 ok=false 的结果，调用方按统一的失败分支处理即可。
   */
  private static searchOutcomeWithError(
    message: string,
    timeout: boolean = false,
    cancelled: boolean = false
  ): LocalSearchOutcome {
    const outcome: LocalSearchOutcome = new LocalSearchOutcome()
    outcome.ok = false
    outcome.errorMessage = message
    outcome.timeout = timeout
    outcome.cancelled = cancelled
    return outcome
  }

  /** 工具执行的超时/取消兜底结果（web_fetch 等：ok=false，output 为可读错误） */
  private static toolResultError(
    message: string,
    timeout: boolean = false,
    cancelled: boolean = false
  ): ToolExecResult {
    const result: ToolExecResult = new ToolExecResult()
    result.ok = false
    result.output = 'ERROR: ' + message
    result.timeout = timeout
    result.cancelled = cancelled
    return result
  }

  /**
   * 交互模式：最后一条 assistant 消息里的界面是否需要重做一次
   * （移植原版 ChatViewModel.needsUiContinuation 1501-1513）。
   *
   * 只看最后一条 assistant 消息，是因为「这一轮的交付物」就是它；
   * 判据用 GuncatUiParts.needsRepair —— 只有**含有界面意图**（围栏或看起来像程序）
   * 却解析不出任何根节点时才为真。
   */
  private static needsUiContinuation(conv: Conversation, mode: string): boolean {
    // 只有交互模式的交付物是界面程序；工作/聊天模式没有「界面没成形」这回事
    if (mode !== Constants.MODE_INTERACTIVE) {
      return false
    }
    for (let i: number = conv.messages.length - 1; i >= 0; i--) {
      const msg: Message = conv.messages[i]
      if (msg.role !== 'assistant') {
        continue
      }
      return GuncatUiParts.needsRepair(msg.content)
    }
    return false
  }

  // ===== 工作模式 / 交互模式：Agent Loop =====

  async runWork(request: WorkRunRequest): Promise<void> {
    const conv: Conversation = this.mustFind(request.conversationId)
    const handle: RunHandle = this.handle(conv.id)
    if (handle.busy) {
      this.emit({ type: 'notice', level: 'warn', text: '当前会话正在执行中，请先停止' })
      return
    }

    const config: ApiConfig | null = await StorageManager.loadApiConfig(this.ctx()).catch(
      (): ApiConfig | null => null
    )
    if (config === null || config.apiKey === '' || config.model === '') {
      this.emit({ type: 'notice', level: 'error', text: '请先在设置里配置 API Key 与模型' })
      return
    }
    config.sessionId = LLMProtocol.conversationSessionId(conv.id)

    const ctx: Context = this.ctx()
    WorkFileService.ensureWorkspace(ctx, conv.id)
    // 每轮新任务都收回上一次的「本次任务全部允许」：它的字面范围就是本次任务，
    // 跨过一轮还有效等于用户在自己的会话里永久签了张空白授权。
    CommandService.clearGrant(conv.id)

    // 子代理工具通过钩子执行；这里注入当前配置，让 subagent 能独立发起请求
    SubagentService.bind(
      config,
      request.thinkingEnabled,
      SessionManager.resolveEffort(request),
      (context: never, convId: string, name: string, argsJson: string, abortSignal?: never) =>
        WorkToolRunner.execute(context, convId, name, argsJson, abortSignal ?? null)
    )

    const userMsg: Message = Message.ofUser(generateMessageId(), request.text, request.text, [])
    conv.messages.push(userMsg)
    this.emit({ type: 'message:added', conversationId: conv.id, message: SessionManager.toMessageDto(userMsg) })
    const agent: Agent | undefined = this.agents.find((a) => a.id === conv.agentId)
    if (SessionManager.needsDerivedTitle(conv.title, agent !== undefined ? agent.name : '')) {
      const title: string = SessionManager.deriveTitle(request.text)
      if (title !== '' && title !== conv.title) {
        conv.title = title
        this.emit({ type: 'conversation:title', conversationId: conv.id, title })
      }
    }

    // 循环消息：系统提示词固定在第 0 条
    // 交互模式的状态回传：把上一轮界面里用户调过的绑定值翻译成一句人话附在任务后，
    // 模型才知道界面当前处于什么状态（对齐上游 GuncatUiRuntime.describeStateForModel）。
    const uiContext: string = this.describeUiState(conv)
    const taskText: string = uiContext === '' ? request.text : `${request.text}\n${uiContext}`

    // 循环消息：系统提示词固定在第 0 条，随后是**本会话此前几轮的往来**，最后才是本轮任务。
    // 少了中间那一段，第二轮开始模型就是彻底失忆的（真实事故：用户问「我上面发了什么」，
    // 它回答「没有历史消息」）—— 上一轮的用户原话与回答正文都必须重放进去。
    // 上面已经 push 了本轮的 user 消息，所以历史取到倒数第二条为止。
    const prior: Message[] = conv.messages.slice(0, conv.messages.length - 1)

    const messages: LoopMessage[] = [
      LoopMessage.system(AgentLoopService.buildWorkSystemPromptFor(request.mode)),
      ...AgentLoopService.historyMessages(prior),
      LoopMessage.user(this.expandMentions(conv.id, taskText))
    ]

    // 'auto' 档的模型审阅器：绑当前配置 + 一个「用户原话」的活引用（含任务中途的插话）。
    // 只取 role==='user' 且不带图片的消息 —— 智能体自己的正文、思考与工具结果一律不进审阅上下文，
    // 否则它可以在请求命令之前先写一句「用户已授权」把审阅器说服，审批就退化成自我批准。
    // 没有绑定 = 没有审阅器，危险命令直接走人工卡（fail-closed）。
    ApprovalReviewService.bind(conv.id, config, (): string[] =>
      messages
        .filter((m: LoopMessage): boolean => m.role === 'user' && m.imageDataUrl === '' && m.content !== '')
        .map((m: LoopMessage): string => m.content)
    )

    const mode: string = request.mode === 'interactive' ? 'interactive' : 'work'
    const reasoningEffort: string = SessionManager.resolveEffort(request)
    const maxSteps: number = Constants.WORK_MAX_STEPS

    // 上下文预算的 usage 锚定值（原版 lastWorkPromptTokens/lastWorkPromptChars）：
    // 只在本次任务运行内有意义 —— 换了模型或工具面，旧的「字符→token」比例就不适用了，
    // 所以它是 runWork 的局部状态而不是 SessionManager 的字段（多会话并发也不会串味）。
    const usageAnchor: BudgetAnchor = { tokens: 0, chars: 0 }

    handle.busy = true
    handle.abort = new AbortSignal()
    this.beginRunStats(conv.id)
    // 压缩环境要在 handle.abort 换成新实例之后再建，否则压缩请求会挂到上一次运行的中断信号上
    const compactionEnv: WorkCompactionEnv = { config, request, reasoningEffort, abort: handle.abort }

    let assistantMsg: Message | null = null
    let streamed: string = ''
    let failure: string = ''
    // 收尾标注要用到的两个状态：本轮最后的 finishReason，以及实际跑了几轮
    let finishReason: string = ''
    let stepsUsed: number = 0

    try {
      // 交互模式的「界面补救」在跑完一遍工作循环之后可能要**再跑一轮**，
      // 所以工作循环外面再套一层：每次回到这里都会重新判定「这一轮到底有没有
      // 产出可渲染的界面」。步数预算由 stepsUsed 共享，补救不会无限续命。
      let uiContinueRounds: number = 0
      while (true) {
        for (let step: number = stepsUsed; step < maxSteps; step++) {
          stepsUsed = step + 1
          if (handle.abort.aborted) {
            break
          }

          // 插话在**轮与轮之间**注入（对齐原版 workSteerQueue 的时机）：
          // 放这里而不是打断当前请求，模型能带着上一轮的工具结果一起看到新要求。
          for (const steerText of this.drainSteer(conv.id)) {
            messages.push(LoopMessage.user(this.expandMentions(conv.id, steerText)))
          }

          // 每一轮在 UI 上是一条 assistant 消息（思考 → 工具 → 正文）
          assistantMsg = Message.ofAssistant(generateMessageId(), '')
          conv.messages.push(assistantMsg)
          this.emit({
            type: 'message:added',
            conversationId: conv.id,
            message: SessionManager.toMessageDto(assistantMsg)
          })
          this.emit({ type: 'turn:started', conversationId: conv.id, messageId: assistantMsg.id })

          // ===== 上下文预算管理（原版 1981 / 2613：每一轮请求之前）=====
          // 三级顺序不可换：先做零成本的工具结果修剪，修剪后已不超预算就不再花模型调用；
          // 仍超预算才做前缀复用式摘要压缩，最后才是从最旧处整条丢弃。
          const compactNote: string = await this.compactWorkHistoryIfNeeded(
            messages,
            false,
            mode,
            usageAnchor,
            compactionEnv
          )

          // ===== 运行时快照（原版 1985-1987 / 2617-2619：每一轮请求之前）=====
          // 放在压缩之后：压缩会改写历史（摘要重建 / 整条裁剪），尾部快照可能已被汇总进
          // 摘要或直接丢掉，这里补一次才保证本轮请求末尾一定带着最新状态。
          // 压缩没改动历史时快照逐字节相同，判重会拦下，前缀缓存不受影响。
          await this.appendRuntimeSnapshotIfNeeded(messages, conv.id)

          const targetMsg: Message = assistantMsg
          // 压缩标注放在正文开头，模型的流式增量接在它后面。
          // 必须从 streamed 起头：下面每个 token 都会用 patchMessage 整体覆盖 content，
          // 标注若只写进 msg.content 会被第一个 token 冲掉，用户就不知道上下文被动过。
          streamed = compactNote
          const callbacks: LoopTurnCallbacks = new LoopTurnCallbacks()
          callbacks.onToken = (text: string): void => {
            streamed += text
            this.patchMessage(conv.id, targetMsg.id, { content: streamed, displayContent: streamed })
          }
          callbacks.onReasoning = (text: string): void => {
            this.patchMessage(conv.id, targetMsg.id, { reasoning: text })
          }
          callbacks.onToolCalls = (calls: ToolCallRecord[]): void => {
            targetMsg.toolCalls = calls
          }
          callbacks.onUsage = (speed: number, hit: number): void => {
            this.patchMessage(conv.id, targetMsg.id, { tokenSpeed: speed, cacheHitRate: hit })
          }

          // 记录本次请求的字符量，与 usage 里的真实 prompt tokens 配对，
          // 推导「本任务实测的字符→token 比例」（原版 requestChars）
          const requestChars: number = ContextBudget.messagesChars(messages)
          const turn: LoopTurnResult = await this.runWorkTurnWithOverflowRetry(
            config,
            messages,
            request,
            reasoningEffort,
            callbacks,
            handle.abort,
            mode,
            usageAnchor,
            compactionEnv,
            (forcedNote: string): void => {
              // 服务端报了上下文超限、强制压缩成功：标注写进正文，并清掉上一次尝试
              // 已流出的部分工具行（那些参数只生成了一半，重试后不该留在时间线上）
              streamed = forcedNote
              targetMsg.toolCalls = []
              this.patchMessage(conv.id, targetMsg.id, {
                content: streamed,
                displayContent: streamed
              })
            }
          )
          if (turn.promptTokens > 0) {
            usageAnchor.tokens = turn.promptTokens
            usageAnchor.chars = requestChars
          }

          targetMsg.reasoning = turn.reasoning
          // Anthropic 思考块跨轮重放要签名: 这里不落盘的话第二轮就回传不了思考块(只剩正文)
          targetMsg.thinkingSignature = turn.thinkingSignature
          targetMsg.redactedThinking = turn.redactedThinking
          targetMsg.tokenSpeed = turn.tokenSpeed
          targetMsg.cacheHitRate = turn.cacheHitRate
          finishReason = turn.finishReason ?? ''
          targetMsg.toolCalls = turn.toolCalls
          this.recordRunRound(conv.id, turn.tokenSpeed, turn.cacheHitRate)

          // 工具调用先行落到时间线上（执行前后各推一次，UI 可显示"执行中"）
          for (const call of turn.toolCalls) {
            this.emit({
              type: 'tool:started',
              conversationId: conv.id,
              messageId: targetMsg.id,
              call: SessionManager.toToolDto(call)
            })
          }

          const loopMsg: LoopMessage = LoopMessage.fromTurn(turn)
          messages.push(loopMsg)

          // 模型输出顶到 max_tokens：收尾并提示「继续」（原版 ChatViewModel 2085-2094）。
          // 排在工具执行**之前** —— 参数可能只生成了一半，执行它只会得到更糟的结果。
          if (LoopDecisions.shouldBreakOnMaxTokens(turn.finishReason)) {
            this.patchMessage(conv.id, targetMsg.id, { content: streamed })
            await this.persist()
            this.emit({
              type: 'turn:finished',
              conversationId: conv.id,
              messageId: targetMsg.id,
              status: handle.abort.aborted ? 'aborted' : 'ok'
            })
            break
          }

          if (turn.toolCalls.length === 0) {
            this.patchMessage(conv.id, targetMsg.id, { content: streamed })
            await this.persist()
            // 状态必须看是否被中止：这里原先写死 'ok'，于是**用户手动停止的那一轮
            // 在界面上报的是「正常完成」**（聊天模式同样的位置就是判 aborted 的）。
            this.emit({
              type: 'turn:finished',
              conversationId: conv.id,
              messageId: targetMsg.id,
              status: handle.abort.aborted ? 'aborted' : 'ok'
            })
            break
          }

          // 串行执行工具（与鸿蒙侧默认行为一致：同一轮的调用按序执行，结果回填到同一批记录）
          // 工具产出的图片不能塞进 tool 结果（协议只收文本），先收集，执行完统一追加为
          // 紧随工具结果之后的 user 多模态消息。此前这里直接丢弃 imageDataUrl，导致
          // view_image 显示“成功”但模型从未收到像素（静默失败）。
          const imageAttachments: ToolImageAttachment[] = []
          for (const call of turn.toolCalls) {
            if (handle.abort.aborted) {
              break
            }
            // 真正开始执行前打上 started 标记并推一次：工具行右端据此从「等待中…」
            // 变成「执行中…」（原版 stepStatusLabel 的判据，这里分批推同一批记录）
            call.preparing = false
            call.started = true
            this.emit({
              type: 'tool:started',
              conversationId: conv.id,
              messageId: targetMsg.id,
              call: SessionManager.toToolDto(call)
            })
            // 真实计时：工具行右端要显示耗时（原版 WorkStepFormat.formatDuration 的口径），
            // 之前这里写死 0，界面上的耗时永远是「0ms」
            const toolStartedAt: number = Date.now()
            const outcome = await WorkToolRunner.execute(
              ctx as never,
              conv.id,
              call.name,
              call.argsJson,
              handle.abort
            )
            call.result = outcome.ok ? outcome.output : outcome.output
            call.isError = !outcome.ok
            call.durationMs = Date.now() - toolStartedAt
            call.timeout = outcome.timeout
            call.cancelled = outcome.cancelled
            call.schemaError = outcome.schemaError
            if (outcome.meta !== '') {
              call.meta = outcome.meta
            }
            if (outcome.imageDataUrl !== '') {
              const attachment: ToolImageAttachment = new ToolImageAttachment()
              attachment.toolName = call.name
              attachment.argsJson = call.argsJson
              attachment.imageDataUrl = outcome.imageDataUrl
              attachment.note = outcome.output
              imageAttachments.push(attachment)
            }
            this.emit({
              type: 'tool:finished',
              conversationId: conv.id,
              messageId: targetMsg.id,
              call: SessionManager.toToolDto(call)
            })
            // 工作区可能已被工具改写
            this.emit({ type: 'workspace:changed', conversationId: conv.id })
          }

          // 图片必须放在工具结果之后、下一轮请求之前：三种协议的构建器会把这条
          // user 消息编码成 image_url / input_image / base64 image 块。
          AgentLoopService.appendToolImageMessages(messages, imageAttachments)

          this.patchMessage(conv.id, targetMsg.id, { content: streamed })
          await this.persist()
          this.emit({
            type: 'turn:finished',
            conversationId: conv.id,
            messageId: targetMsg.id,
            status: handle.abort.aborted ? 'aborted' : 'ok'
          })

          if (turn.finishReason === 'stop' && turn.toolCalls.length === 0) {
            break
          }
        }

        // ===== 交互模式：界面没成形时的自动重做 / 续写（原版 ChatViewModel 2436-2500）=====
        //
        // 为什么只在「完全没有可渲染界面」时才补救（原版注释的理由，逐条保留）：
        // guncat-ui lang 是**按行语句**，被截断时已写完的语句照样能渲染 —— 半截程序
        // 也有界面可看，不值得再花一次请求重做；只有「模型压根没写出可用程序」
        // （典型是通篇文字、没有 root = Card）才值得再来一轮。
        if (
          !SessionManager.needsUiContinuation(conv, mode) ||
          handle.abort.aborted ||
          messages.length === 0 ||
          uiContinueRounds >= Constants.UI_CONTINUE_MAX_ROUNDS
        ) {
          break
        }
        uiContinueRounds++
        // 首选：单独要一份界面程序（不带工具、低推理档），从根本上绕开
        // 「主回答里写长程序被截断 / 模型忘了写 root」的问题
        let programText: string = ''
        try {
          programText = await AgentLoopService.generateUiProgram(config, messages, handle.abort)
        } catch {
          programText = ''
        }
        if (handle.abort.aborted) {
          break
        }
        const uiMsgId: string = generateMessageId()
        if (programText !== '') {
          const blockText: string = '```' + GuncatUiLang.FENCE_LANG + '\n' + programText + '\n```'
          const uiMsg: Message = Message.ofAssistant(uiMsgId, blockText)
          // 界面程序本体不进正文展示位：用户看到的是「界面已重新生成」这一句说明，
          // 真正的界面由 guncat-ui 渲染器按围栏内容画出来
          uiMsg.displayContent = '（界面已重新生成）'
          conv.messages.push(uiMsg)
          this.emit({
            type: 'message:added',
            conversationId: conv.id,
            message: SessionManager.toMessageDto(uiMsg)
          })
          // 让后续请求也能看到这份界面（保持历史完整）
          messages.push(LoopMessage.assistant(blockText, []))
          await this.persist()
          break
        }
        // 兜底：单独生成也失败，退回「文本续写」路径 —— 追加一条用户消息，
        // 让模型接着把界面写完，然后**再跑一轮工作循环**（内层 for 重新进入即可）。
        // 每一轮都会重新判定一次「界面成形了没有」，最多 UI_CONTINUE_MAX_ROUNDS 次。
        const continueText: string = Constants.UI_CONTINUE_MESSAGE
        const continueMsg: Message = Message.ofUser(
          uiMsgId,
          continueText,
          '（界面输出被截断，已自动续写）',
          []
        )
        conv.messages.push(continueMsg)
        this.emit({
          type: 'message:added',
          conversationId: conv.id,
          message: SessionManager.toMessageDto(continueMsg)
        })
        messages.push(LoopMessage.user(continueText))
        await this.persist()
        // 回到外层 while：内层 for 从当前步数接着跑（步数预算共享，不会无限续命）
        continue
      }
    } catch (e) {
      failure = (e as Error)?.message ?? String(e)
      if (assistantMsg !== null) {
        // 失败也标注在正文里（原版：往最后一条 assistant 追加「警告 + 原因」；
        // 没有 assistant 消息时才新起一条纯错误消息）。这样用户翻回来看得到原因，
        // 而不是只有一条转瞬即逝的提示条。
        if (!handle.abort.aborted) {
          SessionManager.appendTurnNote(conv, assistantMsg, `⚠️ ${failure}`)
        }
        this.emit({
          type: 'turn:finished',
          conversationId: conv.id,
          messageId: assistantMsg.id,
          status: 'error',
          error: failure
        })
      }
      await this.persist()
    } finally {
      handle.busy = false
      this.finishRunStats(conv.id)
      // ===== 收尾标注（原版 finalizeWorkTurn 3147-3160 / appendTurnNote 3162-3166）=====
      // 手动停止 / 输出顶到上限 / 步数耗尽，都在这一轮的最后一条 assistant 正文末尾
      // 追加一句说明。界面据此把折叠栏的「已完成」改成「已停止」，
      // 也告诉用户「发『继续』可以接着跑」。
      if (assistantMsg !== null) {
        if (handle.abort.aborted) {
          SessionManager.appendTurnNote(conv, assistantMsg, Constants.WORK_STOPPED_NOTE)
        } else if (failure === '' && finishReason === 'max_tokens') {
          SessionManager.appendTurnNote(
            conv,
            assistantMsg,
            ' 本轮输出达到模型上限(max tokens), 已自动收尾。发送"继续"接着输出。'
          )
        } else if (failure === '' && stepsUsed >= maxSteps) {
          SessionManager.appendTurnNote(
            conv,
            assistantMsg,
            ` 已连续执行 ${maxSteps} 轮工具调用(防失控保险), 发送"继续"可接着执行。`
          )
        }
        // 未走完的 preparing 记录在收尾时落定成「被打断」态（原版 3149-3151），
        // 时间线据此显示「已中断」而不是永远转圈
        for (const call of assistantMsg.toolCalls) {
          call.preparing = false
        }
      }
      await this.persist()
      // 整轮跑完且没被中止时，用最终答复生成会话标题（原版在 turn_end 之后调用；
      // 失败静默、每会话只试一次）
      if (failure === '' && !handle.abort.aborted) {
        const finalAnswer: string = SessionManager.lastAssistantText(conv)
        if (finalAnswer !== '') {
          this.maybeGenerateTitle(conv, SessionManager.lastUserText(conv), finalAnswer)
        }
      }
    }
  }

  /**
   * 上下文预算管理（移植原版 ChatViewModel.compactWorkHistoryIfNeeded, 3021-3081）。
   *
   * 三级策略，代价递增，顺序不可换：
   *   1. 修剪早期过长的工具结果（无模型参与、零成本；原文可用工具按需重新取回）；
   *   2. 前缀复用式摘要压缩（花一次模型调用，把 [1, oldEnd) 压成状态摘要后重建消息数组）；
   *   3. 仍超预算就从最旧处整条丢弃（兜底，损失最大）。
   *
   * force=true 用于「服务端已经明确报上下文超限」的场景：此时跳过「修剪后是否够小」的
   * 提前返回与「超预算」判据，一定要把历史改小，否则重试必然再失败。
   *
   * 返回给用户看的标注文本（由调用方写进本轮正文）；没做任何事时返回空串。
   */
  private async compactWorkHistoryIfNeeded(
    messages: LoopMessage[],
    force: boolean,
    mode: string,
    anchor: BudgetAnchor,
    env: WorkCompactionEnv
  ): Promise<string> {
    if (!force && !ContextBudget.overBudget(messages, anchor)) {
      return ''
    }
    let notes: string = ''
    // 压缩边界：尾部最近 WORK_COMPACT_KEEP_MESSAGES 条原样保留（最近轮次对后续执行最关键），
    // 只处理它之前的历史；索引 0 是系统提示词，永不参与。
    const oldEnd: number = ContextBudget.summaryEndIndex(messages.length)
    // 第一级：修剪早期过长的工具结果
    if (oldEnd > 1 && ContextBudget.pruneOldToolResults(messages, 1, oldEnd)) {
      notes += ContextBudget.PRUNE_NOTE
    }
    // 零成本的第一级已经够用时就不再花钱调模型（force 时跳过：服务端已经报了超限）
    if (!force && !ContextBudget.overBudget(messages, anchor)) {
      return notes
    }
    // 第二级：前缀复用式摘要压缩
    let compacted: boolean = false
    if (oldEnd > 1) {
      let summary: string = ''
      try {
        // 摘要请求复用真实请求的完整前缀（同一份历史 + **同一份工具面**），只在末尾追加压缩指令：
        // 对模型侧 KV 缓存而言这是上一个请求的延续而不是冷启动，前缀部分按缓存命中计价。
        // 工具面必须与主循环逐字节一致（见 runWorkTurnWithOverflowRetry 的 toolDefsForMode），
        // 否则工具定义一变，这段前缀的缓存全部作废。
        summary = await AgentLoopService.summarizeHistory(
          env.config,
          messages,
          env.request.thinkingEnabled,
          env.reasoningEffort,
          env.request.webSearchEnabled,
          env.abort,
          AgentLoopService.toolDefsForMode(mode, env.request.webSearchEnabled)
        )
      } catch (e) {
        // 压缩失败（网络/中断/服务端拒绝）回退为整条裁剪，不把整个任务拖死
        summary = ''
      }
      if (!env.abort.aborted && summary.trim() !== '') {
        const rebuilt: LoopMessage[] = ContextBudget.rebuildWithSummary(
          messages,
          oldEnd,
          ContextBudget.truncateSummary(summary.trim()),
          AgentLoopService.buildWorkSystemPromptFor(mode),
          LOOP_HEAD_FACTORY
        )
        // 就地替换（而不是把 messages 重新赋值）：messages 被 callbacks 与外层闭包共享，
        // 换掉引用会让压缩结果对后续轮次不可见
        messages.splice(0, messages.length)
        for (const m of rebuilt) {
          messages.push(m)
        }
        compacted = true
        notes += ContextBudget.summaryNote(oldEnd - 1)
      }
    }
    // 第三级：压缩后（或压缩失败时）仍超预算 → 从最旧处整条丢弃
    if (ContextBudget.dropOldestUntilUnderBudget(messages, anchor) > 0) {
      compacted = true
    }
    // 标注不重复：已经写了「摘要压缩」就不再补一条「整条裁剪」
    if (compacted && notes.indexOf(ContextBudget.SUMMARY_NOTE_KEY) < 0) {
      notes += ContextBudget.TRIM_NOTE
    }
    // usage 锚定值已失效（历史被改写），下一请求重新测量
    anchor.tokens = 0
    anchor.chars = 0
    return notes
  }

  /**
   * 把用户消息里的 @文件引用展开成正文附在该消息之后。
   *
   * 为什么展开在「本轮消息」而不是运行时快照：快照要靠逐字节判重才能保住 KV 缓存前缀，
   * 而 @ 出来的内容本来就是每条消息各不相同的一次性上下文 —— 它天然属于这条 user 消息，
   * 下一轮不会再有第二条一模一样的快照被它影响。
   *
   * 用户在 UI 上看到的就是自己原本那句 `改一下 @a.md`（存的是原文），展开只发生在发给模型的
   * 这一份里；解析、体积预算与越界拒绝都在 WorkspaceMentionService 内部收口。
   */
  private expandMentions(convId: string, text: string): string {
    if (text.indexOf('@') < 0) {
      return text;
    }
    const render = WorkspaceMentionService.render(
      WorkFileService.workspaceRoot(this.ctx(), convId), text)
    if (render.section === '') {
      return text;
    }
    return text + '\n\n' + render.section
  }

  /**
   * 追加运行时快照（移植原版 ChatViewModel.appendRuntimeSnapshotIfNeeded, 2984-3000）。
   *
   * 快照=「今天日期 + 工作区文件树 + 项目指令 + 任务清单 + 自主目标 + 定时提醒」，作为 **user 消息**
   * 追加到历史末尾（不进系统提示词）。它是模型跨轮、跨会话知道「现在是什么状态」的唯一来源：
   * 系统提示词是静态的（改它会让整段前缀的 KV 缓存失效），而这些状态每轮都可能变。
   *
   * 为什么必须判重、不能每轮无脑 push：
   * `buildRuntimeSnapshot` 里刻意不含时间戳（只有日期），所以工作区/清单/目标/提醒没变时
   * 生成的字符串**逐字节相同**。历史是严格追加式增长的（压缩是唯一改写历史的操作），
   * 相邻两轮请求因此共享逐字节相同的前缀 —— 模型侧 KV 缓存可跨轮命中，每轮只有真正新增的
   * 尾部需要重新计算。一旦每轮都 push 一份，请求前缀每轮都变，缓存命中率立刻归零，
   * 长任务的成本与首字延迟都会明显变差。所以用 LoopDecisions.shouldAppendSnapshot 与历史中
   * 最后一条快照比对，只有真的变了才追加。
   *
   * 顺带一提：状态真的变化（新文件 / 新 todo / 跨天）时字符串自然不同，判重会放行一次新快照，
   * 而快照正文自己声明「取代此前所有快照」，模型知道以最后一条为准，旧快照留在历史里不会误导。
   */
  private async appendRuntimeSnapshotIfNeeded(messages: LoopMessage[], convId: string): Promise<void> {
    const ctx: Context = this.ctx()
    // 工作区文件树随文件操作/上传自动刷新，是快照里最容易变的部分
    const tree: string = await WorkFileService.listWorkspaceTree(ctx, convId)
    const todoText: string = WorkFileService.readTodo(ctx, convId)
    const root: string = WorkFileService.workspaceRoot(ctx, convId)
    const goal = GoalService.read(root)
    const goalText: string = goal !== null ? GoalService.render(goal) : ''
    // renderList 在空清单时返回「(无提醒)」而不是空串 —— 与原版一致，
    // 于是 <session_schedules> 段落总是存在（没有提醒时显式告诉模型"没有"）
    const scheduleText: string = ScheduleService.renderList(ScheduleService.list(root))
    // 工作区项目指令（AGENTS.md / CLAUDE.md / GUNCAT.md）：只在有文件时产出这一段，
    // 没有时为空串 → 快照里整段省略，也就不会因为「多了一行空段」而破坏相邻轮的字节一致性。
    const instructionsText: string = WorkspaceInstructionsService.render(root).section
    const snapshot: string = AgentLoopService.buildRuntimeSnapshot(
      tree, todoText, goalText, scheduleText, instructionsText)
    if (LoopDecisions.shouldAppendSnapshot(AgentLoopService.findLastSnapshot(messages), snapshot)) {
      messages.push(LoopMessage.user(snapshot))
    }
  }

  /**
   * 单轮模型请求（带「上下文溢出后强制压缩并重试一次」）。
   *
   * 移植自原版 runStepWithOverflowRetry（2941-2973）：服务端明确报上下文超限（400/413/超长）
   * 时，按需压缩已经来不及了 —— 历史必须先被改小，重试才有意义。这里强制走一遍三级压缩
   * （force=true 不做「修剪后是否够小」的提前返回），压缩确实改动了历史才重试，否则照常抛出。
   * 其它错误（鉴权/参数/网络）不归本方法管，原样上抛给外层。
   */
  private async runWorkTurnWithOverflowRetry(
    config: ApiConfig,
    messages: LoopMessage[],
    request: WorkRunRequest,
    reasoningEffort: string,
    callbacks: LoopTurnCallbacks,
    abort: AbortSignal,
    mode: string,
    anchor: BudgetAnchor,
    env: WorkCompactionEnv,
    onForcedNote: (note: string) => void
  ): Promise<LoopTurnResult> {
    try {
      return await AgentLoopService.runTurnWithRetry(
        config,
        messages,
        request.thinkingEnabled,
        reasoningEffort,
        request.webSearchEnabled,
        callbacks,
        abort,
        true,
        Constants.WORK_LLM_RETRY_MAX,
        // 工具面按模式裁剪（对齐原版 `toolDefsForMode(loopMode, webSearchEnabled)`）：
        // 交互模式只下发 27 个白名单工具，工作模式返回 null（= 全量 44 个）。
        //
        // 这一条很关键：交互模式的系统提示词写着「默认一次回答直接给界面, 不调用任何工具；
        // 一律不用 todo_write / goal_* / schedule_* / subagent / session_search / record_search」，
        // 而此前主循环把**全量**工具面下发给了它 —— 提示词里明令禁止的工具就在工具表里摆着，
        // 模型于是动不动就去读文件、写文件、建目标，交付物从「一份界面」退化成「一段对话」。
        AgentLoopService.toolDefsForMode(mode, request.webSearchEnabled)
      )
    } catch (e) {
      const err: Error = e as Error
      const overflow: boolean = err instanceof LoopError && (err as LoopError).isContextOverflow()
      // 本轮尚未压缩过（原版同样传 false）：压缩一次即重试一次，不做无休止重试
      if (!LoopDecisions.shouldForceCompactOnOverflow(abort.aborted, overflow, false)) {
        throw err
      }
      const forcedNote: string = await this.compactWorkHistoryIfNeeded(messages, true, mode, anchor, env)
      if (forcedNote === '') {
        // 压缩没改动任何东西（例如历史已只剩系统提示词）→ 重试也是白费，交回原错误
        throw err
      }
      onForcedNote(forcedNote)
      // 强制压缩改写了历史：末尾快照可能已随旧历史被摘要/裁剪掉，重试前必须补回来，
      // 否则重试的这一请求会「不知道今天是几号、工作区有什么」（原版 2964-2965）。
      await this.appendRuntimeSnapshotIfNeeded(messages, request.conversationId)
      return await AgentLoopService.runTurnWithRetry(
        config,
        messages,
        request.thinkingEnabled,
        reasoningEffort,
        request.webSearchEnabled,
        callbacks,
        abort,
        true
      )
    }
  }

  /**
   * 在轮次消息末尾追加标注（原版 ChatViewModel.appendTurnNote）：
   * 正文为空就直接写这句，否则空一行再接 —— 这样它总是独立成段，
   * 不会和模型正文粘成一行。
   */
  private static appendTurnNote(conv: Conversation, msg: Message, note: string): void {
    msg.content = msg.content === '' ? note : `${msg.content}\n\n${note}`
    msg.displayContent = msg.content
  }

  // ===== 会话标题（LLM 生成） =====

  /** 已经排过标题生成任务的会话（原版 titleJobs）：每会话一次，避免每轮都调一次模型 */
  private titleJobs: Set<string> = new Set()

  /** 取最后一条用户消息的正文（生成标题时的输入之一） */
  private static lastUserText(conv: Conversation): string {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') {
        return conv.messages[i].content
      }
    }
    return ''
  }

  /** 取最后一条非空助手答复（工作模式下正文在最后一条 assistant 上） */
  private static lastAssistantText(conv: Conversation): string {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const msg: Message = conv.messages[i]
      if (msg.role === 'assistant' && msg.content.trim() !== '') {
        return msg.content
      }
    }
    return ''
  }

  private maybeGenerateTitle(conv: Conversation, userText: string, answerText: string): void {
    if (this.titleJobs.has(conv.id)) {
      return
    }
    this.titleJobs.add(conv.id)
    // 刻意不 await：标题是锦上添花，绝不能拖住「本轮结束」的收尾
    void this.generateTitle(conv, userText, answerText)
  }

  private async generateTitle(
    conv: Conversation,
    userText: string,
    answerText: string
  ): Promise<void> {
    const config: ApiConfig | null = await StorageManager.loadApiConfig(this.ctx()).catch(
      (): ApiConfig | null => null
    )
    if (config === null || config.apiKey === '') {
      return
    }
    try {
      const title: string = await AgentLoopService.generateSessionTitle(config, userText, answerText)
      if (title === '' || this.find(conv.id) === undefined) {
        return
      }
      conv.title = title
      await this.persist()
      this.emit({ type: 'conversation:title', conversationId: conv.id, title })
    } catch {
      // 标题生成失败静默（与原版一致）：不能因为一个装饰性字段把整轮标成失败
    }
  }

  // ===== 工作区 =====

  listWorkspace(conversationId: string): Array<{
    name: string
    path: string
    isDirectory: boolean
    size: number
    modifiedAt: number
  }> {
    const ctx: Context = this.ctx()
    WorkFileService.ensureWorkspace(ctx, conversationId)
    const items = WorkFileService.listWorkspace(ctx, conversationId)
    return items.map((item) => ({
      name: item.path.split('/').pop() ?? item.path,
      path: item.path,
      isDirectory: item.isDir,
      size: item.size,
      modifiedAt: 0
    }))
  }

  workspaceTreeText(conversationId: string): string {
    return WorkFileService.listWorkspaceTree(this.ctx(), conversationId)
  }

  /** 侧栏文件树懒加载：只列 relPath 这一层的直接子项（'' = 工作区根） */
  listWorkspaceDir(conversationId: string, relPath: string): Array<{
    name: string
    path: string
    isDirectory: boolean
    size: number
    modifiedAt: number
  }> {
    const ctx: Context = this.ctx()
    WorkFileService.ensureWorkspace(ctx, conversationId)
    const items = WorkFileService.listDir(ctx, conversationId, relPath)
    return items.map((item) => ({
      name: item.path.replace(/\/$/, '').split('/').pop() ?? item.path,
      path: item.path,
      isDirectory: item.isDir,
      size: item.size,
      modifiedAt: 0
    }))
  }

  workspaceRoot(conversationId: string): string {
    return WorkFileService.workspaceRoot(this.ctx(), conversationId)
  }

  /** 面板展示用：当前工作区根目录、是否为自定义、目录是否仍然存在、命令审批档位、项目指令文件 */
  workspaceInfo(conversationId: string): WorkspaceInfoDto {
    const custom: string | null = WorkFileService.getWorkspaceOverride(conversationId)
    const root: string = this.workspaceRoot(conversationId)
    const commandPermission: string = CommandService.permissionFor(conversationId)
    // 目录失效时 listFiles 自然返回空数组（探测失败即视为不存在），不需要额外分支
    const instructionFiles: string[] = WorkspaceInstructionsService.listFiles(root)
    if (custom !== null) {
      // 目录失效时**不**自动 mkdir 一个空壳冒充用户的目录 —— 界面要如实报「已失效」
      return {
        root,
        isCustom: true,
        exists: fs.existsSync(custom) && fs.statSync(custom).isDirectory(),
        commandPermission,
        instructionFiles
      }
    }
    return { root, isCustom: false, exists: true, commandPermission, instructionFiles }
  }

  /**
   * 档位语义迁移（每个会话只走一次，靠 commandPermissionMigrated 标记）。
   * 老存档里没有 'full-access' 这个取值，所以它的 'auto' 一定是旧语义「危险命令也不问人」，
   * 按语义改名成 'full-access'；已经被标过 migrated 的会话不动 —— 用户后来亲手选的 'auto'
   * 是新语义（模型先审），再搬一次就把人家的选择改掉了。
   */
  static migrateCommandPermission(conv: Conversation): boolean {
    if (conv.commandPermissionMigrated) {
      return false
    }
    conv.commandPermissionMigrated = true
    if (conv.commandPermission !== CommandGuard.PERMISSION_AUTO) {
      return false
    }
    conv.commandPermission = CommandGuard.PERMISSION_FULL_ACCESS
    return true
  }

  /**
   * 设置本会话的命令审批档位。非法值不写（界面只给四档，走不到非法分支，但模型/旧数据可能给）。
   * 硬禁表不受这个开关影响 —— 四档改的只是「危险命令由谁裁决」：
   * 'ask'/'ask-risk' 由人、'auto' 先由模型审（拦下才找人）、'full-access' 完全不裁。
   * 见 CommandGuard 与 ApprovalReviewService。
   */
  async setCommandPermission(conversationId: string, permission: string): Promise<WorkspaceInfoDto> {
    const conv: Conversation = this.mustFind(conversationId)
    if (CommandGuard.PERMISSIONS.indexOf(permission) === -1) {
      throw new Error('未知的审批档位: ' + permission)
    }
    conv.commandPermission = permission
    CommandService.setPermission(conversationId, permission)
    await this.persist()
    this.emit({ type: 'workspace:changed', conversationId })
    return this.workspaceInfo(conversationId)
  }

  /**
   * 切换/恢复会话的工作区目录。dir=null 恢复默认沙箱。
   * 校验失败抛可读错误（界面直接 toast）；成功即持久化到会话元数据并全局生效。
   */
  async setWorkspaceDirectory(
    conversationId: string,
    dir: string | null
  ): Promise<WorkspaceInfoDto> {
    const conv: Conversation = this.mustFind(conversationId)
    if (dir === null || dir === '') {
      WorkFileService.setWorkspaceOverride(conversationId, null)
      conv.workspacePath = ''
      await this.persist()
      this.emit({ type: 'workspace:changed', conversationId })
      return this.workspaceInfo(conversationId)
    }
    const abs: string = path.resolve(dir)
    if (!path.isAbsolute(abs) || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error('所选目录不存在或不是目录')
    }
    // 拒绝把系统盘根目录当工作区（清空/删除工具会作用到整个盘的相对子树之外没有意义，
    // 而且用户极可能后悔）；具体盘符根（C:\ 之类）一律拒绝。
    const parsed: path.ParsedPath = path.parse(abs)
    if (parsed.dir === '') {
      throw new Error('不能把工作区设在盘符根目录')
    }
    WorkFileService.setWorkspaceOverride(conversationId, abs)
    conv.workspacePath = abs
    await this.persist()
    this.emit({ type: 'workspace:changed', conversationId })
    return this.workspaceInfo(conversationId)
  }

  /**
   * 文件收件：把外部文件（拖拽 / 命令行 / 系统「打开方式」）导入会话沙箱工作区。
   * 这是鸿蒙版「接收系统分享」在桌面端的等价入口 —— 收进来的文件进工作区，
   * 由模型通过文件工具读取，而不是自动当附件发出去。
   */
  async intakePaths(
    conversationId: string,
    paths: string[]
  ): Promise<{ names: string[]; imported: number; failed: string[] }> {
    const conv: Conversation | undefined = this.find(conversationId)
    if (conv === undefined) {
      throw new Error(`会话不存在: ${conversationId}`)
    }
    const ctx: Context = this.ctx()
    WorkFileService.ensureWorkspace(ctx, conversationId)

    const files: PickedFile[] = []
    const failed: string[] = []
    for (const p of paths) {
      try {
        if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) {
          failed.push(p)
          continue
        }
        const stat = fs.statSync(p)
        // 不按扩展名挑文件：用户有终端，什么格式都可能要放进工作区。
        // 这里只保留一个防止整机 OOM 的硬上限（相册照片通常几 MB 到几十 MB）。
        if (stat.size > Constants.WORK_UPLOAD_MAX_BYTES) {
          failed.push(`${path.basename(p)}（超过 ${Math.round(Constants.WORK_UPLOAD_MAX_BYTES / (1024 * 1024))}MB 上限）`)
          continue
        }
        const buf: Buffer = fs.readFileSync(p)
        files.push({
          name: path.basename(p),
          uri: p,
          fileType: FileService.guessTypeByName(path.basename(p)),
          size: stat.size,
          buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
        })
      } catch {
        failed.push(p)
      }
    }

    const names: string[] = WorkFileService.savePickedFiles(ctx, conversationId, files)
    this.emit({ type: 'workspace:changed', conversationId })
    this.emit({
      type: 'files:intaken',
      conversationId,
      names,
      imported: names.length,
      failed
    })
    return { names, imported: names.length, failed }
  }

  /**
   * 把某条回答导出为 Word（复用移植过来的 DocxBuilder，含 LaTeX → OMML 公式转换）。
   * 返回字节，由调用方决定落盘位置。
   */
  async exportMessageDocx(conversationId: string, messageId: string): Promise<Uint8Array> {
    const conv: Conversation = this.mustFind(conversationId)
    const msg: Message | undefined = conv.messages.find((m) => m.id === messageId)
    if (msg === undefined) {
      throw new Error('消息不存在')
    }
    // 交互模式的界面程序不适合直接进 Word，这里只导出文本部分
    const body: string = GuncatUiParts.build(msg.content, true).textOnly || msg.content
    const title: string = conv.title !== '' ? conv.title : 'Guncat 回答'
    return await DocxBuilder.buildFromMarkdown(body, title, {
      resolve: async (): Promise<null> => null
    } as never)
  }

  // ===== 内部工具 =====

  private patchMessage(conversationId: string, messageId: string, patch: Partial<MessageDto>): void {
    const conv: Conversation | undefined = this.find(conversationId)
    if (conv !== undefined) {
      const msg: Message | undefined = conv.messages.find((m) => m.id === messageId)
      if (msg !== undefined) {
        if (patch.content !== undefined) {
          msg.content = patch.content
        }
        if (patch.displayContent !== undefined) {
          msg.displayContent = patch.displayContent
        }
        if (patch.reasoning !== undefined) {
          msg.reasoning = patch.reasoning
        }
        if (patch.tokenSpeed !== undefined) {
          msg.tokenSpeed = patch.tokenSpeed
        }
        if (patch.cacheHitRate !== undefined) {
          msg.cacheHitRate = patch.cacheHitRate
        }
      }
    }
    this.emit({ type: 'message:patched', conversationId, messageId, patch })
  }

  /**
   * 把用户选中的文件变成真正的附件。
   *
   * 用户报障类问题（审计 P0）：原实现只留了文件名 ——
   * `Attachment.of(name, '', 'file', '', '', '')`，dataUrl / parsedText / fileId 全是空串。
   * 而 ChatService 的三条协议都会因 `parsedText === '' && dataUrl === ''` 直接 `continue`，
   * 于是「加了附件」对请求零影响：图片发不过去，文档也没内容。
   *
   * 移植自原版 ChatViewModel.enqueueFiles + parseOneFile + prepareAttachmentFileIds：
   *   · 先行解析（preparseEnabled）：交给 MultimodalService 把内容读成文字；
   *   · 未开先行解析：退回 Base64 内联（dataUrl），由主模型的多模态能力直接看；
   *   · 大文件 / Responses 协议的文档：走 Files API 拿 file_id，按各协议引用。
   *
   * 与开头的差别（本次对齐）：解析结果优先取缓存。用户选完文件时主进程就已经解析过了
   * （见 preparseAttachments），发送路径只该「取一次」，不该把同一份文件再读一遍、
   * 再调一次多模态接口、再传一次 Files API。
   */
  private async makeAttachments(paths: string[]): Promise<Attachment[]> {
    const out: Attachment[] = []
    if (paths.length === 0) {
      return out
    }
    const parsed: AttachmentParseContext = await this.attachmentParseContext()
    for (const p of paths) {
      const { attachment, error }: ParsedAttachment = await this.attachmentFor(p, parsed)
      if (attachment === null) {
        // 彻底不可用（读不出来 / 文件不在了）：不静默丢，说清是哪一个、为什么
        this.emit({
          type: 'notice',
          level: 'warn',
          text: `附件解析失败，已跳过：${SessionManager.baseName(p)}（${error}）`
        })
        continue
      }
      // 复制一份再放进消息：同一条缓存可能被多条消息引用，
      // 消息里的附件不该与缓存共享同一个可变对象（Attachment 是 class，字段可写）。
      out.push(
        Attachment.of(
          attachment.name,
          attachment.parsedText,
          attachment.type,
          attachment.thumbnail,
          attachment.dataUrl,
          attachment.fileId
        )
      )
    }
    return out
  }

  // ===== 附件先行解析（对齐原版 enqueueFiles / parseOneFile） =====

  /**
   * 选完文件后立刻预处理（原版 enqueueFiles 的桌面端对应物）。
   *
   * 与 pick 的分工：IPC 那边**不 await** 地启动它 —— 选文件的返回值必须立刻回到渲染层，
   * 卡片才能马上出现在预览条上（此时是「解析中...」）。这里逐个解析，每完成一个就推一条
   * `attachment:parsed`，渲染层据此把卡片换成「已就绪」或「解析失败」。
   *
   * 刻意串行（而不是 Promise.all）：一次选十几个文件时，并行会把多模态接口和内存同时打满，
   * 而且用户看到的第一个「已就绪」也要等最慢的那个 —— 串行反而逐个更快有反馈（与原始一致）。
   */
  async preparseAttachments(paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return
    }
    const parsed: AttachmentParseContext = await this.attachmentParseContext()
    for (const p of paths) {
      const result: ParsedAttachment = await this.attachmentFor(p, parsed)
      // 两种失败都要报给用户，但严重程度不同：彻底不可用的直接推一条 notice（发送时会被跳过），
      // 先行解析失败但已退回内联的只在卡片上说明 —— 它仍然能发出去，不该再弹一次警告。
      if (result.attachment === null) {
        this.emit({
          type: 'notice',
          level: 'warn',
          text: `${SessionManager.baseName(p)} 解析失败：${result.error}`
        })
      }
      this.emit({
        type: 'attachment:parsed',
        path: p,
        status: result.attachment === null || result.error !== '' ? 'error' : 'ready',
        ...(result.error !== '' ? { error: result.error } : {})
      })
    }
  }

  /**
   * 附件解析缓存：路径 → 已解析好的 Attachment（或失败原因）。
   *
   * 为什么必须有：选完文件就解析，而发送时**不能再解析一遍** —— 否则同一份文件会被
   * 多模态接口调两次、被 Files API 传两次。缓存条目里带「配置指纹」，多模态/接口配置一变，
   * 先前解析出的 parsedText 与上传得到的 file_id 就可能不适用，旧条目自然命中不了、
   * 会按新配置重新解析。
   *
   * 选「指纹失效」而不是「配置变更时主动清空」：后者要在每一处保存配置的分支上都接一根线，
   * 漏一处就是「改了配置还在用旧结果」这种难查的错；前者的代价只是失效条目在内存里多留一会儿。
   */
  private attachmentCache: Map<string, CachedAttachment> = new Map()

  /** 读一次解析所需的配置，并算出这批解析结果的配置指纹 */
  private async attachmentParseContext(): Promise<AttachmentParseContext> {
    const mm: MultimodalConfig = await StorageManager.loadMultimodalConfig(this.ctx()).catch(
      (): MultimodalConfig => MultimodalConfig.default()
    )
    const api: ApiConfig | null = await StorageManager.loadApiConfig(this.ctx()).catch(
      (): ApiConfig | null => null
    )
    return { mm, api, sig: SessionManager.attachmentConfigSig(mm, api) }
  }

  /**
   * 附件解析结果的「配置指纹」。只取会影响结果的那几项：
   *   · 多模态入口决定「解析出什么文字」；
   *   · 接口配置决定「要不要、能不能上传 Files API」（file_id 与 provider 绑定）。
   * 密钥只取「有没有、多长」，不把明文再复制一份进缓存键。
   */
  private static attachmentConfigSig(mm: MultimodalConfig, api: ApiConfig | null): string {
    const mmSig: string = [
      mm.baseUrl,
      mm.model,
      mm.preparseEnabled ? '1' : '0',
      mm.apiKey === '' ? '0' : `k${mm.apiKey.length}`
    ].join('|')
    const apiSig: string =
      api === null
        ? '-'
        : [api.provider, api.baseUrl, api.apiKey === '' ? '0' : `k${api.apiKey.length}`].join('|')
    return `${mmSig}#${apiSig}`
  }

  /** 取（必要时现算）某个路径的解析结果，并写回缓存 */
  private async attachmentFor(
    filePath: string,
    parsed: AttachmentParseContext
  ): Promise<ParsedAttachment> {
    const hit: CachedAttachment | undefined = this.attachmentCache.get(filePath)
    if (hit !== undefined && hit.sig === parsed.sig) {
      return { attachment: hit.attachment, error: hit.error }
    }
    const result: ParsedAttachment = await this.parseAttachmentFile(filePath, parsed.mm, parsed.api)
    this.attachmentCache.set(filePath, { sig: parsed.sig, ...result })
    return result
  }

  /**
   * 解析单个文件：读盘 → 先行解析或 Base64 内联 → 必要时上传 Files API。
   *
   * 返回值的两种形态，对应的「解析失败」不是同一件事：
   *   · attachment === null —— **彻底不可用**（文件不在了 / 读不出来），只能跳过；
   *   · attachment !== null 且 error !== '' —— 先行解析失败，但已退回 Base64 内联，
   *     文件仍然能发出去（卡片照原版口径显示「解析失败」，tooltip 里说明已内联直传）。
   */
  private async parseAttachmentFile(
    filePath: string,
    mm: MultimodalConfig,
    api: ApiConfig | null
  ): Promise<ParsedAttachment> {
    const name: string = SessionManager.baseName(filePath)
    if (!fs.existsSync(filePath)) {
      return { attachment: null, error: '文件不存在' }
    }
    let bytes: Buffer
    try {
      bytes = fs.readFileSync(filePath)
    } catch (e: unknown) {
      return { attachment: null, error: `读取失败：${e instanceof Error ? e.message : String(e)}` }
    }
    const mime: string = SessionManager.guessMime(name)
    const type: string = mime.startsWith('image/') ? 'image' : 'file'
    let parsedText: string = ''
    let dataUrl: string = ''
    let parseError: string = ''
    // 先行解析：多模态服务把图片/文档读成文字（没配密钥时静默跳过，下面会退回内联）
    if (mm.preparseEnabled && mm.apiKey !== '') {
      try {
        const result = await MultimodalService.parseFile(
          mm,
          name,
          SessionManager.toArrayBuffer(bytes),
          mime
        )
        parsedText = result.content
        dataUrl = result.dataUrl
      } catch (e: unknown) {
        // 先行解析失败：**仍然退回 Base64 内联**，但状态如实报「解析失败」。
        //
        // 与原版的差异（如实记录）：原版把 error 的附件从 ready 里过滤掉，也就是不发送。
        // 桌面端保留内联兜底，因为这里的失败几乎总是「多模态入口没配好 / 临时抽风」——
        // 把文件一起丢掉，用户会连一张能直传的图片都发不出去，而失败原因只在卡片上；
        // 原版没有这条兜底，是它的直传与解析在同一步里，失败了本就无内容可发。
        // 卡片照原样变红并在 tooltip 里说明「已改为内联直传」，不制造「红卡却发出去了」的困惑。
        parseError = `${e instanceof Error ? e.message : String(e)}；已改为 Base64 内联发送`
      }
    }
    if (parsedText === '' && dataUrl === '') {
      dataUrl = `data:${mime};base64,${bytes.toString('base64')}`
    }
    let fileId: string = ''
    if (api !== null && SessionManager.shouldUploadViaFilesApi(api, type, bytes.byteLength)) {
      try {
        fileId = await FileUploadService.uploadFile(
          api,
          name,
          mime,
          SessionManager.toArrayBuffer(bytes)
        )
      } catch {
        // 上传失败保留 dataUrl 内联发送（与原版一致）
        fileId = ''
      }
    }
    return {
      attachment: Attachment.of(
        name,
        parsedText,
        type,
        await this.makeThumbnail(dataUrl),
        dataUrl,
        fileId
      ),
      error: parseError
    }
  }

  /** 取路径里的文件名（`C:\a\b.png` 与 `/a/b.png` 都要对） */
  private static baseName(filePath: string): string {
    return filePath.split(/[\\/]/).pop() ?? filePath
  }

  /**
   * 是否走 Files API（对齐原版 prepareAttachmentFileIds 的判定）：
   *   · 文档只在 OpenAI Responses 协议下上传（其余协议没有 file 类型的引用方式）；
   *   · 图片超过 4MB 才上传（小图 Base64 内联更省一次往返）；
   *   · Anthropic 协议下只在 DeepSeek 的兼容入口上这么干（官方入口的阈值不同）。
   */
  private static shouldUploadViaFilesApi(
    config: ApiConfig,
    type: string,
    byteLength: number
  ): boolean {
    const provider: string = config.provider
    if (
      provider !== 'openai-completions' &&
      provider !== 'openai-responses' &&
      provider !== 'anthropic-messages'
    ) {
      return false
    }
    if (type === 'file') {
      return provider === 'openai-responses'
    }
    const THRESHOLD: number = 4 * 1024 * 1024
    if (provider === 'anthropic-messages') {
      return byteLength > THRESHOLD && config.baseUrl.indexOf('deepseek.com') !== -1
    }
    return byteLength > THRESHOLD
  }

  /** 图片的 96px 缩略图（消息气泡里显示小图，避免每次重绘都解码全尺寸原图）。 */
  private async makeThumbnail(dataUrl: string): Promise<string> {
    const comma: number = dataUrl.indexOf(',')
    if (comma < 0) {
      return ''
    }
    let source: image.ImageSource | null = null
    let pixelMap: image.PixelMap | null = null
    let packer: image.ImagePacker | null = null
    try {
      source = image.createImageSource(Buffer.from(dataUrl.slice(comma + 1), 'base64'))
      pixelMap = await source.createPixelMap({ desiredSize: { width: 96, height: 96 } })
      packer = image.createImagePacker()
      const buffer: ArrayBuffer = await packer.packToData(pixelMap, {
        format: 'image/png',
        quality: 80
      })
      return `data:image/png;base64,${Buffer.from(buffer).toString('base64')}`
    } catch {
      // 缩略图失败不影响附件本身（渲染层会退回显示文件名）
      return ''
    } finally {
      if (pixelMap !== null) {
        await pixelMap.release().catch((): void => undefined)
      }
      if (source !== null) {
        await source.release().catch((): void => undefined)
      }
      if (packer !== null) {
        await packer.release().catch((): void => undefined)
      }
    }
  }

  private static toArrayBuffer(bytes: Buffer): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  /** 按扩展名给出 MIME（附件内联 / 上传都要用；认不出时按二进制处理） */
  static guessMime(name: string): string {
    const dot: number = name.lastIndexOf('.')
    const ext: string = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
    const table: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      bmp: 'image/bmp',
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      json: 'application/json',
      log: 'text/plain',
      yaml: 'text/yaml',
      yml: 'text/yaml'
    }
    return table[ext] ?? 'application/octet-stream'
  }

  /**
   * 把最近一轮交互界面的绑定状态翻译成一句给模型看的人话。
   * 没有界面状态时返回空串。
   */
  private describeUiState(conv: Conversation): string {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const msg: Message = conv.messages[i]
      if (msg.role !== 'assistant' || msg.content === '') {
        continue
      }
      const split = GuncatUiTrailer.split(msg.content)
      if (!split.hasState) {
        continue
      }
      const parts = GuncatUiParts.build(msg.content, true)
      const uiSeg = parts.segments.find((s) => s.type === 'ui' && s.program !== null)
      if (uiSeg === undefined || uiSeg.program === null) {
        return ''
      }
      return GuncatUiRuntime.describeStateForModel(uiSeg.program, split.stateJson)
    }
    return ''
  }

  // ===== DTO 映射 =====

  static deriveTitle(text: string): string {
    const line: string = text.trim().split('\n')[0].trim()
    return line.length > 24 ? line.substring(0, 24) + '…' : line
  }

  /**
   * 这条会话的标题是否还需要从首条用户消息推导。
   *
   * 除空标题与历史默认名之外，还认「标题恰好等于引擎名」这一种脏数据：
   * 早期版本建会话时把 agent.name 写成了 title，只认 ''/'新对话' 的守卫会永远跳过它，
   * 于是会话列表里每条都顶着同一个引擎名。这里补上自救，用户下次发消息标题就正常了。
   */
  static needsDerivedTitle(title: string, agentName: string): boolean {
    const trimmed: string = title.trim()
    if (trimmed === '' || trimmed === '新对话') {
      return true
    }
    return agentName !== '' && trimmed === agentName
  }

  static toSummary(conv: Conversation): ConversationSummaryDto {
    let updatedAt: number = conv.createdAt
    let preview: string = ''
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m: Message = conv.messages[i]
      if (m.content !== '') {
        preview = m.content.slice(0, 60)
        break
      }
    }
    if (conv.messages.length > 0) {
      updatedAt = conv.messages[conv.messages.length - 1].timestamp
    }
    return {
      id: conv.id,
      title: conv.title,
      agentId: conv.agentId,
      mode: conv.mode,
      updatedAt,
      messageCount: conv.messages.length,
      lastPreview: preview
    }
  }

  static toToolDto(rec: ToolCallRecord): ToolCallRecordDto {
    return {
      id: rec.id,
      name: rec.name,
      argsJson: rec.argsJson,
      result: rec.result,
      status: rec.isError ? 'error' : rec.durationMs < 0 ? 'running' : 'ok',
      startedAt: 0,
      finishedAt: 0,
      // 真实耗时：工具行的右端、图标位的转圈与否都靠它判断（原版同口径）
      durationMs: rec.durationMs,
      // 「执行中…」与「等待中…」的区分（原版 stepStatusLabel 靠这两个标志）
      started: rec.started,
      preparing: rec.preparing,
      diff: rec.meta
    }
  }

  static toMessageDto(msg: Message): MessageDto {
    return {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      displayContent: msg.displayContent,
      reasoning: msg.reasoning,
      attachments: msg.attachments.map((a, index) => ({
        id: `${msg.id}_att${index}`,
        name: a.name,
        type: a.type,
        dataUrl: a.dataUrl,
        thumbnail: a.thumbnail,
        parsedText: a.parsedText,
        fileId: a.fileId
      })),
      toolCalls: msg.toolCalls.map((c) => SessionManager.toToolDto(c)),
      timestamp: msg.timestamp,
      tokenSpeed: msg.tokenSpeed,
      cacheHitRate: msg.cacheHitRate
    }
  }

  static toDto(conv: Conversation): ConversationDto {
    return {
      id: conv.id,
      title: conv.title,
      agentId: conv.agentId,
      mode: conv.mode,
      createdAt: conv.createdAt,
      updatedAt: conv.messages.length > 0 ? conv.messages[conv.messages.length - 1].timestamp : conv.createdAt,
      messages: conv.messages.map((m) => SessionManager.toMessageDto(m))
    }
  }

  /**
   * 表格提取要用的连接信息（原版 TableOcrPage 从**配置方案**里列模型让用户选）。
   *
   * 解析顺序：
   *   1) 指定模型名且能在某个配置方案里找到 → 用那套的 baseUrl/apiKey；
   *   2) 找不到就用多模态配置（表格识别本质是多模态请求）；
   *   3) 多模态没配 Key 就退回当前生效的主配置。
   * 模型名留空时走 2) / 3)。API Key 只留在主进程，不下发到渲染层。
   */
  async tableOcrConfig(model: string): Promise<MultimodalConfig> {
    const ctx: Context = this.ctx()
    const wanted: string = model.trim()
    if (wanted !== '') {
      const { profiles } = await this.readApiProfiles(ctx)
      const matched = profiles.find(
        (p) => p.apiConfig.model === wanted || p.apiConfig.models.indexOf(wanted) >= 0
      )
      if (matched !== undefined && matched.apiConfig.apiKey !== '') {
        const fromProfile: MultimodalConfig = MultimodalConfig.default()
        fromProfile.baseUrl = matched.apiConfig.baseUrl
        fromProfile.apiKey = matched.apiConfig.apiKey
        fromProfile.model = wanted
        return fromProfile
      }
    }
    const mm: MultimodalConfig = await StorageManager.loadMultimodalConfig(ctx).catch(
      (): MultimodalConfig => MultimodalConfig.default()
    )
    if (mm.apiKey !== '') {
      return mm
    }
    const api: ApiConfig | null = await StorageManager.loadApiConfig(ctx).catch(
      (): ApiConfig | null => null
    )
    if (api !== null && api.apiKey !== '') {
      const fallback: MultimodalConfig = MultimodalConfig.default()
      fallback.baseUrl = api.baseUrl
      fallback.apiKey = api.apiKey
      fallback.model = api.model
      return fallback
    }
    throw new Error('请先在设置里配置多模态解析 API 或至少一套 API 配置')
  }

  /**
   * 会话的产物汇总（原版对话流末尾的 Codex 风格 Changes 卡）。
   *
   * 汇总逻辑直接用已移植的 `WorkArtifactUtil.collect` —— 它在桌面端此前**零引用**
   * （连 core 内部都没有人 import），于是「这一轮产出了/改了哪些文件、各加了多少行」
   * 在界面上完全看不到，用户只能去工作区列表里自己找。
   */
  workArtifacts(conversationId: string): WorkArtifactsDto {
    const conv: Conversation | undefined = this.find(conversationId)
    if (conv === undefined) {
      return { files: [], totalAdds: 0, totalDels: 0 }
    }
    const summary: WorkArtifactSummary = WorkArtifactUtil.collect(conv.messages)
    return {
      files: summary.files.map((file) => ({
        path: file.path,
        hasDiff: file.hasDiff,
        adds: file.adds,
        dels: file.dels,
        rows: SessionManager.diffPreviewRows(file)
      })),
      totalAdds: summary.totalAdds,
      totalDels: summary.totalDels
    }
  }

  /** diff 缩略：最多 8 行（对齐原版 WorkArtifactsCard.diffPreviewRows 的上限） */
  private static diffPreviewRows(file: WorkArtifactFile): ArtifactDiffRowDto[] {
    const rows: ArtifactDiffRowDto[] = []
    const diff: FileDiff | null = file.diff
    if (diff === null) {
      return rows
    }
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (rows.length >= 8) {
          return rows
        }
        rows.push({ type: line.type, text: line.text })
      }
    }
    return rows
  }

  /**
   * 解析推理强度。
   *
   * 请求里给了合法取值就用它（原版按形态分档：工作 Max/High/Low，交互 High/Low/Off）；
   * 否则退回按「深度思考」开关推的默认值（开着 high、关掉 none）——
   * 这也是桌面端此前**唯一**的行为：写死，于是工作模式永远拿不到 Max 档。
   */
  private static resolveEffort(request: { thinkingEnabled: boolean; reasoningEffort?: string }): string {
    const asked: string | undefined = request.reasoningEffort
    if (asked !== undefined && REASONING_EFFORTS.includes(asked)) {
      return asked
    }
    return request.thinkingEnabled ? 'high' : 'none'
  }

  private static toApiConfigDto(config: ApiConfig): ApiConfigDto {
    return {
      provider: config.provider,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      models: ApiConfig.normalizeModels(config.models, config.model),
      temperature: config.temperature ?? 0,
      topP: config.topP ?? 0,
      maxTokens: config.maxTokens ?? 0,
      extraParams: config.extraBody,
      autoSuffix: config.autoSuffix
    }
  }

  static toApiProfileDto(profile: ApiProfile): ApiProfileDto {
    return {
      id: profile.id,
      name: profile.name,
      config: SessionManager.toApiConfigDto(profile.apiConfig),
      multimodalConfig: SessionManager.toMultimodalDto(profile.multimodalConfig)
    }
  }

  static fromApiConfigDto(dto: ApiConfigDto): ApiConfig {
    const config: ApiConfig = new ApiConfig()
    config.provider = ApiConfig.normalizeProvider(dto.provider)
    config.baseUrl = dto.baseUrl
    config.apiKey = dto.apiKey
    config.model = dto.model
    config.models = ApiConfig.normalizeModels(dto.models, dto.model)
    config.temperature = dto.temperature > 0 ? dto.temperature : null
    config.topP = dto.topP > 0 ? dto.topP : null
    config.maxTokens = dto.maxTokens > 0 ? dto.maxTokens : null
    config.extraBody = dto.extraParams
    // 只认显式的 false：老渲染层不带这个字段时不能把它当成「关掉」
    // （默认开启，见 ApiConfig.autoSuffix 的说明）
    config.autoSuffix = dto.autoSuffix !== false
    return config
  }

  static toMultimodalDto(config: MultimodalConfig): MultimodalConfigDto {
    return {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      preparseEnabled: config.preparseEnabled
    }
  }

  static fromMultimodalDto(dto: MultimodalConfigDto): MultimodalConfig {
    const config: MultimodalConfig = MultimodalConfig.default()
    config.baseUrl = dto.baseUrl
    config.apiKey = dto.apiKey
    config.model = dto.model
    config.preparseEnabled = dto.preparseEnabled
    return config
  }
}
