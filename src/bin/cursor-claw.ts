#!/usr/bin/env node
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../config/loadConfig.js";
import { logger } from "../logger.js";
import { TelegramMessenger } from "../adapters/telegram/TelegramMessenger.js";
import { WorkspaceRegistry } from "../core/workspace/WorkspaceRegistry.js";
import { SessionStore } from "../core/session/SessionStore.js";
import { AccessControl } from "../core/access/AccessControl.js";
import { AgentOrchestrator } from "../core/orchestrator/AgentOrchestrator.js";
import { CursorSdkRuntime } from "../core/orchestrator/cursorSdkRuntime.js";
import { AttachmentQueue } from "../core/attachments/AttachmentQueue.js";
import { AttachmentDispatcher } from "../core/attachments/AttachmentDispatcher.js";
import { ReminderStore } from "../core/reminders/ReminderStore.js";
import { ReminderQuota } from "../core/reminders/ReminderQuota.js";
import { ReminderScheduler } from "../core/reminders/ReminderScheduler.js";
import { parseCommand } from "../commands/parser.js";
import { dispatchCommand } from "../commands/dispatch.js";
import { parseForcePrefix } from "../core/orchestrator/busyPolicy.js";
import { sanitizeForOutput } from "../util/sanitize.js";
import { RateLimiter } from "../core/rateLimit/RateLimiter.js";
import { rateLimitGuard } from "./wiring/rateLimitGuard.js";

