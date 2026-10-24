// API 配置 (对齐 web 版本的 guncat_api_config 结构)
// 接入方式统一为三种主流协议：
//   openai-completions: OpenAI Chat Completions  /chat/completions
//   openai-responses:   OpenAI Responses         /responses（DeepSeek、火山方舟等兼容服务）
//   anthropic-messages: Anthropic Messages       /messages
export class ApiConfig {
  provider: string = 'openai-completions';
  baseUrl: string = '';
  apiKey: string = '';
  // 当前生效的模型。models 是同一套接入方式下可切换的模型清单，
  // 一个服务商配一次 Key、多个模型不用重复建配置方案。
  model: string = '';
  models: string[] = [];
  temperature: number | null = null;
  topP: number | null = null;
  maxTokens: number | null = null;
  extraBody: string = '';
  // 自动补全协议路径后缀(/chat/completions、/responses、/v1/messages 等)。
  // 关闭后严格按填写的 Base URL 发起请求, 适合非标准路径的自建网关/代理; 默认开启。
  autoSuffix: boolean = true;
  // 会话级标识, **运行期字段, 不落盘**。
  // OpenCode Go 要求每个模型请求带 x-opencode-session: 同一对话固定、不同对话不同。
  // 由主进程在每次任务开始时填入对话 id; 自动审查读的是同一份配置, 因此也自动带上。
  sessionId: string = '';

  static default(): ApiConfig {
    return new ApiConfig();
  }

  /**
   * 规整模型清单: 去空白、去重, 并保证「当前模型」一定在清单里。
   * 老存档只有单个 model 字段, 这里顺手把它并进清单, 界面不会看到「有模型却列表为空」。
   */
  static normalizeModels(models: string[] | null | undefined, active: string): string[] {
    let result: string[] = [];
    if (models !== null && models !== undefined) {
      for (let i: number = 0; i < models.length; i++) {
        let name: string = (models[i] ?? '').trim();
        if (name !== '' && result.indexOf(name) < 0) {
          result.push(name);
        }
      }
    }
    let current: string = (active ?? '').trim();
    if (current !== '' && result.indexOf(current) < 0) {
      result.push(current);
    }
    return result;
  }

  static openAICompletionsPreset(): ApiConfig {
    let cfg: ApiConfig = new ApiConfig();
    cfg.provider = 'openai-completions';
    cfg.baseUrl = 'https://api.openai.com/v1';
    cfg.model = '';
    return cfg;
  }

  static openAIResponsesPreset(): ApiConfig {
    let cfg: ApiConfig = new ApiConfig();
    cfg.provider = 'openai-responses';
    cfg.baseUrl = 'https://api.openai.com/v1';
    cfg.model = '';
    return cfg;
  }

  static anthropicMessagesPreset(): ApiConfig {
    let cfg: ApiConfig = new ApiConfig();
    cfg.provider = 'anthropic-messages';
    cfg.baseUrl = 'https://api.anthropic.com/v1';
    cfg.model = '';
    return cfg;
  }

  // 旧版本 provider 迁移：custom/deepseek/volcano 统一映射到三种协议。
  static normalizeProvider(provider: string): string {
    if (provider === 'custom' || provider === '') {
      return 'openai-completions';
    }
    if (provider === 'deepseek' || provider === 'volcano') {
      return 'openai-responses';
    }
    return provider;
  }

  static fromJson(json: Record<string, Object>): ApiConfig {
    let cfg: ApiConfig = new ApiConfig();
    cfg.provider = ApiConfig.normalizeProvider((json['provider'] as string) ?? '');
    cfg.baseUrl = (json['baseUrl'] as string) ?? '';
    cfg.apiKey = (json['apiKey'] as string) ?? '';
    cfg.model = (json['model'] as string) ?? '';
    cfg.extraBody = (json['extraBody'] as string) ?? '';
    // 旧存档无该字段时保持默认开启
    let suffix: Object = json['autoSuffix'];
    if (suffix !== undefined && suffix !== null) {
      cfg.autoSuffix = (suffix as boolean) === true;
    }
    // 旧存档只有单个 model: 读出来补进清单, 不丢用户已经填好的模型
    let rawModels: Object = json['models'];
    let parsedModels: string[] = [];
    if (rawModels instanceof Array) {
      for (let i: number = 0; i < rawModels.length; i++) {
        let item: Object = rawModels[i];
        if (typeof item === 'string') {
          parsedModels.push(item as string);
        }
      }
    }
    cfg.models = ApiConfig.normalizeModels(parsedModels, cfg.model);
    let t: Object = json['temperature'];
    if (t !== undefined && t !== null) {
      cfg.temperature = t as number;
    }
    let p: Object = json['topP'];
    if (p !== undefined && p !== null) {
      cfg.topP = p as number;
    }
    let m: Object = json['maxTokens'];
    if (m !== undefined && m !== null) {
      cfg.maxTokens = m as number;
    }
    return cfg;
  }

  toJson(): Record<string, Object> {
    let result: Record<string, Object> = {
      'provider': this.provider,
      'baseUrl': this.baseUrl,
      'apiKey': this.apiKey,
      'model': this.model,
      'models': ApiConfig.normalizeModels(this.models, this.model),
      'extraBody': this.extraBody,
      'autoSuffix': this.autoSuffix
    };
    if (this.temperature !== null) {
      result['temperature'] = this.temperature;
    }
    if (this.topP !== null) {
      result['topP'] = this.topP;
    }
    if (this.maxTokens !== null) {
      result['maxTokens'] = this.maxTokens;
    }
    return result;
  }
}
