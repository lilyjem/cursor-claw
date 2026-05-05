import { describe, it, expect } from "vitest";
import { summarizeTool } from "../../src/core/orchestrator/toolSummary.js";

describe("summarizeTool", () => {
  it("shell 取 command", () => {
    expect(summarizeTool("shell", { command: "pnpm test" })).toBe("shell: pnpm test");
  });

  it("read 取 path", () => {
    expect(summarizeTool("read", { path: "src/auth.ts" })).toBe("read: src/auth.ts");
  });

  it("read 取 relative_path 兜底", () => {
    expect(summarizeTool("read", { relative_path: "src/x.ts" })).toBe("read: src/x.ts");
  });

  it("grep 取 pattern", () => {
    expect(summarizeTool("grep", { pattern: "TODO" })).toBe("grep: TODO");
  });

  it("过长的命令被截断到 60 字符", () => {
    const long = "a".repeat(120);
    const out = summarizeTool("shell", { command: long });
    expect(out.length).toBeLessThanOrEqual("shell: ".length + 60 + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("未知工具 → 只返回 name", () => {
    expect(summarizeTool("nonsense", { whatever: 1 })).toBe("nonsense");
  });

  it("args 缺失 / null → 不抛异常", () => {
    expect(summarizeTool("shell", undefined)).toBe("shell: ");
    expect(summarizeTool("shell", null)).toBe("shell: ");
  });

  it("task 取 description", () => {
    expect(summarizeTool("task", { description: "review the patch" })).toBe(
      "subagent: review the patch",
    );
  });
});
