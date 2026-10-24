import type { ApiProfileDto } from '@ipc/contract'

/**
 * 顶栏 / 输入区的「模型胶囊」选项。
 *
 * 一个配置方案现在可以有多个模型（同一个服务商、同一套 Key），所以选项是
 * 「方案 + 模型」的组合；value 用 `profileId::model` 编码（方案 id 不含 `::`）。
 *
 * 没填 API Key 的方案不进入选项：预置方案刚出现时只是模板，Key 还没填，
 * 放进模型选择框只会让人以为「已经能用」，选中后也只会以 401 失败。
 * 填上 Key 并保存后，下一次读取设置就会自动出现。
 */
export function modelChoices(
  profiles: ApiProfileDto[]
): Array<{ value: string; label: string; triggerLabel: string }> {
  const options: Array<{ value: string; label: string; triggerLabel: string }> = []
  for (const profile of profiles) {
    if (profile.config.apiKey.trim() === '') {
      continue
    }
    const models =
      profile.config.models !== undefined && profile.config.models.length > 0
        ? profile.config.models
        : profile.config.model !== ''
          ? [profile.config.model]
          : []
    for (const model of models) {
      options.push({
        value: `${profile.id}::${model}`,
        // 菜单里带服务商，方便区分不同方案下的同名模型
        label: `${model} · ${profile.name}`,
        // 胶囊只写模型名：顶栏空间有限，服务商不该挤占这里
        triggerLabel: model
      })
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
