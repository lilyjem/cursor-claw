import pino from "pino";
import { sanitizeForOutput } from "./util/sanitize.js";

// 已知的敏感字段名集合：用于 redactSensitive 在结构化对象上手动 mask；
// 同时 pino 的 redact 配置在序列化输出时再做一次保护。
const SENSITIVE_KEYS = new Set([
  "botToken",
  "apiKey",
  "TELEGRAM_BOT_TOKEN",
  "CURSOR_API_KEY",
  "token",
  "secret",
]);

// F-01 深度防御：递归走完整对象，对每个 string 字段值跑 sanitizeForOutput，
// 切除 Telegram bot token URL / Cursor API key 等"字符串内含机密"形态。
// pino 的 redact 配置只能对**字段路径**生效，无法对**字符串内容**做内容级脱敏，
// 这一层补足。
function sanitizeObjectStrings(obj: unknown): unknown {
  if (typeof obj === "string") return sanitizeForOutput(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeObjectStrings);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = sanitizeObjectStrings(v);
    }
    return out;
  }
  return obj;
}

/**
 * 把对象中的敏感字段值替换为 "***"。
 * 用于在调试输出时主动脱敏（例如 dump 配置）。
 */
export function redactSensitive<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) ? "***" : redactSensitive(v);
    }
    return out as unknown as T;
  }
  return value;
}

// 全局 logger 实例。生产模式输出 ndjson，开发模式 pretty。
//
// 三层保护：
//   Layer A：redact.paths（字段路径级精确 mask，如 *.apiKey / *.botToken）
//   Layer B：formatters.log → sanitizeObjectStrings（字符串内容级脱敏，覆盖 token URL）
//   Layer C：上层调用方 redactSensitive() 主动脱敏（dump 配置等显式场景）
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "telegram.botToken",
      "cursor.apiKey",
      "*.botToken",
      "*.apiKey",
      "headers.authorization",
    ],
    censor: "***",
  },
  formatters: {
    // pino 在序列化前调一次 log formatter；返回的对象会替换原对象后再写入 transport。
    // 在这里递归跑 sanitizeObjectStrings 实现内容级脱敏。
    log: (obj) => sanitizeObjectStrings(obj) as Record<string, unknown>,
  },
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } },
});

export type Logger = typeof logger;
