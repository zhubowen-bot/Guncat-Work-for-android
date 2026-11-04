import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ApiConfigDto,
  CredentialStateDto,
  MultimodalConfigDto,
  SearchEngineDto
} from '@ipc/contract'
// 多模态默认地址/模型与主进程 MultimodalConfig.default() 用的是同一份常量。
// 面板保存时若把这两个字段存成空串，会把默认的智谱地址与 glm-4.6v-flash 冲掉，
// 「先行解析附件」随即失效 —— 所以规整时要能拿到这里的默认值（见 normalizeMultimodal）。
import { Constants } from '@core/common/Constants'
import { useStore } from '../store'
import { useSpeech } from '../speech/speechStore'
import {
  IconArrowLeft,
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconCode,
  IconGlobe,
  IconImage,
  IconMic,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconSpeaker,
  IconTrash
} from '../icons'
import { Picker } from './Picker'
import {
  reinstallBundled,
  setShellBackend,
  shellBackend,
  shellBridgeAvailable,
  shellInfo
} from '../shellSettings'
import type { ShellBackend, ShellInfo } from '../shellSettings'

/**
 * 接入方式的文案表。三条占位符/提示逐字对齐原版 SettingsPanel.ets 的
 * getBaseUrlPlaceholder() / getModelPlaceholder() / getHint()（802-839 行）：
 * 这些字串是用户判断「这个接入方式该填什么」的唯一线索，抄漏一句就等于没对齐。
 */
export interface ProviderCopy {
  id: string
  label: string
  baseUrlPlaceholder: string
  modelPlaceholder: string
  hint: string
  /** 自动补全开关打开时拼在 Base URL 后面的协议路径后缀示例 */
  suffix: string
}

const PROVIDERS: ProviderCopy[] = [
  {
    id: 'openai-completions',
    label: 'OpenAI Completions（/chat/completions）',
    baseUrlPlaceholder: 'https://api.openai.com/v1 或 https://api.deepseek.com',
    modelPlaceholder: 'deepseek-chat / deepseek-reasoner / gpt-...',
    hint:
      '当前接入方式：OpenAI Completions，通用API接入方式，兼容大部分模型。若需要原生图片直传、' +
      '联网搜索等能力，建议切换 Responses API 或 Anthropic API 选项（需查询模型支持的方式）',
    suffix: '/chat/completions'
  },
  {
    id: 'openai-responses',
    label: 'OpenAI Responses（/responses）',
    baseUrlPlaceholder: 'https://api.deepseek.com 或 https://ark.cn-beijing.volces.com/api/v3',
    modelPlaceholder: 'deepseek-v4-flash / deepseek-v4-pro / ep-xxx',
    hint:
      '当前接入方式：OpenAI Responses， 建议支持 Responses API 的模型优先选择此选项，' +
      '以获得原生图片直传、联网搜索等能力',
    suffix: '/responses'
  },
  {
    id: 'anthropic-messages',
    label: 'Anthropic Messages（/messages）',
    baseUrlPlaceholder:
      'https://api.anthropic.com/v1、https://api.deepseek.com/anthropic 或 https://opencode.ai/inference/go',
    modelPlaceholder: 'deepseek-flash / deepseek-v4-pro / claude-...',
    hint:
      '当前接入方式：Anthropic Messages，建议支持 Anthropic API 的模型优先选择此选项，' +
      '以获得原生图片直传、联网搜索等能力',
    suffix: '/v1/messages 或 /anthropic/v1/messages'
  }
]

/** 未知接入方式时退回第一项：面板不能因为一个脏 provider 值就没有占位符与提示 */
export function providerCopy(id: string): ProviderCopy {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}

/**
 * 各引擎的搜索提示（原版 getSearchEngineHint() 757-774 行，逐字对齐）。
 * 按引擎 id 分支：引擎目录由主进程 settings:searchEngines 下发（权威表在 core 的 LocalWebSearch）。
 */
export function searchEngineHint(engine: string): string {
  switch (engine) {
    case 'bing':
      return 'Bing 无需 API Key, 直接爬取搜索结果页; 请求失败自动回落 cn.bing.com。'
    case 'tavily':
      return '默认 Base URL: https://api.tavily.com'
    case 'exa':
      return '默认 Base URL: https://api.exa.ai'
    case 'firecrawl':
      return '默认 Base URL: https://api.firecrawl.dev'
    case 'metaso':
      return '密钥在 metaso.cn 开放平台获取, 端点固定为 metaso.cn/api/v1/search。'
    default:
      return '在对应平台获取 API Key 后填入。'
  }
}

/**
 * API Key 的存储说明。措辞必须跟着主进程报上来的真实状态走：
 * 「仅保存在本机」不等于「加密保存」—— 系统没有凭据保险库时它就是明文躺在配置文件里，
 * 这时候写一句漂亮话等于替用户做了一个错的安全假设。解不开的项（换过机器、钥匙串被清空）
 * 也要点名，否则用户只会看到「Key 无效」却不知道该重新填。
 */
export function credentialHint(state: CredentialStateDto | undefined): string {
  if (state === undefined) {
    return '仅保存在本机应用数据目录，不会上传'
  }
  const lost: string =
    state.undecryptable.length > 0
      ? `有几项配置在这台机器上解不开（换过机器或系统钥匙串被清空）：${state.undecryptable.join(
          '、'
        )}，需要重新填写。`
      : ''
  if (!state.available) {
    return (
      lost +
      '注意：本机系统没有可用的凭据保险库，密钥目前明文存在配置文件里（只有这台机器能读到）。' +
      '配好系统的钥匙串/凭据管理器后会自动改为加密保存。'
    )
  }
  return (
    lost +
    '用本机系统的凭据保险库加密保存（与这台机器的登录账户绑定），配置文件里不含明文密钥，也不会上传；换到新机器需要重新填写密钥。'
  )
}

