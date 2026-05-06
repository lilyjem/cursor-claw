// F-06：限速错误类型
// 用 typed error 而不是 sentinel 字符串，方便上游 instanceof 判定后取出 retryAfterMs 给用户提示。

export class RateLimitedError extends Error {
  constructor(
    public readonly key: string,
    public readonly retryAfterMs: number,
  ) {
    super(`rate limited: ${key}, retry in ${retryAfterMs}ms`);
    this.name = "RateLimitedError";
  }
}
