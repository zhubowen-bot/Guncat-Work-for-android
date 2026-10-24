// Android 宿主：把 preload 暴露给渲染层的 window.guncat 接口，直接在 WebView 里实现。
//
// 桌面版这层是 Electron IPC（src/main/ipc.ts）→ 主进程 SessionManager；
// Android 版没有第二个进程，SessionManager 就跑在 WebView 里，接口签名与返回值
// 保持逐字一致，因此渲染层（store / components）一行都不用改。
import fs from 'node:fs'
import path from 'node:path'
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
  ConversationStatsDto,
  GuncatEvent,
  MessageDto,
  MultimodalConfigDto,
  PickedAttachmentDto,
  RendererStage,
  SearchEngineDto,
  TableOcrImageDto,
  TransferRequestDto,
  TransferResultDto,
  WorkArtifactsDto,
  WorkAnswerRequest,
  WorkRunRequest,
  WorkspaceBinaryDto,
  WorkspaceEntryDto,
  WorkspaceInfoDto
} from '@ipc/contract'
import type { GuncatApi } from '@renderer/env'
import { appContext } from '@core/platform/kit/AbilityKit'
import { getDataRoot, resourcesDir } from '@core/platform/appPaths'
import { SessionManager } from '@main/session/SessionManager'
import { AskUserBridge, AskAnswer } from '@core/service/AskUserBridge'
import { TableOcrService } from '@core/service/TableOcrService'
import type { TableOcrImage } from '@core/service/TableOcrService'
import { MultimodalConfig } from '@core/model/MultimodalConfig'
import { image } from '@core/platform/kit/ImageKit'
import { sanitizeTableHtml } from '@main/sanitizeHtml'
import { transcribeAudio } from '@main/asr'
import { pickFilesFromDevice } from '../native/picker'
import { nativeAsrStart, nativeAsrStatus, nativeAsrStop } from '../native/asr'
import { openBytes, saveBytesToUserLocation, shareBytesTo, toast, bytesToBase64, ttsSpeak, ttsStop, ttsSupported } from '../native/bridge'

type Emit = (event: GuncatEvent) => void

export interface MobileHost {
  api: GuncatApi
  session: SessionManager
}

function mimeTypeForFile(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
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
    case '.pdf':
      return 'application/pdf'
    case '.doc':
      return 'application/msword'
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.xls':
      return 'application/vnd.ms-excel'
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.ppt':
      return 'application/vnd.ms-powerpoint'
    case '.pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
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
      return 'text/plain'
    case '.mp4':
      return 'video/mp4'
    case '.mp3':
      return 'audio/mpeg'
    default:
      return 'application/octet-stream'
  }
}

function resolveWorkspaceFile(session: SessionManager, conversationId: string, relPath: string): string {
  const root = path.resolve(session.workspaceRoot(conversationId))
  const full = path.resolve(root, relPath)
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('路径越界')
  }
  return full
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * 按请求取出要传出去的那份文件（与桌面主进程同一条口径）：
 * messageId → 该条回答的 Word；path → 工作区单个文件；都没有 → 打包整个工作区。
 */
async function buildTransferPayload(
  session: SessionManager,
  request: TransferRequestDto
): Promise<{ name: string; mime: string; bytes: Uint8Array }> {
  const conversationId: string = request?.conversationId ?? ''
  if (conversationId === '') {
    throw new Error('缺少会话 id')
  }
  const messageId: string = request.messageId ?? ''
  if (messageId !== '') {
    const bytes: Uint8Array = await session.exportMessageDocx(conversationId, messageId)
    const base: string = (request.suggestedName ?? '').trim() || 'Guncat 回答.docx'
    return { name: /\.docx$/i.test(base) ? base : `${base}.docx`, mime: DOCX_MIME, bytes }
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
  const bytes: Uint8Array = WorkFileService.zipWorkspace(appContext(), conversationId)
  const base: string = (request.suggestedName ?? '').trim() || `guncat-workspace-${conversationId}.zip`
  return { name: /\.zip$/i.test(base) ? base : `${base}.zip`, mime: 'application/zip', bytes }
}

async function makeAttachmentThumbnail(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase()
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
    const buffer = await packer.packToData(pixelMap, { format: 'image/png', quality: 80 })
    return `data:image/png;base64,${bytesToBase64(new Uint8Array(buffer))}`
  } catch {
    return ''
  } finally {
    if (pixelMap !== null) {
      await pixelMap.release().catch((): undefined => undefined)
    }
    if (source !== null) {
      await source.release().catch((): undefined => undefined)
    }
    if (packer !== null) {
      await packer.release().catch((): undefined => undefined)
    }
  }
}

