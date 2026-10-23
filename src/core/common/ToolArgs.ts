// ToolArgs: 工具调用参数解析的纯函数(无副作用、零依赖)。
//
// 为什么单独收一份: 聊天模式的本地工具循环要**自己执行**模型发起的
// local_web_search / search_web(本机联网搜索)与 web_fetch(抓网页)调用,
// 于是需要「从 argsJson 里读一个字符串参数」这类极小的解析动作。
// 原版把 parseSearchQuery / parseArgsObject / readArgString 写成 ChatViewModel 的
// 私有静态方法; 桌面端循环驱动在主进程的 SessionManager 里, 与其在那儿再塞一份
// 协议解析, 不如把这几个纯函数收进 core/common —— 可复用、可单测、也不碰流式解析。

// 工具调用参数 JSON → 对象(解析失败或不是对象一律回落空对象)
export function parseArgsObject(argsJson: string): Record<string, Object> {
  try {
    const parsed: Object = JSON.parse(argsJson === '' ? '{}' : argsJson)
    if (typeof parsed === 'object' && parsed !== null && !(parsed instanceof Array)) {
      return parsed as Record<string, Object>
    }
  } catch {
    // 参数只生成了一半(流被截断)时 JSON 必然不合法, 静默回落
  }
  return {}
}

// 取字符串型参数(缺省/类型不符返回空串)
export function readArgString(args: Record<string, Object>, key: string): string {
  const value: Object | undefined = args[key]
  return typeof value === 'string' ? value : ''
}

// search_web / local_web_search 的搜索词: 取 query 字段;
// 取不到时**回落原始参数文本**(与原版 ChatViewModel.parseSearchQuery 同口径)——
// 宁可把原文当关键词去搜, 也不要因为参数格式问题把这次搜索变成空查询。
export function parseSearchQuery(argsJson: string): string {
  const query: string = readArgString(parseArgsObject(argsJson), 'query')
  if (query.trim() !== '') {
    return query
  }
  return argsJson.trim()
}
