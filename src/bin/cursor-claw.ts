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

  messenger.on("image", (msg) => {
    if (!access.isAllowed(msg.userId)) return;
    void messenger.sendText(
      msg.chatId,
      "（M1 暂不处理图片输入；M2 会接入。）",
    );
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
