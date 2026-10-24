// ContextBudget: Agent Loop 的上下文预算管理(纯逻辑, 无 @kit 依赖, 可直接单测)。
//
// 移植自鸿蒙版 ChatViewModel 的:
//   compactWorkHistoryIfNeeded(3021-3081) / workHistoryOverBudget(3085-3091) /
//   estimateWorkTokens(3094-3099) / pruneOldToolResults(3730-3753) / loopMsgChars(3710-3724)。
//
// 为什么必须做这件事: 循环里的 messages 只增不减, 长任务跑到后面必然撞上下文上限
// (400/413/超长报错), 而且早期巨大的工具结果一直占着预算 —— 用户看到的是任务莫名失败。
//
// 为什么是三级、且顺序不可换 —— 代价递增, 能省下的模型调用就不花:
//   1. 修剪早期过长的工具结果: 模型无参与、零成本; 原文随时能用 read_file/search_files/
//      parse_document 重新获取, 所以只留头尾就够;
//   2. 前缀复用式摘要压缩: 花一次模型调用, 换回任务连续性(目标/已完成步骤/关键发现/失败原因);
//   3. 从最旧处整条丢弃: 兜底, 损失最大(早期历史整段消失), 故排最后。
//
// 为什么阈值要用「上一请求真实 prompt tokens」锚定: 同一份文本在不同模型/工具面下 token 数
// 差别很大, 字符估算只是没有实测数据时的保守近似(中英混合约 2 字符/token)。一旦实测到真实
// 用量, 它比估算可信; 历史只会继续增长, 所以「上一请求已达阈值」即可直接判定超预算, 不必等
// 估算也追上来。

import { Constants } from './Constants';

// 参与预算的最小消息形状: 只看 role/content/reasoning/toolCalls(正文 + 思考 + 工具参数与结果)。
// 刻意不 import core/service 的 LoopMessage —— core/common 不反向依赖 core/service(现有分层),
// 结构化类型让 LoopMessage 实例可以直接传进来。
export interface BudgetToolCall {
  argsJson: string;
  result: string;
}

export interface BudgetMessage {
  role: string;
  content: string;
  /** 历史思考文本: 带 tools 的请求会把它拼回上下文, 必须计入预算(旧调用方可不传) */
  reasoning?: string;
  toolCalls: BudgetToolCall[];
}

// usage 锚定值: 上一请求真实的 prompt tokens, 以及与之配对的「那次请求的字符量」。
// 用可变对象而不是 SessionManager 的实例字段: 锚定的作用域是「一次任务运行」,
// 放在 runWork 的局部变量里, 多个会话/子代理并发时互不串味。
export interface BudgetAnchor {
  tokens: number;
  chars: number;
}

// 重建压缩后消息数组时构造头部两条消息的工厂: common 层不认识 LoopMessage,
// 由调用方注入构造器(测试里传一个造普通对象的工厂即可)。
export interface BudgetHeadFactory<T extends BudgetMessage> {
  system(content: string): T;
  user(content: string): T;
}

export class ContextBudget {
  // ---- 给用户看的三种标注(追加到本轮 assistant 正文里, 见 SessionManager.appendTurnNote 的用法) ----
  static readonly PRUNE_NOTE: string = '（已自动修剪早期过长的工具结果以释放上下文）\n\n';
  static readonly TRIM_NOTE: string = '（已自动裁剪早期历史以释放上下文）\n\n';
  // 摘要标注的关键词: 用来判断 notes 里是否已经有压缩标注, 避免再重复加一条裁剪标注
  static readonly SUMMARY_NOTE_KEY: string = '已自动压缩早期历史';

  static summaryNote(summarizedCount: number): string {
    return '（已自动压缩早期历史: ' + summarizedCount.toString() + ' 条已汇总为状态摘要）\n\n';
  }

  // 中段替换提示: 明确告诉模型「这里省略了多少字符」以及「怎么拿回原文」,
  // 否则模型会以为自己看到的就是全文而据此下结论。
  static pruneMarker(omitted: number): string {
    return '\n[...早期工具结果已修剪, 省略 ' + omitted.toString() +
      ' 字符; 需要原文时用 read_file/search_files/parse_document 重新获取...]\n';
  }

  // 压缩后作为「新的第 1 条用户消息」塞进历史的摘要正文
  static summaryUserText(summarizedCount: number, summary: string): string {
    return '【上下文压缩】以下为此前 ' + summarizedCount.toString() +
      ' 条执行历史的状态摘要, 请基于它继续任务:\n' + summary;
  }

  // ---- 预算判据 ----

  // 触发压缩的 token 阈值 = 上下文窗口 * 占比
  static threshold(): number {
    return Constants.WORK_CONTEXT_WINDOW_TOKENS * Constants.WORK_COMPACT_TOKEN_RATIO;
  }

  // 单条消息字符量: 正文 + 思考 + 工具调用参数与结果(对齐原版 msgChars)
  static messageChars(m: BudgetMessage): number {
    let n: number = m.content.length + (m.reasoning === undefined ? 0 : m.reasoning.length);
    for (let c: number = 0; c < m.toolCalls.length; c++) {
      n += m.toolCalls[c].argsJson.length + m.toolCalls[c].result.length;
    }
    return n;
  }

  // 整个循环历史消息数组的字符量(上下文预算的输入)
  static messagesChars(messages: BudgetMessage[]): number {
    let n: number = 0;
    for (let i: number = 0; i < messages.length; i++) {
      n += ContextBudget.messageChars(messages[i]);
    }
    return n;
  }

