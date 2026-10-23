// PluginHotLoader: 插件清单热加载入口（逐字移植自原版 service/PluginHotLoader.ts）
//
// 约定：`plugins/plugin_list.json` 列出插件 manifest 文件名（字符串数组），
// 每个文件是一份完整的 PluginManifest。
// loadAll 读列表 → PluginManifestLoader.parse/apply → 注册进 ToolRegistry，
// 之后 PromptBuilder 的工具目录会自动包含这些插件工具。
//
// 平台差异：原版从 rawfile 读（`context.resourceManager.getRawFileContent`），
// 桌面端沿用同一个入口 —— 平台层的 ResourceManager 已经把 rawfile 映射到
// 随包资源目录并做了目录穿越校验，所以这里不需要另起一套文件读取。
//
// 为什么必须有调用点：`WorkToolRunner` 早就会分发插件工具、随包也有
// `resources/plugins/plugin_list.json`，但没有加载器的话它们一律返回「插件未实现」。
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { PluginManifestLoader, PluginManifest, PluginManifestResult } from '../common/PluginManifestLoader';

export class PluginHotLoader {
  private static loaded: PluginManifest[] = [];

  // 加载 plugins/ 下由 plugin_list.json 声明的插件; 单个失败不影响其他插件
  static async loadAll(context: common.UIAbilityContext): Promise<PluginManifestResult[]> {
    let results: PluginManifestResult[] = [];
    let text: string = '';
    try {
      let raw: Uint8Array = await context.resourceManager.getRawFileContent('plugins/plugin_list.json');
      let decoder: util.TextDecoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
      text = decoder.decodeToString(raw, { stream: false });
    } catch (e) {
      // 无插件清单: 视为没有插件
      return results;
    }
    let files: string[] = [];
    try {
      let parsed: Object = JSON.parse(text);
      let arr: Object[] = parsed as Object[];
      for (let i: number = 0; i < arr.length; i++) {
        let item: Object = arr[i];
        if (typeof item === 'string') {
          files.push(item as string);
        }
      }
    } catch (e) {
      let r: PluginManifestResult = new PluginManifestResult();
      r.ok = false;
      r.error = 'list_parse_failed:plugins/plugin_list.json';
      results.push(r);
      return results;
    }
    // 排序后再加载: 让「同名工具冲突时谁先注册」有确定的结果, 而不是看目录顺序
    files.sort();
    for (let i: number = 0; i < files.length; i++) {
      let file: string = files[i];
      let rawPath: string = 'plugins/' + file;
      let body: string = '';
      try {
        let raw: Uint8Array = await context.resourceManager.getRawFileContent(rawPath);
        let decoder: util.TextDecoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
        body = decoder.decodeToString(raw, { stream: false });
      } catch (e) {
        let r: PluginManifestResult = new PluginManifestResult();
        r.ok = false;
        r.error = 'read_failed:' + rawPath;
        results.push(r);
        continue;
      }
      let manifest: PluginManifest | null = PluginManifestLoader.parse(body);
      if (manifest === null) {
        let r: PluginManifestResult = new PluginManifestResult();
        r.ok = false;
        r.error = 'parse_failed:' + rawPath;
        results.push(r);
        continue;
      }
      let applied: PluginManifestResult = PluginManifestLoader.apply(manifest);
      if (applied.ok) {
        PluginHotLoader.loaded.push(manifest);
      }
      results.push(applied);
    }
    return results;
  }

  // 卸载后重新加载全部插件(热重载入口)
  static async reloadAll(context: common.UIAbilityContext): Promise<PluginManifestResult[]> {
    PluginHotLoader.unloadAll();
    return await PluginHotLoader.loadAll(context);
  }

  // 当前已加载插件数量(供日志/UI 摘要)
  static loadedCount(): number {
    return PluginHotLoader.loaded.length;
  }

  // 已加载插件摘要(面向维护者/日志)
  static loadedSummary(): string {
    if (PluginHotLoader.loaded.length === 0) {
      return '未加载插件';
    }
    let names: string[] = [];
    for (let i: number = 0; i < PluginHotLoader.loaded.length; i++) {
      names.push(PluginHotLoader.loaded[i].id);
    }
    return '已加载插件(' + names.length.toString() + '): ' + names.join(', ');
  }

  // 卸载本次热加载的所有插件(幂等)
  static unloadAll(): void {
    for (let i: number = 0; i < PluginHotLoader.loaded.length; i++) {
      PluginManifestLoader.unload(PluginHotLoader.loaded[i]);
    }
    PluginHotLoader.loaded = [];
  }
}
