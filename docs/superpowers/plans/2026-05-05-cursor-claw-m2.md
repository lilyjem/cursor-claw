# cursor-claw M2 Implementation Plan（入站图片 + 出站附件 + Reminders）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 M1 基础上完成 (A) Telegram 入站图片 / album → agent；(B) agent 通过 `claw-attach-*` CLI 把文件回送 Telegram；(C) `/remind add|list|del` 支持一次性 text 和 prompt 提醒。M2 完成后预计共 ~127 个测试，e2e smoke 全程无崩溃。

**Architecture:** 沿用 M1 分层单进程；新增 4 个核心模块（ReminderStore / ReminderScheduler / AttachmentQueue / AttachmentDispatcher），扩展 4 个 M1 模块（IMessenger / TelegramMessenger / AgentOrchestrator / bin），新增 2 个独立 CLI 工具（claw-attach-image / claw-attach-file）。所有依赖单向无循环。

**Tech Stack:** Node.js 20+ ESM、TypeScript 5.5、`@cursor/sdk`、`grammy`、`zod`、`pino`、`vitest`、`tsx`、`tsup`（与 M1 完全一致，不引入新依赖）。

**Spec 引用：** `docs/superpowers/specs/2026-05-05-cursor-claw-m2-design.md`

---

## File Structure（M2 范围内）

```
cursor-claw/
├── package.json                            [T1, T7] bin 注册
├── config.example.json                      [T1, T16] 新增字段示例
├── .gitignore                               [T16] 加 .claw/
├── src/
│   ├── config/schema.ts                     [T1] 新增 reminders/attachments/images 三段
│   ├── core/
│   │   ├── messenger/
│   │   │   ├── IMessenger.ts                [T3] 新增 imageGroup 事件
│   │   │   └── types.ts                     [T3] 新增 IncomingImageGroup
│   │   ├── orchestrator/
│   │   │   └── AgentOrchestrator.ts         [T4, T9, T12] 新增 runPromptWithImages / runReminder + dispatcher 接通
│   │   ├── reminders/                       [新]
│   │   │   ├── timeParser.ts                [T10]
│   │   │   ├── ReminderStore.ts             [T11]
│   │   │   └── ReminderScheduler.ts         [T13]
│   │   └── attachments/                     [新]
│   │       ├── AttachmentQueue.ts           [T6]
│   │       └── AttachmentDispatcher.ts      [T8]
│   ├── adapters/telegram/
│   │   ├── ImageGroupBuffer.ts              [T2] 与 grammy 解耦的纯逻辑类
│   │   └── TelegramMessenger.ts             [T3] 接通 ImageGroupBuffer + 真实 sendImage/Document
│   ├── commands/
│   │   ├── dispatch.ts                      [T14] 新增 case "remind"
│   │   └── handlers/remind.ts               [T14]
│   ├── tools/                               [新]
│   │   ├── attach-image.ts                  [T7] bin: claw-attach-image
│   │   └── attach-file.ts                   [T7] bin: claw-attach-file
│   └── bin/cursor-claw.ts                   [T5, T9, T15] imageGroup / dispatcher / scheduler / .claw
├── tests/
│   ├── helpers/
│   │   └── StubAgent.ts                     [T4] 新增 imagesArg 记录
│   ├── unit/
│   │   ├── imageGroupBuffer.test.ts         [T2]
│   │   ├── attachmentQueue.test.ts          [T6]
│   │   ├── attachCli.test.ts                [T7]
│   │   ├── timeParser.test.ts               [T10]
│   │   ├── reminderStore.test.ts            [T11]
│   │   └── remindCommand.test.ts            [T14]
│   └── integration/
│       ├── orchestrator.imageGroup.test.ts  [T4]
│       ├── attachmentDispatcher.test.ts     [T8]
│       └── reminderScheduler.test.ts        [T13]
└── README.md                                  [T16]
```

---

## Task 1：配置 schema 扩展

**Files:**

- Modify: `src/config/schema.ts`
- Modify: `tests/unit/loadConfig.test.ts`
- Modify: `config.example.json`

- [ ] **Step 1：写新字段的 default 失败用例**

修改 `tests/unit/loadConfig.test.ts`，在文件末尾追加：

```typescript
it("M2 新字段 reminders / attachments / images 都有 default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfg-"));
  const path = join(dir, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      telegram: { botToken: "x", allowedUserIds: [1] },
      cursor: { apiKey: "y" },
    }),
  );
  const cfg = await loadConfig({ configPath: path });
  expect(cfg.reminders.timezone).toBe("Asia/Shanghai");
  expect(cfg.reminders.maxAheadDays).toBe(30);
  expect(cfg.attachments.maxFileSizeBytes).toBe(20 * 1024 * 1024);
  expect(cfg.attachments.maxAttachmentsPerFlush).toBe(10);
  expect(cfg.attachments.maxRetries).toBe(3);
  expect(cfg.images.maxImagesPerPrompt).toBe(8);
  expect(cfg.images.defaultPromptSingle).toBe("请分析这张图片");
  expect(cfg.images.defaultPromptMulti).toBe("请分析这些图片");
  expect(cfg.images.mediaGroupDebounceMs).toBe(200);
});
```

- [ ] **Step 2：跑测试，确认失败**

```bash
npm test -- --run tests/unit/loadConfig.test.ts
```

预期：`expect(cfg.reminders).toBeDefined()` 等 fail，因为 schema 还没这三个字段。

- [ ] **Step 3：扩展 schema**

修改 `src/config/schema.ts`，在 `logging` 下方追加三段：

```typescript
  reminders: z
    .object({
      timezone: z.string().default("Asia/Shanghai"),
      maxAheadDays: z.number().int().min(1).max(365).default(30),
    })
    .default({ timezone: "Asia/Shanghai", maxAheadDays: 30 }),
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
  images: z
    .object({
      maxImagesPerPrompt: z.number().int().min(1).max(16).default(8),
      defaultPromptSingle: z.string().default("请分析这张图片"),
      defaultPromptMulti: z.string().default("请分析这些图片"),
      mediaGroupDebounceMs: z.number().int().min(50).max(2000).default(200),
    })
    .default({
      maxImagesPerPrompt: 8,
      defaultPromptSingle: "请分析这张图片",
      defaultPromptMulti: "请分析这些图片",
      mediaGroupDebounceMs: 200,
    }),
```

- [ ] **Step 4：运行测试 + typecheck，确认全绿**

```bash
npm test -- --run tests/unit/loadConfig.test.ts && npm run typecheck
```

预期：全 pass。

- [ ] **Step 5：更新 `config.example.json`**

在末尾对象（`logging` 后）追加：

```json
,
  "reminders": { "timezone": "Asia/Shanghai", "maxAheadDays": 30 },
  "attachments": { "maxFileSizeBytes": 20971520, "maxAttachmentsPerFlush": 10, "maxRetries": 3 },
  "images": { "maxImagesPerPrompt": 8, "mediaGroupDebounceMs": 200 }
```

- [ ] **Step 6：commit**

```bash
git add src/config/schema.ts tests/unit/loadConfig.test.ts config.example.json
git commit -m "feat(config): 新增 reminders/attachments/images 三段配置（M2 准备）"
```

---

## Task 2：ImageGroupBuffer（媒体组 debounce 缓冲）

**Files:**

- Create: `src/adapters/telegram/ImageGroupBuffer.ts`
- Create: `tests/unit/imageGroupBuffer.test.ts`

> **设计要点：** 把"按 media_group_id 聚合 + debounce 触发"这一段纯逻辑从 grammy 中抽出来——不依赖任何 Telegram 类型，只接收 (groupId, item)，到点 emit。这样它能 100% 单测，TelegramMessenger 只是它的"adapter"。

- [ ] **Step 1：写测试**

创建 `tests/unit/imageGroupBuffer.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ImageGroupBuffer } from "../../src/adapters/telegram/ImageGroupBuffer.js";

describe("ImageGroupBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("无 groupId 单条立即触发", () => {
    const fired: string[][] = [];
    const buf = new ImageGroupBuffer<string>(200, (xs) => fired.push(xs));
    buf.push(undefined, "a");
    expect(fired).toEqual([["a"]]);
  });

  it("同 groupId 多条在 debounce 内只触发一次（按入队序）", () => {
    const fired: string[][] = [];
    const buf = new ImageGroupBuffer<string>(200, (xs) => fired.push(xs));
    buf.push("g1", "a");
    vi.advanceTimersByTime(100);
    buf.push("g1", "b");
    vi.advanceTimersByTime(100);
    buf.push("g1", "c");
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(199);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(fired).toEqual([["a", "b", "c"]]);
  });

  it("不同 groupId 互不干扰", () => {
    const fired: string[][] = [];
    const buf = new ImageGroupBuffer<string>(200, (xs) => fired.push(xs));
    buf.push("g1", "a");
    buf.push("g2", "x");
    vi.advanceTimersByTime(250);
    expect(fired.length).toBe(2);
    expect(fired).toContainEqual(["a"]);
    expect(fired).toContainEqual(["x"]);
  });

  it("dispose 清掉所有定时器，再来不会触发", () => {
    const fired: string[][] = [];
    const buf = new ImageGroupBuffer<string>(200, (xs) => fired.push(xs));
    buf.push("g1", "a");
    buf.dispose();
    vi.advanceTimersByTime(500);
    expect(fired).toEqual([]);
  });
});
```

- [ ] **Step 2：跑测试，确认失败**

```bash
npm test -- --run tests/unit/imageGroupBuffer.test.ts
```

预期：模块不存在的 import error。

- [ ] **Step 3：实现**

创建 `src/adapters/telegram/ImageGroupBuffer.ts`：

```typescript
// 把 Telegram media_group 的"多条 message 同 group_id 在短时间内陆续到达"
// 这种异步事件流抽象成"按 groupId 聚合 + 防抖触发"的纯逻辑。
//
// 用法：
//   const buf = new ImageGroupBuffer<MyItem>(200, (items) => emit(items));
//   buf.push(msg.media_group_id, myItem);   // groupId 可为 undefined
//
// 当 groupId 为 undefined 时立即触发（单图快路径）。
//
// 当 groupId 存在时：
//   - 第一次见到该 groupId：建桶 + 启 debounce timer
//   - 之后每次 push 都重置 timer（"最后一次到达后 debounceMs 才触发"）
//   - timer 触发时一次性 fire 整个桶并清掉

export class ImageGroupBuffer<T> {
  private buckets = new Map<
    string,
    { items: T[]; timer: ReturnType<typeof setTimeout> }
  >();
  private disposed = false;

  constructor(
    private readonly debounceMs: number,
    private readonly fire: (items: T[]) => void,
  ) {}

  push(groupId: string | undefined, item: T): void {
    if (this.disposed) return;
    if (!groupId) {
      // 单图快路径：不进 bucket，直接触发
      this.fire([item]);
      return;
    }
    const bucket = this.buckets.get(groupId);
    if (bucket) {
      clearTimeout(bucket.timer);
      bucket.items.push(item);
      bucket.timer = setTimeout(() => this.flush(groupId), this.debounceMs);
    } else {
      const timer = setTimeout(() => this.flush(groupId), this.debounceMs);
      this.buckets.set(groupId, { items: [item], timer });
    }
  }

  // dispose：取消所有未触发的 timer，避免进程退出时仍有定时回调
  dispose(): void {
    this.disposed = true;
    for (const b of this.buckets.values()) clearTimeout(b.timer);
    this.buckets.clear();
  }

  private flush(groupId: string): void {
    const bucket = this.buckets.get(groupId);
    if (!bucket) return;
    this.buckets.delete(groupId);
    this.fire(bucket.items);
  }
}
```

- [ ] **Step 4：跑测试 + typecheck，确认全绿**

```bash
npm test -- --run tests/unit/imageGroupBuffer.test.ts && npm run typecheck
```

预期：4 个测试全 pass。

- [ ] **Step 5：commit**

```bash
git add src/adapters/telegram/ImageGroupBuffer.ts tests/unit/imageGroupBuffer.test.ts
git commit -m "feat(adapter): ImageGroupBuffer 媒体组 debounce 缓冲（M2-A）"
```

---

## Task 3：TelegramMessenger 接通 ImageGroupBuffer + IMessenger 扩展

**Files:**

- Modify: `src/core/messenger/types.ts`
- Modify: `src/core/messenger/IMessenger.ts`
- Modify: `src/adapters/telegram/TelegramMessenger.ts`
- Modify: `tests/helpers/StubMessenger.ts`

> **设计要点：** 新增 `IncomingImageGroup` 类型与 `imageGroup` 事件；M1 既有的 `image` 事件保留以避免动 M1 测试；TelegramMessenger 内部用 ImageGroupBuffer 把 photo 消息聚合后只 emit 一次 `imageGroup`，旧 `image` 退役不再 emit。

- [ ] **Step 1：扩展 types.ts**

修改 `src/core/messenger/types.ts`，在 `IncomingImageMessage` 下方追加：

```typescript
// 媒体组：一次"用户发图"事件可能含 1..N 张图，caption 取首张非空
export interface IncomingImageGroup {
  chatId: string;
  userId: number;
  username?: string;
  images: Array<{ data: string; mimeType: string }>;
  caption?: string;
}
```

- [ ] **Step 2：扩展 IMessenger.ts**

修改 `src/core/messenger/IMessenger.ts`：

```typescript
import type {
  IncomingTextMessage,
  IncomingImageMessage,
  IncomingImageGroup,
  MessageHandle,
  SendOptions,
  ImagePayload,
  FilePayload,
} from "./types.js";

export interface IMessenger {
  start(): Promise<void>;
  stop(): Promise<void>;

  on(event: "text", h: (msg: IncomingTextMessage) => void): void;
  on(event: "image", h: (msg: IncomingImageMessage) => void): void;
  on(event: "imageGroup", h: (msg: IncomingImageGroup) => void): void;

  sendText(chatId: string, text: string, opts?: SendOptions): Promise<MessageHandle>;
  editText(chatId: string, messageId: string, text: string, opts?: SendOptions): Promise<void>;
  sendImage(chatId: string, image: ImagePayload, caption?: string): Promise<MessageHandle>;
  sendDocument(chatId: string, file: FilePayload, caption?: string): Promise<MessageHandle>;

  sendTyping(chatId: string): Promise<void>;
}
```

- [ ] **Step 3：扩展 StubMessenger 让 M1 测试继续绿**

