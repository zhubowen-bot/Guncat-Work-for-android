// IPC 注册：把渲染进程的调用路由到 SessionManager，并把事件推回去。
import { ipcMain, app, shell, dialog, clipboard } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { INVOKE, EVENT } from '../ipc/contract'
import type {
  ApiConfigDto,
  ApiProfileDto,
  AppInfoDto,
  ChatRegenerateRequest,
  ChatSendRequest,
  ConversationDto,
  ConversationSummaryDto,
  GuncatEvent,
  MultimodalConfigDto,
  PickedAttachmentDto,
  RendererStage,
  TransferRequestDto,
  TransferResultDto,
  WorkspaceBinaryDto,
  WorkspaceInfoDto,
  WorkAnswerRequest,
  WorkRunRequest
} from '../ipc/contract'
import { SessionManager } from './session/SessionManager'
import { AskUserBridge, AskAnswer } from '@core/service/AskUserBridge'
import { transcribeAudio } from './asr'
import { getMainWindow, markRendererAlive } from './window'
import { bootLog, bootMark } from './bootlog'
import { getDataRoot, resourcesDir, makeTempDir } from '@core/platform/appPaths'
import { image } from '@core/platform/kit/ImageKit'
import { TableOcrService, TableOcrImage } from '@core/service/TableOcrService'
import { MultimodalConfig } from '@core/model/MultimodalConfig'
import { sanitizeTableHtml } from './sanitizeHtml'

function send(event: GuncatEvent): void {
  const window = getMainWindow()
  if (window !== null && !window.isDestroyed()) {
    window.webContents.send(EVENT, event)
  }
}

