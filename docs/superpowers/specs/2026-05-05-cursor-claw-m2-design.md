# cursor-claw M2 设计文档（入站图片 + 出站附件 + Reminders）

- **作者**：Jem & Claude
- **日期**：2026-05-05
- **状态**：设计已 review，等待 writing-plans
- **依赖**：M1 已完成（87 测试全绿，commit `4cc3807` 之前的所有 M1 工作）

---

## 1. 目标与范围

### 1.1 M2 解决什么

M1 完成了 cursor-claw 的"骨架 + 心脏 + 嘴"——能在 Telegram 上跟本地代码仓库的 Cursor agent 文本对话、流式输出、切换工作区、取消、reset、查 status、改 model。但远程办公一类的真实场景里，还差三件事：

1. **入站图片**：用户在 Telegram 拍个截图发给 bot，agent 应该能"看见"
2. **出站附件**：agent 在 shell 里跑完测试 / 渲染了一张图后，应该能把文件发回给用户
3. **Reminders**：到点提醒一句话；或更进一步，到点让 agent 自动跑某个 prompt（"每天早上看 BTC 价格再写一段总结"）

M2 把这三件事补齐，并且**不动 M1 模块的任何对外接口**——M2 只是在已有 hook 上接通真实实现 + 新增 4 个独立模块。

### 1.2 不在 M2 范围

| 子系统 | 状态 |
|--------|------|
| systemd / launchd 部署 | M3（独立做） |
| 微信适配器实现 | M3+ |
| 重复（cron）reminder | P1 / M2.1 |
| 入站文件（.pdf / .docx 等） | 不做（spec 也没提） |
| 多用户 / 多 chat fan-out | M3+ |
| Homebrew / Scoop 等额外 attach CLI 分发 | 不做 |

---

## 2. 架构与新增模块拓扑

M2 新增 4 个模块、扩展 4 个 M1 模块。所有依赖单向、无循环。

```
src/
├── core/
│   ├── reminders/                          [新]
│   │   ├── ReminderStore.ts                持久化 (data/reminders.json)
│   │   ├── ReminderScheduler.ts            启动扫表 + setTimeout 自管 + 触发
│   │   └── timeParser.ts                   10m / 09:00 / YYYY-MM-DD HH:MM
│   ├── attachments/                        [新]
│   │   ├── AttachmentQueue.ts              读 / 写 / 删 queue.jsonl
│   │   └── AttachmentDispatcher.ts         run.wait() 后扫并发送
│   └── orchestrator/AgentOrchestrator.ts   [扩]
│        - runPromptWithImages({chatId, text, images, force?})
│        - runReminder({chatId, kind, payload, workspaceId?})
│        - runPrompt 在 run.wait() 之后调 dispatcher.flushForCwd()
├── commands/handlers/remind.ts             [新] /remind add|list|del
├── adapters/telegram/TelegramMessenger.ts  [扩]
│        - message:photo 缓存 media_group_id；200ms debounce 后 emit imageGroup
│        - sendImage / sendDocument 实际实现（M1 是占位）
├── tools/                                  [新]
│   ├── attach-image.ts                     bin: claw-attach-image
│   └── attach-file.ts                      bin: claw-attach-file
└── bin/cursor-claw.ts                      [扩]
       - imageGroup 事件接通 orchestrator.runPromptWithImages
       - 启动 ReminderScheduler；进程退出时 dispose
       - 启动时给 currentWorkspace.cwd/.claw/data-dir.txt 写入 dataDir
```

依赖关系：

```
                          ┌─ /remind ─► RemindHandler ──► ReminderScheduler ─┐
TelegramMessenger ─────┐  │                                                   │
   imageGroup event ───┼──┴────────────────► AgentOrchestrator ◄──────────────┘
                       │                              │
                       │                              ▼
                       │                  AttachmentDispatcher
                       │                              │
                       └◄────── sendImage/Document ───┘
                                              ▲
                       AttachmentQueue ◄──────┘
                              ▲
                              │ append
                       attach-image / attach-file CLI（独立子进程）
```

---

## 3. A — 入站图片

### 3.1 流程