修改 `tests/helpers/StubMessenger.ts`，在 `imageListeners` 下方追加成员 + on 分支：

```typescript
  private imageGroupListeners: Array<(m: IncomingImageGroup) => void> = [];
```

并扩展 `on()` 方法：

```typescript
  on(event: "text", h: (m: IncomingTextMessage) => void): void;
  on(event: "image", h: (m: IncomingImageMessage) => void): void;
  on(event: "imageGroup", h: (m: IncomingImageGroup) => void): void;
  on(event: "text" | "image" | "imageGroup", h: (m: never) => void): void {
    if (event === "text") {
      this.textListeners.push(h as (m: IncomingTextMessage) => void);
    } else if (event === "image") {
      this.imageListeners.push(h as (m: IncomingImageMessage) => void);
    } else {
      this.imageGroupListeners.push(h as (m: IncomingImageGroup) => void);
    }
  }
```

并新增触发方法：

```typescript
  emitImageGroup(m: IncomingImageGroup): void {
    for (const l of this.imageGroupListeners) l(m);
  }
```

记得在文件顶部 import 新增类型：

```typescript
import type {
  IncomingTextMessage,
  IncomingImageMessage,
  IncomingImageGroup,
  MessageHandle,
  SendOptions,
  ImagePayload,
  FilePayload,
} from "../../src/core/messenger/types.js";
```

- [ ] **Step 4：先跑 typecheck，确认 IMessenger 接口接通而 M1 既有测试还能编译**

```bash
npm run typecheck
```

预期：pass。如果 StubMessenger 报"未实现 on('imageGroup')" 即修复。

- [ ] **Step 5：改 TelegramMessenger 接通 ImageGroupBuffer**

修改 `src/adapters/telegram/TelegramMessenger.ts`：

替换顶部 import：

```typescript
import { InputFile } from "grammy";
import { createBot, type GrammyBot } from "./grammyClient.js";
import { ImageGroupBuffer } from "./ImageGroupBuffer.js";
import type { IMessenger } from "../../core/messenger/IMessenger.js";
import type {
  IncomingTextMessage,
  IncomingImageMessage,
  IncomingImageGroup,
  MessageHandle,
  ImagePayload,
  FilePayload,
  SendOptions,
} from "../../core/messenger/types.js";
import { logger } from "../../logger.js";
```

扩展 config + 类成员 + 内部 buffer item 类型：

```typescript
export interface TelegramMessengerConfig {
  botToken: string;
  parseMode: "HTML" | "Markdown" | "plain";
  allowedUserIds?: number[];
  // M2: 媒体组 debounce 时间，太小会拆开 album，太大用户感知延迟
  mediaGroupDebounceMs?: number;
}

interface PendingPhoto {
  data: string;
  mimeType: string;
  caption?: string;
  chatId: string;
  userId: number;
  username?: string;
}

export class TelegramMessenger implements IMessenger {
  private bot?: GrammyBot;
  private textListeners: Array<(m: IncomingTextMessage) => void> = [];
  private imageListeners: Array<(m: IncomingImageMessage) => void> = [];
  private imageGroupListeners: Array<(m: IncomingImageGroup) => void> = [];
  private buffer?: ImageGroupBuffer<PendingPhoto>;

  constructor(private readonly cfg: TelegramMessengerConfig) {}
```

替换 `start()` 中的 `bot.on("message:photo", ...)` 整段为：

```typescript
    // M2: 用 ImageGroupBuffer 把同 media_group_id 的多张图聚合成一次 emit
    this.buffer = new ImageGroupBuffer<PendingPhoto>(
      this.cfg.mediaGroupDebounceMs ?? 200,
      (items) => {
        if (items.length === 0) return;
        // 用首张的 chatId / userId 作为整组的"主"标识；caption 取首条非空
        const first = items[0]!;
        const caption = items.map((i) => i.caption).find((c) => !!c);
        const group: IncomingImageGroup = {
          chatId: first.chatId,
          userId: first.userId,
          username: first.username,
          images: items.map((i) => ({ data: i.data, mimeType: i.mimeType })),
          caption,
        };
        for (const l of this.imageGroupListeners) l(group);
      },
    );

    bot.on("message:photo", async (ctx) => {
      const userId = ctx.from?.id;
      if (userId === undefined) return;
      if (
        this.cfg.allowedUserIds &&
        !this.cfg.allowedUserIds.includes(userId)
      ) {
        return;
      }
      const chatId = String(ctx.chat.id);
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      if (!largest) return;
      try {
        const file = await ctx.api.getFile(largest.file_id);
        const url = `https://api.telegram.org/file/bot${this.cfg.botToken}/${file.file_path}`;
        const res = await fetch(url);
        const buf = Buffer.from(await res.arrayBuffer());
        const data = buf.toString("base64");
        const mimeType = "image/jpeg";
        const caption = ctx.message.caption ?? undefined;
        const item: PendingPhoto = {
          data,
          mimeType,
          caption,
          chatId,
          userId,
          username: ctx.from?.username,
        };
        // media_group_id 由 grammy 暴露在 ctx.message
        const groupId = ctx.message.media_group_id ?? undefined;
        this.buffer?.push(groupId, item);
      } catch (e) {
        logger.error({ err: (e as Error).message }, "下载图片失败");
      }
    });
```

替换 `on()` 方法（覆盖旧三行）：

```typescript
  on(event: "text", h: (m: IncomingTextMessage) => void): void;
  on(event: "image", h: (m: IncomingImageMessage) => void): void;
  on(event: "imageGroup", h: (m: IncomingImageGroup) => void): void;
  on(event: "text" | "image" | "imageGroup", h: (m: never) => void): void {
    if (event === "text") {
      this.textListeners.push(h as (m: IncomingTextMessage) => void);
    } else if (event === "image") {
      this.imageListeners.push(h as (m: IncomingImageMessage) => void);
    } else {
      this.imageGroupListeners.push(h as (m: IncomingImageGroup) => void);
    }
  }
```

修改 `stop()` 在停 bot 之后 dispose buffer：

```typescript
  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = undefined;
    }
    this.buffer?.dispose();
    this.buffer = undefined;
  }
```

- [ ] **Step 6：跑全部 M1 既有测试 + typecheck + lint，确认 0 回归**

```bash
npm test -- --run && npm run typecheck && npm run lint
```

预期：87 + 4 = 91 测试全绿。

- [ ] **Step 7：commit**

```bash
git add src/core/messenger/ src/adapters/telegram/TelegramMessenger.ts tests/helpers/StubMessenger.ts
git commit -m "feat(messenger): 新增 imageGroup 事件 + TelegramMessenger 接通 buffer（M2-A）"
```

---

## Task 4：AgentOrchestrator.runPromptWithImages

**Files:**

- Modify: `src/core/orchestrator/AgentOrchestrator.ts`
- Modify: `src/core/orchestrator/runtime.ts`
- Modify: `tests/helpers/StubAgent.ts`
- Create: `tests/integration/orchestrator.imageGroup.test.ts`

> **设计要点：** runtime 接口的 `send()` 增一个 `images?` 参数；StubAgent 记录 send 时收到的 images 字段；orchestrator 新增 `runPromptWithImages()` 方法（与 `runPrompt` 共享 ensureAgent / busyPolicy / streamRenderer 路径，差异仅在传给 `agent.send` 的额外 images 字段）。

- [ ] **Step 1：扩展 runtime 接口**

修改 `src/core/orchestrator/runtime.ts` 中 `RuntimeAgent.send` 签名：

```typescript
export interface RuntimeAgent {
  agentId: string;
  send(
    text: string,
    opts?: {
      force?: boolean;
      images?: Array<{ data: string; mimeType: string }>;
    },
  ): Promise<RuntimeRun>;
  dispose(): Promise<void>;
}
```

同步修改 `src/core/orchestrator/cursorSdkRuntime.ts` 中 `SdkAgentWrapper.send`，让它把 images 透传给 SDK：

```typescript
  async send(
    text: string,
    opts?: {
      force?: boolean;
      images?: Array<{ data: string; mimeType: string }>;
    },
  ): Promise<RuntimeRun> {
    const run = await this.inner.send(text, {
      images: opts?.images,
      local: opts?.force ? { force: true } : undefined,
    });
    return new SdkRunWrapper(run);
  }
```

- [ ] **Step 2：扩展 StubAgent 记录 images**

修改 `tests/helpers/StubAgent.ts` 中 StubAgent 类的 `send`：

```typescript
  // 测试侧记录最近一次 send 的入参，便于断言
  public lastSend?: {
    text: string;
    force?: boolean;
    images?: Array<{ data: string; mimeType: string }>;
  };

  async send(
    text: string,
    opts?: {
      force?: boolean;
      images?: Array<{ data: string; mimeType: string }>;
    },
  ): Promise<RuntimeRun> {
    this.lastSend = { text, force: opts?.force, images: opts?.images };
    const run = new StubRun();
    this.runs.push(run);
    return run;
  }
```

- [ ] **Step 3：写集成测试**

创建 `tests/integration/orchestrator.imageGroup.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentOrchestrator } from "../../src/core/orchestrator/AgentOrchestrator.js";
import { WorkspaceRegistry } from "../../src/core/workspace/WorkspaceRegistry.js";
import { SessionStore } from "../../src/core/session/SessionStore.js";
import { StubMessenger } from "../helpers/StubMessenger.js";
import { StubRuntime } from "../helpers/StubAgent.js";

describe("AgentOrchestrator.runPromptWithImages", () => {
  let dataDir: string;
  let messenger: StubMessenger;
  let registry: WorkspaceRegistry;
  let session: SessionStore;
  let runtime: StubRuntime;
  let orch: AgentOrchestrator;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ig-orch-"));
    messenger = new StubMessenger();
    registry = new WorkspaceRegistry(join(dataDir, "ws.json"));
    await registry.init({ autoRegisterCwd: true, cwd: dataDir });
    session = new SessionStore(join(dataDir, "sess.json"));
    await session.init();
    runtime = new StubRuntime();
    orch = new AgentOrchestrator({
      messenger,
      runtime,
      registry,
      session,
      streamOptions: { throttleMs: 1, maxLen: 1000 },
      defaultModel: { id: "default", params: [] },
    });
  });
  afterEach(async () => {
    await orch.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("把 images 透传给 agent.send（单图）", async () => {
    runtime.nextAgent.script.push({ type: "assistant", text: "看到了" });
    runtime.nextAgent.script.push({ type: "__finish__", status: "finished" });
    await orch.runPromptWithImages({
      chatId: "1",
      text: "这是什么？",
      images: [{ data: "AAA=", mimeType: "image/jpeg" }],
      force: false,
    });
    const a = runtime.lastAgent!;
    expect(a.lastSend?.text).toBe("这是什么？");
    expect(a.lastSend?.images).toEqual([
      { data: "AAA=", mimeType: "image/jpeg" },
    ]);
  });

  it("多张图透传 + 默认 force=false", async () => {
    runtime.nextAgent.script.push({ type: "assistant", text: "x" });
    runtime.nextAgent.script.push({ type: "__finish__", status: "finished" });
    await orch.runPromptWithImages({
      chatId: "1",
      text: "看",
      images: [
        { data: "A", mimeType: "image/png" },
        { data: "B", mimeType: "image/png" },
        { data: "C", mimeType: "image/png" },
      ],
      force: false,
    });
    expect(runtime.lastAgent!.lastSend?.images?.length).toBe(3);
    expect(runtime.lastAgent!.lastSend?.force).toBe(false);
  });

  it("无活跃 workspace 时回提示且不调 send", async () => {
    const empty = new WorkspaceRegistry(join(dataDir, "empty.json"));
    await empty.init({ autoRegisterCwd: false, cwd: dataDir });
    const orch2 = new AgentOrchestrator({
      messenger,
      runtime,
      registry: empty,
      session,
      streamOptions: { throttleMs: 1, maxLen: 1000 },
      defaultModel: { id: "default", params: [] },
    });
    await orch2.runPromptWithImages({
      chatId: "1",
      text: "看",
      images: [{ data: "A", mimeType: "image/jpeg" }],
      force: false,
    });
    expect(runtime.lastAgent).toBeUndefined();
    expect(messenger.sentTexts.some((m) => m.text.includes("没有活跃"))).toBe(
      true,
    );
    await orch2.dispose();
  });
});
```

- [ ] **Step 4：跑测试，确认失败**

```bash
npm test -- --run tests/integration/orchestrator.imageGroup.test.ts
```

预期：fail，因为 `orch.runPromptWithImages` 还不存在。

- [ ] **Step 5：在 AgentOrchestrator 添加方法**

修改 `src/core/orchestrator/AgentOrchestrator.ts`，把 `runPrompt` 重构为内部公共实现 + 两个 thin wrapper：

在类内（紧邻现有 `runPrompt` 上方）插入私有方法：

```typescript
  // 共享路径：text-only / images 两种入口的实际工作流
  private async runInternal(input: {
    chatId: string;
    text: string;
    force: boolean;
    images?: Array<{ data: string; mimeType: string }>;
  }): Promise<void> {
    const ws = this.deps.registry.getActive();
    if (!ws) {
      await this.deps.messenger.sendText(
        input.chatId,
        "没有活跃的工作区，请先 /ws add 一个。",
      );
      return;
    }
    const wsId = ws.name;

    const entry = await this.ensureAgent(wsId, ws.path);
    const action = decideBusyAction({
      activeRunStatus: entry.activeRun?.status as RunStatus | undefined,
      force: input.force,
    });

    if (action === "reject") {
      await this.deps.messenger.sendText(
        input.chatId,
        `Agent 正在工作区 <b>${ws.name}</b> 上工作中；请 /cancel 后重试，或在消息前加 ! 强制打断。`,
        { parseMode: "HTML" },
      );
      return;
    }

    const renderer = new StreamRenderer(
      this.deps.messenger,
      input.chatId,
      this.deps.streamOptions,
    );
    await renderer.start("⏳ thinking...");

    let run: RuntimeRun;
    try {
      run = await entry.agent.send(input.text, {
        force: action === "force-replace",
        images: input.images,
      });
    } catch (e) {
      const msg = (e as Error).message;
      logger.error({ err: msg }, "agent.send failed");
      await renderer.finalize(`\n⚠️ Error: ${escapeHtml(msg.slice(0, 400))}`);
      return;
    }
    entry.activeRun = run;

    try {
      for await (const event of run.stream()) {
        switch (event.type) {
          case "assistant":
            await renderer.pushText(markdownToHtml(event.text));
            break;
          case "thinking":
            renderer.setStatus("🤔 thinking...");
            break;
          case "tool_call":
            if (event.status === "running") {
              renderer.setStatus(`🔧 ${summarizeTool(event.name, event.args)}`);
            } else if (event.status === "completed") {
              renderer.setStatus("🤔 thinking...");
            } else {
              renderer.setStatus(`⚠️ ${event.name} failed`);
            }
            break;
        }
      }
      const r = await run.wait();
      if (r.status === "cancelled") {
        await renderer.finalize("\n<i>(已取消)</i>");
      } else if (r.status === "error") {
        logger.error(
          { err: r.result, durationMs: r.durationMs },
          "run finished with error",
        );
        const tail = r.result
          ? `\n⚠️ Error: ${escapeHtml(r.result.slice(0, 400))}`
          : "\n⚠️ Error";
        await renderer.finalize(tail);
      } else {
        await renderer.finalize();
      }
    } finally {
      if (entry.activeRun === run) entry.activeRun = undefined;
    }
  }