export function createMobileHost(): MobileHost {
  const listeners = new Set<(event: GuncatEvent) => void>()
  const pending: GuncatEvent[] = []
  const emit: Emit = (event) => {
    if (listeners.size === 0) {
      pending.push(event)
      return
    }
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (e) {
        console.warn('[host] 事件处理失败', e)
      }
    }
  }

  const session = new SessionManager(emit)
  session.startScheduleTicker()

  async function pickAndImport(
    conversationId: string,
    options: { extensions?: string[]; multiple?: boolean; camera?: boolean; imagesOnly?: boolean }
  ): Promise<{ names: string[]; imported: number; failed: string[]; canceled: boolean }> {
    const paths = await pickFilesFromDevice({
      extensions: options.extensions,
      maxCount: options.multiple === true ? 20 : 1,
      multiple: options.multiple === true,
      camera: options.camera === true,
      imagesOnly: options.camera === true || options.imagesOnly === true
    })
    if (paths.length === 0) {
      return { names: [], imported: 0, failed: [], canceled: true }
    }
    const outcome = await session.intakePaths(conversationId, paths)
    return { ...outcome, canceled: false }
  }

  const api: GuncatApi = {
    settings: {
      load: (): Promise<AppSettingsDto> => session.loadSettings(),
      saveApiConfig: (dto: ApiConfigDto): Promise<void> => session.saveApiConfig(dto),
      saveApiProfiles: (profiles: ApiProfileDto[]): Promise<void> => session.saveApiProfiles(profiles),
      selectApiProfile: (profileId: string): Promise<void> => session.selectApiProfile(profileId),
      selectApiProfileModel: (profileId: string, model: string): Promise<void> =>
        session.selectApiProfileModel(profileId, model),
      addApiProfile: (): Promise<ApiProfileDto> => session.addApiProfile(),
      deleteApiProfile: (profileId: string): Promise<void> => session.deleteApiProfile(profileId),
      saveCurrentApiProfile: (
        name: string,
        config: ApiConfigDto,
        multimodal: MultimodalConfigDto
      ): Promise<void> => session.saveCurrentApiProfile(name, config, multimodal),
      saveMultimodalConfig: (dto: MultimodalConfigDto): Promise<void> =>
        session.saveMultimodalConfig(dto),
      saveFlag: (key: string, value: boolean): Promise<void> => session.saveFlag(key, value),
      saveString: (key: string, value: string): Promise<void> => session.saveString(key, value),
      searchEngines: async (): Promise<SearchEngineDto[]> => {
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
      }
    },

    agents: {
      list: async (): Promise<AgentDto[]> => session.listAgents()
    },

    conversations: {
      list: async (): Promise<ConversationSummaryDto[]> => {
        await session.bootstrap()
        return session.listConversations()
      },
      get: async (id: string): Promise<ConversationDto | null> => session.getConversation(id),
      create: (agentId: string, mode: string): Promise<ConversationDto> =>
        session.createConversation(agentId, mode),
      remove: (id: string): Promise<void> => session.deleteConversation(id),
      rename: (id: string, title: string): Promise<void> => session.renameConversation(id, title)
    },

    chat: {
      send: (request: ChatSendRequest): Promise<void> => session.sendChat(request),
      abort: async (conversationId: string): Promise<void> => {
        session.abort(conversationId)
      },
      regenerate: (request: ChatRegenerateRequest): Promise<void> => session.regenerateChat(request),
      patchMessage: (conversationId: string, messageId: string, content: string): Promise<void> =>
        session.patchMessageContent(conversationId, messageId, content)
    },

    work: {
      run: (request: WorkRunRequest): Promise<void> => session.runWork(request),
      abort: async (conversationId: string): Promise<void> => {
        session.abort(conversationId)
      },
      answer: async (request: WorkAnswerRequest): Promise<boolean> => {
        const requestId = request?.requestId ?? ''
        if (requestId === '') {
          return false
        }
        if (request.canceled === true) {
          return AskUserBridge.cancel(requestId)
        }
        const answer = new AskAnswer()
        answer.selections = Array.isArray(request.selections) ? request.selections : []
        answer.note = typeof request.note === 'string' ? request.note : ''
        return AskUserBridge.answer(requestId, answer)
      }
    },

    workspace: {
      list: async (conversationId: string): Promise<WorkspaceEntryDto[]> =>
        session.listWorkspace(conversationId),
      listDir: async (conversationId: string, relPath: string): Promise<WorkspaceEntryDto[]> =>
        session.listWorkspaceDir(conversationId, relPath ?? ''),
      treeText: async (conversationId: string): Promise<string> =>
        session.workspaceTreeText(conversationId),
      read: async (conversationId: string, relPath: string) => {
        const full = resolveWorkspaceFile(session, conversationId, relPath)
        if (!fs.existsSync(full)) {
          throw new Error('文件不存在')
        }
        const stat = fs.statSync(full)
        if (stat.isDirectory()) {
          throw new Error('该路径是目录')
        }
        if (stat.size > 2 * 1024 * 1024) {
          return { text: '(文件超过 2MB，未在预览面板加载)', truncated: true }
        }
        return { text: fs.readFileSync(full, 'utf8'), truncated: false }
      },
      readBinary: async (conversationId: string, relPath: string): Promise<WorkspaceBinaryDto> => {
        const full = resolveWorkspaceFile(session, conversationId, relPath)
        if (!fs.existsSync(full)) {
          throw new Error('文件不存在')
        }
        const stat = fs.statSync(full)
        if (stat.isDirectory()) {
          throw new Error('该路径是目录')
        }
        if (stat.size > 16 * 1024 * 1024) {
          throw new Error('文件超过 16MB')
        }
        const bytes = fs.readFileSync(full)
        return {
          dataUrl: `data:${mimeTypeForFile(full)};base64,${Buffer.from(bytes).toString('base64')}`,
          mimeType: mimeTypeForFile(full),
          size: stat.size
        }
      },
      openFile: async (conversationId: string, relPath: string): Promise<void> => {
        const full = resolveWorkspaceFile(session, conversationId, relPath)
        if (!fs.existsSync(full)) {
          throw new Error('文件不存在')
        }
        const bytes = new Uint8Array(fs.readFileSync(full))
        openBytes(path.basename(full), mimeTypeForFile(full), bytes)
      },
      reveal: async (): Promise<void> => {
        toast('Android 版请在「我的文件/下载」中查看导出的文件')
      },
      remove: async (conversationId: string, relPath: string): Promise<void> => {
        const full = resolveWorkspaceFile(session, conversationId, relPath)
        const root = path.resolve(session.workspaceRoot(conversationId))
        if (full === root) {
          throw new Error('不能删除工作区根目录')
        }
        fs.rmSync(full, { recursive: true, force: true })
        emit({ type: 'workspace:changed', conversationId })
      },
      clear: async (conversationId: string) => {
        if (session.workspaceInfo(conversationId).isCustom) {
          emit({ type: 'notice', level: 'warn', text: '自定义工作区不支持一键清空' })
          return { cleared: false }
        }
        if (!window.confirm('将删除工作区中的全部文件，该操作不可恢复。确定继续吗？')) {
          return { cleared: false }
        }
        const root = session.workspaceRoot(conversationId)
        fs.rmSync(root, { recursive: true, force: true })
        fs.mkdirSync(root, { recursive: true })
        emit({ type: 'workspace:changed', conversationId })
        return { cleared: true }
      },
      openInFolder: async (): Promise<void> => {
        toast('Android 版工作区在应用沙箱内，可通过「导出 ZIP」取出')
      },
      exportZip: async (conversationId: string) => {
        const { WorkFileService } = await import('@core/service/WorkFileService')
        const bytes = WorkFileService.zipWorkspace(appContext(), conversationId)
        // 走系统「保存到…」，让用户自己选目录/改文件名，也能取消
        const saved = await saveBytesToUserLocation(
          `guncat-workspace-${conversationId}.zip`,
          'application/zip',
          bytes
        )
        return saved.ok ? { saved: true, path: saved.path } : { saved: false }
      },
      info: async (conversationId: string): Promise<WorkspaceInfoDto> =>
        session.workspaceInfo(conversationId),
      pickDirectory: async (): Promise<string | null> => {
        toast('Android 版使用应用沙箱工作区；如需导入文件请用「上传」')
        return null
      },
      setCustom: async (conversationId: string, dir: string | null): Promise<WorkspaceInfoDto> => {
        if (dir !== null) {
          toast('Android 版暂不支持自定义工作区目录')
          return session.workspaceInfo(conversationId)
        }
        return session.setWorkspaceDirectory(conversationId, null)
      },
      setCommandPermission: async (
        conversationId: string,
        permission: string
      ): Promise<WorkspaceInfoDto> => session.setCommandPermission(conversationId, permission)
    },

    app: {
      info: async (): Promise<AppInfoDto> => ({
        version: __APP_VERSION__,
        dataRoot: getDataRoot(),
        resourcesRoot: resourcesDir(),
        platform: 'android',
        electron: ''
      }),
      reportStage: async (stage: RendererStage, detail?: string): Promise<void> => {
        if (stage === 'error') {
          console.error('[renderer]', detail ?? '')
        }
      }
    },

    intake: {
      importPaths: (conversationId: string, paths: string[]) => session.intakePaths(conversationId, paths),
      pickFiles: (conversationId: string, source?: 'file' | 'camera' | 'gallery') =>
        pickAndImport(conversationId, {
          multiple: source !== 'camera',
          camera: source === 'camera',
          imagesOnly: source === 'gallery',
          extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'csv', 'json', 'png', 'jpg', 'jpeg', 'webp']
        })
    },

    attachments: {
      pick: async (source?: 'file' | 'camera' | 'gallery'): Promise<PickedAttachmentDto[]> => {
        const paths = await pickFilesFromDevice({
          multiple: source !== 'camera',
          maxCount: source === 'camera' ? 1 : 12,
          camera: source === 'camera',
          imagesOnly: source === 'camera' || source === 'gallery'
        })
        const picked: PickedAttachmentDto[] = await Promise.all(
          paths.map(async (filePath) => ({
            path: filePath,
            name: path.basename(filePath),
            size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
            thumbnail: await makeAttachmentThumbnail(filePath),
            status: 'parsing' as const
          }))
        )
        void session.preparseAttachments(picked.map((item) => item.path))
        return picked
      }
    },

    steer: async (conversationId: string, text: string): Promise<boolean> =>
      session.steerWork(conversationId, text),

    stats: async (conversationId: string): Promise<ConversationStatsDto> =>
      session.conversationStats(conversationId),

    artifacts: async (conversationId: string): Promise<WorkArtifactsDto> =>
      session.workArtifacts(conversationId),

    tableOcr: {
      pickImage: async (): Promise<TableOcrImageDto | null> => {
        const paths = await pickFilesFromDevice({ imagesOnly: true })
        if (paths.length === 0) {
          return null
        }
        const filePath = paths[0]
        return {
          path: filePath,
          name: path.basename(filePath),
          size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
          thumbnail: await makeAttachmentThumbnail(filePath)
        }
      },
      run: async (imagePath: string, model: string) => {
        if (!fs.existsSync(imagePath)) {
          throw new Error('图片不存在，请重新选择')
        }
        const config = await session.tableOcrConfig(model)
        const buffer = fs.readFileSync(imagePath)
        const bytes = new Uint8Array(buffer)
        const compressed: TableOcrImage = await TableOcrService.compressImage(
          bytes.slice().buffer as ArrayBuffer
        )
        const raw = await TableOcrService.recognizeImage(config, compressed)
        return { html: sanitizeTableHtml(TableOcrService.cleanHtml(raw)), model: config.model }
      }
    },

    messages: {
      exportDocx: async (conversationId: string, messageId: string, suggestedName?: string) => {
        const bytes = await session.exportMessageDocx(conversationId, messageId)
        const name =
          suggestedName !== undefined && suggestedName !== '' ? suggestedName : 'Guncat 回答.docx'
        // 老入口也改成「先选位置再写」：直接扔进下载目录会让用户不知道文件去了哪
        const saved = await saveBytesToUserLocation(name, DOCX_MIME, bytes)
        return saved.ok ? { saved: true, path: saved.path } : { saved: false }
      }
    },

    /**
     * 统一导出 / 分享。save 走系统文件管理器（用户选位置、可取消）；
     * share 一律交给系统分享面板（里面可以直接选微信）。
     */
    transfer: async (request: TransferRequestDto): Promise<TransferResultDto> => {
      try {
        const payload = await buildTransferPayload(session, request)
        if (request.action === 'share') {
          const outcome = shareBytesTo(payload.name, payload.mime, payload.bytes)
          if (!outcome.ok) {
            return { status: 'error', message: outcome.error ?? '分享失败' }
          }
          return {
            status: 'shared',
            message: `已打开系统分享面板：${payload.name}（可在这里选微信）`
          }
        }
        const saved = await saveBytesToUserLocation(payload.name, payload.mime, payload.bytes)
        if (saved.ok) {
          return { status: 'saved', path: saved.path }
        }
        if (saved.canceled === true) {
          return { status: 'canceled' }
        }
        return { status: 'error', message: saved.error ?? '保存失败' }
      } catch (e) {
        return { status: 'error', message: String(e instanceof Error ? e.message : e) }
      }
    },

    files: {
      pathForFile: (): string => ''
    },

    asr: {
      transcribe: async (audio: Uint8Array, mime: string) => transcribeAudio(audio, mime ?? ''),
      native: (() => {
        const status = nativeAsrStatus()
        if (status === 'none') {
          return undefined
        }
        return { status, start: nativeAsrStart, stop: nativeAsrStop }
      })()
    },

    speech: {
      get supported(): boolean {
        return ttsSupported()
      },
      speak(text: string, rate: number): void {
        ttsSpeak(text, rate)
      },
      stop(): void {
        ttsStop()
      }
    },

    onEvent: (listener: (event: GuncatEvent) => void): (() => void) => {
      listeners.add(listener)
      if (pending.length > 0) {
        const queued = pending.splice(0, pending.length)
        for (const event of queued) {
          listener(event)
        }
      }
      return () => {
        listeners.delete(listener)
      }
    }
  }

  return { api, session }
}
