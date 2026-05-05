# cursor-claw（基于 @cursor/sdk）—— 设计文档

- **日期**：2026-05-05
- **作者**：Jem
- **状态**：草案 v1（已通过分段 brainstorming，待 spec 复核）
- **目录路径**：`/Users/liwei/cursor/cursor-claw`

---

## 1. 背景与目标

[`jes/cursor-claw`](https://github.com/jes/cursor-claw) 是一个 Python 项目：用 Telegram bot 桥接 `cursor agent` CLI，让用户能在手机上指挥 Cursor agent 在本机仓库里干活。本项目要做"它的 TypeScript 后继版"：

- 不再 spawn `cursor agent` CLI，而是直接调用 [`@cursor/sdk`](https://cursor.com/cn/docs/sdk/typescript) 的 `Agent.create / send / stream / cancel / resume`。
- 增强体验：流式回传、工具可视化、定时任务、附件双向、可恢复会话、多工作区切换。
- 预留扩展位：`IMessenger` 接口让微信适配器能在不动核心的前提下接入。

### 1.1 北极星

> "我在地铁里掏出手机，告诉 bot：'修一下 src/auth.ts 里的 bug 并跑测试'。10 秒钟后，我能在 Telegram 里看到工具执行进度、最终的修改摘要，agent 还顺手把测试报告截图发给我。回家打开 Cursor，工作树正好停在它干完活的状态。"

### 1.2 与原版 cursor-claw 的差异

| 维度 | 原版（jes/cursor-claw） | 本项目 |
| --- | --- | --- |
| 语言 | Python 3 | TypeScript / Node 20+ |
| Cursor 调用 | `subprocess` 调 `cursor agent` CLI | `@cursor/sdk` 直接 SDK 调用 |
| 流式 | CLI 块输出 | 事件级流式（assistant 文本、工具调用、思考） |
| 工具可视化 | 无 | 主消息状态行实时更新 |
| 会话保留 | `.cursor_agent_session` 文件 | `Agent.resume(agentId)` |
| 多工作区 | 仅运行目录 | 命令行切换、独立 agent 池 |
| 附件回传 | 队列文件，**下次回复**带出 | 队列文件，**本次 run 结束后**送达 |
| 定时任务 | systemd timer + 独立脚本 | 进程内自管 setTimeout |
| 微信支持 | 无 | 接口预留，第一版不实现 |

### 1.3 非目标（YAGNI）

- 多用户多租户；本项目第一版只服务**一个白名单用户**。
- 群聊。
- 远程 agent / Cursor cloud runtime（仅 local）。
- Web 控制面板。
- 微信的实际实现（仅留接口骨架）。
- 反向代理 / TLS 终端（systemd + 长轮询即可，无需公网入站）。

---

## 2. 总体架构

```
                  ┌─────────────────────────────────────────────────────────────┐
                  │                  cursor-claw  (Node 进程)                    │
                  │                                                              │
  Telegram update │  ┌────────────────────────────────────────────────────┐     │
  ───────────────►│  │  adapters/telegram (grammy)                        │     │
                  │  │   - Long Polling / Webhook 收消息                    │     │
                  │  │   - 实现 IMessenger 接口                             │     │
                  │  └──────────────┬─────────────────────────────────────┘     │
                  │                 │ IMessenger.on("text"/"image")              │
                  │                 ▼                                            │
                  │  ┌────────────────────────────────────────────────────┐     │
                  │  │  core/AgentOrchestrator                            │     │
                  │  │   - 解析 / 命令                                       │     │
                  │  │   - 调 @cursor/sdk: send / stream / cancel          │     │
                  │  │   - 管理 SDKAgent 实例池（按工作区）                    │     │
                  │  │   - 把流式事件渲染回 IMessenger                        │     │
                  │  └────┬─────────┬─────────┬─────────┬─────────┬──────┘     │
                  │       │         │         │         │         │             │
                  │       ▼         ▼         ▼         ▼         ▼             │
                  │  Workspace  Session   Attach.   Reminder  AccessControl     │
                  │  Registry   Store     Queue     Scheduler  (whitelist)      │
                  │       │         │         │         │                       │
                  │       └────┬────┴─────────┴─────────┘                       │
                  │            ▼                                                 │
                  │       data/*.json (持久化)                                    │
                  │                                                              │
                  │  ┌────────────────────────────────────────────────────┐     │
                  │  │  integrations/clawfox    (CLI 封装)                  │     │
                  │  └────────────────────────────────────────────────────┘     │
                  │                                                              │
                  │  ┌────────────────────────────────────────────────────┐     │
                  │  │  config/   (zod schema 加载 + 校验)                  │     │
                  │  └────────────────────────────────────────────────────┘     │
                  │                                                              │
                  │  ┌────────────────────────────────────────────────────┐     │
                  │  │  bin/cursor-claw.ts (入口：装配 + 启动)               │     │
                  │  └────────────────────────────────────────────────────┘     │
                  └─────────────────────────────────────────────────────────────┘
```

### 2.1 模块清单与职责

| 模块 | 职责 | 关键依赖 |
| --- | --- | --- |
| `core/messenger/IMessenger.ts` | 消息适配器抽象接口 | 无 |
| `core/orchestrator/AgentOrchestrator.ts` | 编排 SDK 调用、处理命令、渲染流式事件 | `@cursor/sdk`, IMessenger |
| `core/workspace/WorkspaceRegistry.ts` | 工作区清单 + 当前活跃工作区 + 切换 | fs |
| `core/session/SessionStore.ts` | `workspace → agentId` 持久化 | fs |
| `core/attachment/AttachmentQueue.ts` | agent 主动回传的图/文件队列 | fs |
| `core/reminders/ReminderScheduler.ts` | 持久化定时任务，到点回调 orchestrator | fs, setTimeout |
| `core/access/AccessControl.ts` | 白名单（chatId / userId） | 无 |
| `core/render/markdownToHtml.ts` | LLM 输出 → 安全 HTML | 无 |
| `core/persist/jsonStore.ts` | 原子读写 + 简单文件锁 | fs |
| `adapters/telegram/TelegramMessenger.ts` | grammy 实现 IMessenger | grammy |
| `adapters/wechat/` | 占位骨架 + README（不实现） | 无 |
| `integrations/clawfox/clawfox.ts` | clawfox CLI 封装 | child_process |
| `config/{schema,loadConfig}.ts` | env/文件 加载并 zod 校验 | zod |
| `commands/parser.ts + handlers/*` | `/` 命令分发与处理 | — |
| `tools/{attach-image,attach-file}.ts` | 独立 CLI 工具，给 agent 在 shell 里入队附件 | fs |
| `bin/cursor-claw.ts` | 入口：装配上面所有模块 | 上面所有 |

### 2.2 IMessenger 接口（草案）

```typescript
export interface IMessenger {
  start(): Promise<void>;
  stop(): Promise<void>;

  on(event: "text",  h: (msg: IncomingTextMessage)  => void): void;
  on(event: "image", h: (msg: IncomingImageMessage) => void): void;

  sendText(chatId: string, text: string, opts?: SendOptions): Promise<MessageHandle>;
  editText(chatId: string, messageId: string, text: string): Promise<void>;
  sendImage(chatId: string, image: ImagePayload, caption?: string): Promise<MessageHandle>;
  sendDocument(chatId: string, file: FilePayload, caption?: string): Promise<MessageHandle>;

  sendTyping(chatId: string): Promise<void>;
}

export interface IncomingTextMessage  { chatId: string; userId: string; text: string; }
export interface IncomingImageMessage { chatId: string; userId: string; data: string; mimeType: string; caption?: string; }
export interface MessageHandle        { messageId: string; }
export interface SendOptions          { parseMode?: "HTML" | "Markdown" | "plain"; replyToMessageId?: string; }
export type     ImagePayload          = { data: Buffer; mimeType: string; filename?: string };
export type     FilePayload           = { data: Buffer; mimeType?: string; filename: string };
```

`AgentOrchestrator` 仅依赖此接口；微信 adapter 后续实现同一接口即可即插即用。

> **parseMode 优先级**：`SendOptions.parseMode`（单条消息级）> `config.telegram.parseMode`（全局默认）。未指定时 fallback 到全局默认（HTML）。

---

## 3. 会话、工作区、命令集

### 3.1 Agent 实例池

```typescript
type AgentEntry = { agent: SDKAgent; activeRun?: Run; activeRunMsgId?: string };
const pool = new Map<workspaceId, AgentEntry>();
```

懒加载流程（首次发消息到某工作区）：
- `SessionStore` 已有 `agentId` → `Agent.resume(agentId, { apiKey, model, local: { cwd, settingSources: ["project","user"] } })`
- 否则 → `Agent.create({ apiKey, model, local: { cwd, settingSources, sandboxOptions? }, mcpServers })`，把 `agent.agentId` 写入 SessionStore。

### 3.2 持久化数据形状

`data/workspaces.json`：
```json
{
  "active": "project-x",
  "items": {
    "default":   { "name": "default",   "path": "/Users/liwei/cursor/cursor-claw" },
    "project-x": { "name": "project-x", "path": "/Users/liwei/code/project-x" }
  }
}
```

`data/sessions.json`：
```json
{
  "workspaces": {
    "default":   { "agentId": "agent-...", "model": "auto" },
    "project-x": { "agentId": "agent-...", "model": "composer-2",
                   "modelParams": [{ "id": "thinking", "value": "high" }] }
  }
}
```

### 3.3 忙状态保护

每个工作区一次只能有一个 active run。新文本到达时若 `activeRun?.status === "running"`：
- **默认拒绝并提示** "Agent 正在工作；请 `/cancel` 后重试，或在消息前加 `!` 强制打断"
- 用户消息以 `!` 开头 → `agent.send(text, { local: { force: true } })` 强制替换旧 run
- `/cancel` → `activeRun.cancel()`

### 3.4 命令集

| 命令 | 行为 |
| --- | --- |
| `/start` `/help` | 欢迎 / 帮助 |
| `/ws list` / `/ws use <name>` / `/ws add <name> <abs-path>` / `/ws remove <name>` / `/ws path` | 工作区管理 |
| `/reset` | 关闭当前 agent + 清 agentId（下次发消息开新会话） |
| `/cancel` | 取消当前 run |
| `/status` | 当前 agent / run / 上次 token 用量 / 上次 duration |
| `/model <id>` `/models` | 切换默认模型 / 列出可用 |
| `/remind list` / `/remind add <YYYY-MM-DD HH:MM> <prompt>` / `/remind del <id>` | 定时任务管理 |
| `!<text>` | 强制打断当前 run，并把 `<text>` 作为新 prompt |
| 普通文本 | 作为 prompt 发给当前工作区 agent |

第一版只接受白名单 `userId` 的 **1v1 私聊**；其他消息**静默 drop**（不暴露 bot 存在）。`chatId` 仍保留在数据流中。

---

## 4. 消息流与流式输出

### 4.1 入站文本完整路径

```
TelegramMessenger.on("text", msg)
   → AccessControl.check(msg.userId)               # 不在白名单 → 静默 drop
   → CommandParser.tryParse(msg.text)
        ├── 是命令 → CommandHandler.handle(...)        ── done
        └── 普通文本（含 !-前缀）
             → AgentOrchestrator.runPrompt(workspaceId, text, { force })
                  1. 拿/建 SDKAgent
                  2. 检查 activeRun，按忙状态策略走
                  3. Messenger.sendText("⏳ thinking...") → mainMsgId
                  4. const run = await agent.send(text, { local: { force } })
                  5. for await (event of run.stream())  → 渲染（见 4.2）
                  6. const result = await run.wait()
                  7. 消费 AttachmentQueue（见 4.4）
                  8. 记录 token / duration / git
                  → 清空 activeRun
```

### 4.2 流式渲染：单条主消息 + 编辑

主消息布局：
```
[状态行：🔧 shell: pnpm test]

<assistant text 累加缓冲>
```

事件 → 渲染映射：

| event.type | 处理 |
| --- | --- |
| `system / user` | 忽略（仅 debug 日志） |
| `assistant` | 取 `TextBlock.text` → 累加进 textBuffer |
| `thinking` | 折叠：状态行显示 "🤔 thinking..."，文本本身只入 debug 日志 |
| `tool_call` `running` | 状态行：`🔧 <name>: <短摘要>` |
| `tool_call` `completed` | 短暂 `✅ <name>` 然后清回 "thinking..." |
| `tool_call` `error` | 状态行：`⚠️ <name> failed`；主体追加错误摘要 |
| `status` | 仅日志（local 几乎只见 init） |

**节流**：leading + trailing throttle，**默认 800ms**；缓冲区有变化才发起 `editMessageText`。

**长消息切分**：textBuffer 超过 ~3500 字符时把当前主消息 finalize、再 `sendText("⏳ continuing...")` 拿新 messageId 继续追加；切分时避免劈开 markdown token（在最近的换行/段落处切）。

**完成态**：
- `finished` → 状态行擦掉，只留 assistant 文本；末尾发一条小贴士消息显示 `tokens=in/out, duration=2.3s`（可关闭）。
- `cancelled` → 主消息末尾追加 `(已取消)`。
- `error` → 主消息末尾追加错误信息；若 `isRetryable === true` 提示用户可重发。

### 4.3 工具可视化的防御式解析

工具 `args` / `result` schema 不稳定，按 SDK 文档要求"视为 unknown 防御式解析"：

```typescript
function summarizeTool(name: string, args: unknown): string {
  const a = args as Record<string, unknown> | undefined;
  switch (name) {
    case "shell":     return `shell: ${trim((a?.command as string) ?? "")}`;
    case "read":      return `read: ${(a?.path ?? a?.relative_path) as string ?? ""}`;
    case "write":     return `write: ${(a?.path ?? a?.relative_path) as string ?? ""}`;
    case "edit":      return `edit: ${(a?.path ?? a?.relative_path) as string ?? ""}`;
    case "grep":      return `grep: ${trim((a?.pattern as string) ?? "")}`;
    case "glob":      return `glob: ${trim((a?.pattern as string) ?? "")}`;
    case "ls":        return `ls: ${(a?.path as string) ?? "."}`;
    case "task":      return `subagent: ${trim((a?.description as string) ?? "")}`;
    default:          return name;
  }
}
```
未知工具或字段缺失 → 退回只显示 `name`。

### 4.4 附件回传：CLI 工具 + 文件队列

agent 的 shell tool 可执行（项目 bin 暴露）：
```
claw-attach-image /path/to/x.png [--caption "说明"]
claw-attach-file  /path/to/x.pdf [--caption "..."]
```
内部行为：
1. 把目标文件复制到 `data/attachments/pending/<workspaceId>/<isoTs>-<basename>`
2. 追加一行到 `data/attachments/queue.jsonl`：
   ```json
   {"workspaceId":"default","kind":"image","path":"...","caption":"...","queuedAt":1735000000000}
   ```

Orchestrator **在 `run.wait()` 之后**：
- 读取 `queue.jsonl` 中属于当前 `workspaceId` 的所有条目
- 按顺序调 `IMessenger.sendImage / sendDocument` 发送
- 成功后删除对应行 + 文件
- 失败的条目保留并日志告警；下次 run 结束会再尝试

### 4.5 入站图片

```
Telegram 用户发图 → TelegramMessenger 下载 photo (largest size) → Buffer → base64 + mimeType
   → on("image", { chatId, userId, data, mimeType, caption })
   → Orchestrator: agent.send({ text: caption ?? "用户发来一张图片，请分析",
                                 images: [{ data, mimeType }] })
```
之后流程与文本完全相同。

### 4.6 输出渲染：HTML 模式

- Telegram 三种 parse_mode 中 `HTML` 对 LLM 输出最友好；MarkdownV2 转义太严格，纯文本失去格式。
- 渲染管线：assistant text → 极简 markdown → HTML（仅处理：代码块 → `<pre><code>`、行内代码 → `<code>`、粗体 / 斜体 / 链接）；其余内容做 HTML 实体转义。
- 自写 ~80 行的极简渲染器，避免大依赖（保持单元可测）。

---

## 5. 定时任务、配置、错误、白名单、退出

### 5.1 定时任务（Reminders）

`data/reminders.json`：
```json
{
  "items": [
    { "id": "r-1", "at": "2026-05-06T09:00:00", "tz": "Asia/Shanghai",
      "kind": "prompt", "workspace": "default",
      "prompt": "看一下今天 BTC 价格并告诉我", "createdAt": 1735000000000 },
    { "id": "r-2", "at": "2026-05-06T08:00:00", "tz": "Asia/Shanghai",
      "kind": "text", "text": "起床啦！", "createdAt": 1735000001000 }
  ]
}
```
调度策略：
- 启动时全表扫描 → 对每条 reminder 用 `setTimeout(..., delayMs)` 注册（不引入 cron 库；自管），过期 (at < now) 的丢弃并日志。
- `add` / `del` 后重新调度。
- 触发时：
  - `kind: "text"` → `IMessenger.sendText(primaryChatId, text)` 直接发。
  - `kind: "prompt"` → `orchestrator.runPrompt(workspace, prompt, { initiator: "reminder" })`，正常流式回传到 primaryChatId。
- 第一版**只支持一次性**；触发后从列表移除。重复任务作为 P1 后续迭代（数据结构里预留 `recurrence?` 字段，但不实现）。
- 时区：默认 `Asia/Shanghai`，可在配置覆盖；reminder 自带 `tz` 则以 reminder 为准。

### 5.2 配置加载（zod）

```typescript
const ConfigSchema = z.object({
  telegram: z.object({
    botToken: z.string(),
    allowedUserIds: z.array(z.number()).min(1),
    parseMode: z.enum(["HTML", "Markdown", "plain"]).default("HTML"),
  }),
  cursor: z.object({
    apiKey: z.string(),
    defaultModel: z.object({
      id: z.string().default("auto"),
      params: z.array(z.object({ id: z.string(), value: z.string() })).default([]),
    }).default({ id: "auto", params: [] }),
    settingSources: z.array(
      z.enum(["project","user","team","mdm","plugins","all"])
    ).default(["project","user"]),
    sandboxOptions: z.object({ enabled: z.boolean() }).optional(),
  }),
  workspaces: z.object({ autoRegisterCwd: z.boolean().default(true) }).default({}),
  mcpServers: z.record(z.unknown()).optional(),
  reminders: z.object({ timezone: z.string().default("Asia/Shanghai") }).default({}),
  paths: z.object({ dataDir: z.string().default("./data") }).default({}),
  logging: z.object({ level: z.enum(["debug","info","warn","error"]).default("info") }).default({}),
});
```

加载顺序：
1. `./config.json`（或 `--config <path>`）
2. 环境变量覆盖：`TELEGRAM_BOT_TOKEN`、`CURSOR_API_KEY` 优先
3. zod parse；失败 → 结构化错误 + 退出

`config.example.json` 提交；`config.json` `.gitignore`。

### 5.3 错误处理

| 错误 | 策略 |
| --- | --- |
| `AuthenticationError` | **致命** → 日志告警 + 退出（systemd 拉起；提醒检查 `CURSOR_API_KEY`） |
| `RateLimitError` | 指数退避 3 次；继续失败 → 把消息 + 等待建议回写 Telegram |
| `ConfigurationError` | 详情转用户友好提示发回 Telegram |
| `IntegrationNotConnectedError` | 把 `helpUrl` 直接发给用户 |
| `NetworkError` | 指数退避 3 次（仅当 `isRetryable`） |
| `UnknownAgentError` | 走 `isRetryable` 兜底 |
| 非 SDK 错误 | grammy `errorBoundary` 兜底 + 日志 + 简短 Telegram 反馈 |

错误回 Telegram 统一格式：
```
⚠️ Error: <短摘要>

<可选：建议>
```

### 5.4 白名单 / 隐私 / 安全

- `allowedUserIds` 不在 → 静默 drop。
- `data/primary_chat.json` 记录主 chatId（白名单用户首次私聊后写入；reminders 用它推送）。
- 日志中 token / apiKey 一律 mask 成 `***`（pino redact）。
- agent 跑 shell 的潜在风险：因为是单用户、机器主人自己用，README 显著警告：bot 可执行主人本机命令；切勿把 token 给别人。
- `local.sandboxOptions.enabled` 可作为可选保险（macOS 的 sandbox-exec），配置默认关闭、文档说明权衡。

### 5.5 优雅退出

`SIGINT` / `SIGTERM`：
1. `messenger.stop()` 停止接收新消息
2. 对所有 active run 调 `run.cancel()`
3. 对所有缓存 SDKAgent `await agent[Symbol.asyncDispose]()`
4. flush 所有 in-memory 数据到 JSON 文件（原子写：`tmp + rename`）
5. `process.exit(0)`

启动时若发现 `data/*.json` 有半写文件（`*.tmp`）→ 报警并丢弃。

---

## 6. 技术栈、目录、测试、部署、微信预留

### 6.1 技术栈

- Node.js ≥ 20.10（`await using` 需要）
- TypeScript 5.5+，ESM
- 包管理：pnpm（推荐；npm 兼容）
- **关键依赖**：
  - `@cursor/sdk`、`grammy`、`zod`、`pino` + `pino-pretty`
  - `dayjs` + tz/utc 插件、`mime-types`、`commander`
  - 可选 `dotenv`（也可用 `node --env-file`）
- **dev**：`vitest`、`tsx`、`tsup`、`eslint` + `@typescript-eslint`、`prettier`

### 6.2 目录布局

```
cursor-claw/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── eslint.config.js
├── .prettierrc
├── .gitignore                       (排除 data/、config.json、.env、dist/)
├── README.md
├── config.example.json
├── docs/
│   ├── superpowers/specs/2026-05-05-cursor-claw-design.md  ← 本设计
│   └── architecture.md
├── data/                            (运行时生成)
│   ├── workspaces.json
│   ├── sessions.json
│   ├── reminders.json
│   ├── primary_chat.json
│   └── attachments/
│       ├── pending/<workspaceId>/...
│       └── queue.jsonl
├── src/
│   ├── core/
│   │   ├── messenger/{IMessenger.ts, types.ts}
│   │   ├── orchestrator/{AgentOrchestrator.ts, streamRenderer.ts,
│   │   │                  toolSummary.ts, busyPolicy.ts}
│   │   ├── workspace/WorkspaceRegistry.ts
│   │   ├── session/SessionStore.ts
│   │   ├── attachment/AttachmentQueue.ts
│   │   ├── reminders/ReminderScheduler.ts
│   │   ├── access/AccessControl.ts
│   │   ├── render/markdownToHtml.ts
│   │   └── persist/jsonStore.ts
│   ├── adapters/
│   │   ├── telegram/{TelegramMessenger.ts, grammyClient.ts}
│   │   └── wechat/{README.md, WechatMessenger.ts}   (第一版骨架)
│   ├── integrations/clawfox/clawfox.ts
│   ├── config/{schema.ts, loadConfig.ts}
│   ├── commands/{parser.ts, handlers/{ws.ts, reset.ts, cancel.ts,
│   │              status.ts, model.ts, remind.ts, help.ts}}
│   ├── tools/{attach-image.ts, attach-file.ts}
│   ├── logger.ts
│   └── bin/cursor-claw.ts
├── tests/
│   ├── unit/...
│   └── integration/orchestrator-with-stub-messenger.test.ts
└── deploy/
    ├── systemd/{cursor-claw.service, README.md}
    └── install.sh
```

### 6.3 `package.json` 关键 bin / scripts

```json
{
  "name": "cursor-claw",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20.10.0" },
  "bin": {
    "cursor-claw":       "./dist/bin/cursor-claw.js",
    "claw-attach-image": "./dist/tools/attach-image.js",
    "claw-attach-file":  "./dist/tools/attach-file.js"
  },
  "scripts": {
    "dev":       "tsx watch src/bin/cursor-claw.ts",
    "build":     "tsup",
    "start":     "node dist/bin/cursor-claw.js",
    "test":      "vitest run",
    "test:watch":"vitest",
    "lint":      "eslint src tests",
    "format":    "prettier --write src tests",
    "typecheck": "tsc --noEmit"
  }
}
```

### 6.4 测试策略（TDD）

**单元测试（vitest）**
- `jsonStore`：原子写 / 并发覆盖防御
- `WorkspaceRegistry`：增删切换、active 持久化
- `SessionStore`：读写、resume 数据
- `ReminderScheduler`：用 fake timers 模拟到点触发、过期丢弃、增删后重排
- `AttachmentQueue`：入队 / 消费 / 失败回退
- `markdownToHtml`：各种 LLM 输出（含三反引号、嵌套代码、转义、超长）
- `AccessControl`：白名单边界
- `commands/parser`：命令解析与边界
- `toolSummary`：未知工具防御式解析

**集成测试**
- 使用桩 SDKAgent + 桩 IMessenger，覆盖：
  - 文本流程（含工具事件、节流、长消息切分）
  - 忙状态保护
  - `/cancel`
  - 附件回传整合
  - 错误重试链路

**真实 SDK 烟囱测试**（手动）
- `tests/manual/sdk_smoke.ts`：用真实 `CURSOR_API_KEY` 跑一次 `Agent.prompt("hello")`。

### 6.5 部署：Linux systemd（user-level + linger）

`deploy/systemd/cursor-claw.service`：
```ini
[Unit]
Description=cursor-claw Telegram bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/cursor/cursor-claw
ExecStart=/usr/bin/env node %h/cursor/cursor-claw/dist/bin/cursor-claw.js
EnvironmentFile=%h/cursor/cursor-claw/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

`deploy/install.sh` 完成：
- 复制单元文件到 `~/.config/systemd/user/`
- `loginctl enable-linger $USER`
- `systemctl --user daemon-reload && systemctl --user enable --now cursor-claw.service`

reminders 不需要单独 timer 单元（已内置在主进程），与原版相比简化。

> macOS 备注：本机是 Darwin 25.3.0；macOS 不用 systemd，本地开发用 `npm run dev` 或 `pm2 start dist/bin/cursor-claw.js` 即可；要做开机自启可换成 `launchd`，作为 P1 补一份 `launchd plist`。

### 6.6 微信适配器预留

`src/adapters/wechat/WechatMessenger.ts`：
```typescript
import type { IMessenger, ImagePayload, FilePayload, MessageHandle, SendOptions }
  from "../../core/messenger/IMessenger.js";

export class WechatMessenger implements IMessenger {
  async start() { throw new Error("WechatMessenger 暂未实现"); }
  async stop()  {}
  on() { throw new Error("WechatMessenger 暂未实现"); }
  async sendText(): Promise<MessageHandle>     { throw new Error("not implemented"); }
  async editText(): Promise<void>              { throw new Error("not implemented"); }
  async sendImage(): Promise<MessageHandle>    { throw new Error("not implemented"); }
  async sendDocument(): Promise<MessageHandle> { throw new Error("not implemented"); }
  async sendTyping() {}
}
```

`src/adapters/wechat/README.md` 写明：
- 第一版**不实现**
- 三条接入路径对比（企业微信 webhook / 公众号 / wechaty 个人号）
- 后续接入时只需把 `WechatMessenger` 实现完，并在 `bin/cursor-claw.ts` 装配里加一个分支即可，**core 与 telegram 适配器零改动**

---

## 7. 验收标准（Definition of Done）

第一版被认为完成的可观测条件：

1. 在 macOS 本机运行 `npm run dev`，配置好 `TELEGRAM_BOT_TOKEN` 和 `CURSOR_API_KEY`，能在 Telegram 中：
   - 收到欢迎消息（/start）
   - 在 `default` 工作区里发送 "总结这个仓库的功能"，能在一条消息内看到流式更新与最终摘要。
2. 工具可视化：发出 "找出 src 下所有 TODO 注释"，状态行至少出现一次 `🔧 grep: TODO` 与 `🔧 read: ...`。
3. `/cancel` 在生成中点击后，主消息追加 `(已取消)`，agent 不再继续输出。
4. `!fix this` 在 agent 忙时能强制打断。
5. `/ws add work2 /Users/liwei/code/some-other` + `/ws use work2`，从此后所有消息发到该工作区；切回 `default` 后会话上下文不混。
6. 重启进程后 `/status` 仍显示原 agentId（resume 生效）。
7. 在 agent 干完活后，agent 调 `claw-attach-image /tmp/foo.png`，bot 紧接着把图片发到 Telegram。
8. 在 Telegram 发一张图 + 一段 caption，agent 能看到（验证：让它描述图片内容）。
9. `/remind add 2026-05-06 08:00 起床啦！`，到点收到。
10. 单元测试套件全绿；集成测试（桩 SDK）全绿。
11. README 写明从零启动到 Telegram 跑通的完整步骤。

---

## 8. 风险与已知限制

- **本地多用户/并发**：第一版没有真正的并发保护，工作区池假设只有一个用户在操作。如果并发性变重要，需要把 SDKAgent 操作排队到一个 actor 上。
- **MCP OAuth**：本地 SDK 无法弹浏览器登录；需要的 MCP 服务必须先在 Cursor App 中登录过。文档提示。
- **artifact**：local 运行时不支持 `agent.listArtifacts()`；附件回传完全靠 `claw-attach-*` CLI 工具。
- **流式编辑节流**：Telegram editMessageText 有 RPS 上限；800ms 节流是经验值，若仍触发限速将自动降速。
- **agent shell 风险**：bot 等同于让远程文本控制本机 shell；务必白名单严控、token 严管。
- **macOS 上无 systemd**：第一版 `deploy/` 只给 Linux；macOS 用户用 `pm2` 或 `launchd`（P1 补）。
- **微信适配未做**：第一版仅占位；不要被 README 或 IMessenger 接口误导以为支持。

---

## 9. 实现路线（高层节奏，待 writing-plans 细化）

1. **Skeleton**：仓库初始化、依赖、tsconfig、目录、空模块占位、CI（typecheck + test）
2. **Core 基础设施**：jsonStore、AccessControl、WorkspaceRegistry、SessionStore（含单测）
3. **Messenger 接口与桩**：IMessenger 类型、StubMessenger（仅供测试）
4. **Orchestrator MVP**：runPrompt + stream → StubMessenger（先不接 grammy 也跑通）
5. **Telegram Adapter**：grammy → IMessenger 实现，与现有 orchestrator 拼通
6. **流式渲染**：throttle、长消息切分、HTML 渲染、工具状态行
7. **Commands**：解析与所有 handler
8. **AttachmentQueue + CLI 工具**：attach-image / attach-file
9. **入站图片**
10. **Reminders**
11. **错误处理 / 重试 / 优雅退出**
12. **clawfox 集成**
13. **systemd + install.sh**
14. **微信骨架文件 + README**
15. **README + 文档**

每一步都遵循 TDD（先红再绿再 refactor），每一步结束做一次代码自审 + 集成测试。

---

## 10. 参考

- [Cursor SDK 文档（TypeScript）](https://cursor.com/cn/docs/sdk/typescript)
- [jes/cursor-claw（原版 Python 实现）](https://github.com/jes/cursor-claw)
- [grammy](https://grammy.dev/)
- [vitest](https://vitest.dev/)
