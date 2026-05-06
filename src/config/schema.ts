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
    // F-10：默认开启 Cursor SDK 沙箱（CWE-269 加固）。
    // 沙箱具体规则由 ~/.cursor/sandbox.json 或 <workspace>/.cursor/sandbox.json 控制：
    //   - type: "workspace_readwrite"（默认）/ "workspace_readonly" / "insecure_none"
    //   - networkPolicy: 网络白/黑名单（拦默认 SSRF / cloud metadata）
    //   - additionalReadonlyPaths / additionalReadwritePaths
    // 用户若需关闭（如运行 npm install / 跨工作区写文件等），可在 config.json 设为 false。
    sandboxOptions: z
      .object({ enabled: z.boolean().default(true) })
      .default({ enabled: true }),
  }),
  workspaces: z
    .object({
      autoRegisterCwd: z.boolean().default(true),
      // F-07：/ws add 路径白名单；空数组时由主入口注入 cwd + 既有 workspace 路径作为兼容默认
      allowedRoots: z.array(z.string()).default([]),
    })
    .default({ autoRegisterCwd: true, allowedRoots: [] }),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  paths: z
    .object({ dataDir: z.string().default("./data") })
    .default({ dataDir: "./data" }),
  logging: z
    .object({ level: z.enum(["debug", "info", "warn", "error"]).default("info") })
    .default({ level: "info" }),
  // M2：提醒功能配置（时区 + 最长提前天数）
  reminders: z
    .object({
      timezone: z.string().default("Asia/Shanghai"),
      maxAheadDays: z.number().int().min(1).max(365).default(30),
    })
    .default({ timezone: "Asia/Shanghai", maxAheadDays: 30 }),
  // M2：出站附件队列与投递策略
  attachments: z
    .object({
      maxFileSizeBytes: z
        .number()
        .int()
        .min(1024)
        .max(50 * 1024 * 1024)
        .default(20 * 1024 * 1024),
      maxAttachmentsPerFlush: z.number().int().min(1).max(50).default(10),
      maxRetries: z.number().int().min(0).max(5).default(3),
    })
    .default({
      maxFileSizeBytes: 20 * 1024 * 1024,
      maxAttachmentsPerFlush: 10,
      maxRetries: 3,
    }),
  // M2：入站图片配置（最大张数、默认 prompt、media_group debounce）
  images: z
    .object({
      maxImagesPerPrompt: z.number().int().min(1).max(16).default(8),
      defaultPromptSingle: z.string().default("请分析这张图片"),
      defaultPromptMulti: z.string().default("请分析这些图片"),
      // 800ms 给余量：grammy 接续 update 通常 50-200ms，但偶尔有 300-500ms 抖动；
      // 200ms 偏紧（spec 也注明"太小会拆开 album"），800ms 用户感知延迟仍可接受。
      mediaGroupDebounceMs: z.number().int().min(50).max(2000).default(800),
    })
    .default({
      maxImagesPerPrompt: 8,
      defaultPromptSingle: "请分析这张图片",
      defaultPromptMulti: "请分析这些图片",
      mediaGroupDebounceMs: 800,
    }),
  // F-06：三层资源 cap，全部带默认值，向后兼容旧 config.json
  // - message：单用户 messenger 入口限速（防 owner 误操作 + 凭据被盗后的洪水）
  // - agentCreate：cached miss 进入新 Agent.create / resume 时的限速；cached 命中不计入
  // - reminders：单用户 reminder 总数上限（防 /remind add 灌爆持久化文件）
  rateLimit: z
    .object({
      message: z
        .object({
          capacity: z.number().int().min(1).default(4),
          refillPerSec: z.number().min(0.1).default(2),
        })
        .default({ capacity: 4, refillPerSec: 2 }),
      agentCreate: z
        .object({
          capacity: z.number().int().min(1).default(10),
          refillPerSec: z.number().min(0.01).default(10 / 60),
        })
        .default({ capacity: 10, refillPerSec: 10 / 60 }),
      reminders: z
        .object({ maxPerUser: z.number().int().min(1).default(100) })
        .default({ maxPerUser: 100 }),
    })
    .default({
      message: { capacity: 4, refillPerSec: 2 },
      agentCreate: { capacity: 10, refillPerSec: 10 / 60 },
      reminders: { maxPerUser: 100 },
    }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

// 配置错误：在加载阶段抛出，主入口会捕获并友好打印
export class ConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ConfigError";
  }
}