// cursor-claw 主入口（M1 + M2）：加载 config → 装配单进程依赖 → 启 long-polling
async function main(): Promise<void> {
  const cfg = await loadConfig({});
  const dataDir = cfg.paths.dataDir;
  // F-13：dataDir 含 session/reminder/附件等隐私数据，明确限定 0o700
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const registry = new WorkspaceRegistry(join(dataDir, "workspaces.json"));
  await registry.init({
    autoRegisterCwd: cfg.workspaces.autoRegisterCwd,
    cwd: process.cwd(),
  });

  const session = new SessionStore(join(dataDir, "sessions.json"));
  await session.init();

  // M2：把 dataDir 绝对路径写到 active workspace 根的 .claw/data-dir.txt
  // 这样 attach CLI 子进程在 agent 的 cwd 下能找到主进程的 dataDir。
  // 失败不阻塞启动（仅日志告警）。
  const writeClawMarker = async (wsPath: string): Promise<void> => {
    try {
      const markerDir = join(wsPath, ".claw");
      // F-13：marker 内容是 dataDir 绝对路径，间接暴露用户名/项目布局；
      // 限定 0o700/0o600。
      await mkdir(markerDir, { recursive: true, mode: 0o700 });
      const abs = resolve(dataDir);
      await writeFile(join(markerDir, "data-dir.txt"), abs, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (e) {
      logger.warn(
        { err: (e as Error).message, wsPath },
        ".claw/data-dir.txt 写入失败",
      );
    }
  };

  const access = new AccessControl(cfg.telegram.allowedUserIds);
  const messenger = new TelegramMessenger({
    botToken: cfg.telegram.botToken,
    parseMode: cfg.telegram.parseMode,
    allowedUserIds: cfg.telegram.allowedUserIds,
    // M2: 媒体组聚合 debounce 时间（控制 album 拼合的等待窗口）
    mediaGroupDebounceMs: cfg.images.mediaGroupDebounceMs,
    // F-05: 把 attachments.maxFileSizeBytes 真正注入到下载层（之前仅 schema 有定义、无实施）
    maxFileSizeBytes: cfg.attachments.maxFileSizeBytes,
  });
  const runtime = new CursorSdkRuntime(cfg.cursor.apiKey);

  // M2: 出站附件 queue + dispatcher
  const queue = new AttachmentQueue(
    join(dataDir, "attachments", "queue.jsonl"),
  );
  // F-14：把 pending 目录绝对路径传给 dispatcher，作为 entry.path 的硬边界
  const pendingRoot = join(dataDir, "attachments", "pending");
  const dispatcher = new AttachmentDispatcher({
    queue,
    messenger,
    maxRetries: cfg.attachments.maxRetries,
    maxPerFlush: cfg.attachments.maxAttachmentsPerFlush,
    pendingRoot,
  });

  // M2: reminders store + scheduler
  const reminderStore = new ReminderStore(join(dataDir, "reminders.json"));
  await reminderStore.init();

  // F-06: 三层 RateLimiter（messenger 层 / agent.create 层）
  // ReminderQuota 走独立路径（PR e），不走这里
  const limiter = new RateLimiter({
    buckets: {
      msg: cfg.rateLimit.message,
      agentCreate: cfg.rateLimit.agentCreate,
    },
  });

  const orchestrator = new AgentOrchestrator({
    messenger,
    runtime,
    registry,
    session,
    // 真实 Telegram 比单测要更慢节流；800ms 是 RPS 限制内的稳健值。
    // M2 polish：textBuffer 改为 raw markdown 后 compose 时整体 markdownToHtml，
    // HTML 转换会让长度增长（** 配对净 +1 / < 转 &lt; 净 +3 等），把 maxLen 从 3500 调到 3000
    // 给 HTML 增长留 ~30% 余量，避免触碰 Telegram 4096 单条上限。
    streamOptions: { throttleMs: 800, maxLen: 3000 },
    defaultModel: cfg.cursor.defaultModel,
    attachmentDispatcher: dispatcher,
    // F-10：把 sandboxOptions 沿 orchestrator → runtime → SDK 一路透传。
    // schema 默认 enabled=true；用户可在 config.json 显式 false 关闭。
    sandboxOptions: cfg.cursor.sandboxOptions,
    // F-06：agent.create / resume cached miss 前做单用户限速
    rateLimiter: limiter,
  });

  const scheduler = new ReminderScheduler({
    store: reminderStore,
    runReminder: (input) => orchestrator.runReminder(input),
    sendText: async (chatId, text) => {
      await messenger.sendText(chatId, text);
    },
  });
  // F-06：/remind add 写入前按 createdBy 做数量上限检查（默认 100/user）
  const reminderQuota = new ReminderQuota(scheduler, {
    maxPerUser: cfg.rateLimit.reminders.maxPerUser,
  });
  await scheduler.start();

  // 写 .claw 标记（在 messenger.start() 之前；写不成不阻塞）
  const activeWs = registry.getActive();
  if (activeWs) await writeClawMarker(activeWs.path);
  // F-07：/ws add 默认只允许当前 cwd 与既有 workspace 树，用户可用 config.workspaces.allowedRoots 扩展。
  const workspaceAllowedRoots =
    cfg.workspaces.allowedRoots.length > 0
      ? cfg.workspaces.allowedRoots
      : [process.cwd(), ...registry.list().map((w) => w.path)];

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
    // F-06：白名单通过后再做 messenger 限速；deny 则 guard 内部已通知用户
    void (async () => {
      const ok = await rateLimitGuard({
        limiter,
        messenger,
        chatId: msg.chatId,
        userId: msg.userId,
        key: "msg",
      });
      if (!ok) return;
      await handleText(msg.chatId, msg.text, msg.userId);
    })();
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
    // F-06：图片消息也走同一 "msg" bucket（与文本消息共享 quota，避免攻击者
    // 用图片绕过文本限速；同 user 下两路径加在一起仍受 capacity 4 / 2 msg-per-sec 约束）
    void (async () => {
      const ok = await rateLimitGuard({
        limiter,
        messenger,
        chatId: msg.chatId,
        userId: msg.userId,
        key: "msg",
      });
      if (!ok) return;
      await handleImageGroup(msg.chatId, msg.images, msg.caption, msg.userId);
    })();
  });

  await messenger.start();
  logger.info("cursor-claw started");

  // SIGINT/SIGTERM 平稳退出：先停 long-polling，再依次 dispose scheduler / orchestrator
  const shutdown = async (): Promise<void> => {
    logger.info("shutting down...");
    try {
      await messenger.stop();
    } catch (e) {
      logger.error({ err: (e as Error).message }, "messenger stop");
    }
    try {
      // M2: scheduler 先 dispose，避免还有 timer 在跑时 orchestrator 已 disposed
      scheduler.dispose();
    } catch (e) {
      logger.error({ err: (e as Error).message }, "scheduler dispose");
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
    caption: string | undefined,
    userId: number,
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
        userId,
      });
    } catch (e) {
      logger.error({ err: (e as Error).message }, "handleImageGroup 顶层异常");
      try {
        // F-01 深度防御：用户端 echo 之前先 sanitize，避免 token / API key 通过 error.message 落到 Telegram。
        // 即使 downloadFile 已经在源头消毒，这一层也兜底，覆盖任何未来新增的错误源。
        const safeMsg = sanitizeForOutput((e as Error).message);
        await messenger.sendText(
          chatId,
          `处理图片失败：${safeMsg}`.slice(0, 800),
          { parseMode: "plain" },
        );
      } catch {
        /* ignore */
      }
    }
  }

  async function handleText(
    chatId: string,
    text: string,
    userId: number,
  ): Promise<void> {
    // 顶层 try/catch：渲染失败、Telegram 400/429 等绝不能让整个进程崩
    try {
      const parsed = parseCommand(text);
      if (parsed.type === "command") {
        await dispatchCommand(parsed, {
          chatId,
          userId,
          messenger,
          registry,
          session,
          orchestrator,
          scheduler,
          reminderQuota,
          workspaceAllowedRoots,
          reminderConfig: {
            tz: cfg.reminders.timezone,
            maxAheadDays: cfg.reminders.maxAheadDays,
          },
        });
        return;
      }
      // 普通文本走 prompt 路径；先剥 ! force 前缀
      const { force, text: clean } = parseForcePrefix(parsed.text);
      await orchestrator.runPrompt({ chatId, text: clean, force, userId });
    } catch (e) {
      logger.error({ err: (e as Error).message }, "handleText 顶层异常");
      try {
        // F-01 深度防御：sanitize 后再 echo，参见 handleImageGroup 同样位置注释
        const safeMsg = sanitizeForOutput((e as Error).message);
        // 用 plain 模式回个最终错误提示，避免被 HTML 解析坑住
        await messenger.sendText(
          chatId,
          `内部错误：${safeMsg}`.slice(0, 800),
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
