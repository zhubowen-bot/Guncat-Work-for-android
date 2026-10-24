// memfs 删除事件（移动端）
//
// 工作区的删除入口不止一个：delete_file 走 WorkFileService，面板删除走 host 的
// fs.rmSync，将来还可能有别的调用方。设备镜像是「命令能看见工作区」的前提，
// 因此把「删了哪条路径」做成 fs 垫片上的事件，由镜像统一订阅 —— 而不是在
// 每个业务调用点各贴一次通知（漏一处就会重新出现「删了还在」的幻影目录）。
//
// 只在移动端的 shims/fs.ts 里发事件；桌面端 node:fs 没有这层，也不需要镜像。
type FsDeleteListener = (absPath: string) => void

let listener: FsDeleteListener | null = null

export function setFsDeleteListener(next: FsDeleteListener | null): void {
  listener = next
}

export function notifyFsDelete(absPath: string): void {
  if (listener === null || absPath === '') {
    return
  }
  try {
    listener(absPath)
  } catch {
    // 镜像通知失败不能影响删除本身：下一次 syncDown 仍会按账本收拾残留
  }
}
