# StreamRenderer 跨 chunk markdown 渲染修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 e2e smoke 暴露的 markdown 不渲染 bug：让 StreamRenderer 内部存原始 markdown、`compose()` 输出时整体调用 `markdownToHtml`，跨 chunk 的成对标记（`**bold**` / `` `code` `` / 链接 / 代码块）都能被 Telegram 正确渲染。

**Architecture:** `textBuffer` 改为存 raw markdown；新增 `finalizeExtra` 字段保留 finalize 时的 HTML 末尾；`compose()` 拼接时只有 textBuffer 这一段套 `markdownToHtml`，其它字段保持 HTML 直传；`AgentOrchestrator` 去掉对每个 chunk 的 `markdownToHtml` 包装。

**Tech Stack:** TypeScript / Vitest / Node 20 / 既有 `src/core/render/markdownToHtml.ts`

参考 spec：`docs/superpowers/specs/2026-05-06-streamrenderer-markdown-design.md`

---

## File Structure

| 文件 | 责任 | 改动 |
|---|---|---|
| `src/core/orchestrator/streamRenderer.ts` | 流式渲染状态机 | 内部重构（`textBuffer` 存 raw / `finalizeExtra` 新字段 / `compose` 整体调 `markdownToHtml`） |
| `src/core/orchestrator/AgentOrchestrator.ts` | 编排核心 | 去掉对 chunk 的 `markdownToHtml` 包装 |
| `src/bin/cursor-claw.ts` | 入口装配 | `streamOptions.maxLen` 从 3500 调到 3000 |
| `tests/unit/streamRenderer.test.ts` | StreamRenderer 单测 | 新建：跨 chunk markdown 行为覆盖 |

`tests/unit/markdownToHtml.test.ts` / `tests/integration/orchestrator.test.ts` 不动。

---

## Task 1：写跨 chunk markdown 失败测试（RED）

**Files:**
- Create: `tests/unit/streamRenderer.test.ts`

> **设计要点：** 这是修复的 RED 步骤；测试现在跑必然失败，因为现状 `textBuffer` 已 escape + 局部 inline 转换，无法做整体转换。每个 case 模拟 SDK 把成对 markdown 标记切到不同 chunk，断言最终 `editText` 收到的文本是渲染后的 HTML。

- [ ] **Step 1：新建测试文件**

```ts
// tests/unit/streamRenderer.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { StreamRenderer } from "../../src/core/orchestrator/streamRenderer.js";
import { StubMessenger } from "../helpers/StubMessenger.js";

describe("StreamRenderer", () => {
  let messenger: StubMessenger;
  let renderer: StreamRenderer;

  beforeEach(async () => {
    vi.useFakeTimers();
    messenger = new StubMessenger();
    renderer = new StreamRenderer(messenger, "c1", { throttleMs: 10, maxLen: 3000 });
    await renderer.start("⏳");
  });

  // 拿到最近一次 editText 的文本
  function lastEditText(): string {
    const last = [...messenger.calls].reverse().find((c) => c.kind === "editText");
    return last && last.kind === "editText" ? last.text : "";
  }

  it("跨 chunk **bold** 在 finalize 后整体渲染成 <b>", async () => {
    await renderer.pushText("**A");
    await renderer.pushText("B**");
    await vi.advanceTimersByTimeAsync(50);
    await renderer.finalize();
    expect(lastEditText()).toContain("<b>AB</b>");
    expect(lastEditText()).not.toContain("**");
  });

  it("跨 chunk 行内 `code` 渲染成 <code>", async () => {
    await renderer.pushText("文本 `co");
    await renderer.pushText("de` 后续");
    await vi.advanceTimersByTimeAsync(50);
    await renderer.finalize();
    expect(lastEditText()).toContain("<code>code</code>");
  });

  it("跨 chunk 三反引号代码块渲染成 <pre><code>", async () => {
    await renderer.pushText("```ts\n");
    await renderer.pushText("const x = 1;\n");
    await renderer.pushText("```");
    await vi.advanceTimersByTimeAsync(50);
    await renderer.finalize();
    expect(lastEditText()).toContain("<pre><code>");
    expect(lastEditText()).toContain("const x = 1;");
  });

  it("跨 chunk 链接 [text](url) 渲染成 <a>", async () => {
    await renderer.pushText("点击 [link](htt");
    await renderer.pushText("ps://x.com) 来访问");
    await vi.advanceTimersByTimeAsync(50);
    await renderer.finalize();
    expect(lastEditText()).toContain('<a href="https://x.com">link</a>');
  });

  it("agent 输出含 < > & 必须 escape，不破坏 Telegram HTML", async () => {
    await renderer.pushText("if a < b && c > d");
    await vi.advanceTimersByTimeAsync(50);
    await renderer.finalize();
    const text = lastEditText();
    expect(text).toContain("&lt;");
    expect(text).toContain("&gt;");
    expect(text).toContain("&amp;");
  });

  it("finalize(extra) 的 extra 是 HTML，不再被 markdownToHtml 转", async () => {
    await renderer.pushText("hello");
    await renderer.finalize("\n<i>(已取消)</i>");
    const text = lastEditText();
    expect(text).toContain("hello");
    expect(text).toContain("<i>(已取消)</i>");
    // extra 中的 < > 不能被 escape 成 &lt;
    expect(text).not.toContain("&lt;i&gt;");
  });

  it("status 与 textBuffer 共存：status 是 HTML，textBuffer 是 raw markdown 整体转", async () => {
    renderer.setStatus("🔧 <b>tool</b>");
    await renderer.pushText("**done**");
    await vi.advanceTimersByTimeAsync(50);
    await renderer.finalize();
    const text = lastEditText();
    // 有些 finalize 会清掉 status，看 finalize 后 textBuffer 段
    expect(text).toContain("<b>done</b>");
  });
});
```

- [ ] **Step 2：跑测试看 RED**

```bash
npx vitest run tests/unit/streamRenderer.test.ts
```

预期：6 个 case 失败（多数 case 的最终文本里仍有字面 `**` / `` ` `` / `[](...)`，因为现状 `pushText` 不会做整体转换；`<b>` / `<code>` / `<a>` 都不会出现）。**这是预期的 RED**。