```
Telegram 用户发图（1 张 / 多张同 album / 带 caption）
   │
   ▼
TelegramMessenger.bot.on("message:photo"):
   if msg.media_group_id:
       pendingGroups.get(media_group_id).push(msg)
       重置该 group 的 200ms debounce timer
   else:
       立即下载并 emit("imageGroup", { 单张图 })

   debounce 触发时:
       取该 group 所有 photo → 选 largest size → 下载 base64
       取第一条非空 caption
       emit("imageGroup", { chatId, userId, images[], caption })
       pendingGroups.delete(media_group_id)
   │
   ▼
bin/cursor-claw.ts: handleImageGroup(msg)
   - AccessControl 过滤
   - text = caption ?? defaultPrompt（单图 / 多图 不同）
   - orchestrator.runPromptWithImages({ chatId, text, images })
   │
   ▼
AgentOrchestrator.runPromptWithImages:
   - 走与 runPrompt 完全相同的 ensureAgent → busyPolicy → renderer 流程
   - 唯一差别: agent.send({ text, images: [{ data, mimeType }, ...] })
```

### 3.2 IMessenger 接口扩展

```typescript
interface IncomingImageGroup {
  chatId: string;
  userId: number;
  images: Array<{ data: string; mimeType: string }>;
  caption?: string;
}
type Handlers = {
  text: (m: IncomingText) => void;
  image: (m: IncomingImage) => void;          // M1 已有，单张快路径，保留以兼容测试
  imageGroup: (m: IncomingImageGroup) => void; // M2 新增，正式入口
};
```

实际接通时只用 `imageGroup`；`image` 退役但保留接口，避免 M1 测试改动。

### 3.3 失败兜底

| 失败场景 | 策略 |
|----------|------|
| Telegram getFile / 下载失败 | 立刻给用户 plain reply：`下载图片失败：{msg}`；不入队不送 agent |
| `images.length > images.maxImagesPerPrompt`（默认 8） | 截前 N 张并 reply 提示 |
| caption 长度 > 800 | 截断 |
| 没 caption | 默认文案；可 config 覆盖 |

### 3.4 测试

- `tests/unit/imageGroupBuffer.test.ts`：debounce 缓冲单元（抽出纯逻辑类测试）
- `tests/integration/orchestrator.imageGroup.test.ts`：stub messenger 触发 imageGroup → orchestrator 调 stubRuntime 的 send（参数 images[] 正确）

---

## 4. B — 出站附件

### 4.1 总体流程

```
Cursor agent 在 shell tool 内（一次 run 中可调多次）:
   $ claw-attach-image /tmp/screenshot.png --caption "构建结果"
   $ claw-attach-file  /tmp/report.pdf
   │
   ▼
attach-image / attach-file CLI 进程:
   1. 解析 argv (file path, --caption, 可选 --workspace)
   2. 校验文件存在 + 大小 (<= attachments.maxFileSizeBytes)
   3. 复制到 dataDir/attachments/pending/<basename>.<isoTs>
   4. 追加一行到 dataDir/attachments/queue.jsonl:
      {
        cwd: "/Users/.../proj",   // 用 cwd 给 orchestrator 反查 workspace
        kind: "image" | "file",
        path: ".../pending/foo.png",
        caption: "...",
        queuedAt: 1735000000000
      }
   5. 进程 exit 0
   │
   ▼ (异步：cursor-claw 主进程不知道但稍后会扫)
   │
   ▼
AgentOrchestrator.runPrompt(...) 在 run.wait() 之后:
   - dispatcher.flushForCwd(workspaceCwd, chatId)
   │
   ▼
AttachmentDispatcher.flushForCwd(cwd, chatId):
   - 读 queue.jsonl 全表
   - 找 entry.cwd === cwd 的所有条目（用 cwd 反查）
   - 按 queuedAt 升序循环：
        try:
          if kind=="image": messenger.sendImage(chatId, {data: base64(file), caption})
          else:             messenger.sendDocument(chatId, {data: base64(file), caption})
          删 entry + 删 pending file
        catch e:
          logger.error；保留 entry 留下次再试
   - atomic write 重写 queue.jsonl（保留没成功的 entry）
```

### 4.2 CLI 工具实现细节

`package.json`：

```json
{
  "bin": {
    "claw-attach-image": "./dist/tools/attach-image.js",
    "claw-attach-file":  "./dist/tools/attach-file.js"
  }
}
```

每个 bin 是 ~50 行的小脚本，**完全独立于 cursor-claw 主进程**：只读 `cwd / argv / 环境`，写文件，不依赖 logger / config。出错以 stderr + exit 1，agent 在 shell 里能看到。

