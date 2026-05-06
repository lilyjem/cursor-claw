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
| F-02 | undici 传递依赖含 5 个 High 漏洞（运行时 fetch 受影响） | High | D2 | Open | - |
| F-03 | tar 传递依赖含 6 个 High 漏洞（install-time 路径穿越） | Medium | D2 | Open | - |
| F-04 | 缺少 CI 上的 npm audit gate | Low | D2 | Open | - |

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

### 扫描清单与证据

| 扫描项 | 工具 / 命令 | 结果 |
|---|---|---|
| `npm audit` | `npm audit --json` | 严重级分布 `{low: 2, moderate: 1, high: 7, critical: 0, total: 10}`；总依赖数 prod 96 / dev 267 / optional 158 / total 436 |
| 漏洞集中位置 | npm advisory | 集中在两条传递链：(1) `@cursor/sdk → @connectrpc/connect-node → undici`；(2) `@cursor/sdk → sqlite3 → node-gyp → make-fetch-happen → cacache → tar / http-proxy-agent / @tootallnate/once` |
| `package-lock.json` 完整性 | `npm ls --all --json` | 无 problem 报告；lockfile 存在且与 node_modules 一致 |
| install-time lifecycle scripts | 全 node_modules 扫描 | 仅 2 个真实 install/postinstall：`esbuild`（tsup 编译需）、`sqlite3`（@cursor/sdk 透传，native binding 重编译需）；其余 31 个 `prepare`/`prepublish` 脚本均为合理项目构建命令（husky / npm run build / tsc 等） |
| `@cursor/sdk` 版本检查 | `npm view @cursor/sdk version` | 当前 `1.0.12` 为 npm 上最新版；不能通过升级直接依赖来修透传漏洞，必须用 `overrides` |
| 关键直接依赖维护状态 | npm view | `grammy@1.42.0` 活跃维护 / `pino@10.3.1` 活跃 / `zod@3.25` 主流 / `dayjs@1.11.20` 维护 / `commander@14.0.3` 维护，无废弃 |

### F-02 · undici 传递依赖含 5 个 High 漏洞（运行时 fetch 受影响）

| 字段 | 内容 |
|---|---|
| 严重级 | **High** |
| CWE | CWE-444（HTTP Request Smuggling）/ CWE-93（CRLF Injection）/ CWE-400（Resource Exhaustion） |
| 领域 | D2 |
| 位置 | `package-lock.json` → `undici` (≤ 6.23.0) 透传自 `@cursor/sdk` → `@connectrpc/connect-node` |
| 状态 | Open |
| 修复 PR | - |

**漏洞清单（5 个 GHSA）**

| GHSA | 标题 | 触发条件 |
|---|---|---|
| GHSA-g9mf-h72j-4rw9 | Undici unbounded decompression chain in HTTP responses on Node.js Fetch via Content-Encoding | fetch 接收恶意服务器返回的 nested gzip 压缩 → 资源耗尽 |
| GHSA-2mjp-6q6p-2qxm | Undici HTTP Request/Response Smuggling | undici 作为 HTTP 服务器或反代时 |
| GHSA-vrm6-8vpv-qv8q | Undici Unbounded Memory Consumption in WebSocket permessage-deflate | WebSocket 接收恶意压缩帧 |
| GHSA-v9p9-hfj2-hcw8 | Undici Unhandled Exception in WebSocket Client（invalid `server_max_window_bits`） | WebSocket 握手时 |
| GHSA-4992-7rv2-5pvq | Undici **CRLF Injection in `upgrade` option** | 用户控制 fetch 调用的 `upgrade` 字段 |

**复现 / 触发条件**

cursor-claw 运行时实际使用 undici 的位置：

1. `TelegramMessenger.ts:134` 中 `await fetch(url)` 下载图片 — Node 18+ 内置 fetch 走 undici。
2. `@cursor/sdk` 内部走 `@connectrpc/connect-node` 调远端 → undici 客户端。

cursor-claw **不**作为 HTTP 服务器，所以 Smuggling 漏洞（GHSA-2mjp-6q6p-2qxm）实际不可触发；**不**用 WebSocket，所以两个 WS 漏洞不触发；**不**给 fetch 传 `upgrade` 选项，所以 CRLF 不触发。

实际暴露面：

- **GHSA-g9mf-h72j-4rw9（unbounded decompression）**：恶意 Telegram CDN 服务器（理论上 Telegram 平台被劫持）返回 nested gzip 即可让 cursor-claw 的 fetch 进程内存耗尽 → DoS 主机。但 Telegram CDN 受 Telegram 控制，实际场景为 MITM 时（应该被 TLS 阻挡）。

