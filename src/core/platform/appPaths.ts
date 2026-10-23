// 应用路径中枢：把鸿蒙的应用沙箱目录语义映射到桌面端。
//
// 鸿蒙侧所有落盘位置都挂在 filesDir 下，结构为：
//   <filesDir>/guncat_conversations.json     对话历史
//   <filesDir>/workspaces/<convId>/          每会话沙箱工作区
//   <filesDir>/sessions/<convId>.jsonl       会话事件日志
//   <filesDir>/goals.json, schedules.json …  长程任务状态
// 桌面端保持完全一致的相对结构，只把 filesDir 换成用户数据目录，
// 这样端口代码里所有路径拼接逻辑一行都不用改。
import fs from 'node:fs'
import path from 'node:path'

let dataRootPath: string = ''
let resourcesRootPath: string = ''

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export interface AppPathsInit {
  /** 用户数据根目录（对应鸿蒙的应用沙箱根） */
  dataRoot: string
  /** 随包资源目录（agents.json / 各智能体提示词 / skills 技能库） */
  resourcesRoot: string
}

export function initAppPaths(init: AppPathsInit): void {
  dataRootPath = path.resolve(init.dataRoot)
  resourcesRootPath = path.resolve(init.resourcesRoot)
  ensureDir(dataRootPath)
  for (const name of ['files', 'cache', 'temp', 'logs']) {
    ensureDir(path.join(dataRootPath, name))
  }
}

export function getDataRoot(): string {
  if (dataRootPath === '') {
    throw new Error('应用路径尚未初始化（initAppPaths）')
  }
  return dataRootPath
}

export function filesDir(): string {
  return path.join(getDataRoot(), 'files')
}

export function cacheDir(): string {
  return path.join(getDataRoot(), 'cache')
}

export function tempDir(): string {
  return path.join(getDataRoot(), 'temp')
}

export function logsDir(): string {
  return path.join(getDataRoot(), 'logs')
}

/** 随包只读资源目录 */
export function resourcesDir(): string {
  if (resourcesRootPath === '') {
    throw new Error('应用路径尚未初始化（initAppPaths）')
  }
  return resourcesRootPath
}

/** 随包资源下的子路径 */
export function resource(...segments: string[]): string {
  return path.join(resourcesDir(), ...segments)
}

/** 应用内置临时目录（每次启动清理一次，用于 zip 解包等中间产物） */
export function makeTempDir(prefix: string): string {
  const dir: string = path.join(tempDir(), `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`)
  ensureDir(dir)
  return dir
}

export function clearTempDir(): void {
  const dir: string = tempDir()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // 清理失败不影响启动
  }
  ensureDir(dir)
}
