import type { ApiProfileDto } from '@ipc/contract'

/**
 * 顶栏 / 输入区的「模型胶囊」选项。
 *
 * 一个配置方案现在可以有多个模型（同一个服务商、同一套 Key），所以选项是
 * 「方案 + 模型」的组合；value 用 `profileId::model` 编码（方案 id 不含 `::`）。
 * 没填模型的老方案仍然保留一条纯方案选项，选中它只切方案、不改模型。
 */
export function modelChoices(
  profiles: ApiProfileDto[]
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = []
  for (const profile of profiles) {
    const models =
      profile.config.models !== undefined && profile.config.models.length > 0
        ? profile.config.models
        : profile.config.model !== ''
          ? [profile.config.model]
          : []
    if (models.length === 0) {
      options.push({ value: `${profile.id}::`, label: profile.name })
      continue
    }
    for (const model of models) {
      options.push({ value: `${profile.id}::${model}`, label: `${model} · ${profile.name}` })
    }
  }
  return options
}

/** 把 `profileId::model` 拆回两段；没有分隔符时整段都当方案 id（模型留空） */
export function parseModelChoice(value: string): { profileId: string; model: string } {
  const index = value.indexOf('::')
  if (index < 0) {
    return { profileId: value, model: '' }
  }
  return { profileId: value.slice(0, index), model: value.slice(index + 2) }
}

/** 当前生效的组合值（用于 Picker 的选中态） */
export function currentModelChoice(
  profileId: string,
  model: string
): string {
  return `${profileId}::${model}`
}