CLI 找数据目录的策略：

1. `--data-dir` 参数显式指定
2. 否则读环境变量 `CLAW_DATA_DIR`
3. 否则从 cwd 向上找最近的 `.claw/data-dir.txt`，里面是绝对路径
4. 还找不到 → stderr：`could not locate cursor-claw data dir; set CLAW_DATA_DIR or run cursor-claw once in this workspace` + exit 1

`.claw/data-dir.txt` 由 cursor-claw 主进程在每次 register / `/ws use` 切换时写入（如果与现有不同），文件只含 dataDir 绝对路径一行。

### 4.3 失败与重试

| 场景 | 行为 |
|------|------|
| pending 文件已被外部删掉 | 跳过 + 删 entry + 日志告警 |
| sendImage / sendDocument 网络失败 | entry 保留；下次 run.wait() 重试；最多 `attachments.maxRetries` 次（默认 3），超出则 sendText 告知用户：`⚠️ 附件投递失败 N 次：{path}` 后丢弃 entry |
| 文件 > maxFileSizeBytes | CLI 阶段拒；stderr：`file too large: {size} > {limit} bytes` + exit 1 |
| 单次 flush 超过 `maxAttachmentsPerFlush`（默认 10） | 警告日志 + 一次性全发（Telegram 自身限 30/秒，足够） |

> 注：dispatcher 在 `run.wait()` **之后**才跑，已经不在 active run 范围内，所以 `/cancel` 不会作用到 flush 阶段；用户如果在 flush 中途发 `/cancel`，被 cancel 的是后续 prompt，不是当前 flush。

### 4.4 测试

- `tests/unit/attachmentQueue.test.ts`：写 / 读 / 删 + 并发追加（用 read-modify-write，文件级原子）
- `tests/unit/attachCli.test.ts`：spawn child_process 测试（fixture 文件验证 pending 与 queue 都正确）
- `tests/integration/attachmentDispatcher.test.ts`：stub messenger，dispatcher.flushForCwd 把 queue 中条目正确发完

---

## 5. C — Reminders

### 5.1 数据结构

`data/reminders.json`：

```json
{
  "items": [
    {
      "id": "r-2026-05-06-090000-001",
      "createdAt": 1735000000000,
      "createdBy": 8255870702,
      "chatId": "8255870702",
      "kind": "text",
      "at": 1735056000000,
      "tz": "Asia/Shanghai",
      "text": "起床啦"
    },
    {
      "id": "r-2026-05-06-093000-002",
      "createdAt": 1735000001000,
      "createdBy": 8255870702,
      "chatId": "8255870702",
      "kind": "prompt",
      "at": 1735057800000,
      "tz": "Asia/Shanghai",
      "prompt": "看一下 BTC 当前价格",
      "workspaceId": "default"
    }
  ]
}
```

| 字段 | 必填 | 含义 |
|------|------|------|
| `id` | ✓ | `r-{YYYYMMDD-HHMMSS}-{seq3}`，时间近似可直观看 |
| `createdAt` | ✓ | UTC ms 时间戳 |
| `createdBy` | ✓ | 创建者 Telegram userId（日志 / 审计） |
| `chatId` | ✓ | 触发推送目标（single-user 场景 = createdBy） |
| `kind` | ✓ | `"text"` 或 `"prompt"` |
| `at` | ✓ | UTC ms（解析时已应用 tz） |
| `tz` | ✓ | IANA 时区名，默认从 config.reminders.timezone |
| `text` | kind=text | 直接 sendText |
| `prompt` | kind=prompt | 走 orchestrator.runPrompt |
| `workspaceId` | kind=prompt | 触发时用哪个 workspace；缺省 = 创建时 currentWorkspaceId |

### 5.2 命令语法

```
/remind add text   <时间表达式> <内容>
/remind add prompt <时间表达式> <prompt 内容>
/remind list
/remind del <id>
```

时间表达式三种（`timeParser.ts`）：

| 形式 | 例子 | 解析 |
|------|------|------|
| 相对 | `10m`, `1h30m`, `2d`, `45s` | now + duration，最小粒度秒 |
| 当日 HH:MM | `09:00`, `22:30` | 今日该时刻；若已过 → 明日 |
| 绝对 | `2026-05-06 09:00`, `2026-05-06T09:00` | 显式日期，tz 默认 `Asia/Shanghai` |

