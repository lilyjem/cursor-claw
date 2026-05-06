// 把用户在 Telegram 输入的时间字符串解析成 UTC ms。支持三种形式：
// 1. 相对时长：10m / 1h30m / 45s / 2d（可组合）
// 2. 当日 HH:MM：09:00 / 22:30（已过自动顺延到次日）
// 3. 绝对：YYYY-MM-DD HH:MM（也接受 T 分隔）
//
// 时区 tz 决定 HH:MM / 绝对日期解析的"墙上时间"对应的 UTC 时刻。

export interface ParseTimeOptions {
  now: number; // 当前时刻（UTC ms）；测试可注入固定值
  tz: string; // IANA 时区名，如 "Asia/Shanghai" / "UTC"
  maxAheadDays: number; // 上限：太远拒绝，避免 setTimeout 受 32-bit 溢出影响
}

export interface ParseTimeResult {
  at: number; // 目标 UTC ms；非法或超限时为 0
  error?: string; // 友好错误描述
}

const RELATIVE_RE = /^(\d+d)?(\d+h)?(\d+m)?(\d+s)?$/;
const HHMM_RE = /^(\d{1,2}):(\d{2})$/;
const ABSOLUTE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/;

export function parseTimeExpr(
  input: string,
  opts: ParseTimeOptions,
): ParseTimeResult {
  const t = input.trim();
  if (!t) return { at: 0, error: "empty" };

  // 1. 相对时长
  const m = RELATIVE_RE.exec(t);
  if (m && (m[1] || m[2] || m[3] || m[4])) {
    let ms = 0;
    if (m[1]) ms += parseInt(m[1]) * 86400_000;
    if (m[2]) ms += parseInt(m[2]) * 3600_000;
    if (m[3]) ms += parseInt(m[3]) * 60_000;
    if (m[4]) ms += parseInt(m[4]) * 1000;
    return finalize(opts.now + ms, opts);
  }

  // 2. 当日 HH:MM
  const hm = HHMM_RE.exec(t);
  if (hm) {
    const hh = parseInt(hm[1]!);
    const mm = parseInt(hm[2]!);
    if (hh > 23 || mm > 59) return { at: 0, error: "invalid HH:MM" };
    const at = inTzAt(opts.now, opts.tz, hh, mm);
    // 已过 → 次日
    const finalAt = at <= opts.now ? at + 86400_000 : at;
    return finalize(finalAt, opts);
  }

  // 3. 绝对 YYYY-MM-DD HH:MM
  const ab = ABSOLUTE_RE.exec(t);
  if (ab) {
    const [, y, mo, d, hh, mm] = ab;
    const at = makeTzDate(opts.tz, +y!, +mo! - 1, +d!, +hh!, +mm!);
    if (Number.isNaN(at)) return { at: 0, error: "invalid date" };
    return finalize(at, opts);
  }

  return {
    at: 0,
    error:
      "时间格式不识别：示例 10m / 1h30m / 45s / 09:00 / 2026-05-06 09:00",
  };
}

// 取 now 在指定 tz 当天的 yyyy/mm/dd，再装上目标 hh:mm；返回该时刻的 UTC ms
function inTzAt(now: number, tz: string, hh: number, mm: number): number {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(now));
  const get = (n: string): number =>
    parseInt(parts.find((p) => p.type === n)!.value, 10);
  return makeTzDate(tz, get("year"), get("month") - 1, get("day"), hh, mm);
}

// 在指定 tz 把 (y, m, d, hh, mm) 翻成 UTC ms。
// 实现思路：先把这些值当作 UTC 拼一个 utcGuess，然后查这个时刻在 tz 显示出来的
// 墙上时间（也当作 UTC 拼一个），二者差就是该时刻的 tz 偏移；用偏移修正得到目标 UTC。
function makeTzDate(
  tz: string,
  y: number,
  mIdx: number,
  d: number,
  hh: number,
  mm: number,
): number {
  const utcGuess = Date.UTC(y, mIdx, d, hh, mm);
  const tzNow = new Date(utcGuess);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(tzNow);
  const get = (n: string): number =>
    parseInt(parts.find((p) => p.type === n)!.value, 10);
  const tzAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
  );
  // tzAsUtc 是 utcGuess 时刻在 tz 显示出的 wall-clock；偏差就是 tz 偏移
  const offset = tzAsUtc - utcGuess;
  return utcGuess - offset;
}

function finalize(at: number, opts: ParseTimeOptions): ParseTimeResult {
  const limit = opts.now + opts.maxAheadDays * 86400_000;
  if (at > limit) {
    return { at: 0, error: `超过 ${opts.maxAheadDays} 天上限` };
  }
  if (at < opts.now) {
    return { at: 0, error: "时间已过" };
  }
  return { at };
}
