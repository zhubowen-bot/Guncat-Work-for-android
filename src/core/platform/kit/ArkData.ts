// 平台适配层：鸿蒙 `@kit.ArkData` 的等价实现（Node 侧）
//
// 端口代码只用 preferences 存配置类小数据（API 配置 / 开关 / 朗读偏好），
// 语义是「键值 + 显式 flush」的异步接口。这里落成
// <filesDir>/preferences/<name>.json，put 先改内存再在 flush 时写盘，
// 与鸿蒙侧「put 不落盘、flush 才落盘」的行为保持一致。
//
// 落盘加密：配置里有模型 API Key、语音服务的 Key —— 明文写进 json 意味着任何能读到
// 用户目录的进程（备份、同步盘、别人登一下这台机器）就顺手拿走了凭据。所以写盘时
// 用 Electron safeStorage（Windows DPAPI / macOS Keychain / Linux 钥匙串）把字符串值
// 加密成 enc:v1: 前缀的 Base64，读回时在内存里还原成明文，端口代码一行都不用改。
//
// 三条诚实的边界，都不靠"应该没问题"：
// 1. 平台不提供安全存储（没装钥匙串的 Linux、无头冒烟）时**照旧明文落盘**，并由
//    secretStorageState() 如实上报，设置面板要显示出来 —— 不能让用户以为开了就加密了。
// 2. 密钥是**机器绑定**的：把用户目录拷到另一台机器、或系统钥匙串被清空，密文解不开。
//    这时只丢掉解不开的那几个键（记进 undecryptable），其余配置照常可用，不整份报废。
// 3. 老的明文文件继续读得动：只有带 enc:v1: 标记的值才尝试解密，下次写盘自然变成密文。
import fs from 'node:fs'
import path from 'node:path'
import { filesDir } from '../appPaths'

type PrefValue = string | number | boolean | object

// 密文值的前缀标记：区分「加密过的」与「历史遗留的明文」，也让格式以后能升级
const ENC_MARK: string = 'enc:v1:'

interface SafeStorageApi {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(cipher: Buffer): string
}

// 由主进程在启动时注入 Electron 的 safeStorage。
// 为什么注入而不是在这里 require('electron')：平台适配层在纯 Node（无头冒烟）里 require 到的
// 只是 electron 包的路径字符串，加密这条路等于只在真机上才跑得起来、只能靠「应该没问题」。
// 注入之后，同一份落盘逻辑可以在冒烟测试里被真实验证。没注入 = 平台不提供 = 照旧明文。
let safeStorageImpl: SafeStorageApi | null = null

export function bindSafeStorage(api: SafeStorageApi | null): void {
  safeStorageImpl = api
}

function encryptionAvailable(): boolean {
  if (safeStorageImpl === null) {
    return false
  }
  try {
    return safeStorageImpl.isEncryptionAvailable() === true
  } catch {
    return false
  }
}

// 解不开的键（换机器/钥匙串被清空）记在这里，供设置面板如实告诉用户「哪几项要重新填」
const undecryptable: string[] = []

export interface SecretStorageState {
  available: boolean
  undecryptable: string[]
}

export function secretStorageState(): SecretStorageState {
  return { available: encryptionAvailable(), undecryptable: undecryptable.slice() }
}

export function __setUndecryptableForTest(keys: string[]): void {
  undecryptable.length = 0
  for (const key of keys) {
    undecryptable.push(key)
  }
}

export namespace preferences {
  export interface Options {
    name?: string
  }

  export class Preferences {
    private readonly filePath: string
    private readonly storeName: string
    private data: Record<string, PrefValue> = {}
    private dirty: boolean = false

    constructor(filePath: string, storeName: string = 'default') {
      this.filePath = filePath
      this.storeName = storeName
      this.load()
    }

