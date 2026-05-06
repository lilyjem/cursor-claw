import { TokenBucket } from "./TokenBucket.js";

// F-06 PR b：RateLimiter 多 bucket 容器
// - 按 (userId, key) 索引一组独立 TokenBucket
// - 未在 options.buckets 中声明的 key 视为"无限制"，直接 ALLOW
// - 内置朴素 LRU，按 lastUsedMs 升序 evict，避免 idle bucket 累积

export interface BucketSpec {
  capacity: number;
  refillPerSec: number;
}

export interface RateLimiterOptions {
  // 每种 key 一组 bucket 参数；未声明的 key check() 直接 ALLOW
  buckets: Record<string, BucketSpec>;
  // 内部 (userId, key) → bucket 的最大数；超过就 LRU evict
  maxBuckets?: number;
  now?: () => number;
}

export interface CheckResult {
  allowed: boolean;
  // ALLOW 时为 0；DENY 时为还需等待的 ms（来自底层 bucket.timeUntilNext）
  retryAfterMs: number;
}

export class RateLimiter {
  private readonly specs: Record<string, BucketSpec>;
  private readonly maxBuckets: number;
  private readonly now: () => number;
  // 用 Map 单纯做 id → bucket 索引；LRU 用独立 lastUsed Map 跟踪
  private readonly store = new Map<string, TokenBucket>();
  private readonly lastUsed = new Map<string, number>();

  constructor(opts: RateLimiterOptions) {
    this.specs = opts.buckets;
    this.maxBuckets = opts.maxBuckets ?? 1024;
    this.now = opts.now ?? Date.now;
  }

  // 试取一个 token；ALLOW 表示请求可继续，DENY 时附带 retryAfterMs 给上游回用户提示
  check(userId: number, key: string): CheckResult {
    const spec = this.specs[key];
    // 未声明的 key 默认 ALLOW：避免新增 key 时调用方"忘了配置"导致硬性拒绝
    if (!spec) return { allowed: true, retryAfterMs: 0 };

    const id = `${userId}::${key}`;
    let bucket = this.store.get(id);
    if (!bucket) {
      bucket = new TokenBucket({ ...spec, now: this.now });
      this.store.set(id, bucket);
      this.evictIfFull();
    }
    this.lastUsed.set(id, this.now());

    if (bucket.take(1)) return { allowed: true, retryAfterMs: 0 };
    return { allowed: false, retryAfterMs: bucket.timeUntilNext() };
  }

  // 朴素 LRU：按 lastUsed 升序找出最久未用的 bucket 删除
  // 单进程低 QPS 场景，O(n) 扫一次 maxBuckets 足够；不引入 LinkedList 节省心智
  private evictIfFull(): void {
    if (this.store.size <= this.maxBuckets) return;
    let oldestId: string | undefined;
    let oldestT = Number.POSITIVE_INFINITY;
    for (const [id, t] of this.lastUsed) {
      if (t < oldestT) {
        oldestT = t;
        oldestId = id;
      }
    }
    if (oldestId) {
      this.store.delete(oldestId);
      this.lastUsed.delete(oldestId);
    }
  }
}
