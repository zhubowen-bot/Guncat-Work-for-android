import { ApiProfile } from '@core/model/ApiProfile';
import { ApiConfig } from '@core/model/ApiConfig';
import { ApiPresets } from '@core/model/ApiPresets';
import { MultimodalConfig } from '@core/model/MultimodalConfig';

/** 播种结果：新方案列表 + 应该选中的方案 id + 被合并掉的旧方案数量 */
export interface ApiProfileSeedResult {
  profiles: ApiProfile[];
  currentId: string;
  merged: number;
}

/**
 * 预置配置方案的一次性播种/迁移。
 *
 * 规则（与设置页的「配置方案」语义一致）：
 *   1. 先放两套预置方案：Deepseek（Anthropic Messages）与 Opencode Go；
 *   2. 旧配置里凡是 Base URL 指向 api.deepseek.com 的方案，都并进 Deepseek：
 *      Key、当前模型、模型清单、采样参数、多模态配置能保留的全保留，只把协议
 *      统一到官方 Anthropic 端点 —— 这样老用户升级后不会多出一堆重复方案，
 *      也不会因为换了协议而丢掉已经填好的 Key；
 *   3. 全新安装（所有旧方案都是空白）时直接丢掉空白方案，只留两套预置；
 *   4. 当前方案若正好是被合并的 DeepSeek 方案，就切到预置 Deepseek；
 *      其余情况保持用户原来的选择。
 *
 * 纯函数：不读写存储，便于 ipc-check 直接对生产实现下断言。
 */
export class ApiProfileSeeder {
  static seed(existing: ApiProfile[], currentId: string): ApiProfileSeedResult {
    let deepseek: ApiProfile = ApiPresets.deepseekProfile();
    let opencode: ApiProfile = ApiPresets.opencodeGoProfile();

    let deepseekOld: ApiProfile[] = [];
    let others: ApiProfile[] = [];
    let empties: ApiProfile[] = [];
    let realProfiles: number = 0;
    for (let i: number = 0; i < existing.length; i++) {
      let profile: ApiProfile = existing[i];
      if (ApiProfileSeeder.isEmpty(profile)) {
        // 全新安装时这条是自动迁移出来的「空默认配置」；有真实配置时则可能是用户
        // 特意留的备用位，不能替用户删掉。预置 id 的空壳不再保留（下面会重新生成）。
        if (profile.id !== ApiPresets.DEEPSEEK_ID && profile.id !== ApiPresets.OPENCODE_GO_ID) {
          empties.push(profile);
        }
        continue;
      }
      realProfiles++;
      if (ApiPresets.isDeepSeekBaseUrl(profile.apiConfig.baseUrl)) {
        deepseekOld.push(profile);
      } else if (profile.id !== ApiPresets.DEEPSEEK_ID && profile.id !== ApiPresets.OPENCODE_GO_ID) {
        others.push(profile);
      }
    }

    // 全新安装 / 旧配置全是空壳：不保留空方案，直接给两套可填 Key 的预置
    let keepOthers: ApiProfile[] = realProfiles === 0 ? [] : others.concat(empties);

    if (deepseekOld.length > 0) {
      ApiProfileSeeder.mergeDeepSeek(deepseek, deepseekOld, currentId);
    }

    let profiles: ApiProfile[] = [deepseek, opencode];
    for (let i: number = 0; i < keepOthers.length; i++) {
      profiles.push(keepOthers[i]);
    }

    let nextId: string = currentId;
    let currentMerged: boolean = false;
    for (let i: number = 0; i < deepseekOld.length; i++) {
      if (deepseekOld[i].id === currentId) {
        currentMerged = true;
      }
    }
    if (currentMerged) {
      nextId = deepseek.id;
    }
    if (!ApiProfileSeeder.hasId(profiles, nextId)) {
      nextId = realProfiles === 0 ? deepseek.id : (keepOthers.length > 0 ? keepOthers[0].id : deepseek.id);
    }

    return { profiles: profiles, currentId: nextId, merged: deepseekOld.length };
  }

