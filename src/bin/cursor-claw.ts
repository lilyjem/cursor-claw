#!/usr/bin/env node
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "../config/loadConfig.js";
import { logger } from "../logger.js";
import { TelegramMessenger } from "../adapters/telegram/TelegramMessenger.js";
import { WorkspaceRegistry } from "../core/workspace/WorkspaceRegistry.js";
import { SessionStore } from "../core/session/SessionStore.js";
import { AccessControl } from "../core/access/AccessControl.js";
import { AgentOrchestrator } from "../core/orchestrator/AgentOrchestrator.js";
import { CursorSdkRuntime } from "../core/orchestrator/cursorSdkRuntime.js";
import { parseCommand } from "../commands/parser.js";
import { dispatchCommand } from "../commands/dispatch.js";
import { parseForcePrefix } from "../core/orchestrator/busyPolicy.js";

// cursor-claw M1 主入口：加载 config → 装配单进程的所有依赖 → 启动 Telegram long-polling
async function main(): Promise<void> {
  const cfg = await loadConfig({});
  const dataDir = cfg.paths.dataDir;
  await mkdir(dataDir, { recursive: true });

  const registry = new WorkspaceRegistry(join(dataDir, "workspaces.json"));
  await registry.init({
    autoRegisterCwd: cfg.workspaces.autoRegisterCwd,
    cwd: process.cwd(),
  });

  const session = new SessionStore(join(dataDir, "sessions.json"));
  await session.init();

  const access = new AccessControl(cfg.telegram.allowedUserIds);
  const messenger = new TelegramMessenger({
    botToken: cfg.telegram.botToken,
    parseMode: cfg.telegram.parseMode,
    allowedUserIds: cfg.telegram.allowedUserIds,
    // M2: 媒体组聚合 debounce 时间（控制 album 拼合的等待窗口）
    mediaGroupDebounceMs: cfg.images.mediaGroupDebounceMs,
  });
  const runtime = new CursorSdkRuntime(cfg.cursor.apiKey);
  const orchestrator = new AgentOrchestrator({
    messenger,
    runtime,
    registry,
    session,
    // 真实 Telegram 比单测要更慢节流；800ms 是 RPS 限制内的稳健值
    streamOptions: { throttleMs: 800, maxLen: 3500 },
    defaultModel: cfg.cursor.defaultModel,
  });

  messenger.on("text", (msg) => {
    // 不论是否被白名单接受都先记一行 trace，方便用户首次配置时排查
    logger.info(
      { userId: msg.userId, username: msg.username, len: msg.text.length },
      "incoming text",
    );
    if (!access.isAllowed(msg.userId)) {
      logger.warn({ userId: msg.userId }, "userId 不在 allowedUserIds，丢弃");
      return;
    }
    void handleText(msg.chatId, msg.text);
  });

  // M2：旧 image 事件保留 listener 注册（向后兼容）但不再做事，
  // 真正接入 agent 的路径走聚合后的 imageGroup 事件
  messenger.on("image", () => {});

  messenger.on("imageGroup", (msg) => {
    if (!access.isAllowed(msg.userId)) {
      logger.warn({ userId: msg.userId }, "userId 不在 allowedUserIds，丢弃");
      return;
    }
    logger.info(
      { userId: msg.userId, n: msg.images.length, hasCaption: !!msg.caption },
      "incoming imageGroup",
    );
    void handleImageGroup(msg.chatId, msg.images, msg.caption);
  });

  await messenger.start();
  logger.info("cursor-claw started");

  // SIGINT/SIGTERM 平稳退出：先停 long-polling 不再收新消息，再 dispose orchestrator 取消所有 run
  const shutdown = async (): Promise<void> => {
    logger.info("shutting down...");
    try {
      await messenger.stop();
    } catch (e) {
      logger.error({ err: (e as Error).message }, "messenger stop");
    }
    try {
      await orchestrator.dispose();
    } catch (e) {
      logger.error({ err: (e as Error).message }, "orch dispose");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // M2：把 imageGroup 落到 orchestrator.runPromptWithImages
  // - 超过 cfg.images.maxImagesPerPrompt 时截断并提示用户
  // - caption 为空时按张数选 single/multi 默认 prompt
  // - 与 handleText 一致：以 ! 开头解为 force=true
  async function handleImageGroup(
    chatId: string,
    images: Array<{ data: string; mimeType: string }>,
    caption?: string,
  ): Promise<void> {
    try {
      const cap = cfg.images.maxImagesPerPrompt;
      let used = images;
      if (images.length > cap) {
        used = images.slice(0, cap);
        await messenger.sendText(
          chatId,
          `图片超过 ${cap} 张，仅取前 ${cap} 张。`,
        );
      }
      const text =
        caption ??
        (used.length > 1
          ? cfg.images.defaultPromptMulti
          : cfg.images.defaultPromptSingle);
      const { force, text: clean } = parseForcePrefix(text);
      await orchestrator.runPromptWithImages({
        chatId,
        text: clean,
        images: used,
        force,
      });
    } catch (e) {
      logger.error({ err: (e as Error).message }, "handleImageGroup 顶层异常");
      try {
        await messenger.sendText(
          chatId,
          `处理图片失败：${(e as Error).message}`.slice(0, 800),
          { parseMode: "plain" },
        );
      } catch {
        /* ignore */
      }
    }
  }

  async function handleText(chatId: string, text: string): Promise<void> {
    // 顶层 try/catch：渲染失败、Telegram 400/429 等绝不能让整个进程崩
    try {
      const parsed = parseCommand(text);
      if (parsed.type === "command") {
        await dispatchCommand(parsed, {
          chatId,
          messenger,
          registry,
          session,
          orchestrator,
        });
        return;
      }
      // 普通文本走 prompt 路径；先剥 ! force 前缀
      const { force, text: clean } = parseForcePrefix(parsed.text);
      await orchestrator.runPrompt({ chatId, text: clean, force });
    } catch (e) {
      logger.error({ err: (e as Error).message }, "handleText 顶层异常");
      try {
        // 用 plain 模式回个最终错误提示，避免被 HTML 解析坑住
        await messenger.sendText(
          chatId,
          `内部错误：${(e as Error).message}`.slice(0, 800),
          { parseMode: "plain" },
        );
      } catch {
        /* 最后手段：什么都不做，避免再抛 */
      }
    }
  }
}

main().catch((e) => {
  logger.error({ err: (e as Error).message }, "fatal");
  process.exit(1);
});
