import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { StubMessenger } from "../helpers/StubMessenger.js";
import { StreamRenderer } from "../../src/core/orchestrator/streamRenderer.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("StreamRenderer", () => {
  it("第一次 pushText 立即 sendText", async () => {
    const m = new StubMessenger();
    const r = new StreamRenderer(m, "c1", { throttleMs: 100, maxLen: 1000 });
    await r.start("⏳ thinking...");
    await r.pushText("hello");
    expect(m.calls.find((c) => c.kind === "sendText")).toBeTruthy();
  });

  it("节流：连续 pushText 在窗口内只 edit 一次", async () => {
    const m = new StubMessenger();
    const r = new StreamRenderer(m, "c1", { throttleMs: 100, maxLen: 1000 });
    await r.start("⏳");
    await r.pushText("a");
    await r.pushText("b");
    await r.pushText("c");
    await vi.advanceTimersByTimeAsync(150);
    const edits = m.calls.filter((c) => c.kind === "editText");
    expect(edits.length).toBe(1);
  });

  it("setStatus 仅渲染状态行 + 已有正文", async () => {
    const m = new StubMessenger();
    const r = new StreamRenderer(m, "c1", { throttleMs: 50, maxLen: 1000 });
    await r.start("⏳");
    await r.pushText("body");
    r.setStatus("🔧 shell: pnpm test");
    await vi.advanceTimersByTimeAsync(100);
    const lastEdit = [...m.calls].reverse().find((c) => c.kind === "editText");
    const txt =
      lastEdit && lastEdit.kind === "editText" ? lastEdit.text : "";
    expect(txt).toContain("🔧 shell: pnpm test");
    expect(txt).toContain("body");
  });

  it("finalize 清掉状态行，只留正文", async () => {
    const m = new StubMessenger();
    const r = new StreamRenderer(m, "c1", { throttleMs: 50, maxLen: 1000 });
    await r.start("⏳");
    r.setStatus("🤔 thinking...");
    await r.pushText("done.");
    await r.finalize();
    const lastEdit = [...m.calls].reverse().find((c) => c.kind === "editText");
    const txt =
      lastEdit && lastEdit.kind === "editText" ? lastEdit.text : "";
    expect(txt).toBe("done.");
  });

  it("超过 maxLen → 切分新消息，新 push 走新消息", async () => {
    const m = new StubMessenger();
    const r = new StreamRenderer(m, "c1", { throttleMs: 50, maxLen: 20 });
    await r.start("⏳");
    await r.pushText("a".repeat(15));
    await r.pushText("b".repeat(20));
    await vi.advanceTimersByTimeAsync(100);
    const sends = m.calls.filter((c) => c.kind === "sendText");
    expect(sends.length).toBeGreaterThanOrEqual(2);
  });
});
