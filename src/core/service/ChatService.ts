// ChatService: 真正的 SSE 流式三协议, 对齐 web 版本 streamChat
//  - openai-completions → Chat Completions (/chat/completions)
//  - openai-responses   → Responses API    (/responses)
//  - anthropic-messages → Anthropic Messages (/messages)
import { http } from '@kit.NetworkKit';
import { ApiConfig } from '../model/ApiConfig';
import { Agent } from '../model/Agent';
import { Message } from '../model/Message';
import { Attachment } from '../model/Attachment';
import { ToolCallRecord } from '../model/ToolCallRecord';
import { StreamCallbacks, AbortSignal } from '../common/Types';
import { Constants } from '../common/Constants';
import { LLMProtocol } from '../common/LLMProtocol';
import { SSEProtocolAdapter, SSEParseContext } from '../common/SSEProtocolAdapter';
import { SSEAdapterFactory } from './SSEAdapterFactory';
import { util } from '@kit.ArkTS';
import { ToolCallAccumulator, collectCompletionsToolDelta, collectResponsesToolItem,
  collectAnthropicToolEvent, genToolCallId } from './ToolCallStream';
import { LOCAL_SEARCH_TOOL_NAME, LOCAL_SEARCH_TOOL_DESC_CHAT, LOCAL_SEARCH_TOOL_DESC_CHAT_FALLBACK,
  LOCAL_SEARCH_QUERY_PROP_DESC } from './LocalWebSearch';
import { HarnessTools } from './HarnessTools';
import { connectTimeoutForBody, describeTransportError } from '../common/HttpTimeouts';
import { normalizeUsageTokens, supportsStreamUsage } from '../common/UsageProtocol';
import { UsageRequestMeter, UsageService } from './UsageService';

export class StreamAccumulator {
  buffer: ArrayBuffer = new ArrayBuffer(0);
  decoder: util.TextDecoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
  fullContent: string = '';

  append(data: ArrayBuffer): string {
    let newBuffer: ArrayBuffer = new ArrayBuffer(this.buffer.byteLength + data.byteLength);
    let src: Uint8Array = new Uint8Array(this.buffer);
    let add: Uint8Array = new Uint8Array(data);
    let dst: Uint8Array = new Uint8Array(newBuffer);
    dst.set(src, 0);
    dst.set(add, this.buffer.byteLength);
    this.buffer = newBuffer;
    return this.decoder.decodeToString(add, { stream: true });
  }
}

export function getProtocol(provider: string): string {
  return LLMProtocol.pick(provider);
}

// 单次流式请求的结构化产出(聊天模式本地联网搜索工具循环需要):
// toolCalls 供调用方执行后回灌下一轮; thinkingSignature/redactedThinking 供
// Anthropic 协议思考模式下把带 tool_use 的 assistant 消息回传时随思考块携带
export class ChatStreamResult {
  toolCalls: ToolCallRecord[] = [];
  thinkingSignature: string = '';
  redactedThinking: string = '';
  // Responses 协议的 reasoning output item(JSON 数组字符串), 跨轮次回传思考所需
  reasoningItems: string = '';
}

// 本地内置联网搜索 search_web 的 function tool 定义(协议相关形态):
// 强制注入聊天模式请求体, 与服务端联网搜索(可选开关)并存, 互不影响。
// serverSearchEnabled=true 时描述切换为"兜底版", 引导模型优先走服务端 web_search。
export function buildLocalSearchToolDef(protocol: string, serverSearchEnabled: boolean): Record<string, Object> {
  let schema: Record<string, Object> = {
    'type': 'object',
    'properties': {
      'query': { 'type': 'string', 'description': LOCAL_SEARCH_QUERY_PROP_DESC }
    },
    'required': ['query']
  };
  let description: string = serverSearchEnabled ?
    LOCAL_SEARCH_TOOL_DESC_CHAT_FALLBACK : LOCAL_SEARCH_TOOL_DESC_CHAT;
  if (protocol === 'anthropic') {
    return {
      'name': LOCAL_SEARCH_TOOL_NAME,
      'description': description,
      'input_schema': schema
    };
  }
  if (protocol === 'responses') {
    return {
      'type': 'function',
      'name': LOCAL_SEARCH_TOOL_NAME,
      'description': description,
      'parameters': schema
    };
  }
  return {
    'type': 'function',
    'function': {
      'name': LOCAL_SEARCH_TOOL_NAME,
      'description': description,
      'parameters': schema
    }
  };
}

// web_fetch function tool 定义(复用工作模式 HarnessTools 的定义, 按协议映射形态):
// 与 search_web 一起强制注入聊天模式, 供模型读取搜索来源/用户给的链接
function buildWebFetchToolDef(protocol: string): Record<string, Object> {
  let def: Record<string, Object> = HarnessTools.webFetchDef();
  let name: string = def['name'] as string;
  let description: string = def['description'] as string;
  let schema: Record<string, Object> = def['parameters'] as Record<string, Object>;
  if (protocol === 'anthropic') {
    return { 'name': name, 'description': description, 'input_schema': schema };
  }
  if (protocol === 'responses') {
    return { 'type': 'function', 'name': name, 'description': description, 'parameters': schema };
  }
  return {
    'type': 'function',
    'function': { 'name': name, 'description': description, 'parameters': schema }
  };
}

// 工具调用参数 JSON → 对象(解析失败回落空对象)
function parseToolArgsObject(argsJson: string): Record<string, Object> {
  try {
    let parsed: Object = JSON.parse(argsJson === '' ? '{}' : argsJson);
    if (typeof parsed === 'object' && parsed !== null && !(parsed instanceof Array)) {
      return parsed as Record<string, Object>;
    }
  } catch (e) {
    // ignore
  }
  return {};
}

// 由 Base URL 推导最终请求端点(三协议共用)。
// autoSuffix=false 时严格使用用户填写的地址(仅去首尾空白), 不做任何协议路径补全——
// 用于非标准路径的自建网关/代理; 开启时按协议补全标准路径。
export function resolveEndpointUrl(config: ApiConfig, protocol: string): string {
  return LLMProtocol.resolveEndpoint(config.baseUrl, protocol, config.autoSuffix);
}