    private load(): void {
      try {
        if (fs.existsSync(this.filePath)) {
          const raw: string = fs.readFileSync(this.filePath, 'utf8')
          const parsed: unknown = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object') {
            const stored = parsed as Record<string, PrefValue>
            // 只有带标记的值才解密：历史明文要照读，下次写盘自然转成密文
            for (const key of Object.keys(stored)) {
              const value: PrefValue = stored[key]
              if (typeof value !== 'string' || !value.startsWith(ENC_MARK)) {
                this.data[key] = value
                continue
              }
              const restored: string | null = this.decrypt(key, value)
              if (restored === null) {
                continue  // 解不开的键当没配过：其余配置照常可用，不整份报废
              }
              this.data[key] = restored
            }
          }
        }
      } catch {
        // 配置损坏时按空配置启动，不阻塞应用
        this.data = {}
      }
    }

    // 密文还原成明文；解不开时剔除该键并登记，返回 null
    private decrypt(key: string, marked: string): string | null {
      const api: SafeStorageApi | null = safeStorageImpl
      try {
        if (api === null) {
          throw new Error('未注入安全存储')
        }
        return api.decryptString(Buffer.from(marked.substring(ENC_MARK.length), 'base64'))
      } catch {
        const label: string = this.storeName + '/' + key
        if (undecryptable.indexOf(label) === -1) {
          undecryptable.push(label)
        }
        delete this.data[key]
        return null
      }
    }

    async get(key: string, defValue: PrefValue): Promise<PrefValue> {
      const value: PrefValue | undefined = this.data[key]
      return value === undefined ? defValue : value
    }

    async getAll(): Promise<Record<string, PrefValue>> {
      return { ...this.data }
    }

    async has(key: string): Promise<boolean> {
      return Object.prototype.hasOwnProperty.call(this.data, key)
    }

    async put(key: string, value: PrefValue): Promise<void> {
      this.data[key] = value
      this.dirty = true
    }

    async delete(key: string): Promise<void> {
      if (Object.prototype.hasOwnProperty.call(this.data, key)) {
        delete this.data[key]
        this.dirty = true
      }
    }

    async clear(): Promise<void> {
      this.data = {}
      this.dirty = true
      await this.flush()
    }

    async flush(): Promise<void> {
      if (!this.dirty) {
        return
      }
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp: string = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.encryptAll()), 'utf8')
      fs.renameSync(tmp, this.filePath)
      this.dirty = false
    }

    // 写盘形态：字符串一律加密（内存里始终是明文，端口代码看不到任何加密痕迹）。
    // 平台不给安全存储时原样写明文 —— 这里刻意**不**假装成功，secretStorageState() 会如实上报。
    private encryptAll(): Record<string, PrefValue> {
      const out: Record<string, PrefValue> = {}
      const api: SafeStorageApi | null = safeStorageImpl
      const canEncrypt: boolean = encryptionAvailable() && api !== null
      for (const key of Object.keys(this.data)) {
        const value: PrefValue = this.data[key]
        if (typeof value !== 'string' || !canEncrypt) {
          out[key] = value
          continue
        }
        try {
          out[key] = ENC_MARK + api.encryptString(value).toString('base64')
        } catch {
          out[key] = value  // 加密失败退回明文：配置写得进去比形式上的加密更重要，状态另行上报
        }
      }
      return out
    }
  }

  const instances: Map<string, Preferences> = new Map()

  export async function getPreferences(
    _context: unknown,
    name: string = 'default'
  ): Promise<Preferences> {
    const existing: Preferences | undefined = instances.get(name)
    if (existing !== undefined) {
      return existing
    }
    const dir: string = path.join(filesDir(), 'preferences')
    fs.mkdirSync(dir, { recursive: true })
    const created: Preferences = new Preferences(path.join(dir, `${name}.json`), name)
    instances.set(name, created)
    return created
  }

  export async function removePreferencesFromCache(_context: unknown, name: string): Promise<void> {
    instances.delete(name)
  }

  export async function deletePreferences(_context: unknown, name: string): Promise<void> {
    const dir: string = path.join(filesDir(), 'preferences')
    const file: string = path.join(dir, `${name}.json`)
    if (fs.existsSync(file)) {
      fs.unlinkSync(file)
    }
    instances.delete(name)
  }
}

/** 对齐 @ohos.data.uniformTypeDescriptor（文件 MIME 判定，阶段四分享使用） */
export namespace uniformTypeDescriptor {
  export function getTypeDescriptor(_type: string): { type: string } {
    return { type: _type }
  }
}
