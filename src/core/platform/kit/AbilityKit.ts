// 平台适配层：鸿蒙 `@kit.AbilityKit` 的等价实现（Node 侧）
//
// 端口代码把 `context` 一路传递下来，实际只用到两类能力：
//   - 目录字段：filesDir / cacheDir / tempDir
//   - rawfile 读取：resourceManager.getRawFileContent()（agents.json、技能库）
// 桌面端提供一个进程内单例 AppContext 承载同样的字段，
// 因此 `(context as common.UIAbilityContext).filesDir` 这类写法无需改动。
import fs from 'node:fs'
import path from 'node:path'
import { filesDir, cacheDir, tempDir, resourcesDir } from '../appPaths'

export namespace common {
  /**
   * 对齐 @ohos.resourceManager.ResourceManager。
   * 鸿蒙侧 rawfile 里的 agents.json / 技能库在桌面端就是随包 resources 目录，
   * 因此 getRawFileContent 直接按相对路径读文件即可。
   */
  export class ResourceManager {
    private root: string

    constructor(root: string) {
      this.root = root
    }

    private resolve(name: string): string {
      const normalized: string = name.replace(/^\/+/, '')
      const full: string = path.resolve(this.root, normalized)
      // 防目录穿越：rawfile 读取必须落在资源目录内
      const rootResolved: string = path.resolve(this.root)
      if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
        throw new Error(`rawfile 路径越界: ${name}`)
      }
      return full
    }

    async getRawFileContent(name: string): Promise<Uint8Array> {
      return new Uint8Array(fs.readFileSync(this.resolve(name)))
    }

    getRawFileContentSync(name: string): Uint8Array {
      return new Uint8Array(fs.readFileSync(this.resolve(name)))
    }

    /** 递归列出 rawfile 相对路径（技能库目录扫描用） */
    async getRawFileList(dirName: string): Promise<string[]> {
      const dir: string = this.resolve(dirName)
      const out: string[] = []
      const walk = (current: string, prefix: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const rel: string = prefix === '' ? entry.name : `${prefix}/${entry.name}`
          if (entry.isDirectory()) {
            walk(path.join(current, entry.name), rel)
          } else {
            out.push(rel)
          }
        }
      }
      walk(dir, '')
      return out
    }
  }

  export interface Context {
    filesDir: string
    cacheDir: string
    tempDir: string
    resourceDir: string
    resourceManager: ResourceManager
  }

  /** 对齐 @ohos.app.ability.common.UIAbilityContext（只保留端口代码用到的字段） */
  export class UIAbilityContext implements Context {
    filesDir: string
    cacheDir: string
    tempDir: string
    resourceDir: string
    resourceManager: ResourceManager

    constructor(files: string, cache: string, temp: string, resources: string) {
      this.filesDir = files
      this.cacheDir = cache
      this.tempDir = temp
      this.resourceDir = resources
      this.resourceManager = new ResourceManager(resources)
    }
  }

  /** 等价于鸿蒙的 applicationContext（端口代码未直接使用，保留占位） */
  export class ApplicationContext implements Context {
    filesDir: string
    cacheDir: string
    tempDir: string
    resourceDir: string
    resourceManager: ResourceManager

    constructor(files: string, cache: string, temp: string, resources: string) {
      this.filesDir = files
      this.cacheDir = cache
      this.tempDir = temp
      this.resourceDir = resources
      this.resourceManager = new ResourceManager(resources)
    }
  }
}

let contextSingleton: common.UIAbilityContext | null = null

/** 进程内唯一的能力上下文（在 initAppPaths 之后调用） */
export function appContext(): common.UIAbilityContext {
  if (contextSingleton === null) {
    contextSingleton = new common.UIAbilityContext(filesDir(), cacheDir(), tempDir(), resourcesDir())
  }
  return contextSingleton
}

/** 对齐 @ohos.app.ability.Want（分享/唤起入参，阶段四使用） */
export class Want {
  bundleName?: string
  abilityName?: string
  uri?: string
  action?: string
  parameters?: Record<string, Object>

  constructor(init?: Partial<Want>) {
    if (init !== undefined) {
      Object.assign(this, init)
    }
  }
}

export namespace wantConstant {
  export enum Action {
    ACTION_SEND_DATA = 'ohos.want.action.sendData',
    ACTION_VIEW_DATA = 'ohos.want.action.viewData'
  }
}

export namespace AbilityConstant {
  export interface LaunchParam {
    launchReason?: number
    lastExitReason?: number
  }
}