// 导出两个请求体构建器：跨轮思考重放的回归检查要直接对生产实现下断言，
// 不要在测试里另抄一份「reasoning_content/thinking 放在哪」的规则。
export function buildChatCompletionsBody(config: ApiConfig, agent: Agent | null,
  history: Message[], userText: string,
  thinkingEnabled: boolean, webSearchEnabled: boolean): Record<string, Object> {
  let messages: Record<string, Object>[] = [];
  if (agent !== null && agent.systemPrompt !== '') {
    messages.push({ role: 'system', content: agent.systemPrompt });
  }
  for (let i: number = 0; i < history.length; i++) {
    let m: Message = history[i];
    // 只带工具调用的 assistant 消息(content 为空)不能跳过, 工具结果回灌依赖它;
    // 正文为空但带思考的历史 assistant 同样不能跳（reasoning_content 本身就是有效内容）。
    if (m.content === '' && m.toolCalls.length === 0 && m.reasoning === '') {
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') {
      continue;
    }
    if (m.role === 'user' && m.attachments.length > 0) {
      let contentParts: Record<string, Object>[] = [];
      if (m.content !== '') {
        contentParts.push({ type: 'text', text: m.content });
      }
      for (let j: number = 0; j < m.attachments.length; j++) {
        let attachment: Attachment = m.attachments[j];
        if (attachment.parsedText !== '' || attachment.dataUrl === '') {
          continue;
        }
        if (attachment.type === 'image') {
          if (attachment.fileId !== '') {
            contentParts.push({
              type: 'file',
              file_id: attachment.fileId
            });
          } else {
            contentParts.push({
              type: 'image_url',
              image_url: { url: attachment.dataUrl }
            });
          }
        } else {
          if (attachment.fileId !== '') {
            contentParts.push({
              type: 'file',
              file_id: attachment.fileId
            });
          } else {
            // 兼容支持 file_url 的 OpenAI 兼容接口；不支持的提供商会忽略或报错。
            contentParts.push({
              type: 'file_url',
              file_url: { url: attachment.dataUrl }
            });
          }
        }
      }
      if (contentParts.length > 0) {
        messages.push({ role: 'user', content: contentParts });
        continue;
      }
    }
    if (m.role === 'assistant' && m.toolCalls.length > 0) {
      // 本地工具循环: assistant(tool_calls) + role:'tool' 结果回传。
      // 带 tool_calls 的 assistant 同样要回传 reasoning_content —— DeepSeek 的规则是
      // 「带 tools 的请求，后续每次请求都要完整回传历史 reasoning」，漏掉这一条会 400。
      let callArr: Record<string, Object>[] = [];
      for (let c: number = 0; c < m.toolCalls.length; c++) {
        let call: ToolCallRecord = m.toolCalls[c];
        callArr.push({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.argsJson === '' ? '{}' : call.argsJson }
        });
      }
      let assistantMsg: Record<string, Object> = {
        role: 'assistant',
        content: m.content === '' ? null : m.content,
        tool_calls: callArr
      };
      if (m.reasoning !== '') {
        assistantMsg['reasoning_content'] = m.reasoning;
      }
      messages.push(assistantMsg);
      for (let c: number = 0; c < m.toolCalls.length; c++) {
        let call: ToolCallRecord = m.toolCalls[c];
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: call.result === '' ? '(无结果)' : call.result
        });
      }
      continue;
    }
    let chatMsg: Record<string, Object> = { role: m.role, content: m.content };
    // 请求恒带 tools（本地 search_web / web_fetch），因此历史 assistant 的 reasoning_content
    // 必须回传：它是「带 tools 时会被拼进上下文」的内容，只回正文会让第二轮起丢掉前面的思考。
    if (m.role === 'assistant' && m.reasoning !== '') {
      chatMsg['reasoning_content'] = m.reasoning;
    }
    messages.push(chatMsg);
  }
  let lastHistory: Message | null = history.length > 0 ? history[history.length - 1] : null;
  // 本地搜索工具循环的续轮请求 userText 为空串, 不再追加用户消息
  if (userText !== '') {
    if (lastHistory === null || lastHistory.role !== 'user' || lastHistory.content !== userText) {
      messages.push({ role: 'user', content: userText });
    }
  }

  let body: Record<string, Object> = {
    model: config.model,
    messages: messages,
    stream: true
  };
  // DeepSeek / OpenCode / OpenAI 的流式请求要显式要 usage；其它兼容网关不认这个字段，
  // 直接加会被部分服务端判成 400，因此按 provider 白名单处理。
  if (supportsStreamUsage(config.baseUrl)) {
    body['stream_options'] = { include_usage: true };
  }

  // 本地内置联网搜索 search_web 强制注入(由模型决定是否调用); 服务端联网搜索按开关并存
  let chatTools: Record<string, Object>[] = [];
  if (webSearchEnabled) {
    // OpenAI 兼容 Chat Completions 服务若支持服务端搜索，可识别该工具。
    chatTools.push({ type: 'web_search' });
  }
  chatTools.push(buildLocalSearchToolDef('completions', webSearchEnabled));
  chatTools.push(buildWebFetchToolDef('completions'));
  body['tools'] = chatTools;
  body['tool_choice'] = 'auto';
  if (config.temperature !== null) {
    body['temperature'] = config.temperature;
  }
  if (config.topP !== null) {
    body['top_p'] = config.topP;
  }
  if (config.maxTokens !== null) {
    body['max_tokens'] = config.maxTokens;
  }
  if (config.extraBody !== '') {
    try {
      let extra: Object = JSON.parse(config.extraBody);
      if (typeof extra === 'object' && extra !== null) {
        let keys: string[] = Object.keys(extra);
        for (let i: number = 0; i < keys.length; i++) {
          body[keys[i]] = (extra as Record<string, Object>)[keys[i]];
        }
      }
    } catch (e) {
      // 忽略非法 JSON
    }
  }
  // 深度思考开关（OpenAI 兼容格式）：thinking.type 控制开关 + reasoning_effort 控制强度。
  // 放在 extraBody 合并之后，确保界面开关优先级最高。
  body['thinking'] = { type: thinkingEnabled ? 'enabled' : 'disabled' };
  if (thinkingEnabled) {
    body['reasoning_effort'] = 'high';
  }
  return body;
}

// Responses 协议跨轮次思考: 优先回传服务端下发的 reasoning output item(原样, 含 id /
// encrypted_content); 兼容端点(DeepSeek 等)还支持明文 content 归并到相邻 assistant 消息,
// 而官方 OpenAI 对缺 id/encrypted_content 的明文 reasoning item 会拒绝, 故明文兜底只给非官方端点。
export function responsesReasoningItems(reasoningItemsJson: string, reasoningText: string,
  allowPlainText: boolean): Record<string, Object>[] {
  let out: Record<string, Object>[] = [];
  if (reasoningItemsJson !== '') {
    try {
      let parsed: Object = JSON.parse(reasoningItemsJson);
      if (parsed instanceof Array) {
        let arr: Object[] = parsed as Object[];
        for (let i: number = 0; i < arr.length; i++) {
          let item: Object = arr[i];
          if (typeof item === 'object' && item !== null) {
            out.push(item as Record<string, Object>);
          }
        }
      }
    } catch (e) {
      // 坏数据忽略: 宁可丢思考, 也不让整条历史把请求弄挂
    }
  }
  if (out.length === 0 && reasoningText !== '' && allowPlainText) {
    out.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: reasoningText }] });
  }
  return out;
}

