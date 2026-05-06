import type { IMessenger } from "../../core/messenger/IMessenger.js";
import type { RateLimiter } from "../../core/rateLimit/RateLimiter.js";
import { logger } from "../../logger.js";
import { rateLimitedMessageText } from "../../util/rateLimitMessages.js";

// F-06 PR c：messenger 入口限速守卫
// 抽到独立模块的目的是把"是否允许继续"的判定与 main() 的装配链路解耦，
// 让 integration test 可以构造一个 fake messenger 直接验证拦截/通知行为。

export async function rateLimitGuard(opts: {
  limiter: RateLimiter;
  messenger: IMessenger;
  chatId: string;
  userId: number;
  // 当前只用 "msg"；保留 string 是为了与 RateLimiter API 一致，
  // 允许将来在不改 guard 的情况下复用此函数
  key: "msg";
}): Promise<boolean> {
  const r = opts.limiter.check(opts.userId, opts.key);
  if (r.allowed) return true;

  // 不静默：所有 deny 路径都 logger.warn，便于 owner 日后排查触限
  logger.warn(
    { userId: opts.userId, key: opts.key, retryMs: r.retryAfterMs },
    "rate limited",
  );
  // 用 plain parseMode：retry-after 文本里的"."如果走 HTML 解析可能出意外，
  // plain 最稳；与 USAGE / 错误提示统一风格
  await opts.messenger.sendText(
    opts.chatId,
    rateLimitedMessageText(r.retryAfterMs),
    { parseMode: "plain" },
  );
  return false;
}
