// 一次性工具：导出 guncat-ui lang 的组件清单（名字 + 位置参数表），
// 作为渲染器实现的依据。运行：node scripts/dump-components.mjs
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { root, alias } from './esbuild-aliases.mjs'

const smokeDir = path.join(root, '.smoke')
fs.mkdirSync(smokeDir, { recursive: true })

const entry = path.join(smokeDir, 'dump-entry.ts')
fs.writeFileSync(
  entry,
  `import { GuncatUiLibrary } from '@core/common/GuncatUiLibrary'

export function dump(): Array<{ name: string; group: string; params: string[] }> {
  return GuncatUiLibrary.names().map((name) => {
    const def = GuncatUiLibrary.def(name)!
    return {
      name,
      group: def.group,
      params: def.params.map((p) => p.name + ':' + p.type + (p.required ? '' : '?'))
    }
  })
}
`
)

const outfile = path.join(smokeDir, 'dump.mjs')
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
  alias,
  logLevel: 'error'
})

const mod = await import(pathToFileURL(outfile).href)
const comps = mod.dump()

const byGroup = new Map()
for (const c of comps) {
  if (!byGroup.has(c.group)) byGroup.set(c.group, [])
  byGroup.get(c.group).push(c)
}

for (const [group, list] of byGroup) {
  console.log(`\n## ${group} (${list.length})`)
  for (const c of list) {
    console.log(`  ${c.name}(${c.params.join(', ')})`)
  }
}
console.log(`\n合计 ${comps.length} 个组件`)

fs.writeFileSync(
  path.join(smokeDir, 'components.json'),
  JSON.stringify(comps, null, 2),
  'utf8'
)