注意：本任务不 commit，等 GREEN 一起 commit。

---

## Task 2：StreamRenderer 内部重构 + AgentOrchestrator 去 markdownToHtml 包装（GREEN）

**Files:**
- Modify: `src/core/orchestrator/streamRenderer.ts`
- Modify: `src/core/orchestrator/AgentOrchestrator.ts`

> **设计要点：** 一次原子改动，让 Task 1 的测试通过。`textBuffer` 改为 raw markdown；新增 `finalizeExtra` 字段保留 HTML 末尾；`compose()` 中 textBuffer 段套 `markdownToHtml`、外加 try/catch 兜底；`AgentOrchestrator.runInternal` 流式 assistant 分支去掉 markdownToHtml 包装。

- [ ] **Step 1：改 `streamRenderer.ts`**

把整文件替换为：

```ts
// src/core/orchestrator/streamRenderer.ts
import type { IMessenger } from "../messenger/IMessenger.js";
import { markdownToHtml } from "../render/markdownToHtml.js";

export interface StreamRendererOptions {
  // 编辑节流间隔：连续 pushText 时合并到一次 editMessageText 请求
  throttleMs: number;
  // 单条主消息最大字符数（按 raw markdown 长度算；HTML 转换后会增长，这里取保守值留余量）
  maxLen: number;
}

/**
 * 在一条主消息上滚动渲染 assistant text + 状态行。
 * 超过 maxLen 自动开新消息。
 *
 * 渲染契约（M2 polish）：
 * - textBuffer 存 agent 原始 markdown（raw），不预先 escape / 不预先转换
 * - status / finalizeExtra 是已经 HTML 化的字符串（来自我们自己的代码，不来自 agent）
 * - compose() 时只对 textBuffer 段调一次 markdownToHtml(textBuffer)，整体转换避免跨 chunk 切分丢失闭合标记
 *
 * 设计要点：
 * - editMessageText 在 Telegram 有 RPS 限制，所以用节流；连续小 chunk 合并
 * - 长消息切分用 rotate()：finalize 当前主消息（去状态行）→ 发新 placeholder → 新内容写入新消息
 * - 状态行变更也会触发节流刷新（用同一 timer，避免抖动）
 * - markdownToHtml 兜底：极端输入挂掉时 fallback 到 escapeHtml，宁可丢渲染也不能 streaming 中断
 */
export class StreamRenderer {
  private currentMsgId?: string;
  private status: string = "";
  // 注意：raw markdown，不是 HTML
  private textBuffer: string = "";
  // finalize 时附加的 HTML 末尾（如 "(已取消)" / 错误提示），不进 markdownToHtml
  private finalizeExtra: string = "";
  private flushTimer?: NodeJS.Timeout;
  private dirty = false;
  private finalized = false;

  constructor(
    private readonly messenger: IMessenger,
    private readonly chatId: string,
    private readonly opts: StreamRendererOptions,
  ) {}

  async start(initialPlaceholder: string): Promise<void> {
    this.status = initialPlaceholder;
    const handle = await this.messenger.sendText(this.chatId, this.compose());
    this.currentMsgId = handle.messageId;
  }

  setStatus(line: string): void {
    this.status = line;
    this.dirty = true;
    this.scheduleFlush();
  }

  async pushText(chunk: string): Promise<void> {
    // textBuffer 加上 chunk 超长 → 切两段：head 入当前消息后立即 flush + rotate；rest 递归
    // maxLen 按 raw 长度判断，HTML 转换后会增长，外部传 3000 给余量
    if (this.textBuffer.length + chunk.length > this.opts.maxLen) {
      const remaining = Math.max(0, this.opts.maxLen - this.textBuffer.length);
      const head = chunk.slice(0, remaining);
      const rest = chunk.slice(remaining);
      this.textBuffer += head;
      this.dirty = true;
      await this.flushNow();
      await this.rotate();
      if (rest.length > 0) {
        await this.pushText(rest);
      }
      return;
    }
    this.textBuffer += chunk;
    this.dirty = true;
    this.scheduleFlush();
  }

  async finalize(extra?: string): Promise<void> {
    this.finalized = true;
    this.status = "";
    if (extra) this.finalizeExtra += extra;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    // finalize 总要确保最终状态写到 messenger 上：
    // 即使 dirty=false（例如 cancel 路径下没 pushText），也强制 flush 一次，
    // 把状态行清掉 / 把 extra 追加上去
    this.dirty = true;
    await this.flushNow();
  }

  // 把当前 status / textBuffer / finalizeExtra 拼成一段消息体
  // 关键：textBuffer 段做整体 markdownToHtml；status / finalizeExtra 是 HTML 直接拼
  private compose(): string {
    const lines: string[] = [];
    if (this.status) {
      lines.push(this.status, "");
    }
    if (this.textBuffer) {
      lines.push(this.renderTextBufferSafely());
    }
    if (this.finalizeExtra) {
      lines.push(this.finalizeExtra);
    }
    if (lines.length === 0) lines.push("⏳");
    return lines.join("\n");
  }

  // markdownToHtml 整体转换 textBuffer；万一抛错降级为 escapeHtml 兜底
  private renderTextBufferSafely(): string {
    try {
      return markdownToHtml(this.textBuffer);
    } catch {
      return escapeHtmlFallback(this.textBuffer);
    }
  }

  // 把 dirty 状态在 throttle 间隔后写出去
  private scheduleFlush(): void {
    if (this.finalized) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushNow();
    }, this.opts.throttleMs);
  }

  // 立即 flush（绕过 throttle）：在 finalize 和 rotate 时调用
  private async flushNow(): Promise<void> {
    if (!this.dirty || !this.currentMsgId) return;
    this.dirty = false;
    await this.messenger.editText(this.chatId, this.currentMsgId, this.compose());
  }

  // 切到新主消息：textBuffer / finalizeExtra 清空 → 发 placeholder 拿新 messageId
  private async rotate(): Promise<void> {
    this.textBuffer = "";
    this.finalizeExtra = "";
    this.dirty = false;
    const handle = await this.messenger.sendText(this.chatId, "⏳ continuing...");
    this.currentMsgId = handle.messageId;
    // 切完之后状态行可能仍要渲染，标 dirty 让下次 push 触发刷新
    this.dirty = true;
  }
}

// markdownToHtml 兜底专用 escape；正常路径不走这里
function escapeHtmlFallback(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```

