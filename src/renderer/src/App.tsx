import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { reportStage } from './bootReport'
import { Sidebar } from './components/Sidebar'
import { Composer } from './components/Composer'
import { Timeline } from './components/Timeline'
import { WorkspacePanel } from './components/WorkspacePanel'
import { Picker } from './components/Picker'
import { SettingsDialog } from './components/SettingsDialog'
import { SpeechBar } from './components/SpeechBar'
import { agentById, isVirtualAgentId } from './conversations'
import { AgentGlyph } from './components/AgentGlyph'
import { EmptyState } from './components/EmptyState'
import { WorkArtifactsCard } from './components/WorkArtifactsCard'
import { TableOcrDialog } from './components/TableOcrDialog'
import { ImageLightbox } from './components/ImageLightbox'
import { WorkspacePreviewOverlay } from './components/WorkspacePreview'
import { TransferSheet } from './components/TransferSheet'
import { useSpeech, speechTextOf } from './speech/speechStore'
import { currentModelChoice, modelChoices, parseModelChoice } from './modelChoices'
import { IconBrain, IconFolder, IconGlobe, IconSidebar, IconTable } from './icons'

/**
 * 提示条（对齐原版 ToastView + ChatPage 的 10 拍定时器）。
 *
 * 原版：1 秒自动消失、`hitTestBehavior(HitTestMode.None)`（**点击穿透**、没有关闭钮）、
 * 白字 13px、toast_bg 底、圆角 24、阴影 radius 18 / #22000000 / offsetY 6。
 * 桌面端此前挂 6 秒并带一个关闭钮 —— 那会让提示条盖住界面且必须手动关。
 *
 * 一处保留的差异：**错误**类提示沿用原版自己在错误路径上的时长
 * （`promptAction.showToast({ duration: 2500 })`，见原版朗读失败那条），
 * 因为错误信息在桌面端没有第二个可见出口，1 秒来不及读。
 */
const NOTICE_MS: Record<string, number> = { error: 2500 }

function Notice() {
  const notice = useStore((s) => s.notice)
  const dismiss = useStore((s) => s.dismissNotice)

  useEffect(() => {
    if (notice === null) {
      return
    }
    const timer = setTimeout(dismiss, NOTICE_MS[notice.level] ?? 1000)
    return () => clearTimeout(timer)
  }, [notice, dismiss])

  if (notice === null) {
    return null
  }
  return (
    <div className="notice" data-level={notice.level} role="status">
      <span>{notice.text}</span>
    </div>
  )
}