function buildResponsesBody(config: ApiConfig, agent: Agent | null,
  history: Message[], userText: string,
  thinkingEnabled: boolean, webSearchEnabled: boolean): Record<string, Object> {
  let input: Record<string, Object>[] = [];
  // Responses 没有 reasoning_content 字段: 思考以 reasoning input item 回传(见 responsesReasoningItems)
  let allowPlainReasoning: boolean = !LLMProtocol.isOfficialOpenAI(config.baseUrl);
  for (let i: number = 0; i < history.length; i++) {
    let m: Message = history[i];
    // 只带工具调用的 assistant 消息(content 为空)不能跳过, 工具结果回灌依赖它
    if (m.content === '' && m.toolCalls.length === 0) {
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') {
      continue;
    }
    if (m.role === 'user' && m.attachments.length > 0) {
      let contentParts: Record<string, Object>[] = [];
      contentParts.push({ type: 'input_text', text: m.content });
      for (let j: number = 0; j < m.attachments.length; j++) {
        let attachment: Attachment = m.attachments[j];
        if (attachment.parsedText !== '' || attachment.dataUrl === '') {
          continue;
        }
        if (attachment.type === 'image') {
          if (attachment.fileId !== '') {
            contentParts.push({
              type: 'input_image',
              file_id: attachment.fileId
            });
          } else {
            contentParts.push({
              type: 'input_image',
              image_url: attachment.dataUrl
            });
          }
        } else {
          // 统一发送 input_file；若服务商不支持会由服务端返回错误。
          if (attachment.fileId !== '') {
            contentParts.push({
              type: 'input_file',
              file_id: attachment.fileId
            });
          } else {
            contentParts.push({
              type: 'input_file',
              filename: attachment.name,
              file_data: attachment.dataUrl
            });
          }
        }
      }
      input.push({ role: m.role, content: contentParts });
    } else if (m.role === 'assistant' && m.toolCalls.length > 0) {
      // 本地工具循环: reasoning? + function_call + function_call_output 输入项
      let reasoningItems: Record<string, Object>[] = responsesReasoningItems(
        m.reasoningItems, m.reasoning, allowPlainReasoning);
      for (let r: number = 0; r < reasoningItems.length; r++) {
        input.push(reasoningItems[r]);
      }
      if (m.content !== '') {
        input.push({
          role: 'assistant',
          content: [{ type: 'output_text', text: m.content }]
        });
      }
      for (let c: number = 0; c < m.toolCalls.length; c++) {
        let call: ToolCallRecord = m.toolCalls[c];
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.argsJson === '' ? '{}' : call.argsJson
        });
      }
      for (let c: number = 0; c < m.toolCalls.length; c++) {
        let call: ToolCallRecord = m.toolCalls[c];
        input.push({
          type: 'function_call_output',
          call_id: call.id,
          output: call.result === '' ? '(无结果)' : call.result
        });
      }
    } else {
      if (m.role === 'assistant') {
        let reasoningItems: Record<string, Object>[] = responsesReasoningItems(
          m.reasoningItems, m.reasoning, allowPlainReasoning);
        for (let r: number = 0; r < reasoningItems.length; r++) {
          input.push(reasoningItems[r]);
        }
      }
      input.push({ role: m.role, content: m.content });
    }
  }
  let lastHistory: Message | null = history.length > 0 ? history[history.length - 1] : null;
  // 本地搜索工具循环的续轮请求 userText 为空串, 不再追加用户消息
  if (userText !== '') {
    if (lastHistory === null || lastHistory.role !== 'user' || lastHistory.content !== userText) {
      input.push({ role: 'user', content: userText });
    }
  }

  let body: Record<string, Object> = {
    model: config.model,
    input: input,
    stream: true,
    store: false,
    // 无状态模式(store:false): 拿到 reasoning.encrypted_content 才能在下一轮回传思考。
    // DeepSeek 不支持 include(文档说明静默忽略), 兼容端点不受影响。
    include: ['reasoning.encrypted_content']
  };

  if (agent !== null && agent.systemPrompt !== '') {
    body['instructions'] = agent.systemPrompt;
  }
  // 本地内置联网搜索 search_web 强制注入(由模型决定是否调用); 服务端联网搜索按开关并存
  let respTools: Record<string, Object>[] = [];
  if (webSearchEnabled) {
    // OpenAI Responses 兼容格式；DeepSeek 与火山方舟均支持该工具。
    respTools.push({ type: 'web_search' });
  }
  respTools.push(buildLocalSearchToolDef('responses', webSearchEnabled));
  respTools.push(buildWebFetchToolDef('responses'));
  body['tools'] = respTools;
  body['tool_choice'] = 'auto';
  if (config.temperature !== null) {
    body['temperature'] = config.temperature;
  }
  if (config.topP !== null) {
    body['top_p'] = config.topP;
  }
  if (config.maxTokens !== null) {
    body['max_output_tokens'] = config.maxTokens;
  }
  if (config.extraBody !== '') {
    try {
      let extra: Object = JSON.parse(config.extraBody);
      if (typeof extra === 'object' && extra !== null) {
        let keys: string[] = Object.keys(extra);
        for (let i: number = 0; i < keys.length; i++) {
          body[keys[i]] = (extra as Record<string, Object>)[keys[i]];
        }
      }
    } catch (e) {
      // ignore
    }
  }
  // 深度思考开关（Responses API 格式）：reasoning.effort 控制开关，none 表示关闭。
  // 放在 extraBody 合并之后，确保界面开关优先级最高。
  body['reasoning'] = { effort: thinkingEnabled ? 'high' : 'none' };
  return body;
}

function appendAnthropicMessage(messages: Record<string, Object>[], role: string, content: Object): void {
  let last: Record<string, Object> | null = messages.length > 0 ? messages[messages.length - 1] : null;
  let lastRole: Object = last !== null ? last['role'] : null;
  if (typeof lastRole === 'string' && lastRole === role) {
    let prevContent: Object = last['content'];
    if (typeof prevContent === 'string' && typeof content === 'string') {
      last['content'] = prevContent + '\n\n' + content;
      return;
    }
    if (prevContent instanceof Array && content instanceof Array) {
      let prevArr: Object[] = prevContent as Object[];
      let addArr: Object[] = content as Object[];
      for (let i: number = 0; i < addArr.length; i++) {
        prevArr.push(addArr[i]);
      }
      return;
    }
    if (prevContent instanceof Array && typeof content === 'string') {
      let prevArr: Object[] = prevContent as Object[];
      prevArr.push({ type: 'text', text: content });
      return;
    }
    if (typeof prevContent === 'string' && content instanceof Array) {
      let merged: Object[] = [{ type: 'text', text: prevContent }];
      let addArr: Object[] = content as Object[];
      for (let i: number = 0; i < addArr.length; i++) {
        merged.push(addArr[i]);
      }
      last['content'] = merged;
      return;
    }
  }
  messages.push({ role: role, content: content });
}

