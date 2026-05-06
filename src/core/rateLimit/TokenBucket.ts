// F-06 PR a：TokenBucket 纯算法
// - 突发上限 = capacity；稳态速率 = refillPerSec
// - 状态只有 (tokens, lastRefillMs)；无 timer / 无副作用 / 可测试
// - 可注入 now() 以便单测控制时间

export interface TokenBucketOptions {
  // 桶最大 token 数（即"允许的瞬时突发量"）
  capacity: number;
  // 每秒回血速率
  refillPerSec: number;
  // 测试可注入 fake clock；默认 Date.now
  now?: () => number;
}

/**
 * 经典 token-bucket 算法实现。
 *
 * 设计取舍：
 * - 把 refill 放在 take/inspect 内部按需触发（lazy），
 *   而不是用 setInterval 主动补血——后者带 timer 副作用与多 bucket 时
 *   的 GC 开销，前者是无状态时间数学。
 * - tokens 用浮点保存（refill 不是整数 token/s 时也能精确）。
 *   take(n) 的判定仍按"是否 ≥ n"来做整数判定。
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.now = opts.now ?? Date.now;
    this.tokens = opts.capacity;
    this.lastRefillMs = this.now();
  }

  // 把流逝时间内的 token 补到当前余额，并 clamp 在 capacity 上限
  private refill(): void {
    const t = this.now();
    const dt = (t - this.lastRefillMs) / 1000;
    if (dt <= 0) return;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + dt * this.refillPerSec,
    );
    this.lastRefillMs = t;
  }

  // 试取 n 个 token；够则扣减返回 true，否则保持原状返回 false
  take(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  // 当前可用 token 数（已 refill 同步过）；不消耗
  inspect(): number {
    this.refill();
    return this.tokens;
  }

  // 还差多少 ms 才能再 take 1 个 token；当前已 ≥ 1 时返回 0
  timeUntilNext(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const need = 1 - this.tokens;
    return Math.ceil((need / this.refillPerSec) * 1000);
  }
}
