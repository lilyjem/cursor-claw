# StreamRenderer 跨 chunk markdown 渲染修复 — Design Spec

**Status**：approved 待实施
**Date**：2026-05-06
**Owner**：Jem
**Scope**：`src/core/orchestrator/streamRenderer.ts` + `src/core/orchestrator/AgentOrchestrator.ts`（调用点）+ 配套测试

---

## 1. 背景

M2 e2e smoke 收尾期间，用户在 Telegram 端看到 agent 回复中的 markdown 标记（`**bold**`、`` `code` ``、`[text](url)` 等）以**字面形式**显示，而不是被 Telegram HTML parseMode 渲染成富文本。

仓库已有 `src/core/render/markdownToHtml.ts`，能正确处理一段闭合的 markdown，把 `**xxx**` 转成 `<b>xxx</b>` 等。它本身没问题（138 个测试覆盖也证明如此）。

## 2. 根因

`AgentOrchestrator.runInternal` 在消费 SDK 流式 `assistant` 事件时，对**每个增量 chunk** 单独调用 `markdownToHtml`：

```ts
case "assistant":
  await renderer.pushText(markdownToHtml(event.text));
```

SDK 推过来的 `event.text` 是**未对齐**的 chunk：可能把 `**图 1（cursor 目录）**` 切成 chunk1=`**图 1（` + chunk2=`cursor 目录）**`。

`markdownToHtml` 是基于 regex 的"成对标记"匹配实现：

```ts
out = out.replace(/\*\*([^*\n]+)\*\*/g, ...);  // 必须有闭合的 **
```

每个 chunk 单独跑一次，**所有未闭合的标记**全部 fallback 到原文输出。最终 `textBuffer` 里塞满字面 `**`、`` ` ``、`[]()`，Telegram 不渲染任何 markdown。

代码块（三反引号）、行内代码、链接同样受影响。

## 3. 设计：把"渲染时机"从 chunk 进入推迟到 buffer 输出

### 3.1 数据流

```
agent SDK chunk
     │
     ▼
[AgentOrchestrator]   renderer.pushText(rawChunk)         ← 不再做 markdownToHtml
     │
     ▼
[StreamRenderer.pushText]
     - textBuffer += rawChunk                              ← 存原始 markdown
     - dirty = true; scheduleFlush()
     │
     ▼
[StreamRenderer.compose() 在 flushNow / finalize 时]
     1. statusHtml         (HTML 直接塞)
     2. ""                 (分隔空行)
     3. markdownToHtml(textBuffer)                         ← 整体转换
     4. finalizeExtraHtml  (HTML 直接塞)  例如 <i>(已取消)</i>
     │
     ▼