export function buildAnthropicBody(config: ApiConfig, agent: Agent | null,
  history: Message[], userText: string,
  thinkingEnabled: boolean, webSearchEnabled: boolean): Record<string, Object> {
  let messages: Record<string, Object>[] = [];
  for (let i: number = 0; i < history.length; i++) {
    let m: Message = history[i];
    // 只带工具调用的 assistant 消息(content 为空)不能跳过, 工具结果回灌依赖它;
    // 正文为空但带思考的历史 assistant 同样不能跳（thinking 块本身就是有效内容）。
    if (m.content === '' && m.toolCalls.length === 0 && m.reasoning === '') {
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') {
      continue;
    }
    if (m.role === 'user' && m.attachments.length > 0) {
      let contentParts: Record<string, Object>[] = [];
      if (m.content !== '') {
        contentParts.push({ type: 'text', text: m.content });
      }
      for (let j: number = 0; j < m.attachments.length; j++) {
        let attachment: Attachment = m.attachments[j];
        if (attachment.parsedText !== '' || attachment.dataUrl === '') {
          continue;
        }
        if (attachment.type === 'image') {
          if (attachment.fileId !== '') {
            contentParts.push({
              type: 'image',
              source: { type: 'file', file_id: attachment.fileId }
            });
          } else if (attachment.dataUrl.startsWith('http://') || attachment.dataUrl.startsWith('https://')) {
            contentParts.push({
              type: 'image',
              source: { type: 'url', url: attachment.dataUrl }
            });
          } else {
            let dataUrl: string = attachment.dataUrl;
            let comma: number = dataUrl.indexOf(';base64,');
            if (comma > 0) {
              let mediaType: string = dataUrl.substring(5, comma);
              let data: string = dataUrl.substring(comma + 8);
              contentParts.push({
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: data }
              });
            }
          }
        } else {
          // 统一发送 document 块；若服务商不支持会由服务端返回错误。
          if (attachment.fileId !== '') {
            contentParts.push({
              type: 'document',
              source: { type: 'file', file_id: attachment.fileId }
            });
          } else if (attachment.dataUrl.startsWith('http://') || attachment.dataUrl.startsWith('https://')) {
            contentParts.push({
              type: 'document',
              source: { type: 'url', url: attachment.dataUrl }
            });
          } else {
            let dataUrl: string = attachment.dataUrl;
            let comma: number = dataUrl.indexOf(';base64,');
            if (comma > 0) {
              let mediaType: string = dataUrl.substring(5, comma);
              let data: string = dataUrl.substring(comma + 8);
              contentParts.push({
                type: 'document',
                source: { type: 'base64', media_type: mediaType, data: data }
              });
            }
          }
        }
      }
      if (contentParts.length > 0) {
        appendAnthropicMessage(messages, 'user', contentParts);
        continue;
      }
    }
    if (m.role === 'assistant' && m.toolCalls.length > 0) {
      // 本地工具循环: assistant(thinking? + text? + tool_use) + user(tool_result)。
      // 思考模式下带 tool_use 的 assistant 消息必须回传思考块(置于首位, 与工作模式同规则):
      // 有思考文本即回传, 签名随消息持久化后原样携带
      let allowUnsigned: boolean = !LLMProtocol.isOfficialAnthropic(config.baseUrl);
      let blocks: Object[] = [];
      if (thinkingEnabled && m.redactedThinking !== '') {
        blocks.push({ type: 'redacted_thinking', data: m.redactedThinking });
      } else if (thinkingEnabled && m.reasoning !== '' &&
        (m.thinkingSignature !== '' || allowUnsigned)) {
        let thinkingBlock: Record<string, Object> = { type: 'thinking', thinking: m.reasoning };
        if (m.thinkingSignature !== '') {
          thinkingBlock['signature'] = m.thinkingSignature;
        }
        blocks.push(thinkingBlock);
      }
      if (m.content !== '') {
        blocks.push({ type: 'text', text: m.content });
      }
      for (let c: number = 0; c < m.toolCalls.length; c++) {
        let call: ToolCallRecord = m.toolCalls[c];
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: parseToolArgsObject(call.argsJson)
        });
      }
      appendAnthropicMessage(messages, 'assistant', blocks);
      let results: Object[] = [];
      for (let c: number = 0; c < m.toolCalls.length; c++) {
        let call: ToolCallRecord = m.toolCalls[c];
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: call.result === '' ? '(无结果)' : call.result
        });
      }
      appendAnthropicMessage(messages, 'user', results);
    } else if (m.role === 'assistant') {
      // 历史 assistant 的思考也要回传（不只是带 tool_use 的那一轮）：
      // 带 tools 的请求里，思考是会被拼回上下文的正式内容，丢了就只剩正文总结。
      // 签名随消息持久化；官方端点对无签名块会 400，仅在其上跳过"无签名历史"组合。
      let allowUnsigned: boolean = !LLMProtocol.isOfficialAnthropic(config.baseUrl);
      let blocks: Object[] = [];
      if (thinkingEnabled && m.redactedThinking !== '') {
        blocks.push({ type: 'redacted_thinking', data: m.redactedThinking });
      } else if (thinkingEnabled && m.reasoning !== '' &&
        (m.thinkingSignature !== '' || allowUnsigned)) {
        let thinkingBlock: Record<string, Object> = { type: 'thinking', thinking: m.reasoning };
        if (m.thinkingSignature !== '') {
          thinkingBlock['signature'] = m.thinkingSignature;
        }
        blocks.push(thinkingBlock);
      }
      if (m.content !== '') {
        blocks.push({ type: 'text', text: m.content });
      }
      if (blocks.length === 0) {
        continue;
      }
      // 没有思考块时保持旧形态(纯字符串 content), 不改变既有请求前缀
      if (blocks.length === 1 && m.content !== '') {
        appendAnthropicMessage(messages, 'assistant', m.content);
      } else {
        appendAnthropicMessage(messages, 'assistant', blocks);
      }
    } else {
      appendAnthropicMessage(messages, m.role, m.content);
    }
  }
  let lastHistory: Message | null = history.length > 0 ? history[history.length - 1] : null;
  // 本地搜索工具循环的续轮请求 userText 为空串, 不再追加用户消息
  if (userText !== '') {
    if (lastHistory === null || lastHistory.role !== 'user' || lastHistory.content !== userText) {
      appendAnthropicMessage(messages, 'user', userText);
    }
  }

  // Anthropic Messages API 必填 max_tokens(其他两种协议可省略由服务端决定)。
  // 未配置时默认下发 128K(Constants.DEFAULT_MAX_OUTPUT_TOKENS): 额度顶满时服务端
  // 按 stop_reason=max_tokens 截断输出, 且思考模式的思考文本同样计入该额度。
  let maxTokens: number = config.maxTokens !== null ?
    config.maxTokens : Constants.DEFAULT_MAX_OUTPUT_TOKENS;
  let body: Record<string, Object> = {
    model: config.model,
    messages: messages,
    stream: true,
    max_tokens: maxTokens
  };
  if (agent !== null && agent.systemPrompt !== '') {
    body['system'] = agent.systemPrompt;
  }
  // 本地内置联网搜索 search_web 强制注入(由模型决定是否调用); 服务端联网搜索按开关并存
  let anthroTools: Object[] = [];
  if (webSearchEnabled) {
    let tool: Record<string, Object> = {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5
    };
    anthroTools.push(tool);
  }
  anthroTools.push(buildLocalSearchToolDef('anthropic', webSearchEnabled));
  anthroTools.push(buildWebFetchToolDef('anthropic'));
  body['tools'] = anthroTools;
  if (config.temperature !== null) {
    body['temperature'] = config.temperature;
  }
  if (config.topP !== null) {
    body['top_p'] = config.topP;
  }
  if (config.extraBody !== '') {
    try {
      let extra: Object = JSON.parse(config.extraBody);
      if (typeof extra === 'object' && extra !== null) {
        let keys: string[] = Object.keys(extra);
        for (let i: number = 0; i < keys.length; i++) {
          body[keys[i]] = (extra as Record<string, Object>)[keys[i]];
        }
      }
    } catch (e) {
      // ignore
    }
  }
  // 深度思考开关（Anthropic 兼容格式）：thinking.type 控制开关 + output_config.effort 控制强度。
  // 放在 extraBody 合并之后，确保界面开关优先级最高。
  body['thinking'] = { type: thinkingEnabled ? 'enabled' : 'disabled' };
  if (thinkingEnabled) {
    body['output_config'] = { effort: 'high' };
  }
  return body;
}

