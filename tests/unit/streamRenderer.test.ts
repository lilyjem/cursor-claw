import { describe, it, expect, beforeEach, vi } from "vitest";
import { StreamRenderer } from "../../src/core/orchestrator/streamRenderer.js";
import { StubMessenger } from "../helpers/StubMessenger.js";

// 这一组测试覆盖 M2 polish：跨 chunk markdown 渲染 bug。
// 修复前：AgentOrchestrator 对每个 chunk 单独跑 markdownToHtml，
//        SDK 把 ** / ` / [ ] 切到不同 chunk 时 regex 不匹配，原文残留。
// 修复后：StreamRenderer 内部存 raw markdown，compose 时整体转换。
describe("StreamRenderer", () => {
  let messenger: StubMessenger;
  let renderer: StreamRenderer;

  beforeEach(async () => {
    vi.useFakeTimers();
    messenger = new StubMessenger();
    renderer = new StreamRenderer(messenger, "c1", {
      throttleMs: 10,
      maxLen: 3000,
    });
    await renderer.start("⏳");
  });

  // 拿到最近一次 editText 的文本
  function lastEditText(): string {
    const last = [...messenger.calls]
      .reverse()
      .find((c) => c.kind === "editText");
    return last && last.kind === "editText" ? last.text : "";
  }

  it("跨 chunk **bold** 在 finalize 后整体渲染成 <b>", async () => {
    await renderer.pushText("**A");
    await renderer.pushText("B**");
    await vi.advanceTimersByTimeAsync(50);
    await renderer.finalize();
    expect(lastEditText()).toContain("<b>AB</b>");
    expect(lastEditText()).not.toContain("**");
  });

  it("跨 chunk 行内 `code` 渲染成 <code>", async () => {
    await renderer.pushText("文本 `co");
    await renderer.pushText("de` 后续");
    await vi.advanceTimersByTimeAsync(50);
    await renderer.finalize();
    expect(lastEditText()).toContain("<code>code</code>");
  });

  it("跨 chunk 三反引号代码块渲染成 <pre><code>", async () => {
    await renderer.pushText("```ts\n");
    await renderer.pushText("const x = 1;\n");
    await renderer.pushText("```");
    await vi.advanceTimersByTimeAsync(50);
    await renderer.finalize();
    const text = lastEditText();
    expect(text).toContain("<pre><code>");
    expect(text).toContain("const x = 1;");
  });

  it("跨 chunk 链接 [text](url) 渲染成 <a>", async () => {
    await renderer.pushText("点击 [link](htt");
    await renderer.pushText("ps://x.com) 来访问");
    await vi.advanceTimersByTimeAsync(50);
    await renderer.finalize();
    expect(lastEditText()).toContain('<a href="https://x.com">link</a>');
  });

  it("agent 输出含 < > & 必须 escape，不破坏 Telegram HTML", async () => {
    await renderer.pushText("if a < b && c > d");
    await vi.advanceTimersByTimeAsync(50);
    await renderer.finalize();
    const text = lastEditText();
    expect(text).toContain("&lt;");
    expect(text).toContain("&gt;");
    expect(text).toContain("&amp;");
  });

  it("finalize(extra) 的 extra 是 HTML，不再被 markdownToHtml 转", async () => {
    await renderer.pushText("hello");
    await renderer.finalize("\n<i>(已取消)</i>");
    const text = lastEditText();
    expect(text).toContain("hello");
    expect(text).toContain("<i>(已取消)</i>");
    // extra 中的 < > 不能被 escape 成 &lt;
    expect(text).not.toContain("&lt;i&gt;");
  });

  it("status 与 textBuffer 共存：status 是 HTML，textBuffer 是 raw markdown 整体转", async () => {
    renderer.setStatus("🔧 <b>tool</b>");
    await renderer.pushText("**done**");
    await vi.advanceTimersByTimeAsync(50);
    await renderer.finalize();
    const text = lastEditText();
    expect(text).toContain("<b>done</b>");
  });
});
