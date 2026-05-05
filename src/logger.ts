import pino from "pino";

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
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } },
});

export type Logger = typeof logger;
