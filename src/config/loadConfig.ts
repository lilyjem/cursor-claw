import { readFile } from "node:fs/promises";
import { ConfigSchema, ConfigError, type AppConfig } from "./schema.js";

export interface LoadConfigOptions {
  configPath?: string;
}

/**
 * 加载并校验配置：
 * 1. 读取 JSON 文件（默认 ./config.json，可由 configPath 覆盖）
 * 2. 用环境变量覆盖敏感字段：TELEGRAM_BOT_TOKEN / CURSOR_API_KEY
 * 3. 用 zod schema 做严格校验
 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<AppConfig> {
  const path = opts.configPath ?? "./config.json";
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`config file not found: ${path}`);
    }
    throw new ConfigError(`failed to parse config: ${(e as Error).message}`);
  }

  const overlay = applyEnvOverlay(raw);
  const parsed = ConfigSchema.safeParse(overlay);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`config validation failed:\n${issues}`);
  }
  return parsed.data;
}

// 让环境变量优先：方便部署时只用 .env / systemd EnvironmentFile 注入敏感信息
function applyEnvOverlay(raw: unknown): unknown {
  const r = (raw && typeof raw === "object"
    ? { ...(raw as Record<string, unknown>) }
    : {}) as {
    telegram?: Record<string, unknown>;
    cursor?: Record<string, unknown>;
  };
  if (process.env.TELEGRAM_BOT_TOKEN) {
    r.telegram = { ...(r.telegram ?? {}), botToken: process.env.TELEGRAM_BOT_TOKEN };
  }
  if (process.env.CURSOR_API_KEY) {
    r.cursor = { ...(r.cursor ?? {}), apiKey: process.env.CURSOR_API_KEY };
  }
  return r;
}
