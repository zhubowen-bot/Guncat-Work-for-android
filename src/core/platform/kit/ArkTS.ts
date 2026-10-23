// 平台适配层：鸿蒙 `@kit.ArkTS` 的等价实现（Node 侧）
//
// 端口代码里用到的 util 能力只有三类：
//   - TextEncoder.encodeInto(str)        → 字符串 → UTF-8 字节
//   - TextDecoder.create(enc, opts)      → 增量 UTF-8 解码（SSE 流式切分依赖 stream 选项）
//   - Base64Helper.encodeToStringSync/decodeSync
// 这里用 Node 的 util.TextEncoder / util.TextDecoder 逐一对齐，
// 保持 `util.TextEncoder` 既可作为类型也可作为值使用（与鸿蒙侧写法一致）。
import {
  TextEncoder as NodeTextEncoder,
  TextDecoder as NodeTextDecoder
} from 'node:util'

export namespace util {
  /** 对齐 @ohos.util.TextEncoder */
  export class TextEncoder {
    private inner: NodeTextEncoder = new NodeTextEncoder()

    /** 鸿蒙侧旧签名：直接返回编码后的 Uint8Array */
    encodeInto(input: string): Uint8Array {
      return this.inner.encode(input)
    }

    encode(input?: string): Uint8Array {
      return this.inner.encode(input ?? '')
    }
  }

  export interface DecodeOptions {
    stream?: boolean
  }

  export interface DecoderOptions {
    ignoreBOM?: boolean
    fatal?: boolean
  }

  /** 对齐 @ohos.util.TextDecoder（create + decodeToString 形态） */
  export class TextDecoder {
    private inner: NodeTextDecoder

    private constructor(encoding: string, options?: DecoderOptions) {
      this.inner = new NodeTextDecoder(encoding as BufferEncoding, {
        ignoreBOM: options?.ignoreBOM ?? false,
        fatal: options?.fatal ?? false
      })
    }

    static create(encoding: string, options?: DecoderOptions): TextDecoder {
      return new TextDecoder(encoding, options)
    }

    decodeToString(input?: Uint8Array, options?: DecodeOptions): string {
      return this.inner.decode(input as Uint8Array | undefined, {
        stream: options?.stream ?? false
      })
    }

    decode(input?: Uint8Array, options?: DecodeOptions): string {
      return this.decodeToString(input, options)
    }
  }

  /** 对齐 @ohos.util.Base64Helper（只用同步两件套） */
  export class Base64Helper {
    encodeToStringSync(src: Uint8Array): string {
      return Buffer.from(src.buffer, src.byteOffset, src.byteLength).toString('base64')
    }

    decodeSync(src: string): Uint8Array {
      const buf: Buffer = Buffer.from(src, 'base64')
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    }
  }

  /** 对齐 util.generateRandomUUID（部分端口代码可能用到） */
  export function generateRandomUUID(entropyCache?: boolean): string {
    return entropyCache === false ? randomUUIDNoCache() : randomUUID()
  }

  function randomUUID(): string {
    return globalThis.crypto.randomUUID()
  }

  function randomUUIDNoCache(): string {
    return globalThis.crypto.randomUUID()
  }
}