export function extractChatCompletionsDelta(sseData: string): string {
  try {
    let json: Object = JSON.parse(sseData);
    if (typeof json !== 'object' || json === null) {
      return '';
    }
    let choices: Object = (json as Record<string, Object>)['choices'];
    if (!(choices instanceof Array) || choices.length === 0) {
      return '';
    }
    let first: Object = choices[0];
    if (typeof first !== 'object' || first === null) {
      return '';
    }
    let delta: Object = (first as Record<string, Object>)['delta'];
    if (typeof delta !== 'object' || delta === null) {
      return '';
    }
    let content: Object = (delta as Record<string, Object>)['content'];
    if (typeof content === 'string') {
      return content;
    }
    return '';
  } catch (e) {
    return '';
  }
}

export function extractResponsesDelta(sseData: string): string {
  try {
    let json: Object = JSON.parse(sseData);
    if (typeof json !== 'object' || json === null) {
      return '';
    }
    let type: Object = (json as Record<string, Object>)['type'];
    if (typeof type !== 'string' || type !== 'response.output_text.delta') {
      return '';
    }
    let delta: Object = (json as Record<string, Object>)['delta'];
    if (typeof delta === 'string') {
      return delta;
    }
    return '';
  } catch (e) {
    return '';
  }
}

export function extractResponsesFailure(sseData: string): string {
  try {
    let json: Object = JSON.parse(sseData);
    if (typeof json !== 'object' || json === null) {
      return '';
    }
    let type: Object = (json as Record<string, Object>)['type'];
    if (typeof type !== 'string' || type !== 'response.failed') {
      return '';
    }
    let resp: Object = (json as Record<string, Object>)['response'];
    if (typeof resp !== 'object' || resp === null) {
      return 'Responses API 返回失败';
    }
    let err: Object = (resp as Record<string, Object>)['error'];
    if (typeof err === 'object' && err !== null) {
      let msg: Object = (err as Record<string, Object>)['message'];
      if (typeof msg === 'string') {
        return msg;
      }
    }
    return 'Responses API 返回失败';
  } catch (e) {
    return '';
  }
}

export function extractAnthropicDelta(sseData: string): string {
  try {
    let json: Object = JSON.parse(sseData);
    if (typeof json !== 'object' || json === null) {
      return '';
    }
    let type: Object = (json as Record<string, Object>)['type'];
    if (typeof type !== 'string' || type !== 'content_block_delta') {
      return '';
    }
    let delta: Object = (json as Record<string, Object>)['delta'];
    if (typeof delta !== 'object' || delta === null) {
      return '';
    }
    let deltaType: Object = (delta as Record<string, Object>)['type'];
    if (typeof deltaType !== 'string' || deltaType !== 'text_delta') {
      return '';
    }
    let text: Object = (delta as Record<string, Object>)['text'];
    if (typeof text === 'string') {
      return text;
    }
    return '';
  } catch (e) {
    return '';
  }
}

export function extractAnthropicFailure(sseData: string): string {
  try {
    let json: Object = JSON.parse(sseData);
    if (typeof json !== 'object' || json === null) {
      return '';
    }
    let type: Object = (json as Record<string, Object>)['type'];
    if (typeof type !== 'string' || type !== 'error') {
      return '';
    }
    let err: Object = (json as Record<string, Object>)['error'];
    if (typeof err === 'object' && err !== null) {
      let msg: Object = (err as Record<string, Object>)['message'];
      if (typeof msg === 'string') {
        return msg;
      }
    }
    return 'Anthropic Messages API 返回失败';
  } catch (e) {
    return '';
  }
}

// ===== 深度思考增量解析 (对齐 web 版本 extractXXXReasoning) =====

export function extractChatCompletionsReasoning(sseData: string): string {
  try {
    let json: Object = JSON.parse(sseData);
    if (typeof json !== 'object' || json === null) {
      return '';
    }
    let choices: Object = (json as Record<string, Object>)['choices'];
    if (!(choices instanceof Array) || choices.length === 0) {
      return '';
    }
    let first: Object = choices[0];
    if (typeof first !== 'object' || first === null) {
      return '';
    }
    let delta: Object = (first as Record<string, Object>)['delta'];
    if (typeof delta !== 'object' || delta === null) {
      return '';
    }
    // DeepSeek 使用 reasoning_content; 部分 OpenAI 兼容服务使用 reasoning
    let reasoning: Object = (delta as Record<string, Object>)['reasoning_content'];
    if (typeof reasoning === 'string') {
      return reasoning;
    }
    let reasoningAlt: Object = (delta as Record<string, Object>)['reasoning'];
    if (typeof reasoningAlt === 'string') {
      return reasoningAlt;
    }
    return '';
  } catch (e) {
    return '';
  }
}

// Responses 协议的 reasoning output item: response.output_item.done 里的 item 就是
// 可回传的完整形状(OpenAI 带 id/summary/encrypted_content, DeepSeek 带明文 content)。
// 跨轮次思考回传只能靠它, 因此把 item 原样序列化保存。
export function extractResponsesReasoningItem(sseData: string): string {
  try {
    let json: Object = JSON.parse(sseData);
    if (typeof json !== 'object' || json === null) {
      return '';
    }
    if ((json as Record<string, Object>)['type'] !== 'response.output_item.done') {
      return '';
    }
    let item: Object = (json as Record<string, Object>)['item'];
    if (typeof item !== 'object' || item === null) {
      return '';
    }
    if ((item as Record<string, Object>)['type'] !== 'reasoning') {
      return '';
    }
    return JSON.stringify(item);
  } catch (e) {
    return '';
  }
}

