import { z } from "zod";

// 应用配置的统一 schema：用于 JSON 文件 + 环境变量覆盖后的最终校验。
// 所有可选字段都给了默认值，让运行时不再处理 undefined。
export const ConfigSchema = z.object({
  telegram: z.object({
    botToken: z.string().min(1),
    allowedUserIds: z.array(z.number().int()).min(1),
    parseMode: z.enum(["HTML", "Markdown", "plain"]).default("HTML"),
  }),
  cursor: z.object({
    apiKey: z.string().min(1),
    defaultModel: z
      .object({
        // Cursor SDK 的"自动选择"模型 id 是 "default"（不是 "auto"，会被 ConfigurationError 拒绝）
        id: z.string().default("default"),
        params: z
          .array(z.object({ id: z.string(), value: z.string() }))
          .default([]),
      })
      .default({ id: "default", params: [] }),
    settingSources: z
      .array(z.enum(["project", "user", "team", "mdm", "plugins", "all"]))
      .default(["project", "user"]),
    sandboxOptions: z.object({ enabled: z.boolean() }).optional(),
  }),
  workspaces: z
    .object({ autoRegisterCwd: z.boolean().default(true) })
    .default({ autoRegisterCwd: true }),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  paths: z
    .object({ dataDir: z.string().default("./data") })
    .default({ dataDir: "./data" }),
  logging: z
    .object({ level: z.enum(["debug", "info", "warn", "error"]).default("info") })
    .default({ level: "info" }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

// 配置错误：在加载阶段抛出，主入口会捕获并友好打印
export class ConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ConfigError";
  }
}