  // 字符量 → token 估算: 有本会话实测比例时按实测, 否则按中英混合 ≈ 2 字符/token 的保守值
  static estimateTokens(chars: number, anchorTokens: number, anchorChars: number): number {
    if (anchorTokens > 0 && anchorChars > 0) {
      return chars * anchorTokens / anchorChars;
    }
    return chars / 2;
  }

  // 上下文是否超预算: 上一请求真实 usage 已达阈值必然超预算(历史只会继续增长);
  // 否则用估算值对比阈值
  static overBudget(messages: BudgetMessage[], anchor: BudgetAnchor): boolean {
    if (anchor.tokens >= ContextBudget.threshold()) {
      return true;
    }
    return ContextBudget.estimateTokens(ContextBudget.messagesChars(messages),
      anchor.tokens, anchor.chars) >= ContextBudget.threshold();
  }

  // 压缩边界: 只有 [1, oldEnd) 参与修剪与汇总, 尾部最近 WORK_COMPACT_KEEP_MESSAGES 条保留原样
  // (最近的轮次对后续执行最关键, 汇总它们反而会丢细节)。索引 0 是系统提示词, 永久保留。
  // 短历史因此天然不触发压缩(消息数 ≤ 13 时 oldEnd 恒为 1, 区间为空)。
  static summaryEndIndex(messageCount: number): number {
    if (messageCount <= 1) {
      // 只有系统提示词(或空): 没有可压缩的内容, 返回 1 让所有压缩分支自然跳过
      return 1;
    }
    return messageCount - Math.min(Constants.WORK_COMPACT_KEEP_MESSAGES, messageCount - 1);
  }

  // ---- 第一级: 修剪早期过长的工具结果(无模型参与, 零成本) ----

  // 处理 [from, to) 区间内的 assistant 消息: 结果长度超过阈值的, 保留头 WORK_PRUNE_KEEP_HEAD +
  // 尾 WORK_PRUNE_KEEP_TAIL, 中段换成省略提示。只动 assistant 消息的原因: 工具结果与它的调用
  // 同挂在一条消息内(请求体里的 assistant(tool_calls) 与 tool 两条消息都由它派生),
  // 就地替换不会拆散协议对。返回是否真的修剪过。
  static pruneOldToolResults(messages: BudgetMessage[], from: number, to: number): boolean {
    let pruned: boolean = false;
    const end: number = Math.min(to, messages.length);
    for (let i: number = from; i < end; i++) {
      const m: BudgetMessage = messages[i];
      if (m.role !== 'assistant') {
        continue;
      }
      for (let c: number = 0; c < m.toolCalls.length; c++) {
        const call: BudgetToolCall = m.toolCalls[c];
        if (call.result.length <= Constants.WORK_PRUNE_RESULT_MAX_CHARS) {
          continue;
        }
        const omitted: number = call.result.length -
          Constants.WORK_PRUNE_KEEP_HEAD - Constants.WORK_PRUNE_KEEP_TAIL;
        call.result = call.result.substring(0, Constants.WORK_PRUNE_KEEP_HEAD) +
          ContextBudget.pruneMarker(omitted) +
          call.result.substring(call.result.length - Constants.WORK_PRUNE_KEEP_TAIL);
        pruned = true;
      }
    }
    return pruned;
  }

  // ---- 第二级: 前缀复用式摘要压缩 ----

  // 摘要过长就截断: 压缩本身不能再制造一个新的超大消息
  static truncateSummary(summary: string): string {
    if (summary.length > Constants.WORK_SUMMARY_MAX_CHARS) {
      return summary.substring(0, Constants.WORK_SUMMARY_MAX_CHARS) + '…';
    }
    return summary;
  }

  // 重建消息数组 = [system, user(状态摘要), ...保留的尾部]。
  // 之所以「重建」而不是就地改写: 早期历史整体消失, 留在原数组里只会得到一堆悬挂消息。
  // 尾部是同一批对象引用(与原版 kept[k] 逐个 push 一致) —— 工具结果记录仍与 UI 时间线共享,
  // 界面上的步骤详情不受压缩影响。
  static rebuildWithSummary<T extends BudgetMessage>(messages: T[], oldEnd: number, summary: string,
    systemPrompt: string, factory: BudgetHeadFactory<T>): T[] {
    const rebuilt: T[] = [];
    rebuilt.push(factory.system(systemPrompt));
    rebuilt.push(factory.user(ContextBudget.summaryUserText(oldEnd - 1, summary)));
    const kept: T[] = messages.slice(oldEnd);
    for (let k: number = 0; k < kept.length; k++) {
      rebuilt.push(kept[k]);
    }
    return rebuilt;
  }

  // ---- 第三级: 仍超预算就从最旧处整条丢弃 ----

  // 从索引 1 开始丢: 索引 0 是系统提示词, 任何情况下都不能丢(丢了工具契约与行为纪律就没了);
  // 循环条件里保留 messages.length > 2 —— 至少要留住最近一条消息, 否则模型看不到任何上下文。
  // 返回丢弃条数。
  static dropOldestUntilUnderBudget<T extends BudgetMessage>(messages: T[], anchor: BudgetAnchor): number {
    let dropped: number = 0;
    while (ContextBudget.estimateTokens(ContextBudget.messagesChars(messages),
      anchor.tokens, anchor.chars) >= ContextBudget.threshold() && messages.length > 2) {
      messages.splice(1, 1);
      dropped++;
    }
    return dropped;
  }
}
