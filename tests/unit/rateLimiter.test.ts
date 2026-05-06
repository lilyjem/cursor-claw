import { describe, it, expect } from "vitest";
import { RateLimiter } from "../../src/core/rateLimit/RateLimiter.js";

// F-06 PR b：RateLimiter 多 bucket 容器测试
// - (userId, key) 索引隔离
// - 不同 key 互相独立
// - DENY 时 retryAfterMs > 0
// - 未声明 key 默认 ALLOW（保守失败开放）
// - LRU evict 行为
describe("RateLimiter", () => {
  it("不同 (userId, key) 互相独立", () => {
    let t = 0;
    const lim = new RateLimiter({
      buckets: {
        msg: { capacity: 1, refillPerSec: 1 },
      },
      now: () => t,
    });
    expect(lim.check(1, "msg").allowed).toBe(true);
    expect(lim.check(1, "msg").allowed).toBe(false);
    // 不同 user 不影响
    expect(lim.check(2, "msg").allowed).toBe(true);
  });

  it("不同 key 互相独立", () => {
    const lim = new RateLimiter({
      buckets: {
        msg: { capacity: 1, refillPerSec: 1 },
        agentCreate: { capacity: 1, refillPerSec: 1 },
      },
      now: () => 0,
    });
    expect(lim.check(1, "msg").allowed).toBe(true);
    expect(lim.check(1, "agentCreate").allowed).toBe(true);
    expect(lim.check(1, "msg").allowed).toBe(false);
    expect(lim.check(1, "agentCreate").allowed).toBe(false);
  });

  it("DENY 时 retryAfterMs > 0", () => {
    let t = 0;
    const lim = new RateLimiter({
      buckets: { msg: { capacity: 1, refillPerSec: 2 } },
      now: () => t,
    });
    expect(lim.check(1, "msg").allowed).toBe(true);
    const r = lim.check(1, "msg");
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it("未声明的 key 直接 ALLOW（保守失败开放）", () => {
    const lim = new RateLimiter({
      buckets: { msg: { capacity: 1, refillPerSec: 1 } },
      now: () => 0,
    });
    expect(lim.check(1, "unknown").allowed).toBe(true);
  });

  it("LRU evict：超 maxBuckets 时最久未用被丢", () => {
    let t = 0;
    const lim = new RateLimiter({
      // refill 极慢，方便观察被 evict 的桶被 take 后又重新满
      buckets: { msg: { capacity: 1, refillPerSec: 0.0001 } },
      maxBuckets: 2,
      now: () => t,
    });
    lim.check(1, "msg"); // bucket1：take 1，剩 0
    t = 1;
    lim.check(2, "msg"); // bucket2：take 1，剩 0
    t = 2;
    lim.check(3, "msg"); // bucket3 → 触发 evict 最久未用的 bucket1
    // bucket1 已 evict；user 1 再来一次会得到全新满桶 → ALLOW
    expect(lim.check(1, "msg").allowed).toBe(true);
  });
});
