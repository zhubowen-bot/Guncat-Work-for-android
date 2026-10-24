/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __GUNCAT_RESOURCE_BASE__: string

// PDF.js 的 worker 模块没有随包 .d.mts；这里只声明主线程模式用到的那一个导出。
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs' {
  export const WorkerMessageHandler: unknown
}
