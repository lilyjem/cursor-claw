// F-01 / F-11 的深度防御：在字符串内容上做正则脱敏
//
// 设计原则：
// - 只覆盖"字符串本身就是机密"的形态（token / key 等），保守不过广。
// - 不替换路径 / 用户名 等主机环境信息（那是 F-11 的范围，需要更细粒度策略）。
// - 安全的失败：非 string 输入回空字符串，避免调用方 typo 触发未脱敏的 fallback。
//
// 覆盖目标：
// 1. Telegram 文件下载 URL：https://api.telegram.org/file/bot<token>/<file_path>
//    botToken 形如 "<digits>:<base58-ish>"。我们直接打掉 "bot<token>/" 整段。
// 2. Cursor API key：crsr_<hex>，hex 长度通常 ≥ 32。

// Telegram bot URL 中的 token：
// - bot 后立即跟 token，token 内含数字、字母、下划线、`-`、`:`，不含 `/`
// - 命中后替换整段 "bot<token>/" → "bot***/"
const TELEGRAM_BOT_URL_RE = /bot[A-Za-z0-9_:-]{20,}\//g;

// Cursor API key：crsr_ + 16 字符及以上的 hex / base62 字符
// 命中后替换整段 "crsr_<key>" → "crsr_***"
const CURSOR_API_KEY_RE = /crsr_[A-Za-z0-9]{16,}/g;

export function sanitizeForOutput(s: string): string {
  if (typeof s !== "string") return "";
  if (s.length === 0) return "";
  return s
    .replace(TELEGRAM_BOT_URL_RE, "bot***/")
    .replace(CURSOR_API_KEY_RE, "crsr_***");
}
