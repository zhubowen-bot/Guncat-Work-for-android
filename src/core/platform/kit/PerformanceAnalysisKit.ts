// 平台适配层：鸿蒙 `@kit.PerformanceAnalysisKit` 的等价实现（Node 侧）
//
// 端口代码用 hilog 写诊断日志，格式串形如 'read uri failed: %{public}s'。
// 这里把 %{public}X / %{private}X 归一成 %X 后做最小替换，并走 console。
function format(template: string, args: unknown[]): string {
  const normalized: string = template.replace(/%\{(?:public|private)\}([sdi])/g, '%$1')
  let index: number = 0
  const rendered: string = normalized.replace(/%[sdi]/g, () => {
    if (index >= args.length) {
      return ''
    }
    const value: unknown = args[index]
    index++
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
  if (index < args.length) {
    const rest: string = args
      .slice(index)
      .map((v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join(' ')
    return rest.length > 0 ? rendered + ' ' + rest : rendered
  }
  return rendered
}

export namespace hilog {
  export function log(domain: number, tag: string, template: string, ...args: unknown[]): void {
    console.log(`[${tag}] ${format(template, args)}`)
  }

  export function debug(domain: number, tag: string, template: string, ...args: unknown[]): void {
    console.debug(`[${tag}] ${format(template, args)}`)
  }

  export function info(domain: number, tag: string, template: string, ...args: unknown[]): void {
    console.info(`[${tag}] ${format(template, args)}`)
  }

  export function warn(domain: number, tag: string, template: string, ...args: unknown[]): void {
    console.warn(`[${tag}] ${format(template, args)}`)
  }

  export function error(domain: number, tag: string, template: string, ...args: unknown[]): void {
    console.error(`[${tag}] ${format(template, args)}`)
  }

  export function fatal(domain: number, tag: string, template: string, ...args: unknown[]): void {
    console.error(`[${tag}] ${format(template, args)}`)
  }
}
