// Telegram 默认 HTML parseMode 下的最小转义工具。
// 只转义会改变 HTML 结构的三个字符；引号在文本节点里不需要额外处理。
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