非法格式 → reply：`⚠️ 时间格式不识别：示例 10m / 09:00 / 2026-05-06 09:00`。

时间上限：`reminders.maxAheadDays`（默认 30 天）。超过 → reply 拒收。

### 5.3 调度（ReminderScheduler）

```typescript
class ReminderScheduler {
  start(): void                      // 启动扫表，注册所有未触发的 setTimeout
  add(item: Reminder): Promise<void> // 写 store + 注册一个 setTimeout
  remove(id: string): Promise<void>  // 删 store + clearTimeout
  list(): Reminder[]                 // 当前持有
  dispose(): void                    // 关进程时清所有 timer
}
```

策略：

- 启动扫表：`item.at < now` → 丢弃 + 日志（一次性、过期不补发）
- `setTimeout(fire, item.at - now)`；setTimeout 32-bit 上限 ~24.8 天 → 链式 setTimeout（每段最多 21 天）；`maxAheadDays` 30 配合分段
- 触发：
  - `kind=text` → `messenger.sendText(item.chatId, item.text)`
  - `kind=prompt` → `orchestrator.runPrompt({ chatId, text: item.prompt, force: false, workspaceId })`
- 触发后 `store.remove(id)`（一次性）

### 5.4 busy 冲突

prompt 类 reminder 触发时，目标 workspace 可能正忙：

- reminder 触发时 **始终 force=false**（不打断用户当前对话）
- 若 busy → busyPolicy 拒；scheduler **重排一次**`at = now + 60s` 并**写回 store**（持久化新 `at`，让进程崩溃后下次启动也能恢复正确时刻），并 `messenger.sendText(chatId, "⏰ 提醒延后 1 分钟（agent 正忙）：'{prompt 前 60 字}'")`
- 60 秒后再次 busy → 直接 `messenger.sendText(chatId, "⏰ 提醒：{prompt}")`，**不再重排**，并 `store.remove(id)`（兜底，把 prompt 当 text 推给用户）
- 重排只发生 1 次：每个 reminder 在内存里维护 `attemptCount`（不持久化，进程重启重置为 0），值 ≥ 1 时不再重排

### 5.5 测试

- `tests/unit/timeParser.test.ts`：相对 / HH:MM / 绝对 / tz / 非法 / 上限
- `tests/unit/reminderStore.test.ts`：add / remove / list 持久化
- `tests/integration/reminderScheduler.test.ts`：fake timer + stub orchestrator + stub messenger，验证 text / prompt 两类触发 + busy 重排
- `tests/unit/remindCommand.test.ts`：/remind add|list|del 各路径

---

## 6. 配置 / 命令文档 / 兼容性

### 6.1 配置变更

新增字段（zod schema）：

```typescript
const ConfigSchema = z.object({
  // ... M1 既有字段 ...
  reminders: z.object({
    timezone: z.string().default("Asia/Shanghai"),
    maxAheadDays: z.number().int().min(1).max(365).default(30),
  }).default({}),
  attachments: z.object({
    maxFileSizeBytes: z.number().int().min(1024).max(50 * 1024 * 1024).default(20 * 1024 * 1024),
    maxAttachmentsPerFlush: z.number().int().min(1).max(50).default(10),
    maxRetries: z.number().int().min(0).max(5).default(3),
  }).default({}),
  images: z.object({
    maxImagesPerPrompt: z.number().int().min(1).max(16).default(8),
    defaultPromptSingle: z.string().default("请分析这张图片"),
    defaultPromptMulti: z.string().default("请分析这些图片"),
    mediaGroupDebounceMs: z.number().int().min(50).max(2000).default(200),
  }).default({}),
});
```

### 6.2 /help 文本扩展

```
📅 Reminders
  /remind add text <时间> <内容>     一次性纯文本提醒
  /remind add prompt <时间> <prompt>  到点跑 agent
  /remind list                       看现有
  /remind del <id>                   删除

时间格式：相对 (10m, 1h30m) | 当日 HH:MM | YYYY-MM-DD HH:MM

📎 Agent 端附件 (在 Cursor agent 的 shell tool 内调用)
  claw-attach-image /path/to/x.png [--caption "..."]
  claw-attach-file  /path/to/x.pdf [--caption "..."]
  ↑ run 结束时自动发回 Telegram

🖼 给 bot 发图 / 多图 album → 自动转给 agent 分析
```

