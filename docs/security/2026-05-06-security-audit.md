# cursor-claw Security Audit · 2026-05-06

**Status**：In progress · 6 领域审查中
**Scope**：commit `810a3d9` 公开化时刻基线
**Spec**：[2026-05-06-security-audit-design.md](../superpowers/specs/2026-05-06-security-audit-design.md)
**Plan**：[2026-05-06-security-audit.md](../superpowers/plans/2026-05-06-security-audit.md)
**Threat Model**：[2026-05-06-threat-model.md](./2026-05-06-threat-model.md)

---

## Executive Summary

> _本节在 T7 任务整合时填写。_

### 严重级分布

| Critical | High | Medium | Low | Info | 合计 |
|---|---|---|---|---|---|
| - | - | - | - | - | - |

### Top 3 Priority

| 序号 | Finding ID | 标题 | 严重级 |
|---|---|---|---|
| 1 | - | - | - |
| 2 | - | - | - |
| 3 | - | - | - |

### Findings ToC

| ID | 标题 | 严重级 | 领域 | 状态 | 修复 PR |
|---|---|---|---|---|---|
| F-01 | Telegram 文件下载 URL 内含 botToken，错误信息泄露面 | Low | D1 | Open | - |

---

## D1 · Secret / 敏感面

### 扫描清单与证据

| 扫描项 | 工具 / 命令 | 结果 |
|---|---|---|
| git 全历史 secret 扫描（Telegram bot token / Cursor key / AWS / GitHub PAT / PEM / OpenAI / Slack） | `git log --all --pretty=format: --name-only -p \| grep -nE -e ...`（gitleaks 未安装，用 grep 启发式 fallback） | **clean**，0 命中 |
| working tree（含 untracked，排除 `node_modules/.git/dist/threat-model.md`） | ripgrep regex 集 | **clean**，0 命中 |
| README / docs / config.example.json 教学示例 | ripgrep 严格 regex（`crsr_` / `^[0-9]{9,}:[A-Z]…`） | `docs/PREREQUISITES.md` 中 `123456789:AAEhBP0av-XXXXXXXXXXXXXXXXXXXXXX` 是占位符（明显 X 序列），非真实 token，不构成 finding |
| `.gitignore` 完整性 | 读取并对比已忽略文件 | `config.json` / `.env*` / `data/` / `.claw/` / `dist/` / `*.log` / `coverage/` 全部已忽略；当前 working tree 中 `config.json` 真实 token 仍处 ignored 状态 |
| logger redaction | 读 `src/logger.ts` | **双层保护**：`redactSensitive()` 函数对 `botToken/apiKey/token/secret` 等键做 `***` 替换；pino `redact` 配置对路径 `telegram.botToken`、`cursor.apiKey`、`*.botToken`、`*.apiKey`、`headers.authorization` 做 censor |
| `apiKey` / `botToken` 引用面 | ripgrep | 仅 `config/loadConfig.ts`（env 读取）、`config/schema.ts`（zod 校验）、`bin/cursor-claw.ts`（装配传参）、`adapters/telegram/TelegramMessenger.ts`（grammy bot 实例 + 文件下载 URL）、`core/orchestrator/cursorSdkRuntime.ts`（SDK 调用），**无任何 logger / console 直接打印** |

### F-01 · Telegram 文件下载 URL 内含 botToken，错误信息泄露面

| 字段 | 内容 |
|---|---|
| 严重级 | **Low**（防御深度） |
| CWE | CWE-532（Insertion of Sensitive Information into Log File） |
| 领域 | D1 |
| 位置 | `src/adapters/telegram/TelegramMessenger.ts:131-137` |
| 状态 | Open |
| 修复 PR | - |

**复现 / 触发条件**

```ts
const dataPromise = (async () => {
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${this.cfg.botToken}/${file.file_path}`;
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
})();
```

下载图片附件时构造的 `url` 字符串中嵌入了完整的 `botToken`。该字符串本身不被代码 log，但如果：

- `fetch(url)` 抛出网络错误（如 TLS 失败 / socket reset / 罕见的 undici cause 含 url）
- 错误对象的 `error.message` 或 `error.cause.message` 偶然包含 url（具体取决于 Node.js fetch / undici 错误格式）

错误后续流向 `MediaGroupBuffer` flush 的 catch（第 86-89 行）：

```ts
logger.error({ err: (e as Error).message }, "imageGroup 下载失败，丢弃整组");
```

这里把 `error.message` 作为字段值写入日志。pino `redact` 只对**字段路径**生效（如 `*.botToken`），无法对**字符串内容**做内容级脱敏。如果 message 中嵌有 url，token 会以明文落地日志。

**影响**

* 攻击者若能读取日志文件（如开发机被入侵 / 日志被外发到第三方平台），可能从历史日志中拿到一份 botToken。
* botToken 一旦泄露，攻击者可冒充 bot 给所有授权用户发任意消息。
* 实际触发概率取决于 Node.js fetch 在何种错误下把 url 写进 message：
  - 大多数 fetch 网络错误 message 是 `fetch failed` 或 `request to <url> failed`（部分实现含 url）
  - undici cause（`error.cause`）中常见含 `request.url` 字段
  - 当前代码只 log `error.message` 不 log cause，**当下风险较低**

**修复建议**

任选一种（按推荐排序）：

1. **从源头切断 url 中的 token**：把 `url` 拆成 `base + path`，token 通过 `Authorization: Bearer <token>` header 传递。但 Telegram File API 不支持 header 鉴权，故此方案不可行。
2. **包装 fetch 错误**（推荐）：在 IIFE 内用 try/catch 包裹 fetch，构造无 url 的错误消息：
   ```ts
   const dataPromise = (async () => {
     const file = await ctx.api.getFile(fileId);
     const url = `https://api.telegram.org/file/bot${this.cfg.botToken}/${file.file_path}`;
     try {
       const res = await fetch(url);
       const buf = Buffer.from(await res.arrayBuffer());
       return buf.toString("base64");
     } catch (e) {
       throw new Error(`Telegram 文件下载失败 (file_id=${fileId})`);
     }
   })();
   ```
3. **logger 字符串内容脱敏**：在 `src/logger.ts` 中的 pino `redact.censor` 之外，加一层 hook 对 message 字符串做 regex 替换（`api.telegram.org/file/bot[^/]+/` → `api.telegram.org/file/bot***/`），覆盖所有未来可能的泄露面。

**修复成本**：S（< 30 分钟），方案 2 + 单测覆盖。



---

## D2 · 依赖供应链

> _T2 任务填写。_

---

## D3 · Telegram 输入与权限

> _T3 任务填写。_

---

## D4 · Cursor SDK / Prompt Injection

> _T4 任务填写。_

---

## D5 · 运行时代码审计

> _T5 任务填写。_

---

## D6 · 文件系统与持久化

> _T6 任务填写。_