```

把现有 `runPrompt` 替换为简单 wrapper：

```typescript
  async runPrompt(input: {
    chatId: string;
    text: string;
    force: boolean;
  }): Promise<void> {
    return this.runInternal(input);
  }

  async runPromptWithImages(input: {
    chatId: string;
    text: string;
    force: boolean;
    images: Array<{ data: string; mimeType: string }>;
  }): Promise<void> {
    return this.runInternal(input);
  }
```

- [ ] **Step 6：跑测试 + typecheck，确认 M1 + M2 全绿**

```bash
npm test -- --run && npm run typecheck
```

预期：91 + 3 = 94 测试全绿。

- [ ] **Step 7：commit**

```bash
git add src/core/orchestrator/AgentOrchestrator.ts src/core/orchestrator/runtime.ts src/core/orchestrator/cursorSdkRuntime.ts tests/helpers/StubAgent.ts tests/integration/orchestrator.imageGroup.test.ts
git commit -m "feat(orchestrator): runPromptWithImages 把图片透传给 SDK（M2-A）"
```

---

## Task 5：bin/cursor-claw 接通 imageGroup 事件

**Files:**

- Modify: `src/bin/cursor-claw.ts`

> **设计要点：** 把 M1 中"image 事件回 'M1 暂不处理'"换成真正的 imageGroup 路径；M1 的 image 事件保留监听但不再做事（被 buffer 替代）；同时把 `mediaGroupDebounceMs` 与 images 默认 prompt 从 config 读出注入。

- [ ] **Step 1：改主入口**

修改 `src/bin/cursor-claw.ts` 中：

替换 `messenger = new TelegramMessenger(...)` 一段，加入 mediaGroupDebounceMs：

```typescript
  const messenger = new TelegramMessenger({
    botToken: cfg.telegram.botToken,
    parseMode: cfg.telegram.parseMode,
    allowedUserIds: cfg.telegram.allowedUserIds,
    mediaGroupDebounceMs: cfg.images.mediaGroupDebounceMs,
  });
```

替换原 `messenger.on("image", ...)` 整段为：

```typescript
  // M1 的旧 image 事件保留 listener 但不做事；真正的接通走 imageGroup
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
```

在 `handleText` 上方添加 `handleImageGroup` 函数：

```typescript
  async function handleImageGroup(
    chatId: string,
    images: Array<{ data: string; mimeType: string }>,
    caption?: string,
  ): Promise<void> {
    try {
      // 截到上限，超过部分丢弃并提示
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
      // 与文本路径一致：以 ! 开头解为 force=true
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
```

- [ ] **Step 2：跑全部测试 + typecheck + lint，确认无回归**

```bash
npm test -- --run && npm run typecheck && npm run lint
```

预期：94 测试全绿。

- [ ] **Step 3：commit**

```bash
git add src/bin/cursor-claw.ts
git commit -m "feat(bin): 接通 imageGroup → orchestrator.runPromptWithImages（M2-A）"
```

---

## Task 6：AttachmentQueue（队列读 / 写 / 删）

**Files:**

- Create: `src/core/attachments/AttachmentQueue.ts`
- Create: `tests/unit/attachmentQueue.test.ts`

> **设计要点：** queue.jsonl 是 append-only 的行式 JSON；读时整文件 read + parse 每行；删除某条时 read-modify-write 整文件（M2 规模下足够）。文件级原子更新走 tmp + rename。CLI 进程并发 append 通过 fs `O_APPEND` 由内核保证不互相截断（但仍然假定每条目 ≤ POSIX PIPE_BUF 4096 字节，超长 caption 会被截断）。

- [ ] **Step 1：写测试**

创建 `tests/unit/attachmentQueue.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentQueue } from "../../src/core/attachments/AttachmentQueue.js";

describe("AttachmentQueue", () => {
  let dir: string;
  let queuePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aq-"));
    queuePath = join(dir, "queue.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("readAll：文件不存在视为空", async () => {
    const q = new AttachmentQueue(queuePath);
    expect(await q.readAll()).toEqual([]);
  });

  it("append + readAll：返回顺序", async () => {
    const q = new AttachmentQueue(queuePath);
    await q.append({
      cwd: "/a",
      kind: "image",
      path: "/p1",
      queuedAt: 1,
    });
    await q.append({
      cwd: "/b",
      kind: "file",
      path: "/p2",
      caption: "x",
      queuedAt: 2,
    });
    const items = await q.readAll();
    expect(items).toEqual([
      { cwd: "/a", kind: "image", path: "/p1", queuedAt: 1 },
      { cwd: "/b", kind: "file", path: "/p2", caption: "x", queuedAt: 2 },
    ]);
  });

  it("filterByCwd：只返该 cwd 的条目", async () => {
    const q = new AttachmentQueue(queuePath);
    await q.append({ cwd: "/a", kind: "image", path: "/1", queuedAt: 1 });
    await q.append({ cwd: "/b", kind: "image", path: "/2", queuedAt: 2 });
    await q.append({ cwd: "/a", kind: "file", path: "/3", queuedAt: 3 });
    expect(await q.filterByCwd("/a")).toEqual([
      { cwd: "/a", kind: "image", path: "/1", queuedAt: 1 },
      { cwd: "/a", kind: "file", path: "/3", queuedAt: 3 },
    ]);
  });

  it("rewrite：保留指定条目，atomic 替换", async () => {
    const q = new AttachmentQueue(queuePath);
    await q.append({ cwd: "/a", kind: "image", path: "/1", queuedAt: 1 });
    await q.append({ cwd: "/a", kind: "image", path: "/2", queuedAt: 2 });
    await q.rewrite([
      { cwd: "/a", kind: "image", path: "/2", queuedAt: 2 },
    ]);
    expect(await q.readAll()).toEqual([
      { cwd: "/a", kind: "image", path: "/2", queuedAt: 2 },
    ]);
  });

  it("空行 / 损坏行被跳过且不抛错", async () => {
    await writeFile(
      queuePath,
      [
        '{"cwd":"/a","kind":"image","path":"/p1","queuedAt":1}',
        "",
        "not-json",
        '{"cwd":"/a","kind":"file","path":"/p2","queuedAt":2}',
      ].join("\n"),
    );
    const q = new AttachmentQueue(queuePath);
    const items = await q.readAll();
    expect(items.length).toBe(2);
    expect(items[0]!.path).toBe("/p1");
    expect(items[1]!.path).toBe("/p2");
  });
});
```

- [ ] **Step 2：跑测试，确认失败**

```bash
npm test -- --run tests/unit/attachmentQueue.test.ts
```

预期：模块不存在 import error。

- [ ] **Step 3：实现**

创建 `src/core/attachments/AttachmentQueue.ts`：

```typescript
import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../../logger.js";

export interface AttachmentEntry {
  cwd: string;
  kind: "image" | "file";
  path: string;
  caption?: string;
  queuedAt: number;
}

/**
 * 队列文件 (jsonl)：
 * - append：CLI 子进程并发追加；用 fs.appendFile，内核 O_APPEND 保证整行不互相截断
 * - readAll：整文件 readFile + line split + JSON.parse；坏行跳过
 * - rewrite：tmp + rename atomic 替换全文件，用于 dispatcher flush 后刷新剩余条目
 */
export class AttachmentQueue {
  constructor(private readonly filePath: string) {}

  async append(entry: AttachmentEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf8");
  }

  async readAll(): Promise<AttachmentEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: AttachmentEntry[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as AttachmentEntry);
      } catch {
        logger.warn({ line: t.slice(0, 200) }, "queue 损坏行已跳过");
      }
    }
    return out;
  }

  async filterByCwd(cwd: string): Promise<AttachmentEntry[]> {
    const all = await this.readAll();
    return all.filter((e) => e.cwd === cwd);
  }

  async rewrite(items: AttachmentEntry[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const content =
      items.length === 0 ? "" : items.map((i) => JSON.stringify(i)).join("\n") + "\n";
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, this.filePath);
  }
}
```

- [ ] **Step 4：跑测试 + typecheck，确认 5 测试 pass**

```bash
npm test -- --run tests/unit/attachmentQueue.test.ts && npm run typecheck
```

- [ ] **Step 5：commit**

```bash
git add src/core/attachments/AttachmentQueue.ts tests/unit/attachmentQueue.test.ts
git commit -m "feat(attachments): AttachmentQueue jsonl 队列读写（M2-B）"
```

---

## Task 7：attach-image / attach-file CLI 工具 + bin 注册

**Files:**

- Create: `src/tools/attachShared.ts`（CLI 共享 utils）
- Create: `src/tools/attach-image.ts`
- Create: `src/tools/attach-file.ts`
- Create: `tests/unit/attachCli.test.ts`
- Modify: `package.json`（bin 注册）
- Modify: `tsup.config.ts`（增加两个新入口）

> **设计要点：** 两个 CLI 共享一个 `attachShared.runAttach(kind, argv)` 内核；只 import 两个标准库 + 自家的 attachShared，没有 logger / config / zod 依赖（保持冷启动 < 50ms）。它们必须能在 cursor-claw 主进程没运行时也能跑——只写文件，不读 IPC。

- [ ] **Step 1：写测试**

创建 `tests/unit/attachCli.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const exec = promisify(execFile);

// 直接用 npx tsx 跑源文件，避免每个 unit test 都需要先 build
const TSX = "npx";
const ARGS = (entry: string, ...rest: string[]) => [
  "tsx",
  resolve("src/tools", entry),
  ...rest,
];

describe("attach CLI（spawn）", () => {
  let dir: string;
  let dataDir: string;
  let workDir: string;
  let imgPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "att-"));
    dataDir = join(dir, "data");
    workDir = join(dir, "work");
    await mkdir(dataDir);
    await mkdir(workDir);
    imgPath = join(workDir, "x.png");
    await writeFile(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function runWithEnv(entry: string, ...rest: string[]) {
    return exec(TSX, ARGS(entry, ...rest), {
      cwd: workDir,
      env: { ...process.env, CLAW_DATA_DIR: dataDir },
    });
  }

  it("attach-image 写入 pending + queue 一行", async () => {
    await runWithEnv("attach-image.ts", imgPath, "--caption", "hi");
    const queueRaw = await readFile(join(dataDir, "attachments", "queue.jsonl"), "utf8");
    const lines = queueRaw.trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.kind).toBe("image");
    expect(entry.cwd).toBe(workDir);
    expect(entry.caption).toBe("hi");
    // pending 文件存在
    await stat(entry.path);
  });

  it("attach-file 接受任意扩展", async () => {
    const pdf = join(workDir, "y.pdf");
    await writeFile(pdf, "%PDF-1.4");
    await runWithEnv("attach-file.ts", pdf);
    const queueRaw = await readFile(join(dataDir, "attachments", "queue.jsonl"), "utf8");
    const entry = JSON.parse(queueRaw.trim());
    expect(entry.kind).toBe("file");
  });

  it("源文件不存在 → exit 1", async () => {
    await expect(
      runWithEnv("attach-image.ts", "/nonexistent.png"),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("没 CLAW_DATA_DIR 也没 .claw → exit 1", async () => {
    await expect(
      exec(TSX, ARGS("attach-image.ts", imgPath), { cwd: workDir }),
    ).rejects.toMatchObject({ code: 1 });
  });
}, { timeout: 30000 });
```

- [ ] **Step 2：跑测试，确认失败**

```bash
npm test -- --run tests/unit/attachCli.test.ts
```

预期：模块不存在 import / spawn fail。

- [ ] **Step 3：实现共享 utils**

创建 `src/tools/attachShared.ts`：

```typescript
// CLI 公共逻辑：解析 argv → 复制文件到 pending → append 到 queue.jsonl。
// 故意不依赖 logger / config / zod，保持冷启动快。
import { mkdir, copyFile, stat, readFile, appendFile } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";

export type AttachKind = "image" | "file";

interface ParsedArgs {
  filePath: string;
  caption?: string;
  dataDirOverride?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new Error("usage: <file> [--caption <text>] [--data-dir <path>]");
  }
  let filePath: string | undefined;
  let caption: string | undefined;
  let dataDirOverride: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--caption") {
      caption = argv[++i];
    } else if (a === "--data-dir") {
      dataDirOverride = argv[++i];
    } else if (!filePath) {
      filePath = a;
    } else {
      throw new Error(`unexpected arg: ${a}`);
    }
  }
  if (!filePath) throw new Error("file path required");
  return { filePath: resolve(filePath), caption, dataDirOverride };
}

