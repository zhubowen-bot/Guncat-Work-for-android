// 浏览器全局补丁。必须在任何 core/kit 模块求值前执行。
import { Buffer } from 'buffer'

const g = globalThis as unknown as {
  Buffer?: typeof Buffer
  global?: typeof globalThis
  process?: { env: Record<string, string>; platform: string; cwd: () => string }
}

if (g.Buffer === undefined) {
  g.Buffer = Buffer
}
if (g.global === undefined) {
  g.global = globalThis
}
if (g.process === undefined) {
  g.process = {
    env: {},
    platform: 'android',
    cwd: () => '/'
  }
}