  /** 空白方案：没有任何接入信息，播种时可以安全丢弃 */
  static isEmpty(profile: ApiProfile): boolean {
    let config: ApiConfig = profile.apiConfig;
    return config.baseUrl.trim() === '' && config.apiKey.trim() === '' &&
      config.model.trim() === '' && config.models.length === 0;
  }

  private static mergeDeepSeek(target: ApiProfile, old: ApiProfile[], currentId: string): void {
    let preferred: ApiProfile = old[0];
    for (let i: number = 0; i < old.length; i++) {
      if (old[i].id === currentId) {
        preferred = old[i];
      }
    }

    let apiKey: string = '';
    let models: string[] = target.apiConfig.models.slice(0);
    let active: string = target.apiConfig.model;
    let temperature: number | null = target.apiConfig.temperature;
    let topP: number | null = target.apiConfig.topP;
    let maxTokens: number | null = target.apiConfig.maxTokens;
    let extraBody: string = target.apiConfig.extraBody;
    let autoSuffix: boolean = target.apiConfig.autoSuffix;

    for (let i: number = 0; i < old.length; i++) {
      let config: ApiConfig = old[i].apiConfig;
      if (config.apiKey.trim() !== '') {
        apiKey = config.apiKey;
      }
      for (let j: number = 0; j < config.models.length; j++) {
        models = ApiConfig.normalizeModels(models, config.models[j]);
      }
      models = ApiConfig.normalizeModels(models, config.model);
    }

    // 当前方案优先：它的模型就是用户点开设置时想看到的那个
    if (preferred.apiConfig.apiKey.trim() !== '') {
      apiKey = preferred.apiConfig.apiKey;
    }
    if (preferred.apiConfig.model.trim() !== '') {
      active = preferred.apiConfig.model.trim();
    }
    if (preferred.apiConfig.temperature !== null) {
      temperature = preferred.apiConfig.temperature;
    }
    if (preferred.apiConfig.topP !== null) {
      topP = preferred.apiConfig.topP;
    }
    if (preferred.apiConfig.maxTokens !== null) {
      maxTokens = preferred.apiConfig.maxTokens;
    }
    if (preferred.apiConfig.extraBody.trim() !== '') {
      extraBody = preferred.apiConfig.extraBody;
    }
    // 合并后 Base URL 被统一成官方 Anthropic 入口，路径补全必须打开：
    // 老配置可能把 autoSuffix 关掉过（当时填的是完整 OpenAI 路径），
    // 原样保留会让请求打到 /anthropic 而不是 /anthropic/v1/messages。
    autoSuffix = true;

    target.apiConfig.apiKey = apiKey;
    target.apiConfig.model = active;
    target.apiConfig.models = ApiConfig.normalizeModels(models, active);
    target.apiConfig.temperature = temperature;
    target.apiConfig.topP = topP;
    target.apiConfig.maxTokens = maxTokens;
    target.apiConfig.extraBody = extraBody;
    target.apiConfig.autoSuffix = autoSuffix;

    // 多模态配置跟随「当前方案」；它没配 Key 时退回第一个配了 Key 的旧方案
    let mm: MultimodalConfig | null = null;
    if (preferred.multimodalConfig.apiKey.trim() !== '') {
      mm = preferred.multimodalConfig;
    } else {
      for (let i: number = 0; i < old.length; i++) {
        if (old[i].multimodalConfig.apiKey.trim() !== '') {
          mm = old[i].multimodalConfig;
          break;
        }
      }
    }
    if (mm !== null) {
      target.multimodalConfig = mm;
    }
  }

  private static hasId(profiles: ApiProfile[], id: string): boolean {
    for (let i: number = 0; i < profiles.length; i++) {
      if (profiles[i].id === id) {
        return true;
      }
    }
    return false;
  }
}
