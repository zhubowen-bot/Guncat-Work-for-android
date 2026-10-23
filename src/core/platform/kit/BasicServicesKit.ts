// 平台适配层：鸿蒙 `@kit.BasicServicesKit` 的等价实现（Node 侧）
//
// 端口代码里只用到一个能力：`zlib.decompressFile(zipPath, outDir)`。
// 注意它尽管叫 zlib，实际语义是「把 zip 解包到目录」（docx/xlsx/pptx 都是 zip），
// 因此这里用 fflate 的 unzipSync 实现，而不是 Node 的 zlib.inflate。
import fs from 'node:fs'
import path from 'node:path'
import { unzipSync } from 'fflate'

export class BusinessError extends Error {
  code: number

  constructor(code: number = 0, message: string = '') {
    super(message)
    this.name = 'BusinessError'
    this.code = code
  }
}

export namespace zlib {
  export interface DecompressFileOptions {
    /** 只解压这些条目（端口代码未使用，保留签名） */
    entries?: string[]
  }

  /**
   * 把 zip 文件解包到 outDir（目录不存在时自动创建）。
   * 保留 zip 内的相对目录结构。
   */
  export async function decompressFile(
    inFile: string,
    outFile: string,
    _options?: DecompressFileOptions
  ): Promise<void> {
    const raw: Buffer = fs.readFileSync(inFile)
    const entries: Record<string, Uint8Array> = unzipSync(new Uint8Array(raw))

    fs.mkdirSync(outFile, { recursive: true })
    const resolvedRoot: string = path.resolve(outFile)

    for (const name of Object.keys(entries)) {
      const data: Uint8Array = entries[name]
      const target: string = path.resolve(resolvedRoot, name)
      // 防目录穿越：解包目标必须落在 outFile 之内
      if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
        continue
      }
      if (name.endsWith('/')) {
        fs.mkdirSync(target, { recursive: true })
        continue
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, data)
    }
  }
}