/**
 * 本地联网搜索的说明（对齐原版 SettingsPanel 592-618 的口径，改成桌面端措辞：
 * 原版写「手机直连」，桌面端就是本机直连）。
 */
const SEARCH_INTRO =
  '内置 local_web_search 工具（本机兜底搜索）：本机直连搜索引擎/搜索 API，' +
  '与服务端联网搜索开关互不影响、可同时存在。默认会优先走服务端搜索，' +
  '本机通道只在服务端搜索不可用/无结果或你明确要求时才被调用。'

/**
 * 本地联网搜索配置在偏好里的键名（存在 Preferences 里的一段 JSON）。
 * 与主进程 Constants.LS_KEY_LOCAL_SEARCH_CONFIG 必须是同一个字符串 ——
 * ipc-check 有一条断言按这个键名往返读写，改名漏改一边会被立刻抓到。
 */
const LOCAL_SEARCH_PREF_KEY = 'guncat_local_search_config'

/**
 * 本地联网搜索的可编辑字段。
 * 字段名与 core 的 SearchEngineSettings 一一对应（那份配置由它 parse/toJson），
 * 这里刻意不 import 那个模块：它依赖 `@kit.NetworkKit`，而渲染层的构建里没有 `@kit.*` 别名。
 */
interface SearchDraft {
  engine: string
  maxResults: number
  braveApiKey: string
  tavilyApiKey: string
  tavilyBaseUrl: string
  exaApiKey: string
  exaBaseUrl: string
  metasoApiKey: string
  firecrawlApiKey: string
  firecrawlBaseUrl: string
}

const EMPTY_SEARCH: SearchDraft = {
  engine: 'bing',
  maxResults: 8,
  braveApiKey: '',
  tavilyApiKey: '',
  tavilyBaseUrl: 'https://api.tavily.com',
  exaApiKey: '',
  exaBaseUrl: 'https://api.exa.ai',
  metasoApiKey: '',
  firecrawlApiKey: '',
  firecrawlBaseUrl: 'https://api.firecrawl.dev'
}

function parseSearchDraft(json: string | undefined): SearchDraft {
  if (json === undefined || json.trim() === '') {
    return { ...EMPTY_SEARCH }
  }
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...EMPTY_SEARCH }
    }
    return { ...EMPTY_SEARCH, ...(parsed as Partial<SearchDraft>) }
  } catch {
    // JSON 坏了就用默认值 —— 不能让一段坏配置卡住整个设置面板
    return { ...EMPTY_SEARCH }
  }
}

const EMPTY: ApiConfigDto = {
  provider: 'openai-completions',
  baseUrl: '',
  apiKey: '',
  model: '',
  models: [],
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
}

/**
 * 模型清单规整：去空白、去重，并把当前模型补进清单。
 * 与 core 的 ApiConfig.normalizeModels 同一口径；渲染层不 import core 的模型类
 * （那里带着落盘/迁移语义），但两条规则必须一致，否则保存一次就会丢模型。
 */
export function normalizeModelList(models: string[] | undefined, active: string): string[] {
  const result: string[] = []
  for (const raw of models ?? []) {
    const name = String(raw).trim()
    if (name !== '' && !result.includes(name)) {
      result.push(name)
    }
  }
  const current = active.trim()
  if (current !== '' && !result.includes(current)) {
    result.push(current)
  }
  return result
}

/**
 * 保存前的规整（对齐原版 buildConfig() 854-866）：所有字符串 trim 后再落盘。
 * 用户从别处复制粘贴地址/密钥时经常带上首尾空格与换行，直接存下去会让请求
 * 以「看似填了其实无效」的方式失败（URL 带空格、Authorization 头带换行）。
 */
export function normalizeApiConfig(draft: ApiConfigDto): ApiConfigDto {
  const model = draft.model.trim()
  return {
    ...draft,
    provider: draft.provider.trim(),
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey.trim(),
    model,
    models: normalizeModelList(draft.models, model),
    extraParams: draft.extraParams.trim()
  }
}

/**
 * 多模态配置的规整（对齐原版 buildMmConfig() 868-879）。
 * 关键差异：Base URL / 模型名**为空时保留默认值**，而不是存空串 ——
 * 主进程 fromMultimodalDto 是直接赋值，空串会盖掉 MultimodalConfig.default() 的
 * 智谱地址与 glm-4.6v-flash，于是「先行解析附件」开启也解析不出任何东西。
 */
export function normalizeMultimodal(draft: MultimodalConfigDto): MultimodalConfigDto {
  const baseUrl = draft.baseUrl.trim()
  const model = draft.model.trim()
  return {
    baseUrl: baseUrl === '' ? Constants.DEFAULT_MM_BASE_URL : baseUrl,
    apiKey: draft.apiKey.trim(),
    model: model === '' ? Constants.DEFAULT_MM_MODEL : model,
    preparseEnabled: draft.preparseEnabled
  }
}

/**
 * 搜索配置的规整：字符串 trim 后整体落盘。
 * Base URL 留空是**允许**的语义（占位符就写着「留空使用默认地址」，
 * core 的 LocalWebSearch.normalizeBaseUrl 会把空串回落到各引擎默认端点），
 * 所以这里只 trim，不替用户填回默认值 —— 填回去反而会覆盖掉引擎侧将来的默认变更。
 */