export function registerIpcHandlers(session: SessionManager): void {
  // ===== 设置 =====
  ipcMain.handle(INVOKE.settingsLoad, async () => session.loadSettings())
  ipcMain.handle(INVOKE.settingsSaveApiConfig, async (_e, dto: ApiConfigDto) => {
    await session.saveApiConfig(dto)
  })
  ipcMain.handle(INVOKE.settingsSaveApiProfiles, async (_e, profiles: ApiProfileDto[]) => {
    await session.saveApiProfiles(profiles)
  })
  // 配置方案：选中 / 新建 / 删除 / 一次性保存当前方案（对齐原版 SettingsPanel 的「配置方案」）
  ipcMain.handle(INVOKE.settingsSelectApiProfile, async (_e, profileId: string) => {
    await session.selectApiProfile(profileId)
  })
  ipcMain.handle(INVOKE.settingsAddApiProfile, async () => session.addApiProfile())
  ipcMain.handle(INVOKE.settingsDeleteApiProfile, async (_e, profileId: string) => {
    await session.deleteApiProfile(profileId)
  })
  ipcMain.handle(
    INVOKE.settingsSaveCurrentApiProfile,
    async (_e, name: string, config: ApiConfigDto, multimodal: MultimodalConfigDto) => {
      await session.saveCurrentApiProfile(name, config, multimodal)
    }
  )
  ipcMain.handle(INVOKE.settingsSaveMultimodalConfig, async (_e, dto: MultimodalConfigDto) => {
    await session.saveMultimodalConfig(dto)
  })
  ipcMain.handle(INVOKE.settingsSaveFlag, async (_e, key: string, value: boolean) => {
    await session.saveFlag(key, value)
  })
  ipcMain.handle(INVOKE.settingsSaveString, async (_e, key: string, value: string) => {
    await session.saveString(key, value)
  })
  // 本地联网搜索的引擎目录。渲染层不 import LocalWebSearch（那个模块依赖 @kit.NetworkKit，
  // 而渲染层的构建里没有 @kit.* 别名），改为在这里把引擎表报过去 —— 单一事实来源仍在 core。
  ipcMain.handle(INVOKE.settingsSearchEngines, async () => {
    const search = await import('@core/service/LocalWebSearch')
    const ids: string[] = [
      search.SEARCH_ENGINE_BING,
      search.SEARCH_ENGINE_BRAVE,
      search.SEARCH_ENGINE_TAVILY,
      search.SEARCH_ENGINE_EXA,
      search.SEARCH_ENGINE_METASO,
      search.SEARCH_ENGINE_FIRECRAWL
    ]
    return ids.map((id) => ({
      id,
      label: search.searchEngineLabel(id),
      needsApiKey: search.searchEngineNeedsApiKey(id),
      supportsBaseUrl: search.searchEngineSupportsBaseUrl(id)
    }))
  })

  // ===== 智能体 =====
  ipcMain.handle(INVOKE.agentsList, async () => session.listAgents())

  // ===== 对话 =====
  ipcMain.handle(INVOKE.conversationsLoad, async (): Promise<ConversationSummaryDto[]> => {
    await session.bootstrap()
    return session.listConversations()
  })
  ipcMain.handle(INVOKE.conversationsCreate, async (_e, agentId: string, mode: string) =>
    session.createConversation(agentId, mode)
  )
  ipcMain.handle(INVOKE.conversationsDelete, async (_e, id: string) => {
    await session.deleteConversation(id)
  })
  ipcMain.handle(INVOKE.conversationsRename, async (_e, id: string, title: string) => {
    await session.renameConversation(id, title)
  })
  ipcMain.handle('conversation:get', async (_e, id: string): Promise<ConversationDto | null> =>
    session.getConversation(id)
  )

  // ===== 聊天 / 工作模式 =====
  ipcMain.handle(INVOKE.chatSend, async (_e, request: ChatSendRequest) => {
    await session.sendChat(request)
  })
  ipcMain.handle(INVOKE.workRun, async (_e, request: WorkRunRequest) => {
    await session.runWork(request)
  })
  ipcMain.handle(INVOKE.chatAbort, async (_e, conversationId: string) => {
    session.abort(conversationId)
  })
  // 「重答」：INVOKE.chatRegenerate 在契约里早就声明了，一直没有处理器
  // （渲染进程此前也没有入口）。这里补上实现，通道名与语义都不变。
  ipcMain.handle(INVOKE.chatRegenerate, async (_e, request: ChatRegenerateRequest) => {
    await session.regenerateChat(request)
  })
  ipcMain.handle(INVOKE.workAbort, async (_e, conversationId: string) => {
    session.abort(conversationId)
  })
  /**
   * 回答一次挂起的 ask_user_question（原版 ChatViewModel.answerAsk / cancelAsk）。
   *
   * 这条通道此前只在契约里声明着、没有任何处理器 —— 因为那个工具被整个删掉了。
   * 返回布尔值表示「这次作答有没有落到一条真实挂起的提问上」：为 false 时界面应当
   * 直接收掉卡片（多半是它已经被超时/中止落定了），而不是让用户反复点。
   */
  ipcMain.handle(INVOKE.workAnswer, async (_e, request: WorkAnswerRequest): Promise<boolean> => {
    const requestId: string = request?.requestId ?? ''
    if (requestId === '') {
      return false
    }
    if (request.canceled === true) {
      return AskUserBridge.cancel(requestId)
    }
    const answer: AskAnswer = new AskAnswer()
    answer.selections = Array.isArray(request.selections) ? request.selections : []
    answer.note = typeof request.note === 'string' ? request.note : ''
    return AskUserBridge.answer(requestId, answer)
  })
  ipcMain.handle(
    INVOKE.messagePatch,
    async (_e, conversationId: string, messageId: string, content: string) => {
      await session.patchMessageContent(conversationId, messageId, content)
    }
  )

  // ===== 工作区 =====
  ipcMain.handle(INVOKE.workspaceList, async (_e, conversationId: string) =>
    session.listWorkspace(conversationId)
  )
  ipcMain.handle(INVOKE.workspaceListDir, async (_e, conversationId: string, relPath: string) =>
    session.listWorkspaceDir(conversationId, relPath ?? '')
  )
  ipcMain.handle(INVOKE.workspaceTreeText, async (_e, conversationId: string) =>
    session.workspaceTreeText(conversationId)
  )
  ipcMain.handle(INVOKE.workspaceRead, async (_e, conversationId: string, relPath: string) => {
    const full: string = resolveWorkspaceFile(session, conversationId, relPath)
    if (!fs.existsSync(full)) {
      throw new Error('文件不存在')
    }
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      throw new Error('该路径是目录')
    }
    if (stat.size > 2 * 1024 * 1024) {
      return { text: '(文件超过 2MB，未在预览面板加载，请在外部编辑器中打开)', truncated: true }
    }
    return { text: fs.readFileSync(full, 'utf8'), truncated: false }
  })
  ipcMain.handle(
    INVOKE.workspaceReadBinary,
    async (_e, conversationId: string, relPath: string): Promise<WorkspaceBinaryDto> => {
      const full: string = resolveWorkspaceFile(session, conversationId, relPath)
      if (!fs.existsSync(full)) {
        throw new Error('文件不存在')
      }
      const stat = fs.statSync(full)
      if (stat.isDirectory()) {
        throw new Error('该路径是目录')
      }
      // 内置预览走 data URL（整份进内存再 base64），上限必须比文本预览更克制
      if (stat.size > 16 * 1024 * 1024) {
        throw new Error('文件超过 16MB，请用外部程序打开')
      }
      const bytes: Buffer = fs.readFileSync(full)
      const mimeType: string = mimeTypeForFile(full)
      return {
        dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
        mimeType,
        size: stat.size
      }
    }
  )
  ipcMain.handle(INVOKE.workspaceOpenFile, async (_e, conversationId: string, relPath: string) => {
    const full: string = resolveWorkspaceFile(session, conversationId, relPath)
    if (!fs.existsSync(full)) {
      throw new Error('文件不存在')
    }
    const error: string = await shell.openPath(full)
    if (error !== '') {
      throw new Error(`系统未能打开该文件: ${error}`)
    }
  })
  ipcMain.handle(INVOKE.workspaceReveal, async (_e, conversationId: string, relPath: string) => {
    const full: string = resolveWorkspaceFile(session, conversationId, relPath)
    if (!fs.existsSync(full)) {
      throw new Error('文件不存在')
    }
    shell.showItemInFolder(full)
  })
  ipcMain.handle(INVOKE.workspaceDelete, async (_e, conversationId: string, relPath: string) => {
    const full: string = resolveWorkspaceFile(session, conversationId, relPath)
    const root: string = path.resolve(session.workspaceRoot(conversationId))
    if (full === root) {
      throw new Error('不能删除工作区根目录')
    }
    fs.rmSync(full, { recursive: true, force: true })
    send({ type: 'workspace:changed', conversationId })
  })
  ipcMain.handle(INVOKE.workspaceInfo, async (_e, conversationId: string): Promise<WorkspaceInfoDto> =>
    session.workspaceInfo(conversationId)
  )
  ipcMain.handle(INVOKE.workspacePickDirectory, async (): Promise<string | null> => {
    const window = getMainWindow()
    const result = await dialog.showOpenDialog(window ?? undefined!, {
      title: '打开文件夹作为工作区',
      buttonLabel: '用作工作区',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })
  ipcMain.handle(
    INVOKE.workspaceSetCustom,
    async (_e, conversationId: string, dir: string | null): Promise<WorkspaceInfoDto> =>
      session.setWorkspaceDirectory(conversationId, dir)
  )
  ipcMain.handle(
    INVOKE.workspaceSetCommandPermission,
    async (_e, conversationId: string, permission: string): Promise<WorkspaceInfoDto> =>
      session.setCommandPermission(conversationId, permission)
  )
  ipcMain.handle(INVOKE.workspaceClear, async (_e, conversationId: string) => {
    // 自定义工作区是用户自己的目录，「一键清空整个目录」不该出现在这条路上
    //（界面也会把按钮藏掉；这里是主进程侧的第二道闸）。
    if (session.workspaceInfo(conversationId).isCustom) {
      send({ type: 'notice', level: 'warn', text: '自定义工作区不支持一键清空，请在目录中自行管理文件' })
      return { cleared: false }
    }
    const root: string = session.workspaceRoot(conversationId)
    // 清空是不可恢复的破坏性操作，必须先确认（对齐原版 ChatViewModel.clearWorkspace
    // 的 promptAction.showDialog：标题/正文/按钮文案逐字一致）。
    // 放在主进程做而不是渲染层 window.confirm：那是 Chromium 的简陋提示框，
    // 与应用自己的弹层观感差距很大，也不受深浅色主题控制。
    const window = getMainWindow()
    const answer = await dialog.showMessageBox(window ?? undefined!, {
      type: 'warning',
      title: '清空工作区',
      message: '将删除工作区中的全部文件, 该操作不可恢复。确定继续吗?',
      buttons: ['取消', '清空'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (answer.response !== 1) {
      return { cleared: false }
    }
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(root, { recursive: true })
    send({ type: 'workspace:changed', conversationId })
    return { cleared: true }
  })
  ipcMain.handle(INVOKE.workspaceOpenInFolder, async (_e, conversationId: string) => {
    const info = session.workspaceInfo(conversationId)
    if (info.isCustom) {
      // 自定义目录失效时如实报错，不要顺手 mkdir 出一个空壳冒充用户的目录
      if (!info.exists) {
        throw new Error('工作区目录已失效：' + info.root)
      }
      await shell.openPath(info.root)
      return
    }
    fs.mkdirSync(info.root, { recursive: true })
    await shell.openPath(info.root)
  })
  ipcMain.handle(INVOKE.workspaceExportZip, async (_e, conversationId: string) => {
    const window = getMainWindow()
    const result = await dialog.showSaveDialog(window ?? undefined!, {
      title: '导出工作区',
      defaultPath: `guncat-workspace-${conversationId}.zip`,
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    })
    if (result.canceled || result.filePath === undefined) {
      return { saved: false }
    }
    const { WorkFileService } = await import('@core/service/WorkFileService')
    const { appContext } = await import('@core/platform/kit/AbilityKit')
    const bytes: Uint8Array = WorkFileService.zipWorkspace(appContext(), conversationId)
    fs.writeFileSync(result.filePath, bytes)
    return { saved: true, path: result.filePath }
  })

  /**
   * 统一导出 / 分享（工作区压缩包 / 单个文件 / 一条回答的 Word）。
   *
   * save：先弹系统保存位置选择 —— 这既是确认环节，也让用户自己决定落在哪。
   * share：留一份副本到下载目录、路径进剪贴板并在资源管理器里定位（桌面没有系统分享面板）。
   */
  ipcMain.handle(
    INVOKE.fileTransfer,
    async (_e, request: TransferRequestDto): Promise<TransferResultDto> => {
      let payload: TransferPayload
      try {
        payload = await buildTransferPayload(session, request)
      } catch (e) {
        return { status: 'error', message: String(e instanceof Error ? e.message : e) }
      }
      if (request.action === 'share') {
        try {
          return shareOnDesktop(payload)
        } catch (e) {
          return { status: 'error', message: String(e instanceof Error ? e.message : e) }
        }
      }
      const window = getMainWindow()
      const ext: string = path.extname(payload.name).replace(/^\./, '')
      const result = await dialog.showSaveDialog(window ?? undefined!, {
        title: '选择保存位置',
        defaultPath: payload.name,
        buttonLabel: '保存',
        filters: ext === '' ? [] : [{ name: ext.toUpperCase(), extensions: [ext] }]
      })
      if (result.canceled || result.filePath === undefined) {
        return { status: 'canceled' }
      }
      try {
        fs.writeFileSync(result.filePath, payload.bytes)
        return { status: 'saved', path: result.filePath }
      } catch (e) {
        return { status: 'error', message: String(e instanceof Error ? e.message : e) }
      }
    }
  )

  // ===== 端侧增强 =====

  /** 文件收件：拖拽 / 命令行 / 系统「打开方式」进来的文件导入当前会话工作区 */
  ipcMain.handle(INVOKE.intakeImport, async (_e, conversationId: string, paths: string[]) => {
    return await session.intakePaths(conversationId, paths)
  })

  /**
   * 工作区「上传」按钮：弹系统文件选择框，再把选中的文件导入工作区。
   * 与拖拽走的是同一条落盘链路（session.intakePaths），只是入口换成了看得见的按钮。
   */
  ipcMain.handle(INVOKE.intakePickFiles, async (_e, conversationId: string) => {
    const window = getMainWindow()
    const result = await dialog.showOpenDialog(window ?? undefined!, {
      title: '上传文件到工作区',
      buttonLabel: '上传',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { names: [], imported: 0, failed: [], canceled: true }
    }
    const outcome = await session.intakePaths(conversationId, result.filePaths)
    return { ...outcome, canceled: false }
  })

  /** 把一条回答导出为 Word（复用移植的 DocxBuilder，含 LaTeX → OMML） */
  ipcMain.handle(
    INVOKE.messageExportDocx,
    async (_e, conversationId: string, messageId: string, suggestedName?: string) => {
      const window = getMainWindow()
      const result = await dialog.showSaveDialog(window ?? undefined!, {
        title: '导出为 Word',
        defaultPath: suggestedName !== undefined && suggestedName !== '' ? suggestedName : 'Guncat 回答.docx',
        filters: [{ name: 'Word 文档', extensions: ['docx'] }]
      })
      if (result.canceled || result.filePath === undefined) {
        return { saved: false }
      }
      const bytes: Uint8Array = await session.exportMessageDocx(conversationId, messageId)
      fs.writeFileSync(result.filePath, bytes)
      return { saved: true, path: result.filePath }
    }
  )

  /** 语音输入：把录音字节送到转写接口 */
  ipcMain.handle(
    INVOKE.asrTranscribe,
    async (_e, audio: Uint8Array | ArrayBuffer, mime: string) => {
      const bytes: Uint8Array =
        audio instanceof Uint8Array ? audio : new Uint8Array(audio as ArrayBuffer)
      return await transcribeAudio(bytes, mime ?? '')
    }
  )

  // ===== 附件（聊天模式的图片/文档直传） =====
  //
  // 这里只负责「选哪些文件」并给出预览所需的信息；真正的读取与解析放在
  // SessionManager —— 多模态配置、API Key 与 Files API 上传都在主进程那条路上。
  //
  // 口径（对齐原版 enqueueFiles）：**选完就把卡片给渲染层**，解析在后台逐个进行。
  // 早先这里只返回文件信息、把解析整段留到发送时，用户看不到「解析中/已就绪/解析失败」，
  // 也就无法在发送前知道这份文件到底能不能用。
  ipcMain.handle(INVOKE.attachmentsPick, async () => {
    const window = getMainWindow()
    const result = await dialog.showOpenDialog(window ?? undefined!, {
      title: '选择要发送的图片或文档',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        {
          name: '文档',
          extensions: [
            'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
            'txt', 'md', 'csv', 'json', 'log', 'yaml', 'yml'
          ]
        },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled) {
      return []
    }
    const picked: PickedAttachmentDto[] = await Promise.all(
      result.filePaths.map(async (filePath) => ({
        path: filePath,
        name: path.basename(filePath),
        size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
        thumbnail: await makeAttachmentThumbnail(filePath),
        status: 'parsing' as const
      }))
    )
    // 刻意**不 await** 解析：一 await 就成了「等解析完才返回」——
    // 多模态解析要几秒，卡片会一直不出现（正是本次要修掉的行为）。
    // 每个文件解析完，主进程会推 attachment:parsed 事件。
    void session.preparseAttachments(picked.map((a) => a.path))
    return picked
  })

  // ===== 插话（工作模式执行中补充要求） =====
  // 返回是否被接受：不在跑的时候渲染层改走普通发送，
  // 免得文本挂在队列里等下一次任务。
  ipcMain.handle(INVOKE.workSteer, async (_e, conversationId: string, text: string) =>
    session.steerWork(conversationId, text)
  )

  // ===== 任务统计与当前目标（原版 DetailsPanelView 的统计卡 + 目标卡） =====
  ipcMain.handle(INVOKE.conversationStats, async (_e, conversationId: string) =>
    session.conversationStats(conversationId)
  )

  // ===== 产物汇总（对话流末尾的 Codex 风格 Changes 卡） =====
  ipcMain.handle(INVOKE.conversationArtifacts, async (_e, conversationId: string) =>
    session.workArtifacts(conversationId)
  )

  // ===== 表格提取（原版唯一不依赖对话的独立工具页） =====
  //
  // 桌面端此前完全没有这个功能：`TableOcrService` 零引用，也没有任何界面入口。
  // 这里只负责「选图」与「跑识别」——识别用的连接信息在主进程按模型名解析，
  // API Key 不必经过渲染层。
  ipcMain.handle(INVOKE.tableOcrPickImage, async () => {
    const window = getMainWindow()
    const result = await dialog.showOpenDialog(window ?? undefined!, {
      title: '选择要提取表格的图片',
      buttonLabel: '选择',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    const filePath: string = result.filePaths[0]
    return {
      path: filePath,
      name: path.basename(filePath),
      size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
      thumbnail: await makeAttachmentThumbnail(filePath)
    }
  })

  ipcMain.handle(INVOKE.tableOcrRun, async (_e, imagePath: string, model: string) => {
    if (!fs.existsSync(imagePath)) {
      throw new Error('图片不存在，请重新选择')
    }
    const config: MultimodalConfig = await session.tableOcrConfig(model)
    const bytes: ArrayBuffer = (() => {
      const buffer: Buffer = fs.readFileSync(imagePath)
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      ) as ArrayBuffer
    })()
    // 压缩在识别之前（原版 TableOcrPage 的顺序）：长边超 2500px 等比缩小并转 JPEG
    const compressed: TableOcrImage = await TableOcrService.compressImage(bytes)
    const raw: string = await TableOcrService.recognizeImage(config, compressed)
    return { html: sanitizeTableHtml(TableOcrService.cleanHtml(raw)), model: config.model }
  })

  // ===== 应用信息 =====
  ipcMain.handle(INVOKE.appInfo, async (): Promise<AppInfoDto> => {
    return {
      version: app.getVersion(),
      dataRoot: getDataRoot(),
      resourcesRoot: resourcesDir(),
      platform: process.platform,
      electron: process.versions.electron
    }
  })

  // ===== 启动诊断：渲染进程自报走到了哪一步 =====
  //
  // 为什么非要有这条：主进程能自己观察到的最后一站是「页面加载完成」。
  // 页面加载完成 ≠ React 挂载成功 ≠ 界面真的画出来了 ——
  // 用户机器上现在就卡在这三者之间：dom-ready 与 did-finish-load 都触发了，
  // 窗口里却什么都没有，而主进程这边一条报错都没有。
  // 只有渲染进程主动上报，日志才能把这三态区分开。
  ipcMain.handle(
    INVOKE.appRendererStage,
    async (_e, stage: RendererStage, detail?: string): Promise<void> => {
      if (stage === 'mounted') {
        markReported('mounted', 'REACT_MOUNTED', '界面已渲染（React 已挂载）')
        markRendererAlive()
        return
      }
      if (stage === 'painted') {
        markReported('painted', 'FRAME_PAINTED', '首帧已产出（浏览器已提交一帧）')
        markRendererAlive()
        return
      }
      if (stage === 'error') {
        markReported('error', 'REACT_ERROR', `✗ React 渲染出错: ${String(detail ?? '').slice(0, 2000)}`)
        return
      }
      bootLog(`无法识别的渲染进程阶段上报: ${String(stage)}`)
    }
  )
}

/** 同一步骤只记一次（React 严格模式下 effect 会跑两遍，重复会把日志刷满） */
const reportedStages = new Set<string>()

/**
 * 把工作区相对路径解析成绝对路径, 并做越界校验。
 * 此前 read/delete 各自内联了一份 root+sep 前缀比较, 新增的 readBinary/openFile/reveal
 * 再各写一遍迟早漂移。集中到这里, 所有走工作区的读/打开/定位共用同一把尺子。
 *
 * 注意：workspaceRoot 是用 '/' 拼出来的（与鸿蒙侧一致）, 必须先 path.resolve 归一化
 * 再比较, 否则 Windows 上 '\' 与 '/' 的差异会让合法路径被误判越界。
 */
function resolveWorkspaceFile(
  session: SessionManager,
  conversationId: string,
  relPath: string
): string {
  const root: string = path.resolve(session.workspaceRoot(conversationId))
  const full: string = path.resolve(root, relPath)
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('路径越界')
  }
  return full
}

/** 常见扩展名 → MIME。图片之外的类型给 octet-stream（预览层本就不渲染它们）。 */
function mimeTypeForFile(filePath: string): string {
  const ext: string = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.bmp':
      return 'image/bmp'
    case '.svg':
      return 'image/svg+xml'
    case '.ico':
      return 'image/x-icon'
    case '.avif':
      return 'image/avif'
    // 以下类型以前一律退回 octet-stream：预览层无所谓，但「分享」这类
    // 需要真实 MIME 的出口会因此被接收方拒收（它按类型决定收不收文件）。
    case '.pdf':
      return 'application/pdf'
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.doc':
      return 'application/msword'
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.xls':
      return 'application/vnd.ms-excel'
    case '.pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case '.ppt':
      return 'application/vnd.ms-powerpoint'
    case '.zip':
      return 'application/zip'
    case '.txt':
    case '.md':
    case '.markdown':
    case '.log':
    case '.csv':
    case '.json':
    case '.yaml':
    case '.yml':
      return 'text/plain; charset=utf-8'
    case '.mp4':
      return 'video/mp4'
    case '.mp3':
      return 'audio/mpeg'
    default:
      return 'application/octet-stream'
  }
}

/** 导出/分享的内容载荷：文件名、MIME 与字节。 */
interface TransferPayload {
  name: string
  mime: string
  bytes: Uint8Array
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** 清掉文件名里非法的路径字符（与 Android 侧重名规则一致）。 */
function safeFileName(name: string, fallback: string): string {
  const value = (name ?? '').trim().replace(/[\\/:*?"<>|]/g, '_')
  return value === '' ? fallback : value
}

/**
 * 按请求取出要传出去的那份文件。
 * 三选一：messageId（一条回答的 Word）→ path（工作区里的单个文件）→ 都没有（打包整个工作区）。
 */
async function buildTransferPayload(
  session: SessionManager,
  request: TransferRequestDto
): Promise<TransferPayload> {
  const conversationId: string = request?.conversationId ?? ''
  if (conversationId === '') {
    throw new Error('缺少会话 id')
  }
  const messageId: string = request.messageId ?? ''
  if (messageId !== '') {
    const bytes: Uint8Array = await session.exportMessageDocx(conversationId, messageId)
    const name: string = safeFileName(request.suggestedName ?? '', 'Guncat 回答.docx')
    return {
      name: name.toLowerCase().endsWith('.docx') ? name : `${name}.docx`,
      mime: DOCX_MIME,
      bytes
    }
  }
  const relPath: string = (request.path ?? '').replace(/\\/g, '/')
  if (relPath !== '') {
    const full: string = resolveWorkspaceFile(session, conversationId, relPath)
    if (!fs.existsSync(full)) {
      throw new Error('文件不存在')
    }
    if (fs.statSync(full).isDirectory()) {
      throw new Error('该路径是目录，请打包导出')
    }
    return {
      name: path.basename(full),
      mime: mimeTypeForFile(full),
      bytes: new Uint8Array(fs.readFileSync(full))
    }
  }
  const { WorkFileService } = await import('@core/service/WorkFileService')
  const { appContext } = await import('@core/platform/kit/AbilityKit')
  const bytes: Uint8Array = WorkFileService.zipWorkspace(appContext(), conversationId)
  const fallback = `guncat-workspace-${conversationId}.zip`
  const name: string = safeFileName(request.suggestedName ?? '', fallback)
  return {
    name: name.toLowerCase().endsWith('.zip') ? name : `${name}.zip`,
    mime: 'application/zip',
    bytes
  }
}

/** 同名文件已存在时追加 (1)/(2)…，避免分享一次就覆盖上一次的副本 */
function uniqueFilePath(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return filePath
  }
  const dir: string = path.dirname(filePath)
  const ext: string = path.extname(filePath)
  const base: string = path.basename(filePath, ext)
  for (let i = 1; i < 1000; i++) {
    const next: string = path.join(dir, `${base} (${i})${ext}`)
    if (!fs.existsSync(next)) {
      return next
    }
  }
  return filePath
}

/**
 * 桌面端的「分享」：这里没有 Android 那样的系统分享面板，能兑现的是
 * 「在下载目录留一份副本 + 把路径放进剪贴板 + 在资源管理器里定位」——
 * 微信桌面版支持直接粘贴路径或拖入文件，这条链路是真正可用的。
 * 不再尝试 `weixin://`：协议唤起既不可靠，也不解决「文件交给谁」的问题。
 */
function shareOnDesktop(payload: TransferPayload): TransferResultDto {
  const dir: string = path.join(app.getPath('downloads'), 'Guncat Work')
  fs.mkdirSync(dir, { recursive: true })
  const file: string = uniqueFilePath(path.join(dir, payload.name))
  fs.writeFileSync(file, payload.bytes)
  clipboard.writeText(file)
  shell.showItemInFolder(file)
  return {
    status: 'shared',
    path: file,
    message: `已保存并复制路径：${file}。可粘贴或拖入任意应用（含微信）发送`
  }
}

function markReported(key: string, marker: string, message: string): void {
  if (reportedStages.has(key)) {
    return
  }
  reportedStages.add(key)
  bootMark(marker, message)
}

/** 供启动阶段使用的临时目录（保留导出，便于后续调试） */
export { makeTempDir }

/**
 * 图片的小缩略图（data URL），给附件预览条用。
 * 失败一律返回空串 —— 预览条会退回显示文件名，不该因为缩略图失败而看不到已选文件。
 */
async function makeAttachmentThumbnail(filePath: string): Promise<string> {
  const ext: string = path.extname(filePath).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
    return ''
  }
  let source: image.ImageSource | null = null
  let pixelMap: image.PixelMap | null = null
  let packer: image.ImagePacker | null = null
  try {
    source = image.createImageSource(fs.readFileSync(filePath))
    pixelMap = await source.createPixelMap({ desiredSize: { width: 128, height: 128 } })
    packer = image.createImagePacker()
    const buffer: ArrayBuffer = await packer.packToData(pixelMap, {
      format: 'image/png',
      quality: 80
    })
    return `data:image/png;base64,${Buffer.from(buffer).toString('base64')}`
  } catch {
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
