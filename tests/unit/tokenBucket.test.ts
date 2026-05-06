import { describe, it, expect } from "vitest";
import { TokenBucket } from "../../src/core/rateLimit/TokenBucket.js";

// F-06 PR a：TokenBucket 纯算法测试
// - 满桶/空桶 take 行为
// - refill 不超 capacity
// - inspect 不消耗
// - timeUntilNext 计算精度
describe("TokenBucket", () => {
  it("初始为满桶，take(1) 成功", () => {
    const b = new TokenBucket({ capacity: 4, refillPerSec: 2, now: () => 0 });
    expect(b.take(1)).toBe(true);
  });

  it("空桶 take 返回 false 且 timeUntilNext 为正", () => {
    let t = 0;
    const b = new TokenBucket({ capacity: 2, refillPerSec: 2, now: () => t });
    expect(b.take(1)).toBe(true);
    expect(b.take(1)).toBe(true);
    expect(b.take(1)).toBe(false);
    // 桶空，refill 速率 2/s → 0.5s 后回 1 token
    expect(b.timeUntilNext()).toBeCloseTo(500, 0);
  });

  it("时间推进后自动 refill 但不超 capacity", () => {
    let t = 0;
    const b = new TokenBucket({ capacity: 4, refillPerSec: 2, now: () => t });
    expect(b.take(4)).toBe(true);
    expect(b.take(1)).toBe(false);
    // 推进 10s → 远超 capacity，应被 clamp 回满桶 (4)
    t = 10_000;
    expect(b.take(4)).toBe(true);
    expect(b.take(1)).toBe(false);
  });

  it("inspect() 不消耗 token", () => {
    const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: () => 0 });
    expect(b.inspect()).toBe(3);
    expect(b.inspect()).toBe(3);
    expect(b.take(1)).toBe(true);
    expect(b.inspect()).toBe(2);
  });

  it("retryAfterMs 计算精确：refill 1/s，缺 0.4 token 应等待 400ms", () => {
    let t = 0;
    const b = new TokenBucket({ capacity: 1, refillPerSec: 1, now: () => t });
    expect(b.take(1)).toBe(true);
    // 推进 0.6s → 桶里有 0.6 token，差 0.4 个，需等 400ms
    t = 600;
    expect(b.take(1)).toBe(false);
    expect(b.timeUntilNext()).toBeCloseTo(400, 0);
  });
});
