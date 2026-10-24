// SSEAdapterFactory: 工作模式/聊天模式共用的协议 SSE 适配器工厂
// 把 ChatService 的解析器与 ToolCallStream 的收集器注入统一流水线,
// 避免 AgentLoopService 与 ChatService 各写一套 buildSseAdapter。
import { SSEProtocolAdapter } from '../common/SSEProtocolAdapter';
import { ToolCallAccumulator, collectCompletionsToolDelta, collectResponsesToolItem,
  collectAnthropicToolEvent } from './ToolCallStream';
import {
  extractChatCompletionsDelta, extractChatCompletionsReasoning, extractChatCompletionsUsage,
  extractResponsesDelta, extractResponsesReasoning, extractResponsesUsage, extractResponsesFailure,
  extractAnthropicDelta, extractAnthropicReasoning, extractAnthropicUsage, extractAnthropicFailure,
  extractAnthropicSignature, extractAnthropicRedactedThinking
} from './ChatService';

export class SSEAdapterFactory {
  // 是否支持该协议标识(openai-completions / openai-responses / anthropic-messages)
  static supports(protocol: string): boolean {
    return protocol === 'openai' || protocol === 'responses' || protocol === 'anthropic';
  }

  static build(protocol: string, callAcc: ToolCallAccumulator,
    finishExtractor: ((protocol: string, sseData: string) => string) | null = null): SSEProtocolAdapter {
    let adapter: SSEProtocolAdapter = new SSEProtocolAdapter();
    adapter.protocol = protocol;
    adapter.extractFailure = (sseData: string): string => {
      if (protocol === 'responses') {
        return extractResponsesFailure(sseData);
      }
      if (protocol === 'anthropic') {
        return extractAnthropicFailure(sseData);
      }
      return '';
    };
    adapter.extractDelta = (sseData: string): string => {
      if (protocol === 'responses') {
        return extractResponsesDelta(sseData);
      }
      if (protocol === 'anthropic') {
        return extractAnthropicDelta(sseData);
      }
      return extractChatCompletionsDelta(sseData);
    };
    adapter.extractReasoning = (sseData: string): string => {
      if (protocol === 'responses') {
        return extractResponsesReasoning(sseData);
      }
      if (protocol === 'anthropic') {
        return extractAnthropicReasoning(sseData);
      }
      return extractChatCompletionsReasoning(sseData);
    };
    adapter.extractSignature = (sseData: string): string => {
      if (protocol === 'anthropic') {
        return extractAnthropicSignature(sseData);
      }
      return '';
    };
    adapter.extractRedactedThinking = (sseData: string): string => {
      if (protocol === 'anthropic') {
        return extractAnthropicRedactedThinking(sseData);
      }
      return '';
    };
    adapter.extractUsage = (sseData: string): Record<string, Object> | null => {
      if (protocol === 'responses') {
        return extractResponsesUsage(sseData);
      }
      if (protocol === 'anthropic') {
        return extractAnthropicUsage(sseData);
      }
      return extractChatCompletionsUsage(sseData);
    };
    adapter.collectToolEvent = (sseData: string): void => {
      if (protocol === 'responses') {
        collectResponsesToolItem(sseData, callAcc);
      } else if (protocol === 'anthropic') {
        collectAnthropicToolEvent(sseData, callAcc);
      } else {
        collectCompletionsToolDelta(sseData, callAcc);
      }
    };
    adapter.extractFinishReason = (sseData: string): string => {
      if (finishExtractor !== null) {
        return finishExtractor(protocol, sseData);
      }
      return '';
    };
    // 协议终止事件: 流式请求只有收到它才算完整结束。缺了它(连接被代理/网络掐断)
    // 时调用方必须按 transport 错误重试, 不能把半截正文当成最终回答。
    adapter.extractComplete = (sseData: string): boolean => {
      try {
        if (protocol === 'responses') {
          return sseData.indexOf('"response.completed"') >= 0 ||
            sseData.indexOf('"response.incomplete"') >= 0;
        }
        if (protocol === 'anthropic') {
          if (sseData.indexOf('"message_stop"') >= 0) {
            return true;
          }
          // 部分兼容网关不发 message_stop，只发带 stop_reason 的 message_delta
          if (sseData.indexOf('"stop_reason"') < 0) {
            return false;
          }
          let json: Object = JSON.parse(sseData);
          if (typeof json !== 'object' || json === null) {
            return false;
          }
          let delta: Object = (json as Record<string, Object>)['delta'];
          if (typeof delta !== 'object' || delta === null) {
            return false;
          }
          let stop: Object = (delta as Record<string, Object>)['stop_reason'];
          return typeof stop === 'string' && (stop as string) !== '';
        }
        // completions: 最后一块带非空 finish_reason
        if (sseData.indexOf('finish_reason') < 0) {
          return false;
        }
        let json2: Object = JSON.parse(sseData);
        if (typeof json2 !== 'object' || json2 === null) {
          return false;
        }
        let choices: Object = (json2 as Record<string, Object>)['choices'];
        if (!(choices instanceof Array) || choices.length === 0) {
          return false;
        }
        let first: Object = choices[0];
        if (typeof first !== 'object' || first === null) {
          return false;
        }
        let finish: Object = (first as Record<string, Object>)['finish_reason'];
        return typeof finish === 'string' && (finish as string) !== '';
      } catch (e) {
        return false;
      }
    };
    return adapter;
  }
}