### 6.3 .gitignore

```
.claw/                    # M2 引入：workspace 内的 dataDir 指针
data/attachments/         # 已经在 data/ 下，复述提醒
```

### 6.4 测试矩阵

| 文件 | 类型 | 估用例数 |
|------|------|----------|
| `imageGroupBuffer.test.ts` | unit | 4 |
| `attachmentQueue.test.ts` | unit | 5 |
| `attachCli.test.ts` | unit (spawn) | 4 |
| `timeParser.test.ts` | unit | 8 |
| `reminderStore.test.ts` | unit | 4 |
| `remindCommand.test.ts` | unit | 6 |
| `orchestrator.imageGroup.test.ts` | integration | 3 |
| `attachmentDispatcher.test.ts` | integration | 4 |
| `reminderScheduler.test.ts` | integration | 5 |

加 M1 的 87 个 → M2 完成后 ~127 个测试。

### 6.5 兼容性 / 数据迁移

- 既有 M1 用户的 data/ 目录：M2 读到不存在的 `reminders.json` 与 `attachments/queue.jsonl` 时**自动初始化为空**
- 既有 sessions.json / workspaces.json：完全不变
- 配置：M1 的 `config.json` 不需要改，新字段全部有 default
- 接口：`IMessenger` 仅扩展（imageGroup 事件 + sendImage/Document 实际实现），不破坏

---

## 7. 验收标准

M2 完成需同时满足：

1. **入站图片**：用 Telegram 客户端发一张带 caption 的图给 bot，agent 在该 caption 提示下成功 send 一次（含 images 字段），并流式回 Telegram
2. **入站 album**：连续上传同一个 album 的 3 张图，bot 端**只**触发一次 prompt（包含 3 张 image），caption 来自首张
3. **出站附件**：在 cursor-claw 仓库的 cursor agent 中执行 `bash -c 'claw-attach-image /tmp/test.png --caption "测试"'`；本次 run 结束后 Telegram 端立即收到 image
4. **Reminders text**：`/remind add text 10s 起床啦`；10 秒后收到 plain text "起床啦"，且 reminders.json 里该条已移除
5. **Reminders prompt**：`/remind add prompt 10s 一句话总结这个仓库`；10 秒后看到 agent 流式回复
6. **Reminders busy**：手动 `/remind add prompt 5s ...` 之后立刻 `!长 prompt 让 agent 忙起来`；reminder 触发时 busy → 60 秒后自动重排或退化 sendText（验证至少有一种发生）
7. 所有 M2 新增测试 + 全部 M1 既有测试 → 全绿
8. typecheck / lint / build → 全绿
9. 一次完整的 e2e smoke：Telegram 端发图 → agent 回 → reminder 到点 → agent 调 attach CLI → 用户收到附件，全程无崩溃

---

## 8. 风险与缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| Cursor SDK 在 local 模式不接受 images 参数 | 中 | M2 第一周用 `tests/manual/test_model.ts` 改造单测；如不行降级为：把图片保存到 data/incoming-images/，给 agent 一段 prompt 含路径，让 agent 自己读 |
| media_group_id 在 grammy 的某些配置下不可用 | 低 | grammy 1.x 已暴露此字段；fallback：仅做单图 |
| 100 个 reminders 同时启动 setTimeout 把内存吃爆 | 极低 | 进程内 setTimeout 是非常便宜的对象；100 个 timer 完全可承受 |
| attach CLI 在 Windows 路径上 cwd 含空格 | 中 | path 用 `path.resolve` + 全程用绝对路径；CLI 对 argv[2] 走 path.resolve |
| 多个 attach 并发追加 queue.jsonl 互踩 | 低 | append + line-based JSON 自然互不破坏；orchestrator 读取时 read-modify-write 加文件锁（advisory） |
| Telegram bot API 限流（30/s） | 低 | maxAttachmentsPerFlush 默认 10；不会触限流 |

---

## 9. 时间预估

按 TDD（每个任务包含 RED → GREEN → REFACTOR + commit），与 M1 同节奏估：

| 段 | 估时 |
|------|------|
| 入站图片（A） | 0.5 day |
| 出站附件（B） | 1.5 day |
| Reminders（C） | 1.5 day |
| 集成 + smoke + 文档 | 0.5 day |
| **合计** | ~4 day |

详细任务拆分由后续 writing-plans skill 输出。
