// 应用目录解析：把「开发态」与「打包态」的差异收敛在这一处。
//
// macOS/Windows 打包后：
//   userData  → 用户数据根（对话历史、工作区、配置）
//   resources → 随包资源（agents.json、技能库）
// 开发态则落在仓库内的 .guncat-data 与 resources/，
// 既方便调试，也避免在 DSH 等受限沙箱里写到工作区之外。
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'

export interface ResolvedPaths {
  dataRoot: string
  resourcesRoot: string
}

function isPackaged(): boolean {
  return app.isPackaged
}

/** 打包后 resources 会被放到 process.resourcesPath 下 */
function resolveResourcesRoot(): string {
  const candidates: string[] = isPackaged()
    ? [path.join(process.resourcesPath, 'resources'), path.join(app.getAppPath(), 'resources')]
    : [path.join(app.getAppPath(), 'resources'), path.join(process.cwd(), 'resources')]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return candidates[0]
}

export function resolveAppPaths(): ResolvedPaths {
  const envRoot: string | undefined = process.env.GUNCAT_DATA_DIR
  const dataRoot: string =
    envRoot !== undefined && envRoot !== ''
      ? envRoot
      : isPackaged()
        ? app.getPath('userData')
        : path.join(process.cwd(), '.guncat-data')
  return {
    dataRoot,
    resourcesRoot: resolveResourcesRoot()
  }
}
