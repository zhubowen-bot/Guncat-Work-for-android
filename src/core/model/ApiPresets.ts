import { ApiConfig } from './ApiConfig';
import { ApiProfile } from './ApiProfile';
import { MultimodalConfig } from './MultimodalConfig';

// 内置配置方案（预置模板）。
//
// 这里只放「接入方式 + 端点 + 模型清单」这些公开、可验证的事实，不放任何密钥：
// 用户第一次打开设置时能看到两套可用的骨架，填上自己的 Key 就能用，而不是面对一张空白表单。
//
// 端点与协议的依据：
//   · DeepSeek Anthropic 兼容端点的 base_url 是 https://api.deepseek.com/anthropic
//     （官方文档「使用 Anthropic API」），预留模型为 deepseek-flash；
//   · OpenCode Go 的 base_url 是 https://opencode.ai/inference/go。
//     Go 的每个模型只归属一种协议，deepseek-v4.1-flash 官方给的是 OpenAI Chat Completions
//     （.../openai/v1/chat/completions），所以这套预置按 Chat Completions 接入；
//   · 从 2025-09-05 起 OpenCode Go 的每个请求还必须带 x-opencode-session（会话级稳定 ID），
//     这一条由 LLMProtocol.authHeaders 统一补，聊天、工作流与自动审查都走同一处。
export class ApiPresets {
  /** 预置方案用固定 id：一次性迁移靠它判断「这份方案是不是预置的」 */
  static readonly DEEPSEEK_ID: string = 'preset-deepseek';
  static readonly OPENCODE_GO_ID: string = 'preset-opencode-go';

  static readonly DEEPSEEK_NAME: string = 'Deepseek';
  static readonly OPENCODE_GO_NAME: string = 'Opencode Go';

  static readonly DEEPSEEK_BASE_URL: string = 'https://api.deepseek.com/anthropic';
  static readonly OPENCODE_GO_BASE_URL: string = 'https://opencode.ai/inference/go';

  // 预置只留最常用、且与各自方案协议匹配的模型；其余模型由用户按需添加。
  static readonly DEEPSEEK_MODELS: string[] = ['deepseek-flash'];
  static readonly OPENCODE_GO_MODELS: string[] = ['deepseek-v4.1-flash'];

  static deepseekProfile(): ApiProfile {
    let profile: ApiProfile = new ApiProfile();
    profile.id = ApiPresets.DEEPSEEK_ID;
    profile.name = ApiPresets.DEEPSEEK_NAME;
    profile.apiConfig = ApiPresets.configFor(
      'anthropic-messages',
      ApiPresets.DEEPSEEK_BASE_URL,
      'deepseek-flash',
      ApiPresets.DEEPSEEK_MODELS
    );
    profile.multimodalConfig = MultimodalConfig.default();
    return profile;
  }

  static opencodeGoProfile(): ApiProfile {
    let profile: ApiProfile = new ApiProfile();
    profile.id = ApiPresets.OPENCODE_GO_ID;
    profile.name = ApiPresets.OPENCODE_GO_NAME;
    profile.apiConfig = ApiPresets.configFor(
      'openai-completions',
      ApiPresets.OPENCODE_GO_BASE_URL,
      'deepseek-v4.1-flash',
      ApiPresets.OPENCODE_GO_MODELS
    );
    profile.multimodalConfig = MultimodalConfig.default();
    return profile;
  }

  static allProfiles(): ApiProfile[] {
    return [ApiPresets.deepseekProfile(), ApiPresets.opencodeGoProfile()];
  }

  /**
   * 是否 DeepSeek 官方域名（含 /anthropic、/v1 等任意路径）。
   * 用主机名边界匹配，避免把 api.deepseek.com.evil.example 误判成 DeepSeek。
   */
  static isDeepSeekBaseUrl(baseUrl: string): boolean {
    let url: string = baseUrl.trim();
    return /^https?:\/\/api\.deepseek\.com(?::\d+)?(\/|$)/i.test(url);
  }

  private static configFor(provider: string, baseUrl: string, model: string, models: string[]): ApiConfig {
    let config: ApiConfig = new ApiConfig();
    config.provider = provider;
    config.baseUrl = baseUrl;
    config.model = model;
    config.models = models.slice(0);
    // 预置端点都是标准路径：自动补全开着，用户只改域名也不会拼错协议路径
    config.autoSuffix = true;
    return config;
  }
}