export function normalizeSearch(search: SearchDraft): SearchDraft {
  return {
    ...search,
    engine: search.engine.trim(),
    braveApiKey: search.braveApiKey.trim(),
    tavilyApiKey: search.tavilyApiKey.trim(),
    tavilyBaseUrl: search.tavilyBaseUrl.trim(),
    exaApiKey: search.exaApiKey.trim(),
    exaBaseUrl: search.exaBaseUrl.trim(),
    metasoApiKey: search.metasoApiKey.trim(),
    firecrawlApiKey: search.firecrawlApiKey.trim(),
    firecrawlBaseUrl: search.firecrawlBaseUrl.trim()
  }
}

type SettingsSectionId =
  | 'model'
  | 'advanced'
  | 'search'
  | 'multimodal'
  | 'autoRead'
  | 'voice'
  | 'shell'

interface SettingsNavItem {
  id: SettingsSectionId
  label: string
  hint: string
  icon: ReactNode
}

const SECTION_LEAD: Record<SettingsSectionId, string> = {
  model: '配置方案、接入方式与可用模型，修改会自动保存。',
  advanced: '采样、输出长度与额外请求参数。留 0 表示交给服务端默认值。',
  search: '本机直连搜索引擎或搜索 API，作为服务端联网搜索不可用时的兜底。',
  multimodal: '用独立的多模态模型先行解析附件，再把文本交给主模型。',
  autoRead: '每轮回答生成完成后自动朗读；音色与语速在朗读控制条中调整。',
  voice: '录音转文字使用的 OpenAI 兼容转写接口。',
  shell: '选择 run_command 使用的命令环境；切换只影响之后执行的命令。'
}

/**
 * 手机宽度下设置页改成「一级列表 → 二级详情」。
 * 用 matchMedia 与 mobile.css 共用 860px 断点，避免 JS 与样式各判一次导致错位。
 */
function useCompactSettings(): boolean {
  const [compact, setCompact] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 860px)').matches
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const query = window.matchMedia('(max-width: 860px)')
    const update = (): void => setCompact(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return compact
}

/** 统一的设置卡片：标题、说明与一组相关字段。 */
function SettingsCard(props: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="settings-card">
      <header className="settings-card__head">
        <h3>{props.title}</h3>
        {props.description !== undefined ? <p>{props.description}</p> : null}
      </header>
      <div className="settings-card__body">{props.children}</div>
    </section>
  )
}

export interface SettingsPageProps {
  /**
   * 覆盖「是否打开」。平时不传，由 store 的 settingsOpen 决定。
   * 之所以提成 props：SSR 断言里 zustand 只会读到初始状态（settingsOpen=false），
   * 页面会整块不渲染，无头环境就钉不住首帧口径。
   */
  open?: boolean
  /** 覆盖手机布局判定，只用于 SSR/预览：无头环境没有 matchMedia。 */
  compact?: boolean
}

