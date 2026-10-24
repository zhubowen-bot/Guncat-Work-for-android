// LLMProtocol: 三协议统一元数据与端点解析(纯逻辑, 无 HarmonyOS 依赖)
// 单一事实源: provider → 协议 → 请求端点, 供 AgentLoopService/ChatService 共用。
import { Constants } from './Constants';
import type { ApiConfig } from '../model/ApiConfig';

export class LLMProtocol {
  static readonly COMPLETIONS: string = 'completions';
  static readonly RESPONSES: string = 'responses';
  static readonly ANTHROPIC: string = 'anthropic';

  // OpenCode 网关（Go 套餐与按量付费）要求的会话头。官方文档：
  // 每个请求都要带一个稳定的 x-opencode-session，用于路由与提示缓存复用。
  static readonly OPENCODE_SESSION_HEADER: string = 'x-opencode-session';

  // 没有任何会话上下文时（标题生成、附件解析等旁路请求）用的进程内稳定值。
  private static fallbackSession: string = '';

  // provider 字符串 → 协议: openai-responses→responses, anthropic-messages→anthropic, 其余→completions
  static pick(provider: string): string {
    if (provider === 'openai-responses') {
      return LLMProtocol.RESPONSES;
    }
    if (provider === 'anthropic-messages') {
      return LLMProtocol.ANTHROPIC;
    }
    return LLMProtocol.COMPLETIONS;
  }

  /** 是否 OpenCode 的推理网关（opencode.ai/inference 与 .../inference/go） */
  static isOpenCode(baseUrl: string): boolean {
    return /^https?:\/\/opencode\.ai\/inference(?:\/|$)/i.test(baseUrl.trim());
  }

  /** 对话 id → 稳定的会话头值。同一对话每次都一样，换对话就不同。 */
  static conversationSessionId(conversationId: string): string {
    let safe: string = conversationId.replace(/[^A-Za-z0-9_.-]/g, '_');
    return safe === '' ? '' : 'ses_' + safe;
  }

  /** 取会话头值：优先用任务开始时填入的对话 id，旁路请求退回进程内稳定值 */
  static sessionIdFor(config: ApiConfig): string {
    let value: string = (config.sessionId ?? '').trim();
    if (value !== '') {
      return value;
    }
    if (LLMProtocol.fallbackSession === '') {
      LLMProtocol.fallbackSession = 'ses_guncat_' + Date.now().toString(36) +
        Math.floor(Math.random() * 1000000).toString(36);
    }
    return LLMProtocol.fallbackSession;
  }

  /**
   * 统一的鉴权/网关请求头。聊天、工作循环、自动审查、文件上传都从这里取，
   * 不再各写一份 —— 否则 OpenCode Go 的特殊头很容易只在主聊天链路上生效。
   */
  static authHeaders(config: ApiConfig, protocol: string): Record<string, string> {
    let headers: Record<string, string> = {};
    if (protocol === LLMProtocol.ANTHROPIC) {
      headers['x-api-key'] = config.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = 'Bearer ' + config.apiKey;
    }
    if (LLMProtocol.isOpenCode(config.baseUrl)) {
      // OpenCode 的 Claude Code 接入示例用的是 ANTHROPIC_AUTH_TOKEN（Bearer），
      // 而 Anthropic SDK 走 x-api-key；网关两种都认，这里两边都带上，避免只认其中一种。
      headers['Authorization'] = 'Bearer ' + config.apiKey;
      headers[LLMProtocol.OPENCODE_SESSION_HEADER] = LLMProtocol.sessionIdFor(config);
    }
    return headers;
  }

  // 由 Base URL 推导最终请求端点(三协议共用)。
  // autoSuffix=false 时严格使用用户填写的地址(仅去首尾空白), 不做任何协议路径补全——
  // 用于非标准路径的自建网关/代理; 开启时按协议补全标准路径。
  //
  // 三处特殊路径:
  //   · DeepSeek 的 Anthropic 兼容端点是 https://api.deepseek.com/anthropic，
  //     它后面只接 /v1/messages（不能再拼一次 /anthropic）；
  //   · 用户直接填主域名 https://api.deepseek.com 时自动落到 /anthropic/v1/messages；
  //   · OpenCode 网关的所有协议路径都挂在 /openai 或 /anthropic 下面：
  //     /openai/v1/chat/completions、/openai/v1/responses、/anthropic/v1/messages。
  static resolveEndpoint(baseUrl: string, protocol: string, autoSuffix: boolean): string {
    if (!autoSuffix) {
      return baseUrl.trim();
    }
    let base: string = baseUrl.replace(/\/+$/, '');
    let opencode: boolean = LLMProtocol.isOpenCode(base);
    if (protocol === LLMProtocol.RESPONSES) {
      if (opencode) {
        return base + '/openai/v1/responses';
      }
      return base + Constants.RESPONSES_PATH;
    }
    if (protocol === LLMProtocol.ANTHROPIC) {
      if (base.endsWith('/v1') || base.endsWith('/anthropic/v1')) {
        return base + Constants.MESSAGES_PATH;
      }
      // DeepSeek 官方 Anthropic base_url（/anthropic）与 OpenCode 网关都补 /v1/messages
      if (base.endsWith('/anthropic')) {
        return base + Constants.ANTHROPIC_V1_MESSAGES_PATH;
      }
      if (base === 'https://api.deepseek.com' || base === 'http://api.deepseek.com') {
        // 兼容用户直接填 DeepSeek 主域名时自动切到 Anthropic 兼容端点
        return base + Constants.ANTHROPIC_DEEPSEEK_MESSAGES_PATH;
      }
      if (opencode) {
        return base + Constants.OPENCODE_ANTHROPIC_MESSAGES_PATH;
      }
      return base + Constants.ANTHROPIC_V1_MESSAGES_PATH;
    }
    if (opencode) {
      return base + '/openai/v1/chat/completions';
    }
    return base + Constants.CHAT_COMPLETIONS_PATH;
  }

  static displayName(protocol: string): string {
    if (protocol === LLMProtocol.RESPONSES) {
      return 'OpenAI Responses';
    }
    if (protocol === LLMProtocol.ANTHROPIC) {
      return 'Anthropic Messages';
    }
    return 'OpenAI Chat Completions';
  }
}
