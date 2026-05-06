import { describe, it, expect, vi } from "vitest";
import { RateLimiter } from "../../src/core/rateLimit/RateLimiter.js";
import { rateLimitGuard } from "../../src/bin/wiring/rateLimitGuard.js";

// F-06 PR c：rateLimitGuard 集成测试
// 抽出独立的 wiring 函数，让 integration test 可以脱离 main() 装配链路直接验证

function makeFakeMessenger() {
  const sent: Array<{ chatId: string; text: string }> = [];
  return {
    sent,
    sendText: vi.fn(async (chatId: string, text: string) => {
      sent.push({ chatId, text });
    }),
  };
}

describe("rateLimitGuard / msg key", () => {
  it("capacity=4，第 5 条起拦截并通知用户", async () => {
    const limiter = new RateLimiter({
      // refillPerSec=0：测试时不回血，便于精确判定每次 take 的结果
      buckets: { msg: { capacity: 4, refillPerSec: 0 } },
      now: () => 0,
    });
    const messenger = makeFakeMessenger();

    const results: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      results.push(
        await rateLimitGuard({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          limiter,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messenger: messenger as unknown as any,
          chatId: "C",
          userId: 42,
          key: "msg",
        }),
      );
    }
    expect(results).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(messenger.sent.length).toBe(4);
    expect(messenger.sent[0]?.text).toMatch(/请求过于频繁/);
  });

  it("不同 user 互相独立", async () => {
    const limiter = new RateLimiter({
      buckets: { msg: { capacity: 1, refillPerSec: 0 } },
      now: () => 0,
    });
    const messenger = makeFakeMessenger();
    expect(
      await rateLimitGuard({
        limiter,
        messenger: messenger as unknown as never,
        chatId: "C",
        userId: 1,
        key: "msg",
      }),
    ).toBe(true);
    expect(
      await rateLimitGuard({
        limiter,
        messenger: messenger as unknown as never,
        chatId: "C",
        userId: 1,
        key: "msg",
      }),
    ).toBe(false);
    expect(
      await rateLimitGuard({
        limiter,
        messenger: messenger as unknown as never,
        chatId: "C",
        userId: 2,
        key: "msg",
      }),
    ).toBe(true);
  });
});