**影响**

主要风险为 DoS（资源耗尽）。RCE/数据泄露在当前调用模式下不构成。

**修复建议**

在 `package.json` 加 `overrides` 强制 undici 升级到修复版本（≥ 6.21.2）：

```json
{
  "overrides": {
    "undici": "^6.21.2"
  }
}
```

之后跑：

```bash
rm -rf node_modules package-lock.json
npm install
npm test  # 确认 141 个测试不回归
npm audit
```

**修复成本**：M（< 半天，需重装依赖 + 全量回归测试 + 验证 @connectrpc/connect-node 与新 undici 兼容）。

### F-03 · tar 传递依赖含 6 个 High 漏洞（install-time 路径穿越）

| 字段 | 内容 |
|---|---|
| 严重级 | **Medium**（仅 install 时触发，运行时不接触） |
| CWE | CWE-22（Path Traversal）/ CWE-59（Symlink）/ CWE-362（Race Condition） |
| 领域 | D2 |
| 位置 | `package-lock.json` → `tar` 透传自 `@cursor/sdk` → `sqlite3` → `node-gyp` → `make-fetch-happen` → `cacache` |
| 状态 | Open |
| 修复 PR | - |

**漏洞清单（6 个 GHSA，全部 high，集中在 node-tar）**

| 标题 |
|---|
| Vulnerable to Arbitrary File Creation/Overwrite via Hardlink Path Traversal |
| Vulnerable to Arbitrary File Overwrite and Symlink Poisoning via Insufficient Path Sanitization |
| Arbitrary File Read/Write via Hardlink Target Escape Through Symlink Chain |
| Hardlink Path Traversal via Drive-Relative Linkpath |
| Symlink Path Traversal via Drive-Relative Linkpath |
| Race Condition in Path Reservations via Unicode Ligature Collisions on macOS APFS |

**复现 / 触发条件**

`tar` 仅在 npm install 流程被使用：

- `sqlite3@5.1.7` 的 `install` script 是 `prebuild-install -r napi || node-gyp rebuild`
- `prebuild-install` 走 `make-fetch-happen` → `cacache` → 下载预编译 native binding tar 包并解压
- 解压时若 tar 文件含恶意 hardlink/symlink，会写入 install 路径之外的位置

cursor-claw 运行时**不直接调用 tar**（grep 验证：源码无 `require('tar')`）。

**影响**

供应链风险：当攻击者能向 npm registry 投毒（typosquat / 维护者账号被入侵 / 中间人篡改 npm 响应）注入恶意 tar archive，本机 npm install 时可被路径穿越写入主机敏感位置。已 lockfile 锁版本 + 完整性校验（`integrity` SRI hash）作为已存在缓解。

**修复建议**

在 `package.json` 加 `overrides`：

```json
{
  "overrides": {
    "tar": "^6.2.1",
    "cacache": "^18.0.4",
    "make-fetch-happen": "^13.0.1",
    "node-gyp": "^10.2.0",
    "http-proxy-agent": "^7.0.2",
    "@tootallnate/once": "npm:@tootallnate/once@2.0.0"
  }
}
```

注意：`@tootallnate/once@1.x` 已被废弃；可能需要 review 替代方案。

之后跑 `rm -rf node_modules package-lock.json && npm install && npm audit`，期望 audit 全 clean。

**修复成本**：M（半天，需调试 overrides 与 sqlite3 native binding 兼容性）。

### F-04 · 缺少 CI 上的 npm audit gate

| 字段 | 内容 |
|---|---|
| 严重级 | **Low**（流程性） |
| CWE | CWE-1104（Use of Unmaintained Third Party Components） |
| 领域 | D2 |
| 位置 | `package.json` scripts；`.github/` 下无 workflow |
| 状态 | Open |
| 修复 PR | - |

**复现 / 触发条件**

目前仓库无 GitHub Actions workflow 跑 `npm audit`，新漏洞披露后无自动告警。已配置 GitHub 默认会跑 Dependabot Security Updates（仓库 public 后默认启用），但应在 CI 流水线显式 gate。

**影响**

新 CVE 披露后 P0/P1 修复延迟。

**修复建议**

加 `package.json` script：

```json
{
  "scripts": {
    "audit:ci": "npm audit --audit-level=high"
  }
}
```

并新增 `.github/workflows/security.yml`，每个 push / PR / 每周 cron 跑该命令。可结合 Dependabot 配置文件 `.github/dependabot.yml` 让 npm 依赖自动 PR。

**修复成本**：S（< 30 分钟）。



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
