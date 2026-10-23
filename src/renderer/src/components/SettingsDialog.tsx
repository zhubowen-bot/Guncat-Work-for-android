import { useEffect, useState } from 'react'
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
import { IconChevronDown, IconClose } from '../icons'
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
    baseUrlPlaceholder: 'https://api.anthropic.com/v1 或 https://api.deepseek.com',
    modelPlaceholder: 'deepseek-v4-pro / deepseek-v4-flash / claude-...',
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
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
}

/**
 * 保存前的规整（对齐原版 buildConfig() 854-866）：所有字符串 trim 后再落盘。
 * 用户从别处复制粘贴地址/密钥时经常带上首尾空格与换行，直接存下去会让请求
 * 以「看似填了其实无效」的方式失败（URL 带空格、Authorization 头带换行）。
 */
export function normalizeApiConfig(draft: ApiConfigDto): ApiConfigDto {
  return {
    ...draft,
    provider: draft.provider.trim(),
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey.trim(),
    model: draft.model.trim(),
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

/**
 * 可折叠小节（对齐原版 SettingsPanel 的 buildAdvancedSection / buildSearchSection /
 * buildMultimodalSection）：整行标题可点，右侧开合指示跟随开合旋转。
 *
 * 为什么用 SVG 而不是原版那两个实心三角字符：
 * scripts/check-emoji.mjs 把几何图形区段（U+25A0-U+25FF）当作「符号当图标」拦下来，
 * 渲染层必须用 icons/index.tsx 里的组件；旋转写法与 Sidebar 的「聊天引擎」一致。
 */
function SettingsSection(props: {
  title: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="settings-section">
      <button
        type="button"
        className="settings-section__head"
        aria-expanded={props.open}
        title={props.open ? `收起${props.title}` : `展开${props.title}`}
        onClick={props.onToggle}
      >
        <span className="settings-section__title">{props.title}</span>
        <span className="settings-section__caret" data-open={props.open}>
          <IconChevronDown size={12} />
        </span>
      </button>
      {props.open ? <div className="settings-section__body">{props.children}</div> : null}
    </div>
  )
}

export interface SettingsDialogProps {
  /**
   * 覆盖「是否打开」。平时不传，由 store 的 settingsOpen 决定。
   * 之所以提成 props：SSR 断言里 zustand 只会读到初始状态（settingsOpen=false），
   * 面板会整块不渲染，无头环境就钉不住「三个小节默认收起」这类首帧口径。
   */
  open?: boolean
}

export function SettingsDialog({ open: openOverride }: SettingsDialogProps = {}) {
  const storeOpen = useStore((s) => s.settingsOpen)
  const open = openOverride ?? storeOpen
  const openSettings = useStore((s) => s.openSettings)
  const settings = useStore((s) => s.settings)
  const reloadSettings = useStore((s) => s.reloadSettings)
  const pushNotice = useStore((s) => s.pushNotice)
  // 自动朗读的状态与开关都在 speechStore 里（持久化到 reader_enabled），
  // 这里只是把它接到设置面板上，避免两处各存一份偏好。
  const autoRead = useSpeech((s) => s.autoRead)
  const setAutoRead = useSpeech((s) => s.setAutoRead)

  const [draft, setDraft] = useState<ApiConfigDto>(EMPTY)
  const [mmBaseUrl, setMmBaseUrl] = useState('')
  const [mmApiKey, setMmApiKey] = useState('')
  const [mmModel, setMmModel] = useState('')
  const [mmPreparse, setMmPreparse] = useState(true)
  const [asrBaseUrl, setAsrBaseUrl] = useState('')
  const [asrApiKey, setAsrApiKey] = useState('')
  const [asrModel, setAsrModel] = useState('')
  const [search, setSearch] = useState<SearchDraft>(EMPTY_SEARCH)
  const [engines, setEngines] = useState<SearchEngineDto[]>([])
  const [profileName, setProfileName] = useState('')
  const [saving, setSaving] = useState(false)
  // 三个可折叠小节的开合。缺省全部收起（对齐原版 advancedOpen / multimodalOpen /
  // searchOpen 的初值 false）：设置面板一打开就是「常用项 + 三个标题」，
  // 高级参数、搜索、多模态三块不抢视线。
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [multimodalOpen, setMultimodalOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  // 终端后端只在 Android 上有得选（window.GuncatShell 存在时）；桌面端整块不渲染
  const [shellOpen, setShellOpen] = useState(false)
  const [shellBack, setShellBack] = useState<ShellBackend>('bundled')
  const [shell, setShell] = useState<ShellInfo | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    setDraft(settings?.apiConfig ?? EMPTY)
    setMmBaseUrl(settings?.multimodalConfig.baseUrl ?? '')
    setMmApiKey(settings?.multimodalConfig.apiKey ?? '')
    setMmModel(settings?.multimodalConfig.model ?? '')
    setMmPreparse(settings?.multimodalConfig.preparseEnabled ?? true)
    setAsrBaseUrl(settings?.prefs?.asr_baseUrl ?? '')
    setAsrApiKey(settings?.prefs?.asr_apiKey ?? '')
    setAsrModel(settings?.prefs?.asr_model ?? '')
    setSearch(parseSearchDraft(settings?.prefs?.[LOCAL_SEARCH_PREF_KEY]))
    const current = (settings?.apiProfiles ?? []).find(
      (p) => p.id === settings?.currentApiProfileId
    )
    setProfileName(current?.name ?? '')
    // 每次打开都回到「全部收起」：原版的面板是条件渲染的，每次打开都是新组件，
    // 这里的开合状态若跨次保留，观感就与原版不一致了。
    setAdvancedOpen(false)
    setMultimodalOpen(false)
    setSearchOpen(false)
    setShellOpen(false)
    setShellBack(shellBackend())
    setShell(shellInfo())
    // 引擎目录来自主进程（单一事实来源在 core 的 LocalWebSearch）
    void window.guncat.settings
      .searchEngines()
      .then(setEngines)
      .catch(() => setEngines([]))
  }, [open, settings])

  // 首次安装内置终端要解压 90MB+，设置页开着时轮询进度；就绪后自动停
  useEffect(() => {
    if (!open || !shellBridgeAvailable() || shell?.bundledReady === true) {
      return
    }
    const timer = window.setInterval(() => setShell(shellInfo()), 1200)
    return () => window.clearInterval(timer)
  }, [open, shell?.bundledReady])

  if (!open) {
    return null
  }

  const profiles = settings?.apiProfiles ?? []
  /** 切换配置方案：主进程会把该方案写回运行时生效的配置，这里只要重新读一次设置 */
  async function switchProfile(profileId: string): Promise<void> {
    if (profileId === settings?.currentApiProfileId) {
      return
    }
    try {
      await window.guncat.settings.selectApiProfile(profileId)
      await reloadSettings()
    } catch (e) {
      pushNotice('error', `切换配置方案失败：${String(e)}`)
    }
  }

  async function addProfile(): Promise<void> {
    try {
      await window.guncat.settings.addApiProfile()
      await reloadSettings()
      pushNotice('info', '已新建配置方案（内容复制自当前方案，改名后保存即可）')
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

  async function save(): Promise<void> {
    setSaving(true)
    try {
      // 一次性保存当前配置方案（名称 + API 配置 + 多模态配置）。
      // 走这条而不是分开调 saveApiConfig / saveMultimodalConfig：
      // 方案才是这几项配置的归属，分开调会让「名称改了但没落到方案上」这类半更新出现。
      await window.guncat.settings.saveCurrentApiProfile(
        profileName.trim(),
        normalizeApiConfig(draft),
        normalizeMultimodal({
          baseUrl: mmBaseUrl,
          apiKey: mmApiKey,
          model: mmModel,
          preparseEnabled: mmPreparse
        })
      )
      await window.guncat.settings.saveString('asr_baseUrl', asrBaseUrl.trim())
      await window.guncat.settings.saveString('asr_apiKey', asrApiKey.trim())
      await window.guncat.settings.saveString('asr_model', asrModel.trim())
      await window.guncat.settings.saveString(
        LOCAL_SEARCH_PREF_KEY,
        JSON.stringify(normalizeSearch(search))
      )
      await reloadSettings()
      pushNotice('info', '设置已保存')
      openSettings(false)
    } catch (e) {
      pushNotice('error', `保存失败：${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const provider = providerCopy(draft.provider)
  const keyField = searchKeyField(search.engine)
  const baseUrlField = searchBaseUrlField(search.engine)

  return (
    <div className="overlay" onClick={() => openSettings(false)}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog__head">
          <span>设置</span>
          <button className="icon-btn" title="关闭" onClick={() => openSettings(false)}>
            <IconClose size={16} />
          </button>
        </div>

        <div className="dialog__body">
          {/* 配置方案（对齐原版 SettingsPanel 顶部的「配置方案 / 配置名称」）：
              可以并存多套 API 配置并在其间一键切换，出错时也能两套轮流试。 */}
          <div className="field field--row">
            <div>
              <label>配置方案</label>
              <select
                value={settings?.currentApiProfileId ?? ''}
                onChange={(e) => void switchProfile(e.target.value)}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>配置名称</label>
              <input
                value={profileName}
                placeholder="未命名配置"
                onChange={(e) => setProfileName(e.target.value)}
              />
            </div>
          </div>
          <div className="field field--row">
            <button className="btn" onClick={() => void addProfile()}>
              新建配置
            </button>
            <button
              className="btn btn--danger"
              disabled={profiles.length <= 1}
              title={profiles.length <= 1 ? '至少要保留一个配置方案' : '删除当前配置方案'}
              onClick={() => void removeProfile()}
            >
              删除当前配置
            </button>
          </div>

          <div className="field">
            <label>接入方式</label>
            <select value={draft.provider} onChange={(e) => update('provider', e.target.value)}>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Base URL</label>
            <input
              value={draft.baseUrl}
              placeholder={provider.baseUrlPlaceholder}
              onChange={(e) => update('baseUrl', e.target.value)}
            />
          </div>

          {/* 协议路径后缀补全开关（对齐原版 SettingsPanel）：自建网关/代理常需要关掉它 */}
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

          <div className="field">
            <label>模型</label>
            <input
              value={draft.model}
              placeholder={provider.modelPlaceholder}
              onChange={(e) => update('model', e.target.value)}
            />
          </div>

          {/* 高级模型参数（对齐原版 buildAdvancedSection 379-475）：缺省收起 */}
          <SettingsSection
            title="高级模型参数"
            open={advancedOpen}
            onToggle={() => setAdvancedOpen((v) => !v)}
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
                <div className="field__hint">数值越低回答越确定, 越高越随机。</div>
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

            <div className="field">
              <label>最大输出 Token（0 = 用服务端默认）</label>
              <input
                type="number"
                min="0"
                value={draft.maxTokens}
                onChange={(e) => update('maxTokens', Number(e.target.value))}
              />
            </div>

            {/* 额外请求参数用多行 TextArea（原版 449-458）：一段 JSON 挤在单行输入框里
                既看不全也难改，3 行高度正好容下常见的两个键。 */}
            <div className="field">
              <label>额外请求参数（JSON）</label>
              <textarea
                rows={3}
                value={draft.extraParams}
                placeholder='{"presence_penalty": 0, "frequency_penalty": 0}'
                onChange={(e) => update('extraParams', e.target.value)}
              />
              <div className="field__hint">会合并到请求体中, 适合自定义 provider 专属参数。</div>
            </div>
          </SettingsSection>

          {/* 本地联网搜索（对齐原版 buildSearchSection 589-684 的三段随引擎变化提示）：
              缺省收起 */}
          <SettingsSection
            title="本地联网搜索"
            open={searchOpen}
            onToggle={() => setSearchOpen((v) => !v)}
          >
            <div className="field__hint">{SEARCH_INTRO}</div>

            <div className="field field--row" style={{ marginTop: 10 }}>
              <div>
                <label>搜索引擎</label>
                <select
                  value={search.engine}
                  onChange={(e) => updateSearch('engine', e.target.value)}
                >
                  {engines.length === 0 ? (
                    <option value={search.engine}>{search.engine}</option>
                  ) : (
                    engines.map((engine) => (
                      <option key={engine.id} value={engine.id}>
                        {engine.label}
                      </option>
                    ))
                  )}
                </select>
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
          </SettingsSection>

          {/* 多模态解析 API（对齐原版 buildMultimodalSection 477-587）：缺省收起 */}
          <SettingsSection
            title="多模态解析 API (可选)"
            open={multimodalOpen}
            onToggle={() => setMultimodalOpen((v) => !v)}
          >
            <label className="check">
              <input
                type="checkbox"
                checked={mmPreparse}
                onChange={(e) => setMmPreparse(e.target.checked)}
              />
              <span>
                先行解析附件
                <em>
                  {mmPreparse
                    ? '开启后先由下方独立 API 解析，再将文本交给主模型'
                    : '关闭后图片和文档将直接传给当前接入方式的主模型'}
                </em>
              </span>
            </label>

            <div className="field__hint" style={{ marginBottom: 10 }}>
              默认使用 GLM-4.6V-Flash（免费API调用，请在智谱官网获取API Key），推荐使用
              Doubao-Seed-2.0-mini 等轻量多模态模型。
            </div>

            {/* 三个字段整组只在「先行解析附件」开启时显示（原版 535-578）：
                关闭时它们不参与任何请求，露在外面只会让人以为填了就会生效。 */}
            {mmPreparse ? (
              <>
                <div className="field">
                  <label>Base URL</label>
                  <input
                    value={mmBaseUrl}
                    placeholder="https://open.bigmodel.cn/api/paas/v4"
                    onChange={(e) => setMmBaseUrl(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>API Key</label>
                  <input
                    type="password"
                    value={mmApiKey}
                    placeholder="..."
                    onChange={(e) => setMmApiKey(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>模型名称</label>
                  <input
                    value={mmModel}
                    placeholder="glm-4.6v-flash"
                    onChange={(e) => setMmModel(e.target.value)}
                  />
                </div>
              </>
            ) : null}
          </SettingsSection>

          {/* 终端后端：只在 Android 上出现。切的是真机执行命令的进程环境，
              不是「显示样式」；切换后下一条 run_command 生效。 */}
          {shellBridgeAvailable() ? (
            <SettingsSection
              title="终端命令执行 (Shell)"
              open={shellOpen}
              onToggle={() => setShellOpen((v) => !v)}
            >
              <div className="field__hint" style={{ marginBottom: 10 }}>
                工作模式里的 <code>run_command</code> 默认走<b>随包内置的 Termux 用户态</b>：
                真正的 bash、coreutils、grep/sed/awk/tar，不需要另外安装 Termux。
                命令在你的会话工作区真实目录里执行，执行前的文件会先落地、执行后再同步回工作区。
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '4px 0 10px' }}>
                <button
                  className={'btn' + (shellBack === 'bundled' ? ' btn--primary' : '')}
                  onClick={() => chooseShellBackend('bundled')}
                >
                  内置终端（推荐）
                </button>
                <button
                  className={'btn' + (shellBack === 'system' ? ' btn--primary' : '')}
                  onClick={() => chooseShellBackend('system')}
                >
                  系统 Shell
                </button>
              </div>

              <div className="field__hint" style={{ marginBottom: 6 }}>
                内置终端：
                {!shell?.bundledSupported
                  ? '当前设备 ABI 不在内置范围（仅 arm64），请改用系统 Shell'
                  : shell?.bundledReady
                    ? '已就绪'
                    : shell?.bundledInstalling
                      ? `首次安装中，已解压 ${shell?.bundledExtracted ?? 0} 个文件`
                      : '未就绪'}
                {shell?.bundledError ? ` · ${shell.bundledError}` : ''}
                <br />
                系统 Shell：<code>{shell?.shell || '/system/bin/sh'}</code>
                {shell?.abi ? ` · ${shell.abi}` : ''}
                {shell?.error ? ` · ${shell.error}` : ''}
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
                <button
                  className="btn"
                  onClick={() => {
                    reinstallBundled()
                    window.setTimeout(refreshShell, 600)
                  }}
                >
                  重新安装内置终端
                </button>
                <button className="btn" onClick={refreshShell}>
                  重新检测
                </button>
              </div>

              {shellBack === 'system' ? (
                <div className="field__hint">
                  系统 Shell 用的是 Android 自带的 <code>/system/bin/sh</code> 与 toybox，
                  没有 bash 的完整特性，也没有 Python/Node/git；内置终端才带 Termux 的 Linux 工具链。
                  切换只影响之后执行的命令。
                </div>
              ) : null}
            </SettingsSection>
          ) : null}

          {/* 自动朗读开关：对应原版 ChatPage 顶栏的 autoReadEnabled。
              放在「语音输入」分隔线之前 —— 它属于朗读，不属于转写。 */}
          <label className="check">
            <input
              type="checkbox"
              checked={autoRead}
              onChange={(e) => setAutoRead(e.target.checked)}
            />
            <span>
              自动朗读回答
              <em>
                开启后每轮回答生成完会自动念一遍（音色与语速在朗读控制条里调）；
                关掉时正在念的会立刻停下
              </em>
            </span>
          </label>

          <div
            style={{
              borderTop: '1px solid var(--border)',
              margin: '18px 0 14px',
              paddingTop: 14,
              fontSize: 12,
              color: 'var(--text-muted)'
            }}
          >
            语音输入（录音转文字）
          </div>
          <div className="field__hint" style={{ marginBottom: 10, marginTop: -6 }}>
            桌面端没有端侧识别可用，走 OpenAI 兼容的 /audio/transcriptions 接口。
            留空则复用上面的「多模态解析」地址与 Key。
          </div>

          <div className="field">
            <label>转写 Base URL（可选）</label>
            <input
              value={asrBaseUrl}
              placeholder={mmBaseUrl !== '' ? `默认复用：${mmBaseUrl}` : 'https://api.openai.com/v1'}
              onChange={(e) => setAsrBaseUrl(e.target.value)}
            />
          </div>
          <div className="field">
            <label>转写 API Key（可选）</label>
            <input
              type="password"
              value={asrApiKey}
              placeholder={mmApiKey !== '' ? '默认复用多模态解析的 Key' : 'sk-…'}
              onChange={(e) => setAsrApiKey(e.target.value)}
            />
          </div>
          <div className="field">
            <label>转写模型</label>
            <input
              value={asrModel}
              placeholder="whisper-1"
              onChange={(e) => setAsrModel(e.target.value)}
            />
          </div>

          {/* 接入方式说明（原版 getHint() 828-839 的三段文案，随接入方式变化）。
              原版把它放在表单最底部、保存按钮之前，这里保持同一位置。 */}
          <div className="settings-hint">{provider.hint}</div>
        </div>

        <div className="dialog__foot">
          <button className="btn" onClick={() => openSettings(false)}>
            取消
          </button>
          <button className="btn btn--primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
