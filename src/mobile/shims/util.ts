// node:util 的浏览器替身。端口代码只用到 TextEncoder / TextDecoder。
export class TextEncoder {
  private inner = new globalThis.TextEncoder()

  encodeInto(input: string): Uint8Array {
    return this.inner.encode(input)
  }

  encode(input?: string): Uint8Array {
    return this.inner.encode(input ?? '')
  }
}

export class TextDecoder {
  private inner: globalThis.TextDecoder

  private constructor(encoding: string, options?: { ignoreBOM?: boolean; fatal?: boolean }) {
    this.inner = new globalThis.TextDecoder(encoding, {
      ignoreBOM: options?.ignoreBOM ?? false,
      fatal: options?.fatal ?? false
    })
  }

  static create(
    encoding: string,
    options?: { ignoreBOM?: boolean; fatal?: boolean }
  ): TextDecoder {
    return new TextDecoder(encoding, options)
  }

  decode(input?: Uint8Array, options?: { stream?: boolean }): string {
    return this.inner.decode(input as Uint8Array | undefined, {
      stream: options?.stream ?? false
    })
  }

  decodeToString(input?: Uint8Array, options?: { stream?: boolean }): string {
    return this.decode(input, options)
  }
}
