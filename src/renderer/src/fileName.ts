// 由消息正文推导一个合法的文件名。
//
// 事故（用户实测）：最初直接拿正文前 20 个字符当 .docx 的文件名，而正文里几乎必然
// 带换行 —— Windows 的保存对话框直接报「文件名无效」，导出功能等于不可用。
//
// 要处理的四类字符，每一类都有实际后果：
//   1. 换行/制表等空白 → 折叠成单个空格，否则对话框判为非法名；
//   2. 控制字符（U+0000–U+001F、U+007F）→ 同上；
//   3. `\ / : * ? " < > |` → 路径分隔符与通配符，Win32 明确禁止；
//   4. 结尾的「点」和「空格」→ Win32 会**静默丢弃**，导致实际落盘的名字与预期不符。
export function docxFileName(text: string, fallback = 'Guncat 回答'): string {
  const singleLine: string = text.replace(/\s+/g, ' ').trim()
  const legal: string = singleLine
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[. ]+$/, '')
    .trim()

  // 截断后可能又以点/空格结尾（例如「……如下.」），要再清一次
  const stem: string = legal.slice(0, 24).replace(/[. ]+$/, '').trim()
  return `${stem === '' ? fallback : stem}.docx`
}
