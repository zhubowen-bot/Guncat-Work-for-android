// 平台适配层：鸿蒙 `@kit.ArkTS` 的 Android/Web 实现。
// 浏览器原生就有 TextEncoder/TextDecoder；Base64 用全局 atob/btoa。
export namespace util {
  export class TextEncoder {
    private inner = new globalThis.TextEncoder()

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

  export class TextDecoder {
    private inner: globalThis.TextDecoder

    private constructor(encoding: string, options?: DecoderOptions) {
      this.inner = new globalThis.TextDecoder(encoding, {
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

  export class Base64Helper {
    encodeToStringSync(src: Uint8Array): string {
      let binary = ''
      for (let i = 0; i < src.length; i++) {
        binary += String.fromCharCode(src[i])
      }
      return btoa(binary)
    }

    decodeSync(src: string): Uint8Array {
      const binary = atob(src)
      const out = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i)
      }
      return out
    }
  }

  export function generateRandomUUID(_entropyCache?: boolean): string {
    return crypto.randomUUID()
  }
}