// 找数据目录的策略（顺序）：
// 1. --data-dir
// 2. CLAW_DATA_DIR env
// 3. 从 cwd 向上找 .claw/data-dir.txt
async function locateDataDir(override?: string): Promise<string> {
  if (override) return resolve(override);
  if (process.env.CLAW_DATA_DIR) return resolve(process.env.CLAW_DATA_DIR);
  let cur = process.cwd();
  for (let i = 0; i < 32; i++) {
    const marker = join(cur, ".claw", "data-dir.txt");
    try {
      const txt = (await readFile(marker, "utf8")).trim();
      if (txt) return resolve(txt);
    } catch {
      /* keep searching */
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error(
    "could not locate cursor-claw data dir; set CLAW_DATA_DIR or run cursor-claw once in this workspace",
  );
}

export async function runAttach(kind: AttachKind, argv: string[]): Promise<void> {
  const { filePath, caption, dataDirOverride } = parseArgs(argv);
  const dataDir = await locateDataDir(dataDirOverride);
  const st = await stat(filePath); // 不存在直接抛
  if (!st.isFile()) throw new Error(`not a file: ${filePath}`);

  const pendingDir = join(dataDir, "attachments", "pending");
  await mkdir(pendingDir, { recursive: true });
  const isoTs = new Date().toISOString().replace(/[:.]/g, "-");
  const destPath = join(pendingDir, `${isoTs}-${basename(filePath)}`);
  await copyFile(filePath, destPath);

  const entry = {
    cwd: process.cwd(),
    kind,
    path: destPath,
    caption,
    queuedAt: Date.now(),
  };
  const queuePath = join(dataDir, "attachments", "queue.jsonl");
  await appendFile(queuePath, JSON.stringify(entry) + "\n", "utf8");

  process.stdout.write(`queued: ${destPath}\n`);
}
```

- [ ] **Step 4：实现两个 bin 入口**

创建 `src/tools/attach-image.ts`：

```typescript
#!/usr/bin/env node
import { runAttach } from "./attachShared.js";

runAttach("image", process.argv.slice(2)).catch((e) => {
  process.stderr.write(`claw-attach-image: ${(e as Error).message}\n`);
  process.exit(1);
});
```

创建 `src/tools/attach-file.ts`：

```typescript
#!/usr/bin/env node
import { runAttach } from "./attachShared.js";

runAttach("file", process.argv.slice(2)).catch((e) => {
  process.stderr.write(`claw-attach-file: ${(e as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 5：注册 bin + tsup 入口**

修改 `package.json`：在 `"bin"` 字段（如不存在则新增）：

```json
"bin": {
  "cursor-claw": "./dist/bin/cursor-claw.js",
  "claw-attach-image": "./dist/tools/attach-image.js",
  "claw-attach-file": "./dist/tools/attach-file.js"
}
```

修改 `tsup.config.ts`，把 entry 数组扩展：

```typescript
import { defineConfig } from "tsup";
export default defineConfig({
  entry: [
    "src/bin/cursor-claw.ts",
    "src/tools/attach-image.ts",
    "src/tools/attach-file.ts",
  ],
  format: ["esm"],
  target: "node20",
  splitting: false,
  sourcemap: true,
  clean: true,
});
```

- [ ] **Step 6：跑测试 + typecheck + lint + build**

```bash
npm test -- --run tests/unit/attachCli.test.ts && npm run typecheck && npm run lint && npm run build
```

预期：4 个 spawn 测试 pass + build 输出三个 dist/ 文件。

- [ ] **Step 7：commit**

```bash
git add src/tools/ tests/unit/attachCli.test.ts package.json tsup.config.ts
git commit -m "feat(tools): claw-attach-image / claw-attach-file CLI（M2-B）"
```

---

## Task 8：AttachmentDispatcher（flush + 重试）

**Files:**

- Create: `src/core/attachments/AttachmentDispatcher.ts`
- Create: `tests/integration/attachmentDispatcher.test.ts`

> **设计要点：** flushForCwd 接受 cwd + chatId，从 queue 中找 entry.cwd === cwd 的条目；按 queuedAt 升序循环 sendImage / sendDocument；成功删 pending 文件 + 从 queue rewrite 时排除；失败 attempt++（内存计数），attempt > maxRetries 时给用户 sendText 告知失败并丢弃 entry。

- [ ] **Step 1：写测试**

创建 `tests/integration/attachmentDispatcher.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentQueue } from "../../src/core/attachments/AttachmentQueue.js";
import { AttachmentDispatcher } from "../../src/core/attachments/AttachmentDispatcher.js";
import { StubMessenger } from "../helpers/StubMessenger.js";

describe("AttachmentDispatcher", () => {
  let dir: string;
  let queuePath: string;
  let pendingDir: string;
  let messenger: StubMessenger;
  let queue: AttachmentQueue;

  async function preparePending(name: string, content: Buffer): Promise<string> {
    const p = join(pendingDir, name);
    await writeFile(p, content);
    return p;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ad-"));
    queuePath = join(dir, "queue.jsonl");
    pendingDir = join(dir, "pending");
    await mkdir(pendingDir);
    messenger = new StubMessenger();
    queue = new AttachmentQueue(queuePath);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("正常 flush：调 sendImage / sendDocument 各一次，删 pending + 删 queue", async () => {
    const p1 = await preparePending("a.png", Buffer.from([1, 2, 3]));
    const p2 = await preparePending("b.pdf", Buffer.from([4, 5]));
    await queue.append({ cwd: "/w", kind: "image", path: p1, caption: "c1", queuedAt: 1 });
    await queue.append({ cwd: "/w", kind: "file", path: p2, queuedAt: 2 });
    const d = new AttachmentDispatcher({
      queue,
      messenger,
      maxRetries: 3,
      maxPerFlush: 10,
    });
    await d.flushForCwd("/w", "chat-1");
    expect(messenger.sentImages.length).toBe(1);
    expect(messenger.sentImages[0]!.caption).toBe("c1");
    expect(messenger.sentDocuments.length).toBe(1);
    expect((await queue.readAll()).length).toBe(0);
    await expect(stat(p1)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(p2)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("不同 cwd 不动其他人的", async () => {
    const p1 = await preparePending("a.png", Buffer.from([1]));
    await queue.append({ cwd: "/w1", kind: "image", path: p1, queuedAt: 1 });
    await queue.append({
      cwd: "/w2",
      kind: "image",
      path: "/never",
      queuedAt: 2,
    });
    const d = new AttachmentDispatcher({
      queue,
      messenger,
      maxRetries: 3,
      maxPerFlush: 10,
    });
    await d.flushForCwd("/w1", "chat-1");
    expect(messenger.sentImages.length).toBe(1);
    const remain = await queue.readAll();
    expect(remain.length).toBe(1);
    expect(remain[0]!.cwd).toBe("/w2");
  });

  it("发送失败保留 entry，重试 maxRetries+1 次后告知用户并丢弃", async () => {
    const p1 = await preparePending("a.png", Buffer.from([1]));
    await queue.append({ cwd: "/w", kind: "image", path: p1, queuedAt: 1 });
    messenger.sendImageImpl = async () => {
      throw new Error("boom");
    };
    const d = new AttachmentDispatcher({
      queue,
      messenger,
      maxRetries: 2,
      maxPerFlush: 10,
    });
    // 第 1 次：失败，保留
    await d.flushForCwd("/w", "chat-1");
    expect((await queue.readAll()).length).toBe(1);
    // 第 2 次：失败，保留
    await d.flushForCwd("/w", "chat-1");
    expect((await queue.readAll()).length).toBe(1);
    // 第 3 次：失败，超过 maxRetries=2，告诉用户 + 丢弃
    await d.flushForCwd("/w", "chat-1");
    expect(
      messenger.sentTexts.some((t) => t.text.includes("附件投递失败")),
    ).toBe(true);
    expect((await queue.readAll()).length).toBe(0);
  });

  it("pending 文件已被删 → 跳过 + 删 entry", async () => {
    await queue.append({
      cwd: "/w",
      kind: "image",
      path: "/never",
      queuedAt: 1,
    });
    const d = new AttachmentDispatcher({
      queue,
      messenger,
      maxRetries: 3,
      maxPerFlush: 10,
    });
    await d.flushForCwd("/w", "chat-1");
    expect(messenger.sentImages.length).toBe(0);
    expect((await queue.readAll()).length).toBe(0);
  });
});
```

> **附**：StubMessenger 需要新增 `sentImages` / `sentDocuments` 数组和可注入的 `sendImageImpl` / `sendDocumentImpl` hook。如果 M1 的 StubMessenger 还没记录这些，在本任务也加上：

修改 `tests/helpers/StubMessenger.ts`，加成员：

```typescript
  sentImages: Array<{ chatId: string; image: ImagePayload; caption?: string }> = [];
  sentDocuments: Array<{ chatId: string; file: FilePayload; caption?: string }> = [];
  sendImageImpl?: (chatId: string, image: ImagePayload, caption?: string) => Promise<void>;
  sendDocumentImpl?: (chatId: string, file: FilePayload, caption?: string) => Promise<void>;
```

并替换 `sendImage` / `sendDocument`：

```typescript
  async sendImage(chatId: string, image: ImagePayload, caption?: string): Promise<MessageHandle> {
    if (this.sendImageImpl) await this.sendImageImpl(chatId, image, caption);
    this.sentImages.push({ chatId, image, caption });
    return { messageId: `img-${this.sentImages.length}` };
  }
  async sendDocument(chatId: string, file: FilePayload, caption?: string): Promise<MessageHandle> {
    if (this.sendDocumentImpl) await this.sendDocumentImpl(chatId, file, caption);
    this.sentDocuments.push({ chatId, file, caption });
    return { messageId: `doc-${this.sentDocuments.length}` };
  }
```

- [ ] **Step 2：跑测试，确认失败**

```bash
npm test -- --run tests/integration/attachmentDispatcher.test.ts
```

预期：模块不存在 import error。

- [ ] **Step 3：实现 dispatcher**

创建 `src/core/attachments/AttachmentDispatcher.ts`：

```typescript
import { readFile, unlink } from "node:fs/promises";
import type { IMessenger } from "../messenger/IMessenger.js";
import { logger } from "../../logger.js";
import type { AttachmentQueue, AttachmentEntry } from "./AttachmentQueue.js";

export interface AttachmentDispatcherOptions {
  queue: AttachmentQueue;
  messenger: IMessenger;
  maxRetries: number;
  maxPerFlush: number;
}

/**
 * 在 run.wait() 之后调 flushForCwd 把 attach CLI 入队的文件发回给用户。
 *
 * 重试模型：
 * - 内存里维护 entry.path → attemptCount，进程重启重置（轻量、避免污染队列结构）
 * - 失败一次 attempt++，仍保留在 queue
 * - attempt > maxRetries（即第 maxRetries+1 次）→ sendText 告知用户后从 queue 丢弃
 */
export class AttachmentDispatcher {
  private readonly attempts = new Map<string, number>();

  constructor(private readonly opts: AttachmentDispatcherOptions) {}

  async flushForCwd(cwd: string, chatId: string): Promise<void> {
    const all = await this.opts.queue.readAll();
    const own = all.filter((e) => e.cwd === cwd);
    if (own.length === 0) return;

    if (own.length > this.opts.maxPerFlush) {
      logger.warn(
        { cwd, n: own.length, cap: this.opts.maxPerFlush },
        "queue 中条目超过 maxPerFlush",
      );
    }

    const sortedOwn = [...own].sort((a, b) => a.queuedAt - b.queuedAt);
    const survivors: AttachmentEntry[] = []; // 本 cwd 留下的
    const others = all.filter((e) => e.cwd !== cwd); // 其他 cwd 原样保留

    for (const e of sortedOwn) {
      const ok = await this.tryDeliver(e, chatId);
      if (ok === "delivered" || ok === "drop") {
        // 成功或放弃：删 pending 文件 + 不保留 entry
        try {
          await unlink(e.path);
        } catch {
          /* 已不存在 */
        }
        this.attempts.delete(e.path);
      } else {
        survivors.push(e);
      }
    }

    await this.opts.queue.rewrite([...others, ...survivors]);
  }

  // 单条投递：返回 'delivered' / 'retry' / 'drop'
  private async tryDeliver(
    e: AttachmentEntry,
    chatId: string,
  ): Promise<"delivered" | "retry" | "drop"> {
    // pending 文件不存在 → drop（agent 自己删了 / 上次成功后没清干净）
    let buf: Buffer;
    try {
      buf = await readFile(e.path);
    } catch {
      logger.warn({ path: e.path }, "pending 文件已不存在，丢弃 entry");
      return "drop";
    }

    try {
      if (e.kind === "image") {
        await this.opts.messenger.sendImage(
          chatId,
          { data: buf, mimeType: "image/jpeg", filename: pickName(e.path) },
          e.caption,
        );
      } else {
        await this.opts.messenger.sendDocument(
          chatId,
          { data: buf, filename: pickName(e.path) },
          e.caption,
        );
      }
      return "delivered";
    } catch (err) {
      const attempt = (this.attempts.get(e.path) ?? 0) + 1;
      this.attempts.set(e.path, attempt);
      logger.error(
        { err: (err as Error).message, attempt, path: e.path },
        "附件投递失败",
      );
      if (attempt > this.opts.maxRetries) {
        try {
          await this.opts.messenger.sendText(
            chatId,
            `⚠️ 附件投递失败 ${attempt} 次：${pickName(e.path)}（已丢弃）`,
          );
        } catch {
          /* ignore */
        }
        return "drop";
      }
      return "retry";
    }
  }
}

// 用 path 末尾 segment 作为 filename，但去掉前面的 isoTs 时间戳前缀
function pickName(p: string): string {
  const last = p.split("/").pop() ?? p;
  // pending 文件名是 `${isoTs}-${basename}`，找第一个非时间戳的 dash
  // 简单实现：找到 '-' 后还有非数字 char 的位置
  const dash = last.search(/-\D/);
  if (dash > 0) return last.slice(dash + 1);
  return last;
}
```

- [ ] **Step 4：跑测试 + typecheck + lint，确认 4 测试 pass**

```bash
npm test -- --run tests/integration/attachmentDispatcher.test.ts && npm run typecheck && npm run lint
```

- [ ] **Step 5：commit**

```bash
git add src/core/attachments/AttachmentDispatcher.ts tests/integration/attachmentDispatcher.test.ts tests/helpers/StubMessenger.ts
git commit -m "feat(attachments): AttachmentDispatcher flush + 重试 + 失败告知（M2-B）"
```

---

## Task 9：AgentOrchestrator runPrompt 接 dispatcher.flushForCwd

**Files:**

- Modify: `src/core/orchestrator/AgentOrchestrator.ts`
- Modify: `tests/integration/orchestrator.imageGroup.test.ts`（加一例覆盖 dispatcher 注入）

> **设计要点：** orchestrator 多收一个可选 `attachmentDispatcher` 依赖；在 `runInternal` 的 `run.wait()` 之后（无论结果是 finished / cancelled / error）都调一次 `flushForCwd(ws.path, chatId)`；如果没注入 dispatcher 则跳过。

- [ ] **Step 1：扩展 OrchestratorDeps**

修改 `src/core/orchestrator/AgentOrchestrator.ts`，顶部添加 import：

```typescript
import type { AttachmentDispatcher } from "../attachments/AttachmentDispatcher.js";
```

扩展 `OrchestratorDeps`：

```typescript
export interface OrchestratorDeps {
  messenger: IMessenger;
  runtime: IAgentRuntime;
  registry: WorkspaceRegistry;
  session: SessionStore;
  streamOptions: StreamRendererOptions;
  defaultModel: { id: string; params: Array<{ id: string; value: string }> };
  // M2: 注入后会在每次 runInternal 末尾发当前 cwd 的 attach 队列；不注入则跳过
  attachmentDispatcher?: AttachmentDispatcher;
}
```

- [ ] **Step 2：在 `runInternal` 的 `try { ... } finally { ... }` 块后追加 dispatcher.flush 调用**

替换 `runInternal` 末尾段（紧接着 finally 块）的代码为：

```typescript
    try {
      for await (const event of run.stream()) {
        switch (event.type) {
          case "assistant":
            await renderer.pushText(markdownToHtml(event.text));
            break;
          case "thinking":
            renderer.setStatus("🤔 thinking...");
            break;
          case "tool_call":
            if (event.status === "running") {
              renderer.setStatus(`🔧 ${summarizeTool(event.name, event.args)}`);
            } else if (event.status === "completed") {
              renderer.setStatus("🤔 thinking...");
            } else {
              renderer.setStatus(`⚠️ ${event.name} failed`);
            }
            break;
        }
      }
      const r = await run.wait();
      if (r.status === "cancelled") {
        await renderer.finalize("\n<i>(已取消)</i>");
      } else if (r.status === "error") {
        logger.error(
          { err: r.result, durationMs: r.durationMs },
          "run finished with error",
        );
        const tail = r.result
          ? `\n⚠️ Error: ${escapeHtml(r.result.slice(0, 400))}`
          : "\n⚠️ Error";
        await renderer.finalize(tail);
      } else {
        await renderer.finalize();
      }
    } finally {
      if (entry.activeRun === run) entry.activeRun = undefined;
    }

    // M2: run 结束（无论 finished / cancelled / error）都尝试把队列里属于当前
    // workspace 的附件发给同一 chatId；attach CLI 是在 run 期间被 agent 调的
    if (this.deps.attachmentDispatcher) {
      try {
        await this.deps.attachmentDispatcher.flushForCwd(ws.path, input.chatId);
      } catch (e) {
        logger.error({ err: (e as Error).message }, "dispatcher.flushForCwd 失败");
      }
    }
```

- [ ] **Step 3：在已有集成测试里加一个验证 dispatcher 被调的用例**

修改 `tests/integration/orchestrator.imageGroup.test.ts`，加 import：

```typescript
import { AttachmentQueue } from "../../src/core/attachments/AttachmentQueue.js";
import { AttachmentDispatcher } from "../../src/core/attachments/AttachmentDispatcher.js";
import { writeFile, mkdir as mkdirNode } from "node:fs/promises";
```

在 describe 块末尾追加：

```typescript
  it("run 结束后 dispatcher 把队列条目发出去", async () => {
    const queuePath = join(dataDir, "queue.jsonl");
    const pendingDir = join(dataDir, "pending");
    await mkdirNode(pendingDir, { recursive: true });
    const f = join(pendingDir, "x.png");
    await writeFile(f, Buffer.from([1]));
    const queue = new AttachmentQueue(queuePath);
    const ws = registry.getActive()!;
    await queue.append({ cwd: ws.path, kind: "image", path: f, queuedAt: 1 });
    const dispatcher = new AttachmentDispatcher({
      queue,
      messenger,
      maxRetries: 3,
      maxPerFlush: 10,
    });
    const orch2 = new AgentOrchestrator({
      messenger,
      runtime,
      registry,
      session,
      streamOptions: { throttleMs: 1, maxLen: 1000 },
      defaultModel: { id: "default", params: [] },
      attachmentDispatcher: dispatcher,
    });
    runtime.nextAgent.script.push({ type: "assistant", text: "ok" });
    runtime.nextAgent.script.push({ type: "__finish__", status: "finished" });
    await orch2.runPrompt({ chatId: "1", text: "hi", force: false });
    expect(messenger.sentImages.length).toBe(1);
    expect((await queue.readAll()).length).toBe(0);
    await orch2.dispose();
  });
```

- [ ] **Step 4：跑测试 + typecheck + lint，确认 0 回归 + 新用例 pass**

```bash
npm test -- --run && npm run typecheck && npm run lint
```

- [ ] **Step 5：commit**

```bash
git add src/core/orchestrator/AgentOrchestrator.ts tests/integration/orchestrator.imageGroup.test.ts
git commit -m "feat(orchestrator): run 结束后调 dispatcher.flushForCwd（M2-B）"
```

---

## Task 10：timeParser

**Files:**

- Create: `src/core/reminders/timeParser.ts`
- Create: `tests/unit/timeParser.test.ts`

> **设计要点：** 接受三种字符串：相对（`10m`/`1h30m`/`45s`/`2d`）、当日 HH:MM、绝对日期 `YYYY-MM-DD HH:MM` / `YYYY-MM-DDTHH:MM`。`tz` 默认从 `Intl.DateTimeFormat()` 拿系统时区，但允许显式覆盖（M2 单测里把 tz 锁定为 UTC 避开机器差异）。`maxAheadDays` 由调用者传入用于上限校验。返回 `{ at: number(UTC ms), error?: string }`。

- [ ] **Step 1：写测试**

创建 `tests/unit/timeParser.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { parseTimeExpr } from "../../src/core/reminders/timeParser.js";

const NOW = new Date("2026-05-05T16:00:00Z").getTime(); // UTC

describe("parseTimeExpr", () => {
  it("相对：10m", () => {
    const r = parseTimeExpr("10m", { now: NOW, tz: "UTC", maxAheadDays: 30 });
    expect(r.at).toBe(NOW + 10 * 60 * 1000);
  });
  it("相对：1h30m", () => {
    const r = parseTimeExpr("1h30m", {
      now: NOW,
      tz: "UTC",
      maxAheadDays: 30,
    });
    expect(r.at).toBe(NOW + (60 + 30) * 60 * 1000);
  });
  it("相对：45s", () => {
    const r = parseTimeExpr("45s", { now: NOW, tz: "UTC", maxAheadDays: 30 });
    expect(r.at).toBe(NOW + 45 * 1000);
  });
  it("相对：2d", () => {
    const r = parseTimeExpr("2d", { now: NOW, tz: "UTC", maxAheadDays: 30 });
    expect(r.at).toBe(NOW + 2 * 86400 * 1000);
  });
  it("当日 HH:MM 未过 → 当天", () => {
    const r = parseTimeExpr("18:30", {
      now: NOW,
      tz: "UTC",
      maxAheadDays: 30,
    });
    expect(r.at).toBe(new Date("2026-05-05T18:30:00Z").getTime());
  });
  it("当日 HH:MM 已过 → 次日", () => {
    const r = parseTimeExpr("09:00", {
      now: NOW,
      tz: "UTC",
      maxAheadDays: 30,
    });
    expect(r.at).toBe(new Date("2026-05-06T09:00:00Z").getTime());
  });
  it("绝对：2026-05-06 09:00", () => {
    const r = parseTimeExpr("2026-05-06 09:00", {
      now: NOW,
      tz: "UTC",
      maxAheadDays: 30,
    });
    expect(r.at).toBe(new Date("2026-05-06T09:00:00Z").getTime());
  });
  it("非法格式 → 错误", () => {
    const r = parseTimeExpr("hello", {
      now: NOW,
      tz: "UTC",
      maxAheadDays: 30,
    });
    expect(r.error).toBeDefined();
    expect(r.at).toBe(0);
  });
  it("超过 maxAheadDays → 错误", () => {
    const r = parseTimeExpr("2027-01-01 09:00", {
      now: NOW,
      tz: "UTC",
      maxAheadDays: 30,
    });
    expect(r.error).toMatch(/30/);
  });
});
```

- [ ] **Step 2：跑测试，确认失败**

```bash
npm test -- --run tests/unit/timeParser.test.ts
```

- [ ] **Step 3：实现**

创建 `src/core/reminders/timeParser.ts`：

```typescript
export interface ParseTimeOptions {
  now: number;
  tz: string;
  maxAheadDays: number;
}

export interface ParseTimeResult {
  at: number;
  error?: string;
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

  // 相对时长
  const m = RELATIVE_RE.exec(t);
  if (m && (m[1] || m[2] || m[3] || m[4])) {
    let ms = 0;
    if (m[1]) ms += parseInt(m[1]) * 86400_000;
    if (m[2]) ms += parseInt(m[2]) * 3600_000;
    if (m[3]) ms += parseInt(m[3]) * 60_000;
    if (m[4]) ms += parseInt(m[4]) * 1000;
    return finalize(opts.now + ms, opts);
  }

  // 当日 HH:MM
  const hm = HHMM_RE.exec(t);
  if (hm) {
    const hh = parseInt(hm[1]!);
    const mm = parseInt(hm[2]!);
    if (hh > 23 || mm > 59) return { at: 0, error: "invalid HH:MM" };
    const at = inTzAt(opts.now, opts.tz, hh, mm);
    const finalAt = at <= opts.now ? at + 86400_000 : at;
    return finalize(finalAt, opts);
  }

  // 绝对 YYYY-MM-DD HH:MM
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
  const get = (n: string) =>
    parseInt(parts.find((p) => p.type === n)!.value, 10);
  return makeTzDate(tz, get("year"), get("month") - 1, get("day"), hh, mm);
}

// 在指定 tz 把 (y, m, d, hh, mm) 翻成 UTC ms
// 实现：先把这些值当作 UTC 拼一个 utcGuess，然后查这个时刻在 tz 的小时偏移，
// 用偏移修正得到真正的 UTC 值。
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
  const get = (n: string) =>
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
```

- [ ] **Step 4：跑测试 + typecheck，确认 9 测试 pass**

```bash
npm test -- --run tests/unit/timeParser.test.ts && npm run typecheck
```

- [ ] **Step 5：commit**

```bash
git add src/core/reminders/timeParser.ts tests/unit/timeParser.test.ts
git commit -m "feat(reminders): timeParser 支持相对 / HH:MM / 绝对（M2-C）"
```

---

## Task 11：ReminderStore

**Files:**

- Create: `src/core/reminders/ReminderStore.ts`
- Create: `tests/unit/reminderStore.test.ts`

- [ ] **Step 1：写测试**

创建 `tests/unit/reminderStore.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReminderStore,
  type Reminder,
} from "../../src/core/reminders/ReminderStore.js";

describe("ReminderStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rs-"));
    path = join(dir, "reminders.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sample = (id: string, at: number): Reminder => ({
    id,
    createdAt: 100,
    createdBy: 1,
    chatId: "1",
    kind: "text",
    at,
    tz: "UTC",
    text: "x",
  });

  it("空文件 init → 空数组", async () => {
    const s = new ReminderStore(path);
    await s.init();
    expect(s.list()).toEqual([]);
  });

  it("add + persist 后再 read 回来", async () => {
    const s1 = new ReminderStore(path);
    await s1.init();
    await s1.add(sample("r-1", 1000));
    const s2 = new ReminderStore(path);
    await s2.init();
    expect(s2.list().map((r) => r.id)).toEqual(["r-1"]);
  });

  it("remove 删除指定 id", async () => {
    const s = new ReminderStore(path);
    await s.init();
    await s.add(sample("r-1", 1));
    await s.add(sample("r-2", 2));
    await s.remove("r-1");
    expect(s.list().map((r) => r.id)).toEqual(["r-2"]);
  });

  it("update 修改 at 字段", async () => {
    const s = new ReminderStore(path);
    await s.init();
    await s.add(sample("r-1", 1));
    await s.update("r-1", (r) => ({ ...r, at: 2 }));
    expect(s.list()[0]!.at).toBe(2);
  });
});
```

- [ ] **Step 2：跑测试，确认失败**

```bash
npm test -- --run tests/unit/reminderStore.test.ts
```

- [ ] **Step 3：实现**

创建 `src/core/reminders/ReminderStore.ts`：

```typescript
import { JsonStore } from "../persist/jsonStore.js";

export interface ReminderText {
  id: string;
  createdAt: number;
  createdBy: number;
  chatId: string;
  kind: "text";
  at: number;
  tz: string;
  text: string;
}

export interface ReminderPrompt {
  id: string;
  createdAt: number;
  createdBy: number;
  chatId: string;
  kind: "prompt";
  at: number;
  tz: string;
  prompt: string;
  workspaceId: string;
}

export type Reminder = ReminderText | ReminderPrompt;

interface RemindersFile {
  items: Reminder[];
}

export class ReminderStore {
  private readonly store: JsonStore<RemindersFile>;
  private state: RemindersFile = { items: [] };

  constructor(filePath: string) {
    this.store = new JsonStore<RemindersFile>(filePath, { items: [] });
  }

  async init(): Promise<void> {
    this.state = await this.store.readOrInit();
  }

  list(): Reminder[] {
    return [...this.state.items];
  }

  async add(item: Reminder): Promise<void> {
    this.state.items.push(item);
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    this.state.items = this.state.items.filter((r) => r.id !== id);
    await this.persist();
  }

  // 用回调原子地改某条；不存在则不变
  async update(id: string, fn: (r: Reminder) => Reminder): Promise<void> {
    let changed = false;
    this.state.items = this.state.items.map((r) => {
      if (r.id !== id) return r;
      changed = true;
      return fn(r);
    });
    if (changed) await this.persist();
  }

  private async persist(): Promise<void> {
    await this.store.write(this.state);
  }
}

// 生成 reminder id：r-{YYYYMMDD-HHMMSS}-{seq3}，进程内按 createdAt 顺序自增 seq
let seq = 0;
export function newReminderId(at: number, now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  seq = (seq + 1) % 1000;
  return `r-${stamp}-${String(seq).padStart(3, "0")}`;
}
```

- [ ] **Step 4：跑测试 + typecheck，确认 4 测试 pass**

```bash
npm test -- --run tests/unit/reminderStore.test.ts && npm run typecheck
```

- [ ] **Step 5：commit**

```bash
git add src/core/reminders/ReminderStore.ts tests/unit/reminderStore.test.ts
git commit -m "feat(reminders): ReminderStore 持久化（M2-C）"
```

---

## Task 12：AgentOrchestrator.runReminder

**Files:**

- Modify: `src/core/orchestrator/AgentOrchestrator.ts`
- Modify: `tests/integration/orchestrator.imageGroup.test.ts`（追加 reminder 用例）

> **设计要点：** `runReminder` 接受 `{ chatId, kind: 'text' | 'prompt', text?, prompt?, workspaceId? }`。kind=text 直接 `messenger.sendText`；kind=prompt 走 `runInternal`，但 `force` 永远为 false，且**返回值告知调用方是否被 busy 拒**——scheduler 用这个信号决定是否重排。

- [ ] **Step 1：在 AgentOrchestrator 加 runReminder**

修改 `src/core/orchestrator/AgentOrchestrator.ts`，把 `runInternal` 的 reject 路径变成"返回 boolean"以便 reminder 知道是不是被拒：

替换 `runInternal` 的 reject 段：

```typescript
    if (action === "reject") {
      await this.deps.messenger.sendText(
        input.chatId,
        `Agent 正在工作区 <b>${ws.name}</b> 上工作中；请 /cancel 后重试，或在消息前加 ! 强制打断。`,
        { parseMode: "HTML" },
      );
      return false;
    }
```

并把 `runInternal` 返回类型改 `Promise<boolean>`（true = 接受执行，false = 被 busy 拒）：

```typescript
  private async runInternal(input: {
    chatId: string;
    text: string;
    force: boolean;
    images?: Array<{ data: string; mimeType: string }>;
    skipBusyMsg?: boolean;
  }): Promise<boolean> {
    const ws = this.deps.registry.getActive();
    if (!ws) {
      await this.deps.messenger.sendText(
        input.chatId,
        "没有活跃的工作区，请先 /ws add 一个。",
      );
      return false;
    }
    // ... 后面同上 ...
    if (action === "reject") {
      if (!input.skipBusyMsg) {
        await this.deps.messenger.sendText(
          input.chatId,
          `Agent 正在工作区 <b>${ws.name}</b> 上工作中；请 /cancel 后重试，或在消息前加 ! 强制打断。`,
          { parseMode: "HTML" },
        );
      }
      return false;
    }
    // ... 后续 send / stream / wait / dispatcher.flush 全部不变 ...
    // 末尾返回 true：
    return true;
  }
```

> **重要**：现有的 `runPrompt` / `runPromptWithImages` 都是 `Promise<void>` 返回，不返回这个 boolean —— 让它们继续原样：

```typescript
  async runPrompt(input: {
    chatId: string;
    text: string;
    force: boolean;
  }): Promise<void> {
    await this.runInternal(input);
  }

  async runPromptWithImages(input: {
    chatId: string;
    text: string;
    force: boolean;
    images: Array<{ data: string; mimeType: string }>;
  }): Promise<void> {
    await this.runInternal(input);
  }
```

新增 `runReminder`：

```typescript
  /**
   * 触发一条 reminder：
   * - kind='text' → 直接 sendText，立即 fulfilled；不会 busy
   * - kind='prompt' → 走 runInternal；force 永远 false；返回 false 表示被 busy 拒，调用方决定是否重排
   *
   * 注：kind='prompt' 时如果给了 workspaceId 但与当前 active 不同，**不切换** active，
   * 而是临时让 ensureAgent 用 workspaceId 对应的路径——但本任务保持简单：直接走 active workspace。
   * 真正的 cross-workspace reminder 在 M3+ 再补。
   */
  async runReminder(input: {
    chatId: string;
    kind: "text" | "prompt";
    text?: string;
    prompt?: string;
    workspaceId?: string;
  }): Promise<{ delivered: boolean; busy?: boolean }> {
    if (input.kind === "text") {
      const text = input.text ?? "";
      await this.deps.messenger.sendText(input.chatId, `⏰ ${text}`);
      return { delivered: true };
    }
    // prompt：force=false，busy 时返回 busy=true 让 scheduler 决定
    const ok = await this.runInternal({
      chatId: input.chatId,
      text: input.prompt ?? "",
      force: false,
      skipBusyMsg: true,
    });
    return { delivered: ok, busy: !ok };
  }
```

- [ ] **Step 2：在已有集成测试追加 reminder 用例**

修改 `tests/integration/orchestrator.imageGroup.test.ts`，在 describe 末尾追加：

```typescript
  describe("runReminder", () => {
    it("kind=text 直接 sendText", async () => {
      const r = await orch.runReminder({
        chatId: "1",
        kind: "text",
        text: "起床啦",
      });
      expect(r.delivered).toBe(true);
      expect(messenger.sentTexts.some((t) => t.text.includes("起床啦"))).toBe(
        true,
      );
    });

    it("kind=prompt 走 send", async () => {
      runtime.nextAgent.script.push({ type: "assistant", text: "查到了" });
      runtime.nextAgent.script.push({
        type: "__finish__",
        status: "finished",
      });
      const r = await orch.runReminder({
        chatId: "1",
        kind: "prompt",
        prompt: "查 BTC 价格",
      });
      expect(r.delivered).toBe(true);
      expect(runtime.lastAgent!.lastSend?.text).toBe("查 BTC 价格");
    });
  });
```

- [ ] **Step 3：跑测试 + typecheck + lint，确认全绿**

```bash
npm test -- --run && npm run typecheck && npm run lint
```

- [ ] **Step 4：commit**

```bash
git add src/core/orchestrator/AgentOrchestrator.ts tests/integration/orchestrator.imageGroup.test.ts
git commit -m "feat(orchestrator): runReminder 支持 text/prompt 两种触发（M2-C）"
```

---

## Task 13：ReminderScheduler（fake timer 集成测试）

**Files:**

- Create: `src/core/reminders/ReminderScheduler.ts`
- Create: `tests/integration/reminderScheduler.test.ts`

> **设计要点：** scheduler 持有 `Map<reminderId, NodeJS.Timeout>`；`add(item)` → 写 store + setTimeout；`remove(id)` → 删 store + clearTimeout；`start()` 全表扫描重新注册（启动 / 重启时调）；`dispose()` 清掉所有 timer。busy 重排：触发时 prompt 走 runReminder，返回 `busy=true` 时把 reminder.at 改为 now+60s 写回 store + 重新注册一次；attempt 用进程内 Map 跟踪，>=2 直接退化 sendText 不再排。

- [ ] **Step 1：写集成测试**

创建 `tests/integration/reminderScheduler.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReminderScheduler,
  type SchedulerDeps,
} from "../../src/core/reminders/ReminderScheduler.js";
import {
  ReminderStore,
  newReminderId,
  type Reminder,
} from "../../src/core/reminders/ReminderStore.js";

describe("ReminderScheduler", () => {
  let dir: string;
  let path: string;
  let store: ReminderStore;
  let runReminder: ReturnType<typeof vi.fn>;
  let sendText: ReturnType<typeof vi.fn>;
  let scheduler: ReminderScheduler;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), "rsch-"));
    path = join(dir, "reminders.json");
    store = new ReminderStore(path);
    await store.init();
    runReminder = vi.fn();
    sendText = vi.fn();
    const deps: SchedulerDeps = {
      store,
      runReminder,
      sendText,
    };
    scheduler = new ReminderScheduler(deps);
  });
  afterEach(async () => {
    scheduler.dispose();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  const NOW = 1735000000000;

  function textRem(id: string, at: number): Reminder {
    return {
      id,
      createdAt: NOW,
      createdBy: 1,
      chatId: "1",
      kind: "text",
      at,
      tz: "UTC",
      text: "x",
    };
  }

  function promptRem(id: string, at: number): Reminder {
    return {
      id,
      createdAt: NOW,
      createdBy: 1,
      chatId: "1",
      kind: "prompt",
      at,
      tz: "UTC",
      prompt: "p",
      workspaceId: "default",
    };
  }

  it("add → 到点触发 runReminder + 从 store 移除", async () => {
    vi.setSystemTime(NOW);
    runReminder.mockResolvedValue({ delivered: true });
    await scheduler.start();
    await scheduler.add(textRem("r-1", NOW + 1000));
    expect(store.list().length).toBe(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(runReminder).toHaveBeenCalledTimes(1);
    expect(store.list().length).toBe(0);
  });

  it("启动时已过期的丢弃且不触发", async () => {
    vi.setSystemTime(NOW);
    await store.add(textRem("r-old", NOW - 10_000));
    await scheduler.start();
    expect(store.list().length).toBe(0);
    expect(runReminder).not.toHaveBeenCalled();
  });

  it("重启后未触发的 reminder 仍能在原 at 触发", async () => {
    vi.setSystemTime(NOW);
    await store.add(textRem("r-1", NOW + 5000));
    await scheduler.start();
    await scheduler.dispose();
    // 模拟重启
    runReminder.mockClear();
    runReminder.mockResolvedValue({ delivered: true });
    const store2 = new ReminderStore(path);
    await store2.init();
    const sch2 = new ReminderScheduler({
      store: store2,
      runReminder,
      sendText,
    });
    await sch2.start();
    await vi.advanceTimersByTimeAsync(5500);
    expect(runReminder).toHaveBeenCalledTimes(1);
    sch2.dispose();
  });

  it("prompt busy → 重排到 +60s + 写回 store + sendText 通知", async () => {
    vi.setSystemTime(NOW);
    runReminder
      .mockResolvedValueOnce({ delivered: false, busy: true }) // 第一次 busy
      .mockResolvedValueOnce({ delivered: true });             // 60s 后成功
    await scheduler.start();
    await scheduler.add(promptRem("r-1", NOW + 1000));
    await vi.advanceTimersByTimeAsync(1100);
    // 第一次：被拒，sendText 通知 + at 改写
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0]![1] as string)).toMatch(/延后 1 分钟/);
    expect(store.list()[0]!.at).toBe(NOW + 1000 + 60_000);
    // 60s 后再触发：成功
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runReminder).toHaveBeenCalledTimes(2);
    expect(store.list().length).toBe(0);
  });

  it("prompt 第二次仍 busy → 退化 sendText + 不再排 + 移除", async () => {
    vi.setSystemTime(NOW);
    runReminder.mockResolvedValue({ delivered: false, busy: true });
    await scheduler.start();
    await scheduler.add(promptRem("r-1", NOW + 1000));
    await vi.advanceTimersByTimeAsync(1100); // 第一次 busy → 重排
    await vi.advanceTimersByTimeAsync(60_000); // 第二次 busy → 退化
    expect(runReminder).toHaveBeenCalledTimes(2);
    // 第二次后应有 "提醒：" 文本（前缀 ⏰）
    const fallbackCall = sendText.mock.calls.find((c) =>
      (c[1] as string).startsWith("⏰ 提醒"),
    );
    expect(fallbackCall).toBeDefined();
    expect(store.list().length).toBe(0);
  });

  it("remove(id) 取消未触发的 timer", async () => {
    vi.setSystemTime(NOW);
    await scheduler.start();
    await scheduler.add(textRem("r-1", NOW + 5000));
    await scheduler.remove("r-1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runReminder).not.toHaveBeenCalled();
    expect(store.list().length).toBe(0);
  });
});
```

- [ ] **Step 2：跑测试，确认失败**

```bash
npm test -- --run tests/integration/reminderScheduler.test.ts
```

- [ ] **Step 3：实现**

创建 `src/core/reminders/ReminderScheduler.ts`：

```typescript
import { logger } from "../../logger.js";
import type { ReminderStore, Reminder } from "./ReminderStore.js";

