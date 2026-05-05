import { describe, it, expect } from "vitest";
import { redactSensitive } from "../../src/logger.js";

describe("redactSensitive", () => {
  it("把 botToken 替换为 ***", () => {
    const out = redactSensitive({ botToken: "1234:abcdef" });
    expect(out).toEqual({ botToken: "***" });
  });

  it("把 apiKey 替换为 ***", () => {
    const out = redactSensitive({ apiKey: "secret" });
    expect(out).toEqual({ apiKey: "***" });
  });

  it("递归处理嵌套对象", () => {
    const out = redactSensitive({
      cursor: { apiKey: "sk-...", model: "auto" },
      telegram: { botToken: "t1", parseMode: "HTML" },
    });
    expect(out).toEqual({
      cursor: { apiKey: "***", model: "auto" },
      telegram: { botToken: "***", parseMode: "HTML" },
    });
  });

  it("非敏感字段保持不变", () => {
    const out = redactSensitive({ a: 1, b: "ok" });
    expect(out).toEqual({ a: 1, b: "ok" });
  });

  it("处理数组", () => {
    const out = redactSensitive([{ apiKey: "x" }, { ok: true }]);
    expect(out).toEqual([{ apiKey: "***" }, { ok: true }]);
  });
});
