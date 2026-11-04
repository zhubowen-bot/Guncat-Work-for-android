// 多模态配置 (默认使用智谱 GLM-4.6V-Flash；附件先行解析默认关闭)
import { Constants } from '../common/Constants';

export class MultimodalConfig {
  baseUrl: string = '';
  apiKey: string = '';
  model: string = '';
  preparseEnabled: boolean = false;

  static default(): MultimodalConfig {
    let cfg: MultimodalConfig = new MultimodalConfig();
    cfg.baseUrl = Constants.DEFAULT_MM_BASE_URL;
    cfg.apiKey = '';
    cfg.model = Constants.DEFAULT_MM_MODEL;
    // 默认关闭：附件直接交给主模型，避免新用户在没有配置多模态 Key 时
    // 先走一次独立解析再退回内联。需要先行解析时在设置里显式开启。
    cfg.preparseEnabled = false;
    return cfg;
  }

  static fromJson(json: Record<string, Object>): MultimodalConfig {
    let cfg: MultimodalConfig = MultimodalConfig.default();
    if (json['baseUrl'] !== undefined) {
      cfg.baseUrl = json['baseUrl'] as string;
    }
    if (json['apiKey'] !== undefined) {
      cfg.apiKey = json['apiKey'] as string;
    }
    if (json['model'] !== undefined) {
      cfg.model = json['model'] as string;
    }
    if (json['preparseEnabled'] !== undefined) {
      cfg.preparseEnabled = json['preparseEnabled'] as boolean;
    }
    return cfg;
  }

  toJson(): Record<string, Object> {
    return {
      'baseUrl': this.baseUrl,
      'apiKey': this.apiKey,
      'model': this.model,
      'preparseEnabled': this.preparseEnabled
    };
  }
}