- [ ] **Step 2：改 `AgentOrchestrator.ts`**

定位文件中的：

```ts
case "assistant":
  await renderer.pushText(markdownToHtml(event.text));
  break;
```

改成：

```ts
case "assistant":
  // M2 polish：StreamRenderer 内部存 raw markdown + compose 时整体转换；
  // 避免 SDK 把 ** / ` / [ ] 等成对标记切到不同 chunk 后 regex 匹配失败原文残留
  await renderer.pushText(event.text);
  break;
```

同时**删除文件顶部** `import { markdownToHtml } from "../render/markdownToHtml.js";` 这一行（如果除了上面这处之外没有其它使用——用 grep 确认，本仓库目前只在这一处使用）。

- [ ] **Step 3：跑 streamRenderer 单测确认 GREEN**

```bash
npx vitest run tests/unit/streamRenderer.test.ts
```

预期：6 个 case 全部通过。

- [ ] **Step 4：跑全套测试 / typecheck / lint 验证不退步**

```bash
npx vitest run
npx tsc --noEmit
npx eslint src tests
```

预期：所有都通过；总测试数从 139 增长到 145（+6 新测试）。

- [ ] **Step 5：commit**

```bash
git add src/core/orchestrator/streamRenderer.ts \
        src/core/orchestrator/AgentOrchestrator.ts \
        tests/unit/streamRenderer.test.ts
git commit -m "$(cat <<'EOF'
fix(render): 跨 chunk markdown 整体渲染避免成对标记被切丢