export function SettingsPage({ open: openOverride, compact: compactOverride }: SettingsPageProps = {}) {
  const storeOpen = useStore((s) => s.settingsOpen)
  const open = openOverride ?? storeOpen
  const openSettings = useStore((s) => s.openSettings)
  const settings = useStore((s) => s.settings)
  const reloadSettings = useStore((s) => s.reloadSettings)
  const pushNotice = useStore((s) => s.pushNotice)
  // 自动朗读的状态与开关都在 speechStore 里（持久化到 reader_enabled），
  // 这里只是把它接到设置页上，避免两处各存一份偏好。
  const autoRead = useSpeech((s) => s.autoRead)
  const setAutoRead = useSpeech((s) => s.setAutoRead)

  const detectedCompact = useCompactSettings()
  const compact = compactOverride ?? detectedCompact
  const [section, setSection] = useState<SettingsSectionId>('model')
  // 手机端一级列表 / 二级详情的切换；桌面端两项同时显示，这个值不参与布局。
  const [detailOpen, setDetailOpen] = useState(false)
  const [draft, setDraft] = useState<ApiConfigDto>(EMPTY)
  const [mmBaseUrl, setMmBaseUrl] = useState('')
  const [mmApiKey, setMmApiKey] = useState('')
  const [mmModel, setMmModel] = useState('')
  const [mmPreparse, setMmPreparse] = useState(false)
  const [asrBaseUrl, setAsrBaseUrl] = useState('')
  const [asrApiKey, setAsrApiKey] = useState('')
  const [asrModel, setAsrModel] = useState('')
  const [search, setSearch] = useState<SearchDraft>(EMPTY_SEARCH)
  const [engines, setEngines] = useState<SearchEngineDto[]>([])
  const [profileName, setProfileName] = useState('')
  // 模型管理器的新模型输入框（不直接进 draft：未点「添加」前不算配置的一部分）
  const [newModel, setNewModel] = useState('')
  // 终端后端只在 Android 上有得选（window.GuncatShell 存在时）；桌面端整块不渲染
  const [shellBack, setShellBack] = useState<ShellBackend>('bundled')
  const [shell, setShell] = useState<ShellInfo | null>(null)
  // 二级菜单没有保存按钮：字段改动后短延迟落盘，离开设置页时再冲刷一次。
  const dirtyRef = useRef(false)
  const saveTimerRef = useRef<number | null>(null)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const flushRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    if (!open) {
      return
    }
    const loaded = settings?.apiConfig
    setDraft(
      loaded === null || loaded === undefined
        ? { ...EMPTY }
        : { ...loaded, models: normalizeModelList(loaded.models, loaded.model) }
    )
    setNewModel('')
    setMmBaseUrl(settings?.multimodalConfig.baseUrl ?? '')
    setMmApiKey(settings?.multimodalConfig.apiKey ?? '')
    setMmModel(settings?.multimodalConfig.model ?? '')
    setMmPreparse(settings?.multimodalConfig.preparseEnabled ?? false)
    setAsrBaseUrl(settings?.prefs?.asr_baseUrl ?? '')
    setAsrApiKey(settings?.prefs?.asr_apiKey ?? '')
    setAsrModel(settings?.prefs?.asr_model ?? '')
    setSearch(parseSearchDraft(settings?.prefs?.[LOCAL_SEARCH_PREF_KEY]))
    const current = (settings?.apiProfiles ?? []).find(
      (p) => p.id === settings?.currentApiProfileId
    )
    setProfileName(current?.name ?? '')
    setShellBack(shellBackend())
    setShell(shellInfo())
    // 引擎目录来自主进程（单一事实来源在 core 的 LocalWebSearch）
    void window.guncat.settings
      .searchEngines()
      .then(setEngines)
      .catch(() => setEngines([]))
  }, [open, settings])

  // 每次进入设置页都从「模型配置」开始，不把上次停留的选项带进新一次配置。
  useEffect(() => {
    if (open) {
      setSection('model')
      setDetailOpen(false)
    }
  }, [open])

  // 首次安装内置终端要解压 90MB+，设置页开着时轮询进度；就绪后自动停
  useEffect(() => {
    if (!open || !shellBridgeAvailable() || shell?.bundledReady === true) {
      return
    }
    const timer = window.setInterval(() => setShell(shellInfo()), 1200)
    return () => window.clearInterval(timer)
  }, [open, shell?.bundledReady])

  /** 文本字段用防抖：连续输入只在停顿后落盘一次，但不延迟到离开页面。 */
  function scheduleSave(): void {
    dirtyRef.current = true
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void flushRef.current()
    }, 350)
  }

  /**
   * 把当前二级菜单里的改动写回主进程。
   * 不调用 reloadSettings：那会把正在输入的模型名清空，也会让光标跳动；
   * 离开设置页时再统一重新读取，顶栏的配置名与模型随之更新。
   */
  async function flushSave(): Promise<void> {
    if (!dirtyRef.current) {
      await saveChainRef.current
      return
    }
    dirtyRef.current = false
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const snapshot = {
      name: profileName.trim(),
      config: normalizeApiConfig(draft),
      multimodal: normalizeMultimodal({
        baseUrl: mmBaseUrl,
        apiKey: mmApiKey,
        model: mmModel,
        preparseEnabled: mmPreparse
      }),
      asrBaseUrl: asrBaseUrl.trim(),
      asrApiKey: asrApiKey.trim(),
      asrModel: asrModel.trim(),
      search: normalizeSearch(search)
    }
    const task = saveChainRef.current
      .then(async () => {
        // 方案是名称 / API 配置 / 多模态配置的共同归属，必须一次写入。
        await window.guncat.settings.saveCurrentApiProfile(
          snapshot.name,
          snapshot.config,
          snapshot.multimodal
        )
        await window.guncat.settings.saveString('asr_baseUrl', snapshot.asrBaseUrl)
        await window.guncat.settings.saveString('asr_apiKey', snapshot.asrApiKey)
        await window.guncat.settings.saveString('asr_model', snapshot.asrModel)
        await window.guncat.settings.saveString(
          LOCAL_SEARCH_PREF_KEY,
          JSON.stringify(snapshot.search)
        )
      })
      .catch((e) => {
        dirtyRef.current = true
        pushNotice('error', `保存失败：${String(e)}`)
      })
    saveChainRef.current = task
    await task
  }

  // 定时器与离开前的冲刷都必须拿到最新一次渲染的 flushSave。
  useEffect(() => {
    flushRef.current = flushSave
  })

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
      }
      void flushRef.current()
    }
  }, [])

  if (!open) {
    return null
  }

  const profiles = settings?.apiProfiles ?? []
  const shellAvailable = shellBridgeAvailable()

  /** 切换配置方案：主进程会把该方案写回运行时生效的配置，这里只要重新读一次设置 */
  async function switchProfile(profileId: string): Promise<void> {
    if (profileId === settings?.currentApiProfileId) {
      return
    }
    try {
      // 切换前先冲刷当前方案的未落盘改动，否则刚改的配置名/模型会留在内存里。
      await flushSave()
      await window.guncat.settings.selectApiProfile(profileId)
      await reloadSettings()
    } catch (e) {
      pushNotice('error', `切换配置方案失败：${String(e)}`)
    }
  }

  async function addProfile(): Promise<void> {
    try {
      // 新方案会复制当前方案的内容，复制前先确保当前改动已经落盘。
      await flushSave()
      await window.guncat.settings.addApiProfile()
      await reloadSettings()
      pushNotice('info', '已新建配置方案，改名后会自动保存')
    } catch (e) {
      pushNotice('error', `新建配置方案失败：${String(e)}`)
    }
  }

  async function removeProfile(): Promise<void> {
    if (profiles.length <= 1) {
      pushNotice('warn', '至少要保留一个配置方案')
      return
    }
    const currentId = settings?.currentApiProfileId ?? ''
    if (currentId === '') {
      return
    }
    try {
      await window.guncat.settings.deleteApiProfile(currentId)
      await reloadSettings()
      pushNotice('info', '已删除当前配置方案')
    } catch (e) {
      pushNotice('error', `删除配置方案失败：${String(e)}`)
    }
  }

  function update<K extends keyof ApiConfigDto>(key: K, value: ApiConfigDto[K]): void {
    setDraft((d) => ({ ...d, [key]: value }))
    scheduleSave()
  }

  /** 添加模型并立刻设为当前模型（用户的下一步通常就是用它） */
  function addModel(): void {
    const name = newModel.trim()
    if (name === '') {
      return
    }
    setDraft((d) => ({
      ...d,
      models: normalizeModelList([...d.models, name], name),
      model: name
    }))
    setNewModel('')
    scheduleSave()
  }

  /** 删除模型；删掉的正好是当前模型时退到清单里的第一个，没有就留空 */
  function removeModel(name: string): void {
    setDraft((d) => {
      const models = d.models.filter((item) => item !== name)
      return {
        ...d,
        models,
        model: d.model === name ? (models[0] ?? '') : d.model
      }
    })
    scheduleSave()
  }

  /** 切换终端后端：立刻写同步存储（下一条命令就生效），同时落进设置偏好 */
  function chooseShellBackend(choice: ShellBackend): void {
    setShellBack(choice)
    setShellBackend(choice)
    void window.guncat.settings.saveString('shell_backend', choice)
  }

  function refreshShell(): void {
    setShell(shellInfo())
  }

  function updateSearch<K extends keyof SearchDraft>(key: K, value: SearchDraft[K]): void {
    setSearch((s) => ({ ...s, [key]: value }))
    scheduleSave()
  }

  /** 当前引擎的 Key 落在哪个字段上（与原版 SettingsPanel 的 apiKeyForEngine 同口径） */
  function searchKeyField(engine: string): keyof SearchDraft | '' {
    switch (engine) {
      case 'brave':
        return 'braveApiKey'
      case 'tavily':
        return 'tavilyApiKey'
      case 'exa':
        return 'exaApiKey'
      case 'metaso':
        return 'metasoApiKey'
      case 'firecrawl':
        return 'firecrawlApiKey'
      default:
        return ''
    }
  }

  function searchBaseUrlField(engine: string): keyof SearchDraft | '' {
    switch (engine) {
      case 'tavily':
        return 'tavilyBaseUrl'
      case 'exa':
        return 'exaBaseUrl'
      case 'firecrawl':
        return 'firecrawlBaseUrl'
      default:
        return ''
    }
  }

  /** 离开设置页：先冲刷自动保存队列，再重新读取设置，让顶栏配置名/模型同步。 */
  function leaveSettings(): void {
    void flushSave().then(() => reloadSettings())
    openSettings(false)
  }

  /** 手机端：二级页面返回一级列表；一级页面的返回才离开设置。 */
  function goBack(): void {
    if (compact && detailOpen) {
      setDetailOpen(false)
      return
    }
    leaveSettings()
  }

  function openSection(id: SettingsSectionId): void {
    setSection(id)
    setDetailOpen(true)
  }

  const provider = providerCopy(draft.provider)
  const keyField = searchKeyField(search.engine)
  const baseUrlField = searchBaseUrlField(search.engine)
  // OpenCode 网关（含 Go 套餐）要求 x-opencode-session；这里只负责把规则说清楚，
  // 真正补头由主进程的 LLMProtocol 统一做（聊天 / 工作流 / 自动审查 / 附件上传都走它）。
  const isOpencode = /^https?:\/\/opencode\.ai\/inference(?:\/|$)/i.test(draft.baseUrl.trim())

  const navItems: SettingsNavItem[] = [
    { id: 'model', label: '模型配置', hint: '方案与接入', icon: <IconBrain size={17} /> },
    { id: 'advanced', label: '高级参数', hint: '采样与请求', icon: <IconSettings size={17} /> },
    { id: 'search', label: '本地联网搜索', hint: '引擎与密钥', icon: <IconGlobe size={17} /> },
    { id: 'multimodal', label: '多模态解析', hint: '附件先行解析', icon: <IconImage size={17} /> },
    { id: 'autoRead', label: '自动朗读', hint: '回答自动播报', icon: <IconSpeaker size={17} /> },
    { id: 'voice', label: '语音输入', hint: '录音转文字', icon: <IconMic size={17} /> }
  ]
  if (shellAvailable) {
    navItems.push({
      id: 'shell',
      label: '终端执行',
      hint: '命令执行环境',
      icon: <IconCode size={17} />
    })
  }

  const activeSection = navItems.some((item) => item.id === section) ? section : 'model'
  const activeItem = navItems.find((item) => item.id === activeSection) ?? navItems[0]

  const headerTitle = compact && detailOpen ? activeItem.label : '设置'
  const headerHint = compact
    ? detailOpen
      ? '修改会自动保存'
      : '选择要修改的模块'
    : '按模块管理模型、搜索、语音与执行环境，修改自动保存'
  const showNav = !compact || !detailOpen
  const showPane = !compact || detailOpen

  return (
    <div className="settings-page" aria-label="设置">
      <header className="settings-page__head">
        <button
          type="button"
          className="icon-btn settings-page__back"
          title={compact && detailOpen ? '返回设置列表' : '返回'}
          aria-label={compact && detailOpen ? '返回设置列表' : '返回'}
          onClick={goBack}
        >
          <IconArrowLeft size={18} />
        </button>
        <div className="settings-page__heading">
          <strong>{headerTitle}</strong>
          <span>{headerHint}</span>
        </div>
      </header>

      <div className="settings-page__body" data-detail={compact ? detailOpen : true}>
        {showNav ? (
          <nav className="settings-nav" aria-label="设置选项">
            <div className="settings-nav__title">设置选项</div>
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className="settings-nav__item"
                data-active={!compact && item.id === activeSection}
                aria-current={!compact && item.id === activeSection ? 'page' : undefined}
                onClick={() => openSection(item.id)}
              >
                <span className="settings-nav__icon">{item.icon}</span>
                <span className="settings-nav__text">
                  <span>{item.label}</span>
                  <small>{item.hint}</small>
                </span>
                <span className="settings-nav__go" aria-hidden="true">
                  <IconChevronRight size={16} />
                </span>
              </button>
            ))}
          </nav>
        ) : null}

        {showPane ? (
          <div className="settings-pane" key={activeSection}>
            <div className="settings-pane__inner">
              <header className="settings-pane__head">
                <h2>{activeItem.label}</h2>
                <p>{SECTION_LEAD[activeSection]}</p>
              </header>

            {activeSection === 'model' ? (
              <>
                {/* 配置方案：可以并存多套 API 配置并在其间一键切换，出错时也能两套轮流试。 */}
                <SettingsCard
                  title="配置方案"
                  description="可以并存多套 API 配置，并在其间一键切换；新建方案会复制当前方案的内容。"
                >
                  <div className="field field--row">
                    <div>
                      <label>配置方案</label>
                      <Picker
                        variant="field"
                        ariaLabel="选择配置方案"
                        value={settings?.currentApiProfileId ?? ''}
                        options={profiles.map((p) => ({ value: p.id, label: p.name }))}
                        onChange={(value) => void switchProfile(value)}
                      />
                    </div>
                    <div>
                      <label>配置名称</label>
                      <input
                        value={profileName}
                        placeholder="未命名配置"
                        onChange={(e) => {
                          setProfileName(e.target.value)
                          scheduleSave()
                        }}
                      />
                    </div>
                  </div>
                  <div className="settings-actions">
                    <button className="btn" onClick={() => void addProfile()}>
                      <IconPlus size={15} />
                      新建配置
                    </button>
                    <button
                      className="btn btn--danger"
                      disabled={profiles.length <= 1}
                      title={profiles.length <= 1 ? '至少要保留一个配置方案' : '删除当前配置方案'}
                      onClick={() => void removeProfile()}
                    >
                      <IconTrash size={15} />
                      删除当前配置
                    </button>
                  </div>
                </SettingsCard>

                <SettingsCard
                  title="接入方式"
                  description="按服务商支持的能力选择协议；不确定时使用 OpenAI Completions。"
                >
                  <div className="field">
                    <label>接入方式</label>
                    <Picker
                      variant="field"
                      ariaLabel="选择接入方式"
                      value={draft.provider}
                      options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
                      onChange={(value) => update('provider', value)}
                    />
                  </div>

                  <div className="field">
                    <label>Base URL</label>
                    <input
                      value={draft.baseUrl}
                      placeholder={provider.baseUrlPlaceholder}
                      onChange={(e) => update('baseUrl', e.target.value)}
                    />
                    {isOpencode ? (
                      <div className="field__hint">
                        OpenCode 网关要求每个请求携带会话头 <code>x-opencode-session</code>；
                        本应用会按对话自动附带，不需要手动填写。Go 套餐的 Base URL 是
                        <code>https://opencode.ai/inference/go</code>。
                        注意：同一个方案只能用一种协议，当前按「{provider.label}」发请求。
                        deepseek-v4.1-flash 支持 Anthropic Messages 与 OpenAI Responses，
                        不支持 OpenAI Chat Completions；本预置按 Anthropic Messages 接入，
                        换协议请另建方案。
                      </div>
                    ) : null}
                  </div>

                  {/* 协议路径后缀补全开关：自建网关/代理常需要关掉它 */}
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={draft.autoSuffix}
                      onChange={(e) => update('autoSuffix', e.target.checked)}
                    />
                    <span>
                      自动补全协议路径后缀
                      <em>
                        {draft.autoSuffix
                          ? `开启后按接入方式自动拼接路径后缀（如 ${provider.suffix}）`
                          : '关闭后严格按上面填写的 Base URL 发起请求，适合非标准路径的自建网关/代理'}
                      </em>
                    </span>
                  </label>
                </SettingsCard>

                <SettingsCard
                  title="凭据与模型"
                  description="API Key 只保存在本机，不会上传；同一服务商的多个模型共用地址与 Key。"
                >
                  <div className="field">
                    <label>API Key</label>
                    <input
                      type="password"
                      value={draft.apiKey}
                      placeholder="sk-…"
                      onChange={(e) => update('apiKey', e.target.value)}
                    />
                    <div className="field__hint">{credentialHint(settings?.credentialState)}</div>
                  </div>

                  {/* 一个服务商多个模型：Base URL / Key 只配一次，模型之间点一下就切换 */}
                  <div className="field">
                    <label>模型（可添加多个）</label>
                    <div className="settings-models" role="radiogroup" aria-label="模型列表">
                      {draft.models.length === 0 ? (
                        <div className="settings-models__empty">还没有模型，先在下面添加一个</div>
                      ) : (
                        draft.models.map((name) => {
                          const active = name === draft.model
                          return (
                            <div className="settings-model" data-active={active} key={name}>
                              <button
                                type="button"
                                className="settings-model__pick"
                                role="radio"
                                aria-checked={active}
                                title={active ? '当前模型' : `切换到 ${name}`}
                                onClick={() => update('model', name)}
                              >
                                <span className="settings-model__name">{name}</span>
                                {active ? (
                                  <span className="settings-model__badge">
                                    <IconCheck size={11} />
                                    当前
                                  </span>
                                ) : null}
                              </button>
                              <button
                                type="button"
                                className="icon-btn settings-model__remove"
                                title={`删除模型 ${name}`}
                                onClick={() => removeModel(name)}
                              >
                                <IconTrash size={14} />
                              </button>
                            </div>
                          )
                        })
                      )}
                    </div>
                    <div className="settings-model-add">
                      <input
                        value={newModel}
                        placeholder={provider.modelPlaceholder}
                        aria-label="要添加的模型名称"
                        onChange={(e) => setNewModel(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addModel()
                          }
                        }}
                      />
                      <button className="btn" onClick={addModel} disabled={newModel.trim() === ''}>
                        添加模型
                      </button>
                    </div>
                    <div className="field__hint">
                      点模型行把它设为当前模型；发送时使用当前模型。
                    </div>
                  </div>
                </SettingsCard>

                {/* 接入方式说明（原版 getHint() 828-839 的三段文案，随接入方式变化）。 */}
                <div className="settings-note">{provider.hint}</div>
              </>
            ) : null}

            {activeSection === 'advanced' ? (
              <>
                <SettingsCard
                  title="采样参数"
                  description="数值越低回答越确定，越高越随机；0 表示使用服务端默认值。"
                >
                  <div className="field field--row">
                    <div>
                      <label>Temperature（0 = 用服务端默认）</label>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        max="2"
                        value={draft.temperature}
                        onChange={(e) => update('temperature', Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <label>Top P（0 = 用服务端默认）</label>
                      <input
                        type="number"
                        step="0.05"
                        min="0"
                        max="1"
                        value={draft.topP}
                        onChange={(e) => update('topP', Number(e.target.value))}
                      />
                    </div>
                  </div>
                </SettingsCard>

                <SettingsCard
                  title="输出与请求"
                  description="限制单次回答长度，或为特定服务商追加请求参数。"
                >
                  <div className="field">
                    <label>最大输出 Token（0 = 用服务端默认）</label>
                    <input
                      type="number"
                      min="0"
                      value={draft.maxTokens}
                      onChange={(e) => update('maxTokens', Number(e.target.value))}
                    />
                  </div>

                  <div className="field">
                    <label>额外请求参数（JSON）</label>
                    <textarea
                      rows={3}
                      value={draft.extraParams}
                      placeholder='{"presence_penalty": 0, "frequency_penalty": 0}'
                      onChange={(e) => update('extraParams', e.target.value)}
                    />
                    <div className="field__hint">
                      会合并到请求体中, 适合自定义 provider 专属参数。
                    </div>
                  </div>
                </SettingsCard>
              </>
            ) : null}

            {activeSection === 'search' ? (
              <>
                <div className="settings-note">{SEARCH_INTRO}</div>
                <SettingsCard
                  title="搜索引擎"
                  description="选择本机直连的搜索通道；不同引擎的密钥与端点各自独立。"
                >
                  <div className="field field--row">
                    <div>
                      <label>搜索引擎</label>
                      <Picker
                        variant="field"
                        ariaLabel="选择搜索引擎"
                        value={search.engine}
                        options={
                          engines.length === 0
                            ? [{ value: search.engine, label: search.engine }]
                            : engines.map((engine) => ({ value: engine.id, label: engine.label }))
                        }
                        onChange={(value) => updateSearch('engine', value)}
                      />
                    </div>
                    <div>
                      <label>单次结果条数</label>
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={search.maxResults}
                        onChange={(e) => updateSearch('maxResults', Number(e.target.value))}
                      />
                    </div>
                  </div>

                  {keyField !== '' ? (
                    <div className="field">
                      <label>API Key</label>
                      <input
                        type="password"
                        value={String(search[keyField])}
                        placeholder="当前搜索引擎的 API Key"
                        onChange={(e) => updateSearch(keyField, e.target.value)}
                      />
                    </div>
                  ) : null}

                  {baseUrlField !== '' ? (
                    <div className="field">
                      <label>Base URL（可选）</label>
                      <input
                        value={String(search[baseUrlField])}
                        placeholder="留空使用默认地址"
                        onChange={(e) => updateSearch(baseUrlField, e.target.value)}
                      />
                    </div>
                  ) : null}

                  <div className="field__hint">{searchEngineHint(search.engine)}</div>
                </SettingsCard>
              </>
            ) : null}

            {activeSection === 'multimodal' ? (
              <>
                <SettingsCard
                  title="附件先行解析"
                  description="默认关闭。开启后，图片与文档先交给独立的多模态模型解析，再把文本交给主模型。"
                >
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={mmPreparse}
                      onChange={(e) => {
                        setMmPreparse(e.target.checked)
                        scheduleSave()
                      }}
                    />
                    <span>
                      先行解析附件
                      <em>
                        {mmPreparse
                          ? '已开启：先由下方独立 API 解析，再将文本交给主模型'
                          : '已关闭：图片和文档将直接传给当前接入方式的主模型'}
                      </em>
                    </span>
                  </label>

                  <div className="field__hint">
                    默认使用 GLM-4.6V-Flash（免费API调用，请在智谱官网获取API Key），推荐使用
                    Doubao-Seed-2.0-mini 等轻量多模态模型。
                  </div>
                </SettingsCard>

                {/* 三个字段整组只在「先行解析附件」开启时显示：
                    关闭时它们不参与任何请求，露在外面只会让人以为填了就会生效。 */}
                {mmPreparse ? (
                  <SettingsCard
                    title="解析服务"
                    description="该服务只用于附件解析，与上方主模型配置相互独立。"
                  >
                    <div className="field">
                      <label>Base URL</label>
                      <input
                        value={mmBaseUrl}
                        placeholder="https://open.bigmodel.cn/api/paas/v4"
                        onChange={(e) => {
                          setMmBaseUrl(e.target.value)
                          scheduleSave()
                        }}
                      />
                    </div>
                    <div className="field">
                      <label>API Key</label>
                      <input
                        type="password"
                        value={mmApiKey}
                        placeholder="..."
                        onChange={(e) => {
                          setMmApiKey(e.target.value)
                          scheduleSave()
                        }}
                      />
                    </div>
                    <div className="field">
                      <label>模型名称</label>
                      <input
                        value={mmModel}
                        placeholder="glm-4.6v-flash"
                        onChange={(e) => {
                          setMmModel(e.target.value)
                          scheduleSave()
                        }}
                      />
                    </div>
                  </SettingsCard>
                ) : null}
              </>
            ) : null}

            {activeSection === 'autoRead' ? (
              <SettingsCard
                title="朗读行为"
                description="只在一轮回答生成完成时触发，不影响历史消息。"
              >
                <label className="check">
                  <input
                    type="checkbox"
                    checked={autoRead}
                    onChange={(e) => setAutoRead(e.target.checked)}
                  />
                  <span>
                    开启自动朗读
                    <em>
                      开启后每轮回答生成完会自动念一遍（音色与语速在朗读控制条里调）；
                      关掉时正在念的会立刻停下
                    </em>
                  </span>
                </label>
              </SettingsCard>
            ) : null}

            {activeSection === 'voice' ? (
              <>
                <div className="settings-note">
                  当前版本没有端侧识别可用，走 OpenAI 兼容的 /audio/transcriptions 接口。
                  留空则复用「多模态解析」的地址与 Key。
                </div>
                <SettingsCard
                  title="转写服务"
                  description="三个字段都可留空；留空时按占位提示回落到多模态解析配置。"
                >
                  <div className="field">
                    <label>转写 Base URL（可选）</label>
                    <input
                      value={asrBaseUrl}
                      placeholder={
                        mmBaseUrl !== '' ? `默认复用：${mmBaseUrl}` : 'https://api.openai.com/v1'
                      }
                      onChange={(e) => {
                        setAsrBaseUrl(e.target.value)
                        scheduleSave()
                      }}
                    />
                  </div>
                  <div className="field">
                    <label>转写 API Key（可选）</label>
                    <input
                      type="password"
                      value={asrApiKey}
                      placeholder={mmApiKey !== '' ? '默认复用多模态解析的 Key' : 'sk-…'}
                      onChange={(e) => {
                        setAsrApiKey(e.target.value)
                        scheduleSave()
                      }}
                    />
                  </div>
                  <div className="field">
                    <label>转写模型</label>
                    <input
                      value={asrModel}
                      placeholder="whisper-1"
                      onChange={(e) => {
                        setAsrModel(e.target.value)
                        scheduleSave()
                      }}
                    />
                  </div>
                </SettingsCard>
              </>
            ) : null}

            {activeSection === 'shell' && shellAvailable ? (
              <>
                <div className="settings-note">
                  工作模式里的 <code>run_command</code> 默认走<b>随包内置的 Termux 用户态</b>：
                  真正的 bash、coreutils、grep/sed/awk/tar，不需要另外安装 Termux。
                  命令在你的会话工作区真实目录里执行，执行前的文件会先落地、执行后再同步回工作区。
                </div>

                <SettingsCard
                  title="执行后端"
                  description="切换后下一条命令生效；两种后端使用同一份工作区镜像。"
                >
                  <div className="settings-segment" role="radiogroup" aria-label="终端后端">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={shellBack === 'bundled'}
                      data-active={shellBack === 'bundled'}
                      onClick={() => chooseShellBackend('bundled')}
                    >
                      <span>内置终端</span>
                      <small>随包 Termux 用户态</small>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={shellBack === 'system'}
                      data-active={shellBack === 'system'}
                      onClick={() => chooseShellBackend('system')}
                    >
                      <span>系统 Shell</span>
                      <small>Android 自带 /system/bin/sh</small>
                    </button>
                  </div>

                  <dl className="settings-kv">
                    <div>
                      <dt>内置终端</dt>
                      <dd>
                        {!shell?.bundledSupported
                          ? '当前设备 ABI 不在内置范围（仅 arm64），请改用系统 Shell'
                          : shell?.bundledReady
                            ? '已就绪'
                            : shell?.bundledInstalling
                              ? `首次安装中，已解压 ${shell?.bundledExtracted ?? 0} 个文件`
                              : '未就绪'}
                        {shell?.bundledError ? ` · ${shell.bundledError}` : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>系统 Shell</dt>
                      <dd>
                        <code>{shell?.shell || '/system/bin/sh'}</code>
                        {shell?.abi ? ` · ${shell.abi}` : ''}
                        {shell?.error ? ` · ${shell.error}` : ''}
                      </dd>
                    </div>
                  </dl>

                  <div className="settings-actions">
                    <button
                      className="btn"
                      onClick={() => {
                        reinstallBundled()
                        window.setTimeout(refreshShell, 600)
                      }}
                    >
                      <IconRefresh size={15} />
                      重新安装内置终端
                    </button>
                    <button className="btn" onClick={refreshShell}>
                      重新检测
                    </button>
                  </div>

                  {shellBack === 'system' ? (
                    <div className="field__hint">
                      系统 Shell 用的是 Android 自带的 <code>/system/bin/sh</code> 与 toybox，
                      没有 bash 的完整特性，也没有 Python/Node/git；内置终端才带 Termux 的 Linux
                      工具链。切换只影响之后执行的命令。
                    </div>
                  ) : null}
                </SettingsCard>
              </>
            ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