// 调用方注入的最小依赖：runReminder（orchestrator）+ sendText（messenger 兜底）
export interface SchedulerDeps {
  store: ReminderStore;
  runReminder: (input: {
    chatId: string;
    kind: "text" | "prompt";
    text?: string;
    prompt?: string;
    workspaceId?: string;
  }) => Promise<{ delivered: boolean; busy?: boolean }>;
  sendText: (chatId: string, text: string) => Promise<void>;
}

const SETTIMEOUT_MAX = 2_000_000_000; // ~23 天，留点余量避免触 32-bit 上限

export class ReminderScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private attempts = new Map<string, number>(); // 进程内重排计数；不持久化
  private disposed = false;

  constructor(private readonly deps: SchedulerDeps) {}

  async start(): Promise<void> {
    const now = Date.now();
    // 启动时全表扫描：过期的丢弃，未过期的注册 timer
    const items = this.deps.store.list();
    for (const r of items) {
      if (r.at <= now) {
        logger.warn(
          { id: r.id, at: r.at, now },
          "启动时发现过期 reminder，丢弃",
        );
        await this.deps.store.remove(r.id);
        continue;
      }
      this.scheduleTimer(r);
    }
  }

  async add(item: Reminder): Promise<void> {
    await this.deps.store.add(item);
    this.scheduleTimer(item);
  }

  async remove(id: string): Promise<void> {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.attempts.delete(id);
    await this.deps.store.remove(id);
  }

  list(): Reminder[] {
    return this.deps.store.list();
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.attempts.clear();
  }

  private scheduleTimer(r: Reminder): void {
    if (this.disposed) return;
    const delay = Math.max(0, r.at - Date.now());
    // 大于 setTimeout 上限时分段链式注册
    if (delay > SETTIMEOUT_MAX) {
      const t = setTimeout(() => this.scheduleTimer(r), SETTIMEOUT_MAX);
      this.timers.set(r.id, t);
      return;
    }
    const t = setTimeout(() => void this.fire(r.id), delay);
    this.timers.set(r.id, t);
  }

  private async fire(id: string): Promise<void> {
    if (this.disposed) return;
    this.timers.delete(id);
    const r = this.deps.store.list().find((x) => x.id === id);
    if (!r) return;

    const attempt = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempt);

    try {
      if (r.kind === "text") {
        await this.deps.runReminder({
          chatId: r.chatId,
          kind: "text",
          text: r.text,
        });
        await this.deps.store.remove(id);
        this.attempts.delete(id);
        return;
      }
      // prompt
      const res = await this.deps.runReminder({
        chatId: r.chatId,
        kind: "prompt",
        prompt: r.prompt,
        workspaceId: r.workspaceId,
      });
      if (res.delivered) {
        await this.deps.store.remove(id);
        this.attempts.delete(id);
        return;
      }
      // busy
      if (attempt >= 2) {
        // 第二次仍 busy → 退化 sendText
        try {
          await this.deps.sendText(
            r.chatId,
            `⏰ 提醒：${r.prompt}（agent 一直在忙，未能自动执行）`,
          );
        } catch (e) {
          logger.error(
            { err: (e as Error).message, id },
            "fallback sendText 失败",
          );
        }
        await this.deps.store.remove(id);
        this.attempts.delete(id);
        return;
      }
      // 第一次 busy → 重排到 +60s + 写回 store
      const newAt = Date.now() + 60_000;
      await this.deps.store.update(id, (r0) => ({ ...r0, at: newAt }));
      try {
        await this.deps.sendText(
          r.chatId,
          `⏰ 提醒延后 1 分钟（agent 正忙）：${r.prompt.slice(0, 60)}`,
        );
      } catch (e) {
        logger.error(
          { err: (e as Error).message, id },
          "通知用户重排失败",
        );
      }
      const refreshed = this.deps.store.list().find((x) => x.id === id);
      if (refreshed) this.scheduleTimer(refreshed);
    } catch (e) {
      logger.error({ err: (e as Error).message, id }, "reminder fire 失败");
      // 不丢 store，让下次启动再扫；但现在没 timer 了，避免空忙：
      // 这里取保守路径：丢 store + 移除 attempt
      await this.deps.store.remove(id);
      this.attempts.delete(id);
    }
  }
}
```

- [ ] **Step 4：跑测试 + typecheck + lint，确认 6 测试 pass**

```bash
npm test -- --run tests/integration/reminderScheduler.test.ts && npm run typecheck && npm run lint
```

- [ ] **Step 5：commit**

```bash
git add src/core/reminders/ReminderScheduler.ts tests/integration/reminderScheduler.test.ts
git commit -m "feat(reminders): ReminderScheduler 启停 + busy 重排（M2-C）"
```

---

## Task 14：/remind 命令 handler + dispatch 路由

**Files:**

- Create: `src/commands/handlers/remind.ts`
- Modify: `src/commands/dispatch.ts`
- Create: `tests/unit/remindCommand.test.ts`

> **设计要点：** handler 拆三个子命令 add / list / del；解析 `cmd.rest`（不能用 `cmd.args` 因为 prompt 文本含空格）；时间表达式只能是单个 token 不含空格（`10m` / `09:00` / `2026-05-06T09:00`）—— 注意：spec 中 `2026-05-06 09:00` 含空格的形式我们简化只接受 `2026-05-06T09:00`（用 T 分隔）。在 /help 中明确写 T 分隔的版本。

- [ ] **Step 1：写测试**

创建 `tests/unit/remindCommand.test.ts`：

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReminderScheduler } from "../../src/core/reminders/ReminderScheduler.js";
import { handleRemind } from "../../src/commands/handlers/remind.js";
import { StubMessenger } from "../helpers/StubMessenger.js";

describe("/remind", () => {
  let messenger: StubMessenger;
  let scheduler: ReminderScheduler;
  let registry: { getActive: () => { name: string; path: string } };

  beforeEach(() => {
    messenger = new StubMessenger();
    scheduler = {
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockReturnValue([]),
    } as unknown as ReminderScheduler;
    registry = {
      getActive: () => ({ name: "default", path: "/w" }),
    };
  });

  function ctx() {
    return {
      chatId: "1",
      userId: 100,
      messenger,
      scheduler,
      registry,
      now: () => new Date("2026-05-05T16:00:00Z").getTime(),
      tz: "UTC",
      maxAheadDays: 30,
    };
  }

  it("/remind add text 10m 喝水 → scheduler.add 被调", async () => {
    await handleRemind(["add", "text", "10m", "喝水"], "10m 喝水", ctx() as never);
    expect((scheduler.add as never as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(
      1,
    );
  });

  it("/remind add prompt 1h 看 BTC → kind=prompt 携 prompt 文本", async () => {
    await handleRemind(["add", "prompt", "1h", "看 BTC 价格"], "1h 看 BTC 价格", ctx() as never);
    const args = (scheduler.add as never as { mock: { calls: { 0: { kind: string; prompt?: string } }[] } }).mock.calls[0]!;
    const r = args[0] as { kind: string; prompt?: string };
    expect(r.kind).toBe("prompt");
    expect(r.prompt).toBe("看 BTC 价格");
  });

  it("/remind add 缺 kind → 友好报错", async () => {
    await handleRemind(["add"], "", ctx() as never);
    expect(messenger.sentTexts.some((m) => m.text.includes("用法"))).toBe(true);
  });

  it("/remind add 时间格式不对 → 友好报错且不调 add", async () => {
    await handleRemind(["add", "text", "abcd", "x"], "abcd x", ctx() as never);
    expect(messenger.sentTexts.some((m) => m.text.includes("不识别"))).toBe(true);
    expect((scheduler.add as never as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it("/remind list → 列出现有 + 空时友好提示", async () => {
    await handleRemind(["list"], "", ctx() as never);
    expect(messenger.sentTexts.some((m) => m.text.includes("无"))).toBe(true);
  });

  it("/remind del r-1 → scheduler.remove 被调", async () => {
    await handleRemind(["del", "r-1"], "r-1", ctx() as never);
    expect(
      (scheduler.remove as never as { mock: { calls: unknown[] } }).mock.calls
        .length,
    ).toBe(1);
  });
});
```

