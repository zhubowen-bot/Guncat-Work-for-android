// 桌面端的 canvas 能力（@napi-rs/canvas）。
//
// 为什么需要它：主进程没有 DOM，没有 canvas。而两件事都非要不可：
//   · PDF 页面转图（PDF.js 只负责算，真正的像素落在一张 canvas 上）；
//   · SVG 栅格化 —— Electron 的 nativeImage **只解码 PNG / JPEG**，SVG 交给它必然失败。
//     这正是「write_svg 能存源码、预览 PNG 却出不来，导致 docx/pptx 也引用不了 SVG」的原因。
//
// 这里集中做三件事，避免两个调用方各写一份：
//   1. 惰性加载原生模块（首次用到才 require，没碰过 PDF/SVG 的会话不付这份启动成本）；
//   2. 把 PDF.js 渲染路径需要的浏览器全局补上；
//   3. 缺模块时给出一句说得清的提示 —— 而不是让上层把「缺能力」误报成「文件坏了」。
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

export interface CanvasLike {
  width: number
  height: number
  getContext(kind: string): unknown
  encodeSync(format: string): Buffer
}

export interface CanvasImageLike {
  width: number
  height: number
}

export interface CanvasModule {
  createCanvas(width: number, height: number): CanvasLike
  /** SVG 源码可以经这条路当图片用（底层是 resvg），这是桌面端栅格化 SVG 的唯一手段 */
  loadImage(source: Buffer | string): Promise<CanvasImageLike>
  DOMMatrix: unknown
  Path2D: unknown
  ImageData: unknown
}

/** 缺 canvas 时的统一文案：说清缺的是什么能力 */
export const CANVAS_UNAVAILABLE =
  '当前环境缺少图像渲染后端（@napi-rs/canvas 未随包提供），无法渲染 PDF 页面或栅格化 SVG。'

let modulePromise: Promise<CanvasModule | null> | null = null

/**
 * 取 canvas 模块；取不到返回 null（调用方据此给出可读提示，而不是抛一个底层错误）。
 */
export function loadCanvasModule(): Promise<CanvasModule | null> {
  if (modulePromise === null) {
    modulePromise = (async (): Promise<CanvasModule | null> => {
      try {
        const mod = nodeRequire('@napi-rs/canvas') as CanvasModule
        // PDF.js 的渲染路径按浏览器环境写，这几个全局必须先补上
        const globals = globalThis as unknown as Record<string, unknown>
        globals.DOMMatrix = mod.DOMMatrix
        globals.Path2D = mod.Path2D
        globals.ImageData = mod.ImageData
        return mod
      } catch {
        return null
      }
    })()
  }
  return modulePromise
}

/** 取 canvas 模块，取不到直接抛带说明的错误 */
export async function requireCanvasModule(): Promise<CanvasModule> {
  const mod: CanvasModule | null = await loadCanvasModule()
  if (mod === null) {
    throw new Error(CANVAS_UNAVAILABLE)
  }
  return mod
}
