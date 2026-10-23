// 随包资源：agents.json、智能体提示词、技能库、插件清单。
//
// 桌面端从 resources/ 目录直接读盘；Android 版没有可写的安装目录读取通道，
// 因此在构建时把文本类资源以 raw 形式打进 JS，启动时写进内存文件系统。
// 图片类资源（icons/*.png）不进这里：它们由构建脚本拷到 APK assets 里，
// 渲染层通过 /resources/... 直接加载。
import { mkdirResource, writeResource } from './shims/fs'

const TEXT_FILES = import.meta.glob('../../resources/**/*.{md,json,txt}', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

const RESOURCE_PREFIX = '/guncat/resources/'

export function installBundledResources(): void {
  mkdirResource(RESOURCE_PREFIX)
  for (const key of Object.keys(TEXT_FILES)) {
    const relative = key.replace(/^.*?\/resources\//, '')
    const target = RESOURCE_PREFIX + relative
    const parent = target.slice(0, target.lastIndexOf('/'))
    if (parent !== '') {
      mkdirResource(parent)
    }
    writeResource(target, TEXT_FILES[key])
  }
  // 技能库目录即使为空也要存在：getRawFileList 会按目录扫描
  for (const dir of ['skills', 'plugins', 'icons']) {
    mkdirResource(RESOURCE_PREFIX + dir)
  }
}