之前 AgentOrchestrator 对每个流式 chunk 单独跑 markdownToHtml，
SDK 把 **bold** / `code` / [text](url) 切到两个 chunk 时
regex 匹配不到闭合标记，原文 ** / ` / [ ] 全数残留到 textBuffer，
Telegram HTML parseMode 不渲染 → 用户在 Telegram 看到字面 markdown。

修复：StreamRenderer 内部 textBuffer 存 raw markdown，新增
finalizeExtra 字段保留 finalize 时的 HTML 末尾；compose() 时
只对 textBuffer 段整体 markdownToHtml，其它字段直接拼。
markdownToHtml 异常时降级 escapeHtml 兜底确保 streaming 不中断。

参考 spec：docs/superpowers/specs/2026-05-06-streamrenderer-markdown-design.md
EOF
)"
```

---

## Task 3：bin maxLen 3500 → 3000 留 HTML 增长余量

**Files:**
- Modify: `src/bin/cursor-claw.ts`

> **设计要点：** Telegram 单条消息上限 4096 字符（含 HTML 标签）。textBuffer 存 raw markdown 后，markdownToHtml 转换会让长度增长（`**xxx**` 5 字符 → `<b>xxx</b>` 7 字符；`<` `>` 单字符 → 5/4 字符）。把 maxLen 从 3500 调到 3000 给 HTML 转换留 ~30% 余量。

- [ ] **Step 1：定位并修改**

在 `src/bin/cursor-claw.ts` 中搜索 `maxLen`，应该形如：

```ts
streamOptions: { throttleMs: 250, maxLen: 3500 },
```

改成：

```ts
streamOptions: { throttleMs: 250, maxLen: 3000 },
```

- [ ] **Step 2：跑全测确认不退步**

```bash
npx vitest run
```

预期：145 tests 全绿（如果 bin 装配没在测试里被加载，则不影响）。

- [ ] **Step 3：commit**

```bash
git add src/bin/cursor-claw.ts
git commit -m "$(cat <<'EOF'
chore(bin): streamOptions.maxLen 3500 → 3000 给 HTML 增长留余量

textBuffer 改为存 raw markdown 后，compose 时整体 markdownToHtml 转换
让消息长度净增长（** 配对净 +1 / < 转 &lt; 净 +3 等）。
保守把 maxLen 调到 3000，避免转换后超过 Telegram 4096 上限。
EOF
)"
```

---

## Task 4：手工 e2e 验证修复（在真实 Telegram 上）

**Files:**
- Modify: 无

> **设计要点：** 自动化测试覆盖了"输入 raw markdown → 输出 HTML 标签"的逻辑层面；但能否在真实 Telegram 客户端正确**渲染**只能人眼看。这一步是验证修复是否真的解决了用户报告的问题。

- [ ] **Step 1：重启 dev 进程**

```bash
pkill -f "tsx src/bin/cursor-claw" ; sleep 1.5 ; npx tsx src/bin/cursor-claw.ts
```

- [ ] **Step 2：在 Telegram 端发一张截图触发多模态分析**

让 agent 输出含 `**bold**` / `` `code` `` / fenced code block 的 markdown 回复。

- [ ] **Step 3：人眼检查 Telegram 客户端**

预期：

- `**xxx**` 显示成**粗体**而不是字面 `**xxx**`
- 行内 `` `code` `` 显示成等宽底色而不是字面反引号
- ```` ```ts ... ``` ```` 显示成多行代码块
- `[link](url)` 显示成可点击的链接

- [ ] **Step 4：检查 server 日志没有 Telegram 400 错误**

```bash
# 翻最近的 cursor-claw 日志，确认没有
# "Bad Request: can't parse entities" 之类的报错
```

- [ ] **Step 5：收尾 commit（如果手工验证通过且无别的改动则跳过；如果发现 polish 项再加 commit）**

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | 对应任务 |
|---|---|
| §3.1 数据流 | T2（StreamRenderer 重构 + AgentOrchestrator 调用点） |
| §3.2 接口变更 | T2（`textBuffer` raw / `finalizeExtra` 新字段 / `pushText` 不再外层包装 / `compose` 整体转） |
| §3.3 maxLen 调整 | T3（3500 → 3000） |
| §3.4 错误兜底 | T2 中 `renderTextBufferSafely()` + `escapeHtmlFallback` |
| §4 测试矩阵 | T1（6 条 unit case） + T4（手工 e2e） |
| §5 风险 / 回滚 | 单 commit 改动 + 回滚直接 revert |
| §6 不在范围 | "重复打招呼"明确不做 |

✅ 全覆盖。

**2. Placeholder scan**：grep `TBD` `TODO` `FIXME` `implement later` —— 无命中。

**3. Type consistency**：`textBuffer` / `finalizeExtra` / `compose` / `pushText` / `setStatus` / `finalize(extra?)` 命名在 T1（测试）和 T2（实现）一致。`maxLen` / `throttleMs` 配置字段名一致。

✅ 自洽。