messenger.editText(parseMode: "HTML")
```

关键不变量：

- **`textBuffer` 永远是 raw markdown**（agent 原文），不预先 escape、不预先转 HTML。
- **`status` 与 `finalizeExtra` 是已经 HTML 化**的字符串，来自我们自己的代码（不来自 agent），`compose()` 时直接拼接，不再过 `markdownToHtml`。

### 3.2 组件接口变更

| 字段 / 方法 | 现状 | 改后 |
|---|---|---|
| `private textBuffer: string` | 经过 escape + 局部 inline 转换 | **raw markdown**（agent 原文） |
| `private status: string` | HTML 字符串 | 不变（HTML） |
| **新增** `private finalizeExtra: string` | (无) | HTML 字符串，`finalize(extra)` 时填 |
| `pushText(chunk)` | 外层包装 `markdownToHtml(chunk)` | 接收 raw chunk |
| `compose()` | 字段直接 `join("\n")` | textBuffer 段套 `markdownToHtml(textBuffer)` |
| `AgentOrchestrator` 调用 | `pushText(markdownToHtml(event.text))` | `pushText(event.text)` |
| `finalize(extra)` 语义 | extra 拼到 textBuffer 末尾 | extra 写入 `finalizeExtra` 字段（保留 HTML 形式） |

### 3.3 长消息切分（maxLen）

- 现状：`textBuffer.length + chunk.length > maxLen` 触发 rotate（切到新主消息）。
- 改后：阈值依然用 raw 长度判断；但 markdownToHtml 转换后 HTML 会增长（`**xxx**` → `<b>xxx</b>` 净长度 +1 / 5 个字符；`<` `>` `&` 转义会涨 +3 / +3 / +4）。
- **保守做法**：当前 `bin/cursor-claw.ts` 装配时 `streamOptions.maxLen` 默认 3500。本次降到 **3000**，给 HTML 增长留余量；rotate 时仍按 raw 切分，递归 head/rest 逻辑保留。

### 3.4 错误兜底

`markdownToHtml(textBuffer)` 在极端输入下若抛错，`compose()` 用 try/catch 包一层，fallback 走 `escapeHtml(textBuffer)`：宁可丢渲染也不能让 streaming 整体中断。

## 4. 测试矩阵

### 新增 / 扩展 unit 测试 — `tests/unit/streamRenderer.test.ts`（新建或扩展）

1. **跨 chunk bold**：`pushText("**A")` + `pushText("B**")` + flush → editText 收到含 `<b>AB</b>` 的消息
2. **跨 chunk inline code**：`` pushText("`co") `` + `` pushText("de`") `` → `<code>code</code>`
3. **跨 chunk fenced code block**：``` pushText("```\n") ``` + `pushText("foo\n")` + ``` pushText("```") ``` → `<pre><code>foo\n</code></pre>`
4. **跨 chunk link**：`pushText("[link](htt")` + `pushText("ps://x.com)")` → `<a href="https://x.com">link</a>`
5. **含 `<` 的 raw chunk**：`pushText("if a < b")` → 输出含 `if a &lt; b`（escape 不丢）
6. **finalize(extra) 是 HTML**：`pushText("hello")` + `finalize("\n<i>(done)</i>")` → editText 收到含 `hello` + `<i>(done)</i>`，extra 不被 markdownToHtml 转
7. **rotate 切分**：连续推大量 raw 触发 maxLen → 第一条主消息按 raw 长度切，第二条 placeholder 后从空 textBuffer 累积

### 已有测试

- `tests/unit/markdownToHtml.test.ts` 不动（markdownToHtml 行为本身不变）
- `tests/integration/orchestrator.test.ts` 不必改：现有断言"editText 收到的 text 含 `Hi! There.`"用 raw 输入也成立；如有依赖 escape 后内容的断言，调整为更宽松的 `toContain`

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| markdownToHtml 在每次 flush 重复跑（streaming 期 + finalize），对长 textBuffer 是 O(n) regex 多次扫描 | 单次 ms 级开销，throttleMs 默认 200ms，不构成瓶颈 |
| `finalize(extra)` 调用方传的不是 HTML 而是 raw markdown | 全代码库 grep `finalize(` 调用点：当前 3 处全是 HTML（`<i>(已取消)</i>`、`⚠️ Error: ${escapeHtml(...)}`、空 finalize），约定明确 |
| 回退 | 单 commit 改动；revert 该 commit 即可恢复（M1 + M2 测试不依赖此机制，回退后维持当前 138 测试全绿） |

## 6. 不在范围

- **重复打招呼问题**：本次只修 markdown bug。多段 assistant text 在 UI 层的可读性增强（分隔符 / blockquote / 多消息）属于另一轮 polish。
- **MarkdownV2 parseMode**：评估后否决（转义规则严、回归风险大）。

## 7. 自我复审

- ✅ Placeholder 扫描：无 TBD / TODO / FIXME
- ✅ 内部一致性：textBuffer raw / status+extra HTML 这一不变量在 §3.1、§3.2、§3.3 一致
- ✅ 范围检查：单一焦点（流式 markdown 渲染），改动 2 个源文件 + 1 个测试文件
- ✅ 模糊性：finalize(extra) 是 HTML 这一约定在 §3.2、§5 双重声明