- [ ] **Step 2：跑测试，确认失败**

```bash
npm test -- --run tests/unit/remindCommand.test.ts
```

- [ ] **Step 3：实现 handler**

创建 `src/commands/handlers/remind.ts`：

```typescript
import type { IMessenger } from "../../core/messenger/IMessenger.js";
import type { WorkspaceRegistry } from "../../core/workspace/WorkspaceRegistry.js";
import type { ReminderScheduler } from "../../core/reminders/ReminderScheduler.js";
import {
  newReminderId,
  type Reminder,
} from "../../core/reminders/ReminderStore.js";
import { parseTimeExpr } from "../../core/reminders/timeParser.js";

export interface RemindContext {
  chatId: string;
  userId: number;
  messenger: IMessenger;
  scheduler: ReminderScheduler;
  registry: WorkspaceRegistry;
  now: () => number;
  tz: string;
  maxAheadDays: number;
}

const USAGE = `用法：
/remind add text   <时间> <内容>
/remind add prompt <时间> <prompt>
/remind list
/remind del <id>

时间格式：相对 (10m, 1h30m) | 当日 HH:MM | YYYY-MM-DDTHH:MM`;

export async function handleRemind(
  args: string[],
  rest: string,
  ctx: RemindContext,
): Promise<void> {
  const sub = args[0];
  if (sub === "add") return handleAdd(args.slice(1), rest, ctx);
  if (sub === "list") return handleList(ctx);
  if (sub === "del") return handleDel(args.slice(1), ctx);
  await ctx.messenger.sendText(ctx.chatId, USAGE);
}

async function handleAdd(
  rest: string[],
  fullRest: string,
  ctx: RemindContext,
): Promise<void> {
  const kind = rest[0];
  if (kind !== "text" && kind !== "prompt") {
    await ctx.messenger.sendText(ctx.chatId, USAGE);
    return;
  }
  const expr = rest[1];
  if (!expr) {
    await ctx.messenger.sendText(ctx.chatId, USAGE);
    return;
  }
  // body 文本：去掉前两个 token（text|prompt + 时间表达式），其余原样保留空格
  const body = stripLeading(fullRest, kind, expr);
  if (!body) {
    await ctx.messenger.sendText(ctx.chatId, "内容不能为空。" + "\n" + USAGE);
    return;
  }

  const parsed = parseTimeExpr(expr, {
    now: ctx.now(),
    tz: ctx.tz,
    maxAheadDays: ctx.maxAheadDays,
  });
  if (parsed.error || !parsed.at) {
    await ctx.messenger.sendText(
      ctx.chatId,
      `⚠️ 时间格式 ${parsed.error ?? "不识别"}：${expr}`,
    );
    return;
  }

  const id = newReminderId(parsed.at, ctx.now());
  let item: Reminder;
  if (kind === "text") {
    item = {
      id,
      createdAt: ctx.now(),
      createdBy: ctx.userId,
      chatId: ctx.chatId,
      kind: "text",
      at: parsed.at,
      tz: ctx.tz,
      text: body,
    };
  } else {
    const ws = ctx.registry.getActive();
    if (!ws) {
      await ctx.messenger.sendText(
        ctx.chatId,
        "没有活跃 workspace，先 /ws use 一个再 /remind add prompt。",
      );
      return;
    }
    item = {
      id,
      createdAt: ctx.now(),
      createdBy: ctx.userId,
      chatId: ctx.chatId,
      kind: "prompt",
      at: parsed.at,
      tz: ctx.tz,
      prompt: body,
      workspaceId: ws.name,
    };
  }
  await ctx.scheduler.add(item);
  await ctx.messenger.sendText(
    ctx.chatId,
    `✅ ${id}：将于 ${new Date(parsed.at).toISOString()} 触发`,
  );
}

async function handleList(ctx: RemindContext): Promise<void> {
  const items = ctx.scheduler.list();
  if (items.length === 0) {
    await ctx.messenger.sendText(ctx.chatId, "无 reminder。");
    return;
  }
  const lines = items
    .sort((a, b) => a.at - b.at)
    .map((r) => {
      const when = new Date(r.at).toISOString();
      const summary =
        r.kind === "text" ? `text: ${r.text}` : `prompt[${r.workspaceId}]: ${r.prompt}`;
      return `${r.id}  ${when}\n  ${summary}`;
    });
  await ctx.messenger.sendText(ctx.chatId, lines.join("\n\n"));
}

async function handleDel(rest: string[], ctx: RemindContext): Promise<void> {
  const id = rest[0];
  if (!id) {
    await ctx.messenger.sendText(ctx.chatId, "用法：/remind del <id>");
    return;
  }
  await ctx.scheduler.remove(id);
  await ctx.messenger.sendText(ctx.chatId, `已删除 ${id}（若存在）。`);
}

// 把 fullRest 里前导的 kind / expr 两个 token 剥掉，保留之后原始空格
function stripLeading(rest: string, kind: string, expr: string): string {
  let s = rest.trimStart();
  if (s.startsWith(kind)) s = s.slice(kind.length).trimStart();
  if (s.startsWith(expr)) s = s.slice(expr.length).trimStart();
  return s;
}
```