// 把一条 reasoning item 追加进 JSON 数组字符串(跨事件累积)
export function appendReasoningItem(current: string, itemJson: string): string {
  let arr: Object[] = [];
  if (current !== '') {
    try {
      let parsed: Object = JSON.parse(current);
      if (parsed instanceof Array) {
        arr = parsed as Object[];
      }
    } catch (e) {
      arr = [];
    }
  }
  try {
    arr.push(JSON.parse(itemJson) as Object);
  } catch (e) {
    return current;
  }
  return JSON.stringify(arr);
}

export function extractResponsesReasoning(sseData: string): string {
  try {
    let json: Object = JSON.parse(sseData);
    if (typeof json !== 'object' || json === null) {
      return '';
    }
    let type: Object = (json as Record<string, Object>)['type'];
    if (typeof type !== 'string') {
      return '';
    }
    if (type !== 'response.reasoning_summary_text.delta' && type !== 'response.reasoning_text.delta') {
      return '';
    }
    let delta: Object = (json as Record<string, Object>)['delta'];
    if (typeof delta === 'string') {
      return delta;
    }
    if (delta instanceof Array) {
      let parts: string[] = [];
      let arr: Object[] = delta as Object[];
      for (let i: number = 0; i < arr.length; i++) {
        let item: Object = arr[i];
        if (typeof item === 'object' && item !== null) {
          let text: Object = (item as Record<string, Object>)['text'];
          if (typeof text === 'string') {
            parts.push(text);
          }
        }
      }
      return parts.join('');
    }
    return '';
  } catch (e) {
    return '';
  }
}

export function extractAnthropicReasoning(sseData: string): string {
  try {
    let json: Object = JSON.parse(sseData);
    if (typeof json !== 'object' || json === null) {
      return '';
    }
    let type: Object = (json as Record<string, Object>)['type'];
    if (typeof type !== 'string' || type !== 'content_block_delta') {
      return '';
    }
    let delta: Object = (json as Record<string, Object>)['delta'];
    if (typeof delta !== 'object' || delta === null) {
      return '';
    }
    let deltaType: Object = (delta as Record<string, Object>)['type'];
    if (typeof deltaType !== 'string' || deltaType !== 'thinking_delta') {
      return '';
    }
    let thinking: Object = (delta as Record<string, Object>)['thinking'];
    if (typeof thinking === 'string') {
      return thinking;
    }
    return '';
  } catch (e) {
    return '';
  }
}

// 思考块签名增量: thinking 块结束后由 signature_delta 事件携带, 回传 thinking 块时随块携带
export function extractAnthropicSignature(sseData: string): string {
  try {
    let json: Object = JSON.parse(sseData);
    if (typeof json !== 'object' || json === null) {
      return '';
    }
    let type: Object = (json as Record<string, Object>)['type'];
    if (typeof type !== 'string' || type !== 'content_block_delta') {
      return '';
    }
    let delta: Object = (json as Record<string, Object>)['delta'];
    if (typeof delta !== 'object' || delta === null) {
      return '';
    }
    let deltaType: Object = (delta as Record<string, Object>)['type'];
    if (typeof deltaType !== 'string' || deltaType !== 'signature_delta') {
      return '';
    }
    let signature: Object = (delta as Record<string, Object>)['signature'];
    if (typeof signature === 'string') {
      return signature;
    }
    return '';
  } catch (e) {
    return '';
  }
}

// 加密思考块(redacted_thinking): content_block_start 事件直接携带完整 data 字段,
// 回传时原样送回(无增量), 否则思考模式下服务端 400
export function extractAnthropicRedactedThinking(sseData: string): string {
  try {
    let json: Object = JSON.parse(sseData);
    if (typeof json !== 'object' || json === null) {
      return '';
    }
    let type: Object = (json as Record<string, Object>)['type'];
    if (typeof type !== 'string' || type !== 'content_block_start') {
      return '';
    }
    let block: Object = (json as Record<string, Object>)['content_block'];
    if (typeof block !== 'object' || block === null) {
      return '';
    }
    let blockRec: Record<string, Object> = block as Record<string, Object>;
    let blockType: Object = blockRec['type'];
    if (typeof blockType !== 'string' || (blockType as string) !== 'redacted_thinking') {
      return '';
    }
    let data: Object = blockRec['data'];
    if (typeof data === 'string') {
      return data;
    }
    return '';
  } catch (e) {
    return '';
  }
}

// ===== usage 解析 (对齐 web 版本 extractXXXUsage) =====

export function extractChatCompletionsUsage(sseData: string): Record<string, Object> | null {
  try {
    let json: Object = JSON.parse(sseData);
    if (typeof json !== 'object' || json === null) {
      return null;
    }
    let usage: Object = (json as Record<string, Object>)['usage'];
    if (typeof usage === 'object' && usage !== null) {
      return usage as Record<string, Object>;
    }
    return null;
  } catch (e) {
    return null;
  }
}

