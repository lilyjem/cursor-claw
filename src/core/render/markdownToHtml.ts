// HTML 实体转义：先做这一步，再做行内 markdown 替换。
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 极简 markdown → Telegram HTML 渲染。
 *
 * 支持：
 * - 三反引号代码块（含可选语言标签，渲染时被忽略）
 * - 行内代码 `code`
 * - **粗体** _斜体_
 * - [text](url)
 *
 * 实现策略：
 * 1. 先把代码块切走，避免内部被行内规则误伤
 * 2. 代码块体做 HTML 转义后包裹 <pre><code>...
 * 3. 普通文本段先做 HTML 转义，再做行内替换（注意顺序：粗体在斜体之前，避免 ** 被 _ 干扰）
 */
export function markdownToHtml(input: string): string {
  if (!input) return "";

  const fenceRe = /```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```/g;
  const segments: Array<{ kind: "text" | "code"; value: string }> = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = fenceRe.exec(input)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ kind: "text", value: input.slice(lastIndex, m.index) });
    }
    segments.push({ kind: "code", value: m[1] ?? "" });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < input.length) {
    segments.push({ kind: "text", value: input.slice(lastIndex) });
  }

  return segments
    .map((s) => {
      if (s.kind === "code") {
        return `<pre><code>${escapeHtml(s.value)}\n</code></pre>`;
      }
      return renderInline(s.value);
    })
    .join("");
}

// 普通段：先 HTML 转义；再做行内替换
function renderInline(text: string): string {
  let out = escapeHtml(text);

  // 行内代码 — 优先处理，避免里面的 _ * 被后面的规则吃掉
  out = out.replace(/`([^`\n]+)`/g, (_, inner: string) => `<code>${inner}</code>`);
  // 粗体 **...** 在斜体之前
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, inner: string) => `<b>${inner}</b>`);
  // 斜体 _..._（避免吃 __ 双下划线和单词内的下划线）
  out = out.replace(
    /(^|[^_])_([^_\n]+)_(?!_)/g,
    (_, pre: string, inner: string) => `${pre}<i>${inner}</i>`,
  );
  // 链接：URL 必须 http(s) 协议，避免被注入 javascript: 等
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );

  return out;
}