- [ ] **Step 4：dispatch 路由 + 给 dispatch 提供 scheduler/cfg**

修改 `src/commands/dispatch.ts`：扩展 `CommandContext` + 加 case：

```typescript
import type { IMessenger } from "../core/messenger/IMessenger.js";
import type { WorkspaceRegistry } from "../core/workspace/WorkspaceRegistry.js";
import type { SessionStore } from "../core/session/SessionStore.js";
import type { AgentOrchestrator } from "../core/orchestrator/AgentOrchestrator.js";
import type { ReminderScheduler } from "../core/reminders/ReminderScheduler.js";
import type { ParsedCommand } from "./parser.js";
import { handleHelp } from "./handlers/help.js";
import { handleWs } from "./handlers/ws.js";
import { handleReset } from "./handlers/reset.js";
import { handleCancel } from "./handlers/cancel.js";
import { handleStatus } from "./handlers/status.js";
import { handleModel } from "./handlers/model.js";
import { handleRemind } from "./handlers/remind.js";

export interface CommandContext {
  chatId: string;
  userId: number;
  messenger: IMessenger;
  registry: WorkspaceRegistry;
  session: SessionStore;
  orchestrator: AgentOrchestrator;
  scheduler?: ReminderScheduler;
  reminderConfig?: { tz: string; maxAheadDays: number };
}

export async function dispatchCommand(
  cmd: ParsedCommand,
  ctx: CommandContext,
): Promise<void> {
  switch (cmd.name) {
    case "start":
    case "help":
      return handleHelp(ctx);
    case "ws":
      return handleWs(cmd.args, ctx);
    case "reset":
      return handleReset(ctx);
    case "cancel":
      return handleCancel(ctx);
    case "status":
      return handleStatus(ctx);
    case "model":
      return handleModel(cmd.args, ctx);
    case "remind":
      if (!ctx.scheduler || !ctx.reminderConfig) {
        await ctx.messenger.sendText(
          ctx.chatId,
          "/remind 暂未启用（reminder scheduler 未注入）",
        );
        return;
      }
      return handleRemind(cmd.args, cmd.rest, {
        chatId: ctx.chatId,
        userId: ctx.userId,
        messenger: ctx.messenger,
        scheduler: ctx.scheduler,
        registry: ctx.registry,
        now: () => Date.now(),
        tz: ctx.reminderConfig.tz,
        maxAheadDays: ctx.reminderConfig.maxAheadDays,
      });
    default:
      await ctx.messenger.sendText(
        ctx.chatId,
        `未知命令：/${cmd.name}。/help 查看可用命令。`,
      );
  }
}
```

> **注意：** `CommandContext.userId` 是新增字段，bin/cursor-claw.ts 在调 dispatch 时要传 userId。这是 T15 的事。

- [ ] **Step 5：跑测试 + typecheck + lint，确认 6 测试 pass**

```bash
npm test -- --run tests/unit/remindCommand.test.ts && npm run typecheck && npm run lint
```

> 注：M1 的 commandHandlers.test.ts 可能因为 CommandContext 加了 userId / scheduler 字段而 TS 报错——按测试改 ctx 构造（加可选字段或 `as never`）即可保持绿。

- [ ] **Step 6：commit**

```bash
git add src/commands/handlers/remind.ts src/commands/dispatch.ts tests/unit/remindCommand.test.ts
git commit -m "feat(commands): /remind add|list|del 路由 + handler（M2-C）"
```

---

## Task 15：bin 装配（imageGroup 已通；这里加 dispatcher / scheduler / .claw 标记）

**Files:**

- Modify: `src/bin/cursor-claw.ts`

> **设计要点：** 在 main() 里：
> - 实例化 `AttachmentQueue` 与 `AttachmentDispatcher`，注入 orchestrator
> - 实例化 `ReminderStore` + `ReminderScheduler`，启动后传给 dispatch
> - 启动后写 `.claw/data-dir.txt` 到当前 active workspace 根
> - 在 shutdown 中先 dispose scheduler 再 dispose orchestrator

- [ ] **Step 1：修改 bin/cursor-claw.ts**

在顶部 import 块加：

```typescript
import { writeFile } from "node:fs/promises";
import { AttachmentQueue } from "../core/attachments/AttachmentQueue.js";
import { AttachmentDispatcher } from "../core/attachments/AttachmentDispatcher.js";
import { ReminderStore } from "../core/reminders/ReminderStore.js";
import { ReminderScheduler } from "../core/reminders/ReminderScheduler.js";
```