export default function App() {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const active = useStore((s) => s.active)
  const activeId = useStore((s) => s.activeId)
  const mode = useStore((s) => s.mode)
  const running = useStore((s) => s.running)
  const thinkingEnabled = useStore((s) => s.thinkingEnabled)
  const reasoningEffort = useStore((s) => s.reasoningEffort)
  const setReasoningEffort = useStore((s) => s.setReasoningEffort)
  const interactiveEffort = useStore((s) => s.interactiveEffort)
  const setInteractiveEffort = useStore((s) => s.setInteractiveEffort)
  const webSearchEnabled = useStore((s) => s.webSearchEnabled)
  const setThinking = useStore((s) => s.setThinking)
  const setWebSearch = useStore((s) => s.setWebSearch)
  const send = useStore((s) => s.send)
  const steer = useStore((s) => s.steer)
  const abort = useStore((s) => s.abort)
  const fillDraft = useStore((s) => s.fillDraft)
  const engines = useStore((s) => s.engines)
  const activeAgentId = useStore((s) => s.activeAgentId)
  const workspaceOpen = useStore((s) => s.workspaceOpen)
  const artifacts = useStore((s) => s.artifacts)
  const openTableOcr = useStore((s) => s.openTableOcr)
  const settings = useStore((s) => s.settings)
  const reloadSettings = useStore((s) => s.reloadSettings)
  const profiles = settings?.apiProfiles ?? []
  const currentProfile = profiles.find((p) => p.id === settings?.currentApiProfileId)
  const activeModel =
    currentProfile?.config.model !== undefined && currentProfile.config.model !== ''
      ? currentProfile.config.model
      : (currentProfile?.config.models?.[0] ?? '')
  const currentModelValue = currentModelChoice(
    settings?.currentApiProfileId ?? '',
    activeModel
  )
  const pushNotice = useStore((s) => s.pushNotice)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const openSidebar = useStore((s) => s.openSidebar)
  const closeSidebar = useStore((s) => s.closeSidebar)
  const toggleWorkspace = useStore((s) => s.toggleWorkspace)

  /** 顶栏模型胶囊：切换配置方案或同一方案下的模型（主进程会把结果写回运行时配置） */
  async function switchModel(value: string): Promise<void> {
    const picked = parseModelChoice(value)
    if (picked.profileId === '') {
      return
    }
    if (
      picked.profileId === settings?.currentApiProfileId &&
      (picked.model === '' || picked.model === activeModel)
    ) {
      return
    }
    try {
      await window.guncat.settings.selectApiProfileModel(picked.profileId, picked.model)
      await reloadSettings()
    } catch (e) {
      pushNotice('error', `切换模型失败：${String(e)}`)
    }
  }
  // 文件预览：侧栏工作区面板与对话流末尾的产物汇总卡都走这一个入口（弹层在根部渲染一份）
  const openWorkspaceFile = useStore((s) => s.openWorkspaceFile)
  // 工作区面板由「侧栏底部的『工作区』」控制，**不再按模式隐藏**：
  // 原版 ChatPage 只判 isWide && detailsOpen、不判模式 ——
  // 聊天模式下来路（拖拽 / 命令行 / 第二实例）落进该会话工作区的文件同样要能在这里看到。
  const showWorkspace = workspaceOpen

  const scrollRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const intakeFiles = useStore((s) => s.intakeFiles)

  // 自动朗读（对齐原版 ChatPage 的 autoReadEnabled）：一轮结束就把最后一条回答念出来。
  // 只看 running 由 true → false 的那一次跃迁 —— 否则打开应用、切换会话都会触发朗读。
  const autoRead = useSpeech((s) => s.autoRead)
  const speak = useSpeech((s) => s.speak)
  const wasRunning = useRef(false)
  useEffect(() => {
    const justFinished = wasRunning.current && !running
    wasRunning.current = running
    if (!autoRead || !justFinished) {
      return
    }
    const messages = active?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        const text = speechTextOf(
          messages[i].displayContent !== '' ? messages[i].displayContent : messages[i].content
        )
        if (text.trim() !== '') {
          speak(messages[i].id, text)
        }
        return
      }
    }
  }, [running, autoRead, active, speak])

  // 最新一条 assistant 才是「可交互的那一轮」
  const lastAssistantId = (() => {
    const messages = active?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        return messages[i].id
      }
    }
    return ''
  })()

  const engine = agentById(engines, activeAgentId)

  useEffect(() => {
    void init()
    // 只在挂载时初始化一次：init 内部已订阅事件并做幂等处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 启动诊断：把「React 挂载成功」与「浏览器真的产出了一帧」分开上报。
  //
  // 理由：主进程能自己观察到的最后一站是「页面加载完成」。用户机器上那一站是正常的，
  // 窗口却什么都没有 —— 说明失败发生在这之后。有了这两个信号，日志就能把
  //   DOM 就绪 / 加载完成 / React 已挂载 / 已产出首帧
  // 四个状态分开；缺哪一步，问题就锁定在哪一步：
  //   · 缺 mounted      → 界面产物没跑起来（脚本/CSP/React 抛异常，后者会走 error 上报）
  //   · 有 mounted 无 painted → React 进 DOM 了，但合成器产不出帧（光栅化被关掉等）
  useEffect(() => {
    reportStage('mounted')
    // requestAnimationFrame 只在浏览器真要产出下一帧时回调 ——
    // 它恰好是「能不能画出来」最接近的可用信号。
    const handle = window.requestAnimationFrame(() => {
      reportStage('painted')
    })
    return () => {
      window.cancelAnimationFrame(handle)
    }
  }, [])

  // 流式输出时保持滚动到底部
  const messageCount = active?.messages.length ?? 0
  const lastLength = active?.messages[active.messages.length - 1]?.content.length ?? 0
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) {
      return
    }
    // 界面块里的本地状态回传会临时冻结自动置底（用户正在拖滑块/填表时，
    // 页面突然被拽到底部是原版专门修过的问题）
    if (Date.now() < useStore.getState().scrollFreezeUntil) {
      return
    }
    // 用户正在选文字（长按拖选区）：这时候改 scrollTop 会把选区拽掉/撑开，
    // Android WebView 上表现为「选了一点、复制出来却是整段甚至全文」。
    // 选区还活着就完全不碰滚动，松手后下一帧再恢复自动置底。
    const selection = window.getSelection()
    if (selection !== null && !selection.isCollapsed) {
      return
    }
    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 160
    if (nearBottom || lastLength === 0) {
      element.scrollTop = element.scrollHeight
    }
  }, [messageCount, lastLength])

  // 切会话 / 新建会话后**无条件**回到最新一条（原版 scrollToBottomDelayed(100)：
  // 先立刻置底，再等一拍让 Markdown 完成布局后补一次）。
  // 上面那个效果按「是否贴近底部」判断，切到一个被翻到中段的旧会话时就会留在原地 ——
  // 用户看到的是一段没有上下文的中间内容。
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) {
      return
    }
    element.scrollTop = element.scrollHeight
    const timer = window.setTimeout(() => {
      if (scrollRef.current !== null) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    }, 100)
    return () => window.clearTimeout(timer)
  }, [activeId])

  if (!ready) {
    return (
      <div
        style={{
          display: 'grid',
          placeItems: 'center',
          height: '100%',
          color: 'var(--text-faint)'
        }}
      >
        正在启动…
      </div>
    )
  }

  return (
    <div
      className={
        (showWorkspace ? 'app with-workspace' : 'app') + (sidebarOpen ? ' sidebar-open' : '')
      }
      onDragOver={(e) => {
        // 只有真的拖了文件才提示；拖文本不拦截
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) {
          setDragging(false)
        }
      }}
      onDrop={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) {
          return
        }
        e.preventDefault()
        setDragging(false)
        // contextIsolation 下 File 没有 path，必须经 preload 的 webUtils 换算
        const paths: string[] = Array.from(e.dataTransfer.files)
          .map((f) => window.guncat.files.pathForFile(f))
          .filter((p) => p !== '')
        void intakeFiles(paths)
      }}
    >
      {dragging ? (
        <div className="dropzone">
          <div className="dropzone__box">松开即可把文件导入当前会话工作区</div>
        </div>
      ) : null}
      {sidebarOpen ? (
        <div className="mobile-backdrop" onClick={closeSidebar} aria-hidden="true" />
      ) : null}
      <Sidebar />

      <main className="main">
        <div className="topbar">
          <button
            className="mobile-icon-btn mobile-menu-btn"
            aria-label="打开会话列表"
            onClick={openSidebar}
          >
            <IconSidebar size={20} />
          </button>
          <div className="topbar__title">
            <strong>{active?.title || engine?.name || '新会话'}</strong>
          </div>
          <button
            className="mobile-icon-btn mobile-workspace-btn"
            aria-label={showWorkspace ? '关闭工作区' : '打开工作区'}
            data-active={showWorkspace}
            onClick={() => toggleWorkspace()}
          >
            <IconFolder size={20} />
          </button>

          {/* 能力预设（推理强度）：对齐原版 ChatPage 输入区「模型」胶囊弹层下半部分。
              档位按形态分叉，且是**两个独立字段、两个偏好键**：
                工作模式 极高(max) / 均衡(high) / 快速(low)，缺省 high；
                交互模式 均衡(high) / 快速(low) / 关闭(off)，缺省 **low**（首答速度优先）。
              此前这个值被写死在主进程里，工作模式永远拿不到 Max 档；
              交互模式的「关闭」也被错写成了 'none'。 */}
          {mode !== 'chat' ? (
            <Picker
              variant="plain"
              triggerClassName="topbar__effort"
              prefix="推理"
              title="推理强度（越高越慢，长程复杂任务建议拉满）"
              ariaLabel="选择推理强度"
              value={mode === 'interactive' ? interactiveEffort : reasoningEffort}
              disabled={running}
              options={
                mode === 'interactive'
                  ? [
                      { value: 'high', label: '均衡' },
                      { value: 'low', label: '快速' },
                      { value: 'off', label: '关闭' }
                    ]
                  : [
                      { value: 'max', label: '极高' },
                      { value: 'high', label: '均衡' },
                      { value: 'low', label: '快速' }
                    ]
              }
              onChange={(value) =>
                mode === 'interactive' ? setInteractiveEffort(value) : setReasoningEffort(value)
              }
            />
          ) : null}
          {/* 模型胶囊（对齐原版 ChatPage 输入区左下角那颗）：直接在这儿换配置，
              不必进设置。原版弹层上半部分就是配置列表 —— 这里用一个下拉等价表达。 */}
          {profiles.length > 0 ? (
            <Picker
              variant="plain"
              triggerClassName="topbar__model"
              title="当前模型（同一服务商可配多个模型，切换即换模型）"
              ariaLabel="选择模型"
              value={currentModelValue}
              disabled={running}
              options={modelChoices(profiles)}
              onChange={(value) => void switchModel(value)}
            />
          ) : null}
          {/* 表格提取：原版唯一不依赖对话的独立工具页，入口在顶栏（桌面端没有 pages/ 概念） */}
          <button
            className="toggle"
            title="表格提取（选一张表格图片，用视觉模型识别成 HTML 表格）"
            onClick={() => openTableOcr(true)}
          >
            <IconTable size={14} />
            表格提取
          </button>
          {/* 深度思考开关：**只在聊天模式给**。
              原版 ChatPage 在 agentLoopMode（工作/交互）下不渲染它 —— 那两种形态的思考由
              「智能体的默认值（效率/轻简模式默认关、专家模式默认开）」与交互模式的
              「关闭(Off)」档位决定，再多一个开关只会和档位打架。 */}
          {mode === 'chat' ? (
            <button
              className="toggle"
              data-on={thinkingEnabled}
              onClick={() => setThinking(!thinkingEnabled)}
              title="深度思考（按各协议显式控制）"
            >
              <IconBrain size={14} />
              深度思考
            </button>
          ) : null}
          <button
            className="toggle"
            data-on={webSearchEnabled}
            onClick={() => setWebSearch(!webSearchEnabled)}
            title="服务端联网搜索（本地内置搜索工具始终可用）"
          >
            <IconGlobe size={14} />
            联网搜索
          </button>
        </div>

        <div className="timeline" ref={scrollRef}>
          <div className="timeline__inner">
            {active === null || active.messages.length === 0 ? (
              <EmptyState mode={mode} engine={engine} />
            ) : (
              <>
                <Timeline
                  messages={active.messages}
                  mode={mode}
                  running={running}
                  lastAssistantId={lastAssistantId}
                  onEditToInput={fillDraft}
                />
                {/* 产物汇总卡挂在对话流末尾（对齐原版 ChatPage 把 WorkArtifactsCard
                    放在时间线之后）：聊天模式没有产物概念，不给。 */}
                {mode !== 'chat' && artifacts !== null && !running ? (
                  <WorkArtifactsCard artifacts={artifacts} onPreview={openWorkspaceFile} />
                ) : null}
              </>
            )}
          </div>
        </div>

        <Composer
          running={running}
          mode={mode}
          onSend={(text, attachmentPaths) => void send(text, attachmentPaths)}
          onSteer={steer}
          onAbort={() => void abort()}
        />
      </main>

      {showWorkspace ? <WorkspacePanel /> : null}

      {/* 文件预览弹层只渲染这一份：工作区面板与产物汇总卡点开的都是 store 里的同一个目标
          （弹层不能挤进 300 多像素宽的面板里，正文根本读不了） */}
      <WorkspacePreviewOverlay />
      {/* 导出 / 分享弹层只渲染这一份：工作区、单文件、消息 Word 共用 */}
      <TransferSheet />

      <SettingsDialog />
      <TableOcrDialog />
      <ImageLightbox />
      <SpeechBar />
      <Notice />
    </div>
  )
}