export function extractResponsesUsage(sseData: string): Record<string, Object> | null {
  try {
    let json: Object = JSON.parse(sseData);
    if (typeof json !== 'object' || json === null) {
      return null;
    }
    let type: Object = (json as Record<string, Object>)['type'];
    if (typeof type !== 'string' ||
      (type !== 'response.completed' && type !== 'response.incomplete')) {
      return null;
    }
    let resp: Object = (json as Record<string, Object>)['response'];
    if (typeof resp === 'object' && resp !== null) {
      let usage: Object = (resp as Record<string, Object>)['usage'];
      if (typeof usage === 'object' && usage !== null) {
        return usage as Record<string, Object>;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Anthropic 流式 usage 分两次到达：
//   message_start.message.usage → input_tokens + cache_creation/read（output_tokens=0）
//   message_delta.usage         → output_tokens（以及部分网关补的输入字段）
// 只取 message_delta 会把输入与缓存命中全部丢掉；两处都返回，由请求级 meter 合并。
export function extractAnthropicUsage(sseData: string): Record<string, Object> | null {
  try {
    let json: Object = JSON.parse(sseData);
    if (typeof json !== 'object' || json === null) {
      return null;
    }
    let type: Object = (json as Record<string, Object>)['type'];
    if (typeof type !== 'string') {
      return null;
    }
    if (type === 'message_delta') {
      let usage: Object = (json as Record<string, Object>)['usage'];
      if (typeof usage === 'object' && usage !== null) {
        return usage as Record<string, Object>;
      }
      return null;
    }
    if (type === 'message_start') {
      let message: Object = (json as Record<string, Object>)['message'];
      if (typeof message === 'object' && message !== null) {
        let usage: Object = (message as Record<string, Object>)['usage'];
        if (typeof usage === 'object' && usage !== null) {
          return usage as Record<string, Object>;
        }
      }
      return null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// 由 API 返回的 usage 派生 token 速度(tok/s)与缓存命中率(0..1)。
// 三协议 + OpenCode 的字段差异统一交给 normalizeUsageTokens，避免这里再维护一份口径。
// protocol 传空串时按字段自动判断（兼容旧调用点）。
export function deriveStreamStats(usage: Record<string, Object> | null,
  elapsedMs: number, protocol: string = ''): number[] {
  let speed: number = -1;
  let hit: number = -1;
  if (usage === null) {
    return [speed, hit];
  }
  try {
    const normalized = normalizeUsageTokens(protocol, usage);
    const tokens = normalized.tokens;
    const outTokens: number = tokens.output;
    const hitTokens: number = tokens.inputHit;
    const totalTokens: number = tokens.inputHit + tokens.inputMiss + tokens.cacheWrite;
    if (outTokens > 0 && elapsedMs > 0) {
      speed = outTokens / (elapsedMs / 1000);
    }
    if (hitTokens > 0 && totalTokens > 0) {
      hit = hitTokens / totalTokens;
    } else if (normalized.cacheFieldsPresent && totalTokens > 0) {
      // 服务端明确报了缓存字段但命中为 0：这是 0%，不是“没有数据”
      hit = 0;
    }
  } catch (e) {
    return [-1, -1];
  }
  return [speed, hit];
}

export class ChatService {
  private static activeRequest: http.HttpRequest | null = null;

  static async streamChat(
    config: ApiConfig,
    agent: Agent | null,
    history: Message[],
    userText: string,
    thinkingEnabled: boolean,
    webSearchEnabled: boolean,
    callbacks: StreamCallbacks,
    abortSignal: AbortSignal
  ): Promise<ChatStreamResult> {
    let protocol: string = getProtocol(config.provider);
    let url: string = resolveEndpointUrl(config, protocol);
    // 请求级记账器：startedAt 取请求开始时间（峰谷/计费日期都以它为准）。
    // 只创建一个轻量对象，不碰磁盘，也不影响流式解析。
    let usageMeter: UsageRequestMeter = UsageService.beginRequest(config, protocol);

    let body: Record<string, Object>;
    if (protocol === 'responses') {
      body = buildResponsesBody(config, agent, history, userText, thinkingEnabled, webSearchEnabled);
    } else if (protocol === 'anthropic') {
      body = buildAnthropicBody(config, agent, history, userText, thinkingEnabled, webSearchEnabled);
    } else {
      body = buildChatCompletionsBody(config, agent, history, userText, thinkingEnabled, webSearchEnabled);
    }
    let bodyStr: string = JSON.stringify(body);

    let httpRequest: http.HttpRequest = http.createHttp();
    ChatService.activeRequest = httpRequest;
    let acc: StreamAccumulator = new StreamAccumulator();
    let lineBuffer: string = '';
    let receivedAnyData: boolean = false;
    let aborted: boolean = false;
    let failedMsg: string = '';
    // 深度思考累积 + 请求起始时间(用于由 usage 派生 token 速度)
    let fullReasoning: string = '';
    let startTime: number = Date.now();
    // 工具调用累积(本地联网搜索 search_web 等强制注入的 function tool)
    let callAcc: ToolCallAccumulator = new ToolCallAccumulator();
    let sseAdapter: SSEProtocolAdapter = SSEAdapterFactory.build(protocol, callAcc);
    let lastToolSig: string = '';
    // Anthropic 思考块签名与加密思考块(思考模式下本地工具循环回传所需)
    let thinkingSignature: string = '';
    let redactedThinking: string = '';
    let reasoningItems: string = '';
    // 是否收到协议终止事件(finish_reason / message_stop / response.completed / [DONE])。
    // 没收到就闭合连接 = 半截流, 不能当成正常回答结束。
    let sawComplete: boolean = false;
    let streamResult: ChatStreamResult = new ChatStreamResult();
    // 对齐 web 版本: SSE 解析出一个 delta 就立即 onToken 全量累积,
    // UI 端 50ms 节流刷新. 不做应用层字符拆分 (避免 setTimeout 队列过长 OOM)

    // 单条 SSE 数据分发(数据流与 dataEnd 兜底共用): 协议适配器统一解析文本/思考/工具调用/usage
    let processSseData = (sseData: string): void => {
      let ctx: SSEParseContext = new SSEParseContext();
      ctx.onFailure = (msg: string): boolean => {
        failedMsg = msg;
        throw new Error(msg);
      };
      ctx.onToken = (delta: string): void => {
        acc.fullContent += delta;
        callbacks.onToken(delta);
      };
      ctx.onReasoning = (text: string): void => {
        fullReasoning += text;
        callbacks.onReasoning(fullReasoning);
      };
      ctx.onSignature = (signature: string): void => {
        thinkingSignature += signature;
      };
      ctx.onRedactedThinking = (data: string): void => {
        redactedThinking = data;
      };
      ctx.onReasoningItem = (itemJson: string): void => {
        reasoningItems = appendReasoningItem(reasoningItems, itemJson);
      };
      ctx.onUsage = (usageObj: Record<string, Object> | null): void => {
        // Anthropic 的输入与输出分两个事件到达：先合并，再算速度/命中率。
        let merged: Record<string, Object> | null = usageMeter.observe(usageObj);
        let stats: number[] = deriveStreamStats(merged, Date.now() - startTime, protocol);
        callbacks.onUsage(stats[0], stats[1]);
      };
      ctx.onComplete = (): void => {
        sawComplete = true;
      };
      sseAdapter.handleLine(sseData, ctx);
      // 工具调用流式生成过程中即时上抛(调用数或累计参数量变化时)
      if (callAcc.calls.length > 0) {
        let argsLen: number = 0;
        for (let i: number = 0; i < callAcc.calls.length; i++) {
          argsLen += callAcc.calls[i].argsJson.length;
        }
        let sig: string = callAcc.calls.length.toString() + ':' + argsLen.toString();
        if (sig !== lastToolSig) {
          lastToolSig = sig;
          callbacks.onToolCalls(callAcc.calls);
        }
      }
    };

    try {
      await new Promise<void>((resolve: () => void, reject: (e: Error) => void) => {
        let statusCode: number = 0;
        let dataEnded: boolean = false;
        let settled: boolean = false;
        // 2xx 流结束时统一走这里：没有终止事件就是半截流，明确报错而不是静默收尾。
        let settleStream = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (!sawComplete && !abortSignal.aborted) {
            reject(new Error('响应流在结束事件前中断，请重试或继续'));
            return;
          }
          resolve();
        };
        httpRequest.on('dataReceive', (data: ArrayBuffer) => {
          if (abortSignal.aborted) {
            return;
          }
          receivedAnyData = true;
          try {
            let chunk: string = acc.append(data);
            lineBuffer += chunk;
            let lines: string[] = lineBuffer.split('\n');
            if (lineBuffer.endsWith('\n')) {
              lineBuffer = '';
            } else {
              lineBuffer = lines.pop() as string;
            }
            for (let i: number = 0; i < lines.length; i++) {
              let line: string = lines[i];
              let trimmed: string = line.trim();
              if (trimmed === '') {
                continue;
              }
              if (trimmed === Constants.SSE_DONE_TOKEN) {
                sawComplete = true;
                continue;
              }
              if (!trimmed.startsWith(Constants.SSE_DATA_PREFIX)) {
                continue;
              }
              let sseData: string = trimmed.substring(Constants.SSE_DATA_PREFIX.length);
              if (sseData === Constants.SSE_DONE_TOKEN) {
                sawComplete = true;
                continue;
              }
              processSseData(sseData);
            }
          } catch (e) {
            let err: Error = e as Error;
            reject(err);
          }
        });

        httpRequest.on('dataEnd', () => {
          if (lineBuffer !== '') {
            let trimmed: string = lineBuffer.trim();
            if (trimmed.startsWith(Constants.SSE_DATA_PREFIX)) {
              let sseData: string = trimmed.substring(Constants.SSE_DATA_PREFIX.length);
              if (sseData === Constants.SSE_DONE_TOKEN) {
                sawComplete = true;
              } else {
                try {
                  processSseData(sseData);
                } catch (e) {
                  let err: Error = e as Error;
                  if (!settled) {
                    settled = true;
                    reject(err);
                  }
                  return;
                }
              }
            }
            lineBuffer = '';
          }
          dataEnded = true;
          if (statusCode !== 0 && statusCode >= 200 && statusCode < 300 && !settled) {
            settleStream();
          }
        });

        let headers: Record<string, string> = {
          'Content-Type': 'application/json'
        };
        // 鉴权头 + 网关特殊头统一由 LLMProtocol 生成（OpenCode Go 的 x-opencode-session
        // 在三种协议下都必须带；自动审查走同一份实现）。
        let authHeaders: Record<string, string> = LLMProtocol.authHeaders(config, protocol);
        for (let key in authHeaders) {
          headers[key] = authHeaders[key];
        }
        if (protocol === 'anthropic') {
          let needsAnthropicBeta: boolean = false;
          for (let hi: number = 0; hi < history.length; hi++) {
            let hm: Message = history[hi];
            for (let hj: number = 0; hj < hm.attachments.length; hj++) {
              if (hm.attachments[hj].fileId !== '') {
                needsAnthropicBeta = true;
                break;
              }
            }
            if (needsAnthropicBeta) {
              break;
            }
          }
          headers['Accept'] = 'text/event-stream';
          if (needsAnthropicBeta) {
            headers['anthropic-beta'] = 'files-api-2025-04-14';
          }
        }
        httpRequest.requestInStream(url, {
          method: http.RequestMethod.POST,
          header: headers,
          extraData: bodyStr,
          // 与工作模式同口径：附件 base64 可能让请求体很大，固定 30s 会在上传途中
          // 被 AbortController 掐断（"The user aborted a request"）。
          connectTimeout: connectTimeoutForBody(bodyStr),
          readTimeout: 180000,
          usingProtocol: http.HttpProtocol.HTTP1_1
        }).then((code: number) => {
          statusCode = code;
          if (abortSignal.aborted) {
            return;
          }
          if (code < 200 || code >= 300) {
            if (!settled) {
              settled = true;
              let msg: string = '';
              if (code === 401) {
                msg = 'API Key 无效，请检查设置';
              } else if (code === 429) {
                msg = '请求过于频繁，请稍后再试';
              } else if (code === 408 || code === 425) {
                msg = '请求超时 (' + code + ')，请重试';
              } else if (code === 409) {
                msg = '请求冲突 (' + code + ')，请重试';
              } else if (code >= 400 && code < 500) {
                msg = 'API 请求错误 (' + code + ')，请检查配置';
              } else if (code >= 500) {
                msg = '服务器错误 (' + code + ')，请稍后再试';
              } else {
                msg = '请求失败，状态码: ' + code;
              }
              reject(new Error(msg));
            }
            return;
          }
          if (dataEnded && !settled) {
            settleStream();
          }
        }).catch((err: Error) => {
          if (abortSignal.aborted) {
            // 当 abort 导致 requestInStream 抛错时 resolve, 让 promise 得以完成, finally 得以执行
            if (!settled) {
              settled = true;
              resolve();
            }
            return;
          }
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
      });
      // 结构化产出: 累积的工具调用/思考块签名随流结束返回给调用方
      streamResult.toolCalls = ChatService.normalizeChatToolCalls(callAcc.calls);
      streamResult.thinkingSignature = thinkingSignature;
      streamResult.redactedThinking = redactedThinking;
      streamResult.reasoningItems = reasoningItems;
    } catch (e) {
      let err: Error = e as Error;
      if (abortSignal.aborted) {
        aborted = true;
      } else {
        if (failedMsg === '' && err.message !== undefined) {
          failedMsg = describeTransportError(err);
        }
        if (failedMsg === '') {
          failedMsg = '请求失败';
        }
        callbacks.onError(failedMsg);
      }
    } finally {
      if (abortSignal.aborted) {
        aborted = true;
      }
      // 一次响应只记一次账；失败但有 usage 的响应同样计入（服务端已经计费）。
      try {
        usageMeter.finish(!aborted && failedMsg === '', aborted);
      } catch (e) {
        // 统计失败不影响聊天收尾
      }
      ChatService.activeRequest = null;
      try {
        httpRequest.off('dataReceive');
        httpRequest.off('dataEnd');
        httpRequest.destroy();
      } catch (e) {
        // ignore
      }
      if (!aborted) {
        callbacks.onDone(acc.fullContent);
      }
    }
    return streamResult;
  }

  // 兜底补全: 缺名字的调用记录不送回(避免协议校验失败), 空 argsJson 填 '{}', 缺 id 补生成
  private static normalizeChatToolCalls(calls: ToolCallRecord[]): ToolCallRecord[] {
    let out: ToolCallRecord[] = [];
    for (let i: number = 0; i < calls.length; i++) {
      let call: ToolCallRecord = calls[i];
      if (call.name === '') {
        continue;
      }
      if (call.id === '') {
        call.id = genToolCallId();
      }
      if (call.argsJson.trim() === '') {
        call.argsJson = '{}';
      }
      out.push(call);
    }
    return out;
  }

  static abort(): void {
    let req: http.HttpRequest | null = ChatService.activeRequest;
    if (req !== null) {
      try {
        req.destroy();
      } catch (e) {
        // ignore
      }
      ChatService.activeRequest = null;
    }
  }
}