在 `await mkdir(dataDir, ...)` 之后插入：

```typescript
  // M2: 把 dataDir 绝对路径写到 active workspace 根的 .claw/data-dir.txt
  // 这样 attach CLI 子进程在 agent 的 cwd 下能找到主进程的 dataDir
  // 失败不阻塞启动（仅日志告警）
  const writeClawMarker = async (wsPath: string): Promise<void> => {
    try {
      const markerDir = join(wsPath, ".claw");
      await mkdir(markerDir, { recursive: true });
      const abs = await import("node:path").then((p) => p.resolve(dataDir));
      await writeFile(join(markerDir, "data-dir.txt"), abs, "utf8");
    } catch (e) {
      logger.warn(
        { err: (e as Error).message, wsPath },
        ".claw/data-dir.txt 写入失败",
      );
    }
  };
```

替换 orchestrator 装配段：

```typescript
  const queue = new AttachmentQueue(join(dataDir, "attachments", "queue.jsonl"));
  const dispatcher = new AttachmentDispatcher({
    queue,
    messenger,
    maxRetries: cfg.attachments.maxRetries,
    maxPerFlush: cfg.attachments.maxAttachmentsPerFlush,
  });

  const reminderStore = new ReminderStore(join(dataDir, "reminders.json"));
  await reminderStore.init();

  const orchestrator = new AgentOrchestrator({
    messenger,
    runtime,
    registry,
    session,
    streamOptions: { throttleMs: 800, maxLen: 3500 },
    defaultModel: cfg.cursor.defaultModel,
    attachmentDispatcher: dispatcher,
  });

  const scheduler = new ReminderScheduler({
    store: reminderStore,
    runReminder: (input) => orchestrator.runReminder(input),
    sendText: async (chatId, text) => {
      await messenger.sendText(chatId, text);
    },
  });
  await scheduler.start();
```

写 .claw 标记（在 messenger.start() 之前）：

```typescript
  const activeWs = registry.getActive();
  if (activeWs) await writeClawMarker(activeWs.path);
```

修改 dispatch 调用，传 userId 与 scheduler / reminderConfig：

```typescript
      if (parsed.type === "command") {
        await dispatchCommand(parsed, {
          chatId,
          userId: 0, // handleText 在 messenger.on("text") 监听器内已知 userId，需要传进来；改造见下
          messenger,
          registry,
          session,
          orchestrator,
          scheduler,
          reminderConfig: {
            tz: cfg.reminders.timezone,
            maxAheadDays: cfg.reminders.maxAheadDays,
          },
        });
        return;
      }
```

> 这里需要把 `handleText` 改成接收 `userId`。修改：把 `messenger.on("text", ...)` 内调用 `void handleText(msg.chatId, msg.text)` 改为 `void handleText(msg.chatId, msg.text, msg.userId)`，并在 `handleText(chatId, text, userId)` 中把 userId 传给 dispatchCommand。

完整替换：

```typescript
  messenger.on("text", (msg) => {
    logger.info(
      { userId: msg.userId, username: msg.username, len: msg.text.length },
      "incoming text",
    );
    if (!access.isAllowed(msg.userId)) {
      logger.warn({ userId: msg.userId }, "userId 不在 allowedUserIds，丢弃");
      return;
    }
    void handleText(msg.chatId, msg.text, msg.userId);
  });
```

```typescript
  async function handleText(
    chatId: string,
    text: string,
    userId: number,
  ): Promise<void> {
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
          reminderConfig: {
            tz: cfg.reminders.timezone,
            maxAheadDays: cfg.reminders.maxAheadDays,
          },
        });
        return;
      }
      const { force, text: clean } = parseForcePrefix(parsed.text);
      await orchestrator.runPrompt({ chatId, text: clean, force });
    } catch (e) {
      logger.error({ err: (e as Error).message }, "handleText 顶层异常");
      try {
        await messenger.sendText(
          chatId,
          `内部错误：${(e as Error).message}`.slice(0, 800),
          { parseMode: "plain" },
        );
      } catch {
        /* ignore */
      }
    }
  }
```

修改 shutdown，在 orch.dispose() 之前先 dispose scheduler：

```typescript
  const shutdown = async (): Promise<void> => {
    logger.info("shutting down...");
    try {
      await messenger.stop();
    } catch (e) {
      logger.error({ err: (e as Error).message }, "messenger stop");
    }
    try {
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
```

- [ ] **Step 2：跑全部测试 + typecheck + lint，确认 0 回归**

```bash
npm test -- --run && npm run typecheck && npm run lint
```

预期：所有 M1 + M2 的测试全绿（约 ~125 条）。

- [ ] **Step 3：commit**

```bash
git add src/bin/cursor-claw.ts
git commit -m "feat(bin): 装配 dispatcher + scheduler + .claw 标记（M2-D）"
```

---

## Task 16：/help 文本扩展 + README + .gitignore + config.example.json

**Files:**

- Modify: `src/commands/handlers/help.ts`
- Modify: `README.md`
- Modify: `.gitignore`
- Modify: `config.example.json`

- [ ] **Step 1：扩展 /help**

修改 `src/commands/handlers/help.ts`，替换 HELP_TEXT：

```typescript
const HELP_TEXT = `<b>cursor-claw</b>
<code>/start</code> 或 <code>/help</code>  本帮助
<code>/ws list</code>  列出工作区
<code>/ws use &lt;name&gt;</code>  切换工作区
<code>/ws add &lt;name&gt; &lt;abs-path&gt;</code>  注册工作区
<code>/ws remove &lt;name&gt;</code>  注销工作区
<code>/ws path</code>  当前路径
<code>/reset</code>  重置当前工作区会话
<code>/cancel</code>  取消当前 run
<code>/status</code>  当前 agent / 工作区 / 模型
<code>/model &lt;id&gt;</code>  切换默认模型

📅 <b>Reminders</b>
<code>/remind add text &lt;时间&gt; &lt;内容&gt;</code>  一次性纯文本提醒
<code>/remind add prompt &lt;时间&gt; &lt;prompt&gt;</code>  到点跑 agent
<code>/remind list</code>
<code>/remind del &lt;id&gt;</code>
时间格式：相对 (10m, 1h30m) | 当日 HH:MM | YYYY-MM-DDTHH:MM

📎 <b>Agent 端附件</b>（在 Cursor agent 的 shell tool 内）
<code>claw-attach-image /path/to/x.png [--caption "..."]</code>
<code>claw-attach-file  /path/to/x.pdf [--caption "..."]</code>
本次 run 结束时自动发回 Telegram

🖼 <b>给 bot 发图</b> / 多图 album → 自动转给 agent 分析

普通文本 → 作为 prompt
以 <code>!</code> 开头的文本 → 强制打断当前 run`;
```

- [ ] **Step 2：扩展 README**

修改 `README.md`，在"M1 Roadmap" 段下方追加 "M2"：

```markdown
## M2: 入站图片 / 出站附件 / Reminders

M2 在 M1 文本对话基础上增加：

- **入站图片**：Telegram 用户发图（含多图 album）→ agent 自动接收并分析
- **出站附件**：agent 在 shell tool 中调 `claw-attach-image /tmp/x.png` 把文件回发给 Telegram
- **Reminders**：`/remind add text 10m 喝水` 或 `/remind add prompt 09:00 看 BTC 价格`

### 安装 attach CLI

```bash
npm i -g cursor-claw   # 全局安装后 PATH 里有 claw-attach-image / claw-attach-file
```

或者本地开发用 `npm link`。

agent 在 workspace 根目录跑时会自动通过 `.claw/data-dir.txt` 找到 cursor-claw 主进程的 data 目录；如果失败，可以显式 `CLAW_DATA_DIR=/path/to/data` 注入。

### Reminders 时间格式

- 相对：`10m` `1h30m` `45s` `2d`
- 当日：`09:00` `22:30`
- 绝对：`2026-05-06T09:00`（用 T 分隔）

时区默认 `Asia/Shanghai`，可在 `config.json` 的 `reminders.timezone` 覆盖。
```

- [ ] **Step 3：扩展 .gitignore**

在末尾追加：

```
# M2
.claw/
```

- [ ] **Step 4：扩展 config.example.json（如果 T1 没加全则补齐）**

确认 `config.example.json` 已包含：

```json
"reminders": { "timezone": "Asia/Shanghai", "maxAheadDays": 30 },
"attachments": { "maxFileSizeBytes": 20971520, "maxAttachmentsPerFlush": 10, "maxRetries": 3 },
"images": { "maxImagesPerPrompt": 8, "mediaGroupDebounceMs": 200 }
```

- [ ] **Step 5：跑 typecheck + lint，确认无回归**

```bash
npm run typecheck && npm run lint
```

- [ ] **Step 6：commit**

```bash
git add src/commands/handlers/help.ts README.md .gitignore config.example.json
git commit -m "docs(m2): /help + README + .gitignore + config.example 同步 M2 字段"
```

---

## Task 17：M2 e2e smoke 验证清单

**Files:**

- Modify: 无（仅运行验证）

> **设计要点：** 不是自动化测试，而是把 spec 第 7 节的 9 条验收标准变成可勾选清单；逐条手动验证（实际 Telegram 发图、reminders 等）。每验证一项做一次 `git status` 与 `npm test` 确认仓库干净 + 测试绿。

- [ ] **Step 1：跑全套测试 + typecheck + lint + build**

```bash
npm test -- --run && npm run typecheck && npm run lint && npm run build
```

预期：~127 个测试全绿；dist/ 中应有 cursor-claw.js / attach-image.js / attach-file.js 三个产物。

- [ ] **Step 2：启动 dev**

```bash
npx tsx src/bin/cursor-claw.ts
```

观察 startup log：`cursor-claw started`；不应有 grammy 409；`.claw/data-dir.txt` 应已写入 active workspace 根。

- [ ] **Step 3：验证清单（每条勾选后再勾下一条）**

- [ ] **A1 单图入站**：用 Telegram 发一张带 caption "这是什么？" 的图给 bot；agent 应有流式回复
- [ ] **A2 album 入站**：用 Telegram 一次发 3 张图（同 album）；server 端应仅一次 "incoming imageGroup" 日志（n: 3）；agent 单 prompt 收到 3 张图
- [ ] **B1 出站附件**：让 agent 在 shell 跑：`echo test > /tmp/clawtest.txt && claw-attach-file /tmp/clawtest.txt --caption "test"`；run 结束后 Telegram 立即收到该文件
- [ ] **B2 多附件 + 重试**：让 agent 一次 run 中多发 2 张图（claw-attach-image）；都送达；queue.jsonl 在送达后为空
- [ ] **C1 reminders text**：`/remind add text 10s 起床啦`；10 秒后收到 "⏰ 起床啦"；reminders.json 已不含此条
- [ ] **C2 reminders prompt**：`/remind add prompt 10s 一句话总结这个仓库`；10 秒后看到 agent 流式回复
- [ ] **C3 reminders busy 重排**：先 `/remind add prompt 5s 一句话总结仓库`，立刻 `!写一个 200 字小说让 agent 卡住`（超长 prompt）；scheduler 触发时 busy → 收到 "⏰ 提醒延后 1 分钟" 通知；60s 内 agent 仍忙时收到 "⏰ 提醒：..." 退化文本
- [ ] **C4 list / del**：`/remind add text 1h 测试`；`/remind list` 应见此条；记下 id；`/remind del <id>`；再 list 不再显示

- [ ] **Step 4：每条验收后留干净 git 状态**

```bash
git status   # 应输出 nothing to commit
```

- [ ] **Step 5：M2 收尾 commit**

```bash
git commit --allow-empty -m "chore(m2): e2e smoke 全 9 条验收完成"
```

---

## Self-Review 备注（writing-plans skill 要求）

写完上面 17 个任务后，作者已对照 spec 做 3 项检查：

**1. Spec coverage**：

| Spec 章节 | 对应任务 |
|-----------|----------|
| 3 入站图片 | T2 / T3 / T4 / T5 |
| 4 出站附件 | T6 / T7 / T8 / T9 |
| 5 Reminders | T10 / T11 / T12 / T13 / T14 |
| 6.1 配置变更 | T1（前置一次性加完）/ T16（example 同步） |
| 6.2 /help 扩展 | T16 |
| 6.3 .gitignore | T16 |
| 6.4 测试矩阵 | T2 / T6 / T7 / T10 / T11 / T14（unit）+ T4 / T8 / T13（integration） |
| 6.5 兼容性 | T1（schema 全 default）+ T9 / T11（store 不存在自动 init） |
| 7 验收标准 | T17 |
| 8 风险 | 在每个任务的 "设计要点" 中点出（如 SETTIMEOUT_MAX 分段、jsonl 行级原子等） |

**2. Placeholder scan**：搜索 TBD / TODO / FIXME / "implement later"，无命中。

**3. Type 一致性**：

- `IncomingImageGroup` 在 T3 定义，T3 / T5 / T15 引用 → 一致
- `AttachmentEntry` 在 T6 定义，T7 / T8 / T15 引用 → 一致
- `Reminder` 与 `ReminderText` / `ReminderPrompt` 在 T11 定义，T12 / T13 / T14 / T15 引用 → 一致
- `runReminder` 返回 `{ delivered: boolean; busy?: boolean }` 在 T12 定义，T13 ReminderScheduler 用同一结构断言 → 一致
- `OrchestratorDeps.attachmentDispatcher` 在 T9 定义可选，T15 传入 → 一致
- `CommandContext.userId / scheduler / reminderConfig` 在 T14 扩展，T15 传入 → 一致

完成。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-05-cursor-claw-m2.md`. Two execution options:

**1. Subagent-Driven (recommended)** — 每个任务派一个 fresh subagent 实现，主 agent 在任务间 review；快速迭代

**2. Inline Execution** — 在本会话用 executing-plans skill 批次执行，每段批次后 checkpoint review

按用户的硬要求"禁止使用任何 subagent" → **Inline Execution** 是唯一可选项。

按 M1 节奏，建议批次：

- 批次 1：T1（前置准备，1 tasks）→ checkpoint
- 批次 2：T2-T5（A 入站图片，4 tasks）→ checkpoint
- 批次 3：T6-T9（B 出站附件，4 tasks）→ checkpoint
- 批次 4：T10-T14（C reminders，5 tasks）→ checkpoint
- 批次 5：T15-T17（整合 + 文档 + e2e，3 tasks）→ M2 完成
