import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../src/config/schema.js";

// F-06 PR c：rateLimit 段加入 schema 后的兼容性 + 自定义生效测试
describe("ConfigSchema rateLimit", () => {
  it("旧 config（无 rateLimit）解析后获得默认值", () => {
    const cfg = ConfigSchema.parse({
      telegram: { botToken: "x", allowedUserIds: [1] },
      cursor: { apiKey: "y" },
    });
    expect(cfg.rateLimit.message.capacity).toBe(4);
    expect(cfg.rateLimit.message.refillPerSec).toBe(2);
    expect(cfg.rateLimit.agentCreate.capacity).toBe(10);
    expect(cfg.rateLimit.agentCreate.refillPerSec).toBeCloseTo(10 / 60);
    expect(cfg.rateLimit.reminders.maxPerUser).toBe(100);
  });

  it("用户自定义阈值生效；未给的字段仍走默认", () => {
    const cfg = ConfigSchema.parse({
      telegram: { botToken: "x", allowedUserIds: [1] },
      cursor: { apiKey: "y" },
      rateLimit: {
        message: { capacity: 2, refillPerSec: 1 },
        reminders: { maxPerUser: 50 },
      },
    });
    expect(cfg.rateLimit.message.capacity).toBe(2);
    expect(cfg.rateLimit.message.refillPerSec).toBe(1);
    expect(cfg.rateLimit.reminders.maxPerUser).toBe(50);
    expect(cfg.rateLimit.agentCreate.capacity).toBe(10);
  });
});
