# cursor-claw 项目安全审查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Subagent disabled per project rule** — execute inline only.

**Goal:** 对刚 public 的 `lilyjem/cursor-claw` 仓库做一次系统化安全审查，输出威胁模型 + 主报告 + 逐项修复 PR；覆盖 secret/敏感面、依赖供应链、Telegram 输入与权限、Cursor SDK 调用与 prompt injection、运行时代码安全、文件系统与持久化六个领域。

**Architecture:** 顺序执行 7 个审查任务（T0 准备 → T1-T6 6 个领域 → T7 总报告整合），每个任务读取代码 + 跑工具 + 写 finding 入主报告 + commit；之后 T8 与用户逐项交互决定每条 finding 的处置（Fix / Accepted-Risk / Wont-Fix），Fix 走 fix/F-XX-<slug> 分支 + TDD + PR + squash merge。

**Tech Stack:** Node.js 20+ / TypeScript / grammy（Telegram） / @cursor/sdk / pino（日志） / zod（schema 校验） / vitest（测试） / `npm audit`（依赖扫描） / 必要时 `gitleaks` 或 ripgrep regex 集（secret 扫描）

参考 spec：[`docs/superpowers/specs/2026-05-06-security-audit-design.md`](../specs/2026-05-06-security-audit-design.md)

---

## File Structure

| 文件 / 目录 | 责任 | 改动 |
|---|---|---|
| `docs/security/` | 安全审查输出根目录 | **新建** |
| `docs/security/2026-05-06-threat-model.md` | 威胁模型骨架（资产 / 信任边界 / 攻击者画像） | **新建** |
| `docs/security/2026-05-06-security-audit.md` | 主报告（Executive Summary + 6 领域 finding 汇总） | **新建** |
| `docs/security/findings/` | 单条 finding 大于 200 字时独立成文件 | **按需新建** |
| `CHANGELOG.md` | 增加 `### Security` 小节列出已修复 finding | T8 阶段每个 fix PR 时追加 |
| 任何 `src/**` 文件 | 修复阶段按 finding 改 | T8 动态决定 |
| 任何 `tests/**` 文件 | 修复阶段配套 TDD 测试 | T8 动态决定 |

**审查阶段（T0-T7）**：read-only，只动 `docs/security/` 与（必要时）`docs/superpowers/specs/` 与 `package.json` scripts（如增 `audit:full`）。

**修复阶段（T8）**：动 `src/`、`tests/`、`config.example.json`、`CHANGELOG.md` 等，每条 finding 一个独立 PR。

---

## Task 0：准备审查基础设施

**Files:**
- Create: `docs/security/2026-05-06-threat-model.md`
- Create: `docs/security/2026-05-06-security-audit.md`

> **设计要点：** 把 spec §2 §3 的资产分级和信任边界落到 `threat-model.md`，做长期档案；同时建好主报告骨架（含 Executive Summary 占位、6 个领域章节空槽、Findings ToC 空表），后续每个 D 任务往里填 finding。

- [ ] **Step 1：创建 docs/security/ 目录并写 threat-model.md**

```bash
mkdir -p docs/security/findings
```

写入 `docs/security/2026-05-06-threat-model.md`：

```markdown
# cursor-claw Threat Model

**Date**：2026-05-06
**Repo**：lilyjem/cursor-claw（public，commit `810a3d9` 公开化）
**Scope**：Telegram ↔ Cursor SDK 桥接 Node.js 服务

## 1. 资产分级

| 资产 | 等级 | 一旦泄露 / 被攻陷的影响 |
|---|---|---|
| Telegram Bot Token | Critical | 攻击者冒充 bot 给所有授权用户发任意消息、读取全部更新 |
| Cursor API Key | Critical | 攻击者代用户调 Cursor SDK，烧 quota、操纵 agent |
| `allowedUserIds` 白名单值 | High | 决定谁能驱动 bot；间接定位真实用户 |
| `data/` 会话 / 附件 / 定时任务 | High | 含历史对话、可能私人信息、附件原始字节 |
| `data/` 落盘文件名与路径 | Medium | 路径穿越可能写入主机任意位置 |
| 运行 bot 的进程 / 主机 | Critical | 命令注入 / RCE 直接接管主机 |
| Cursor agent 在 workspace 写权限 | High | 通过 prompt injection 让 agent 在主机执行 tool |

## 2. 信任边界

[Internet]
    ↓ Telegram MTProto
[Telegram Server]   ← 信任边界 1：Telegram 平台可信，但消息内容不可信
    ↓ getUpdates / sendMessage
[cursor-claw 进程]
  ├─ TelegramAdapter (grammy)   ← A1：消息文本/命令/附件 = 不可信输入
  ├─ Config Loader              ← A2：config.json 持久化敏感数据
  ├─ Workspace Router           ← A3：cwd / 路径决策可能受消息影响
  ├─ Cursor SDK Client          ← A4：prompt 由用户消息构造 → prompt injection
  └─ Data Store                 ← A5：data/ 落盘、附件下载
        ↓
[Cursor Agent / 主机文件系统]   ← 信任边界 2：agent tool 真实写主机

## 3. 攻击者画像

| 画像 | 能力 | 目标 |
|---|---|---|
| Internet 上的随机扫描者 | 可读 public 仓库源码、可在 Telegram 上发消息 | 找泄露 token / 公开依赖 CVE |
| 已被加进 `allowedUserIds` 但已撤销信任的前用户 | 可发任意 Telegram 消息到 bot | 横向滥用 Cursor agent / 越权读取私人数据 |
| 钓鱼 / 社会工程 | 诱导 owner 把恶意指令贴给 bot | Prompt injection → agent 在主机执行 |
| 第三方依赖被 typosquat / 投毒 | 通过 supply chain 进入运行时 | 长期潜伏 / 数据外传 |

## 4. public 化的事实约束

- 仓库公开后，旧 commit 永久可读：本次审查在 commit `810a3d9` 公开化，已验证此前历史不含 secret / 私人 data。后续如出现 secret 误提交，仅靠 force-push 不足够，必须撤销 token。
- fork 保留风险：任何 fork 在公开后即不可控；安全策略应预设 fork 已经存在。
```

- [ ] **Step 2：写主报告骨架到 docs/security/2026-05-06-security-audit.md**

```markdown
# cursor-claw Security Audit · 2026-05-06

**Status**：In progress · 6 领域审查中
**Scope**：commit `810a3d9` 公开化时刻基线
**Spec**：[2026-05-06-security-audit-design.md](../superpowers/specs/2026-05-06-security-audit-design.md)
**Threat Model**：[2026-05-06-threat-model.md](./2026-05-06-threat-model.md)

---

## Executive Summary

> _本节在 T7 任务整合时填写。_

### 严重级分布（T7 填表）

| Critical | High | Medium | Low | Info | 合计 |
|---|---|---|---|---|---|
| - | - | - | - | - | - |

### Top 3 Priority（T7 填表）

| 序号 | Finding ID | 标题 | 严重级 |
|---|---|---|---|
| 1 | - | - | - |
| 2 | - | - | - |
| 3 | - | - | - |

### Findings ToC（T1-T6 各任务自增）

| ID | 标题 | 严重级 | 领域 | 状态 | 修复 PR |
|---|---|---|---|---|---|

---

## D1 · Secret / 敏感面

> _T1 任务填写。_

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
```

- [ ] **Step 3：commit T0**

```bash
git add docs/security/2026-05-06-threat-model.md docs/security/2026-05-06-security-audit.md
git commit -m "docs(security): 安全审查基础设施（威胁模型 + 主报告骨架）"
```

- [ ] **Step 4：直推 main**

```bash
git push origin main
```

预期：admin bypass 正常通过（`enforce_admins=false`）。

---

## Task 1：D1 Secret / 敏感面审查

**Files:**
- Modify: `docs/security/2026-05-06-security-audit.md`（D1 节）

> **设计要点：** D1 目标是确认仓库公开化前后没有任何 secret 暴露面。三类扫描：（a）git 全历史 secret 扫描，（b）代码中是否硬编码 secret，（c）log 输出是否会打印 token。

- [ ] **Step 1：尝试用 gitleaks 做全历史扫描；若未装则 fallback 到 ripgrep 启发式**

```bash
which gitleaks || echo "GITLEAKS_MISSING"
```

若装了：

```bash
gitleaks detect --source=. --no-git=false --redact --report-path=/tmp/gitleaks-report.json --report-format=json --verbose 2>&1 | tee /tmp/gitleaks-output.txt
```

若未装，用 ripgrep regex 启发式（覆盖 Telegram bot token / Cursor key / generic API key / PEM）：

```bash
git log --all --pretty=format: --name-only -p | rg -n --no-heading -e \
  '\b\d{8,}:[A-Za-z0-9_-]{30,}\b' \
  -e 'crsr_[a-f0-9]{40,}' \
  -e 'AKIA[0-9A-Z]{16}' \
  -e 'ghp_[A-Za-z0-9]{30,}' \
  -e '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' \
  -e 'sk-[A-Za-z0-9]{20,}' \
  -e 'xox[baprs]-[A-Za-z0-9-]{10,}' \
  | head -100 | tee /tmp/secret-scan.txt
```

记录命令与原始输出（即便为空也记录）。

- [ ] **Step 2：扫描 working tree（含 untracked）中是否有真实 secret 漏出但被忽略的副本**

```bash
rg -n --hidden -g '!node_modules' -g '!.git' -e 'crsr_[a-f0-9]{20,}' -e '\b\d{8,}:[A-Za-z0-9_-]{30,}\b' . | head -50
```

预期：仅 `config.json` 命中（已被 .gitignore 排除）。如其他文件命中即为 finding。

- [ ] **Step 3：审查 README / docs / config.example.json 中是否误把真 token 写成示例**

```bash
rg -n -e 'crsr_[a-f0-9]{20,}' -e '\b\d{9,}:[A-Z][A-Za-z0-9_-]{30,}\b' README.md README.zh-CN.md docs/ config.example.json
```

预期：无命中或仅命中明显占位字符串如 `REPLACE_OR_SET_*`。

- [ ] **Step 4：审查 logger 调用面，确认 token / API Key 不会被日志打印**

```bash
rg -n 'logger\.(info|debug|trace|warn|error|fatal)\(' src/ | rg -v '\.test\.' | head -50
rg -n 'console\.(log|error|warn|info)' src/ | rg -v '\.test\.' | head -20
```

打开 `src/config/` 与 `src/adapters/` 中所有 logger 调用点，确认日志参数不含 raw `botToken` / `apiKey`，必要时检查是否存在 `redact` 配置（pino 支持 `redact` 字段）。

```bash
rg -n 'redact' src/
```

- [ ] **Step 5：把 D1 finding 写入主报告 D1 节**

每条 finding 用 spec §5 模板。如 D1 全部 clean，明确写 `_无 finding。本节扫描内容如下：_` + 扫描清单与命令证据。

更新 `Findings ToC` 表（追加 D1 的 F-XX 行）。

- [ ] **Step 6：commit T1**

```bash
git add docs/security/2026-05-06-security-audit.md
git commit -m "docs(security): D1 secret 扫描结果"
git push origin main
```

---

## Task 2：D2 依赖供应链审查

**Files:**
- Modify: `docs/security/2026-05-06-security-audit.md`（D2 节）
- Modify（可选）: `package.json` scripts（如新增 `audit:full`）

> **设计要点：** D2 目标是识别已知 CVE、被投毒依赖、过宽 install scripts 风险。先 npm audit 拿全量数据，再人工 review 关键 deps（grammy / @cursor/sdk / pino / zod 等），最后看 package.json 是否有可疑 lifecycle scripts。

- [ ] **Step 1：跑 npm audit 并保留 JSON 与人类可读两种输出**

```bash
npm audit --json > /tmp/npm-audit.json 2>/tmp/npm-audit.err || true
npm audit > /tmp/npm-audit.txt 2>&1 || true
cat /tmp/npm-audit.txt | head -80
```

注意 npm audit 在无漏洞时 exit code 0，有漏洞时非 0；用 `|| true` 保证 pipeline 不中断。

- [ ] **Step 2：解析 JSON 提取 vulnerability 概览**

```bash
node -e "
const r = require('/tmp/npm-audit.json');
const m = r.metadata?.vulnerabilities || {};
console.log('严重级分布:', m);
console.log('总依赖数:', r.metadata?.dependencies);
const advs = r.vulnerabilities || {};
Object.entries(advs).slice(0,30).forEach(([name, v]) => {
  console.log('-', name, v.severity, '|', v.via?.[0]?.title || v.via?.[0]);
});
"
```

- [ ] **Step 3：检查 package-lock.json 完整性**

```bash
test -f package-lock.json && echo "lockfile present"
npm ls --all --json > /tmp/npm-ls.json 2>/dev/null || echo "npm ls 报错（依赖不一致）"
node -e "const r=require('/tmp/npm-ls.json'); console.log('problems:', (r.problems||[]).slice(0,20));"
```

- [ ] **Step 4：扫描 package.json 与所有依赖的 install lifecycle scripts**

```bash
node -e "
const fs = require('fs');
const path = require('path');
const visited = new Set();
function scan(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const danger = ['preinstall','install','postinstall','prepare','prepublish'];
  const found = danger.filter(s => pkg.scripts?.[s]);
  if (found.length) console.log(pkg.name + '@' + pkg.version + ':', found.map(s => s+'='+pkg.scripts[s]).join(' | '));
}
scan('.');
const nm = './node_modules';
if (fs.existsSync(nm)) {
  for (const e of fs.readdirSync(nm)) {
    if (e.startsWith('.')) continue;
    if (e.startsWith('@')) {
      for (const sub of fs.readdirSync(path.join(nm, e))) scan(path.join(nm, e, sub));
    } else {
      scan(path.join(nm, e));
    }
  }
}
" | head -80
```

记录有 lifecycle scripts 的依赖（特别是 install/postinstall），评估每个是否合理（如 esbuild、native binding 包合理；非典型包要警惕）。

- [ ] **Step 5：人工 review 关键依赖的安全声誉**

依赖清单：`@cursor/sdk`、`commander`、`dayjs`、`grammy`、`mime-types`、`pino`、`pino-pretty`、`zod`。

每个依赖检查：

```bash
npm view <pkg> versions --json | head -5
npm view <pkg> dist-tags
npm view <pkg> repository
```

- 是否仍在维护（最近一年有发版）？
- 仓库链接是否真实？
- 是否有公开的安全 advisory（结合 Step 2）？

- [ ] **Step 6：把 D2 finding 写入主报告 D2 节并更新 ToC**

每条 CVE 一个 finding；多个同类（如所有都源自一个传递依赖）合并为一条。结构：

```markdown
### F-XX · <CVE-YYYY-NNNN 在 <pkg>@<ver> 中触发>

| 严重级 | 领域 | 位置 | 状态 |
|---|---|---|---|
| <Critical/High/Medium/Low> | D2 | `package-lock.json`（透传依赖 <pkg>@<ver>） | Open |

**复现**：`npm audit` 输出节选。
**影响**：（CVE 描述 + 在本项目运行时是否真的 reach 到该路径）
**修复建议**：升级 / `overrides` 字段固定子依赖版本 / 切换替代包。
**修复成本**：S / M / L
```

- [ ] **Step 7：commit T2**

```bash
git add docs/security/2026-05-06-security-audit.md
git commit -m "docs(security): D2 依赖供应链审查结果"
git push origin main
```

---

## Task 3：D3 Telegram 输入与权限审查

**Files:**
- Modify: `docs/security/2026-05-06-security-audit.md`（D3 节）

> **设计要点：** D3 是攻击者最容易触达的面。重点检查：白名单 `allowedUserIds` 是否每个 handler 都强制；命令解析是否对长度/字符做边界；附件 `maxFileSizeBytes` 是否真正强制；`parseMode: HTML` 下 bot 回显的用户文本是否被 escape。

- [ ] **Step 1：定位 grammy 适配器与命令注册中心**

```bash
ls src/adapters/
rg -ln 'allowedUserIds' src/
rg -ln 'bot\.(command|on|use|hears)' src/
```

记下入口文件与每个 handler 的注册位置。

- [ ] **Step 2：审查 allowedUserIds 实施位置**

读取上一步定位到的所有文件，验证：
- 是否有一个全局 middleware 在所有 handler 之前检查 `from.id` 是否在白名单内？
- 还是每个 handler 自己检查？如果是后者，是否存在遗漏 handler？
- 当 from.id 不在白名单时，行为是？（静默丢弃 / 回复"未授权" / 计入限流）

```bash
rg -n -B 2 -A 8 'allowedUserIds' src/
```

把对应代码行号与逻辑摘要写入 finding 草稿。

- [ ] **Step 3：审查命令解析边界**

```bash
rg -n 'ctx\.(message|update|chat|from)' src/adapters/ | head -40
rg -n 'msg\.text|message\.text' src/ | head -20
```

逐处确认：
- 文本长度是否有上限（避免内存/CPU 耗尽）？
- 命令参数（如 `/remind <when> <text>`）是否走 zod schema 验证？
- 用户 ID / chat ID / message ID 等数字字段是否当字符串拼路径用？

- [ ] **Step 4：审查附件下载边界**

```bash
rg -n 'maxFileSizeBytes\|file_size\|getFile\|download' src/ | head -30
```

打开附件下载代码，验证：
- 是否在下载前检查 `file_size`？
- 下载流是否有大小累计 + 中断阈值（防止 server 谎报 file_size）？
- 文件名是否经过 sanitize（防路径穿越，等到 D6 还会重看一次）？

- [ ] **Step 5：审查 parseMode: HTML 下回显用户文本**

```bash
rg -n 'parseMode\|parse_mode' src/ | head -20
rg -n 'sendMessage\|reply\|editMessageText\|sendDocument' src/ | head -30
rg -n 'escapeHtml\|escape_html' src/ | head -10
```

逐处看 bot 回显时是否对 user-controlled 字符串调用 escapeHtml（项目里已有，用法是否覆盖所有 user echo 路径）。

- [ ] **Step 6：审查速率/flood 防护**

```bash
rg -n 'rate\|flood\|throttle\|debounce' src/ | head -20
```

对 `/remind` 等可堆积 timer 的命令重点看：是否限制单用户并发 timer 数？

- [ ] **Step 7：把 D3 finding 写入主报告 D3 节并更新 ToC**

- [ ] **Step 8：commit T3**

```bash
git add docs/security/2026-05-06-security-audit.md
git commit -m "docs(security): D3 Telegram 输入与权限审查结果"
git push origin main
```

---

## Task 4：D4 Cursor SDK / Prompt Injection 审查

**Files:**
- Modify: `docs/security/2026-05-06-security-audit.md`（D4 节）

> **设计要点：** D4 关注两件事：（1）API key 不会以任何形式落到日志、错误、Telegram 回显里；（2）用户消息进入 prompt 时与 system prompt 有清晰边界，agent 工具权限可控。

- [ ] **Step 1：定位 Cursor SDK 调用点与 prompt 构造点**

```bash
rg -ln '@cursor/sdk\|Agent\.\(create\|prompt\|resume\)\|cursor\.\|Orchestrator' src/
ls src/core/
```

记下 prompt 构造 / agent 启动 / tool 配置的所有文件。

- [ ] **Step 2：审查 prompt 构造**

打开每个 prompt 构造点，确认：
- 用户消息（来自 Telegram）插入 prompt 时是否有清晰边界（如 `<user_message>...</user_message>` / 引号包裹 / 单独段）？
- 是否拼接 system prompt（"忽略之前指令"等基础注入语会破坏吗）？
- 是否有 prompt template 测试覆盖？

```bash
rg -n -B 2 -A 8 'systemPrompt\|userPrompt\|prompt:\|messages:' src/ | head -80
```

- [ ] **Step 3：审查 agent tool 权限**

Cursor SDK 支持限制 agent 可用 tools。检查 settingSources 与 model params 配置：

```bash
rg -n 'settingSources\|tools\|allowedTools\|toolPolicy' src/
```

确认：
- agent 是否能不经用户确认写主机文件？
- 是否限制了 working directory？
- 是否能跨 workspace 跑（project / user 两级 settingSources 各自风险）？

- [ ] **Step 4：审查 API key 处理路径**

```bash
rg -n 'apiKey' src/ | head -30
```

逐处确认：
- API key 仅来自 config.json / env？
- 任何 catch 块里把 key 字符串包含在 error message 里？
- 任何代码路径会 log API key？

- [ ] **Step 5：审查错误回显**

```bash
rg -n 'catch\s*(\([^)]*\))?\s*\{' src/ | head -30
rg -n 'replyError\|sendError\|onError\|catch.*error' src/ | head -30
```

逐处看 catch 块：是否把 stack trace 或 error.message 直接发回 Telegram？这是常见的信息泄露面（绝对路径、用户名、版本号）。

- [ ] **Step 6：把 D4 finding 写入主报告 D4 节并更新 ToC**

- [ ] **Step 7：commit T4**

```bash
git add docs/security/2026-05-06-security-audit.md
git commit -m "docs(security): D4 Cursor SDK / Prompt Injection 审查结果"
git push origin main
```

---

## Task 5：D5 运行时代码审计

**Files:**
- Modify: `docs/security/2026-05-06-security-audit.md`（D5 节）

> **设计要点：** D5 是经典代码审计 6 大类。每个类用一组 grep 模式找出所有候选点，逐个判断是否真有问题。这一步耗时最多。

- [ ] **Step 1：命令注入扫描**

```bash
rg -n 'child_process\|spawn\|execSync\|execFile\|spawnSync\|exec(' src/
```

每个命中点打开看：
- 是否传 shell?（`shell: true` 是高风险）
- 命令字符串是否拼接用户输入？
- 是否使用数组形式 args（推荐）？

- [ ] **Step 2：路径穿越扫描**

```bash
rg -n 'path\.(join\|resolve\|normalize)\|fs\.\(read\|write\|create\|access\|unlink\)' src/ | head -60
rg -n 'dataDir\|attachmentsDir\|tmpDir' src/
```

每个拼接 `dataDir` / `tmpDir` / 用户给的文件名的位置：
- 是否 sanitize 文件名（去 `..` / 绝对路径前缀）？
- 是否最终用 path.relative 检查结果还在 base 内？

- [ ] **Step 3：SSRF 扫描**

```bash
rg -n 'fetch(\|axios\|got\|http\.(get\|request)\|undici' src/
```

每个网络出站点：URL 是否含用户可控部分？如有，是否有 allowlist/blocklist？是否会被用作内网探测（127.0.0.1 / 169.254.169.254 metadata）？

- [ ] **Step 4：不安全反序列化扫描**

```bash
rg -n 'JSON\.parse\|yaml\.load\|eval(\|Function(\|vm\.\(runIn\)' src/
```

每个 JSON.parse 点：parse 后是否有 schema 校验（zod）？错误是否吃掉？

- [ ] **Step 5：错误信息泄露扫描**

```bash
rg -n 'error\.stack\|err\.stack\|String(\(error\|err\))\|JSON\.stringify\(.*error' src/
```

每处看：是否会把 stack trace 直接 reply 给 Telegram？

- [ ] **Step 6：资源耗尽扫描**

```bash
rg -n 'setTimeout\|setInterval\|setImmediate\|new Map(\|new Set(\|new Array(' src/ | head -40
rg -n 'limit\|max\|cap' src/ | head -30
```

重点看：
- 定时任务（reminders）有无单用户上限？
- 内存中 map / array（如 attachment queue / pending agent runs）有无 size cap？
- 流（pipe）有无超时？

- [ ] **Step 7：把 D5 finding 写入主报告 D5 节并更新 ToC**

D5 finding 数量预计最多。每条单独编号 F-XX，按子类分组（命令注入 / 路径穿越 / ... 共 6 子类）。

- [ ] **Step 8：commit T5**

```bash
git add docs/security/2026-05-06-security-audit.md
git commit -m "docs(security): D5 运行时代码审计结果"
git push origin main
```

---

## Task 6：D6 文件系统与持久化审查

**Files:**
- Modify: `docs/security/2026-05-06-security-audit.md`（D6 节）

> **设计要点：** D6 关注落盘 artifacts 的安全：data/ 目录权限、附件文件名 sanitize（与 D5 路径穿越互补）、临时文件清理、config.json 权限、跨 workspace 串扰。

- [ ] **Step 1：定位所有 fs 写入点**

```bash
rg -n 'fs\.\(writeFile\|writeFileSync\|createWriteStream\|mkdir\|mkdirSync\|appendFile\)' src/
```

记下：data 文件 / 附件 / 临时文件 / 标记文件（.claw/）的写入位置。

- [ ] **Step 2：审查目录权限设置**

```bash
rg -n 'mode:\|chmod\|0o\d{3}' src/
```

- 是否在 mkdir 时显式传 mode（如 `0o700`）？
- 是否在 writeFile 时显式传 mode（敏感文件应是 `0o600`）？
- macOS / Linux 下默认 umask 077 vs 022 行为差异，最好显式不依赖 umask。

- [ ] **Step 3：审查附件文件名 sanitize**

```bash
rg -n -B 2 -A 5 'file_name\|fileName\|attachment.*name\|saveAs' src/
```

每个落盘文件名：
- 是否去除 `..`、`/`、控制字符、null byte？
- 是否限制长度？
- 是否使用 hash / UUID 替代 raw name？

- [ ] **Step 4：审查临时文件清理**

```bash
rg -n 'os\.tmpdir\|fs\.unlink\|fs\.rm\|tmp-' src/
```

下载流中断 / 解析失败时是否清理已落盘的临时文件？

- [ ] **Step 5：审查 .claw/ 标记目录写位置**

```bash
rg -n '\.claw\b' src/
```

`.claw/` 写入哪个目录的根？是 workspace cwd 还是固定 home？是否会被恶意指令推到非预期位置？

- [ ] **Step 6：审查 config.json 加载与潜在覆写**

```bash
rg -n 'config\.json\|loadConfig\|ConfigSchema' src/
```

- 加载路径是否硬编码？
- 是否会因 cwd 变化而加载到不同 config（导致使用错的 token）？
- 是否有代码会写回 config.json？如有，权限设置如何？

- [ ] **Step 7：把 D6 finding 写入主报告 D6 节并更新 ToC**

- [ ] **Step 8：commit T6**

```bash
git add docs/security/2026-05-06-security-audit.md
git commit -m "docs(security): D6 文件系统与持久化审查结果"
git push origin main
```

---

## Task 7：主报告整合 + Executive Summary

**Files:**
- Modify: `docs/security/2026-05-06-security-audit.md`（Executive Summary 与 ToC）

> **设计要点：** 把 T1-T6 累积的所有 finding 编号去重 / 排序，填表 Executive Summary 的严重级分布，挑出 Top 3 Priority，刷新 Findings ToC 与每条 finding 的状态字段（此时全部为 Open）。

- [ ] **Step 1：扫一遍 D1-D6 节，提取所有 F-XX 编号与严重级**

打开 `docs/security/2026-05-06-security-audit.md`，把每节下的 `### F-XX` 标题与表格中的"严重级"字段抽出来。验证编号无跳号、无重复。

- [ ] **Step 2：填严重级分布表**

按统计结果填 Executive Summary 中的表格。

- [ ] **Step 3：选 Top 3**

排序规则：（a）严重级高优先；（b）同级别下，攻击成本低 / 触发条件少的优先；（c）修复成本 S 优先（可快速消除）。

- [ ] **Step 4：刷新 Findings ToC**

把每条 finding 一行汇总到顶部 ToC 表，每行：`F-XX | 标题 | 严重级 | D? | Open | -`（修复 PR 列暂为 `-`）。

- [ ] **Step 5：把 Status 改为 "Audit complete"，加一段交叉一致性说明**

```markdown
**Status**：Audit complete · 等待逐项处置决策（T8）
```

加一段：

```markdown
## 一致性说明

- 严重级分布与 Findings ToC 计数一致：见上方表格
- 每条 finding 至少含：严重级 / 位置 / 影响 / 修复建议
- 每条 finding 状态当前均为 Open；处置决策见后续 T8 阶段每个 fix PR 的引用
```

- [ ] **Step 6：commit T7**

```bash
git add docs/security/2026-05-06-security-audit.md
git commit -m "docs(security): T7 整合 Executive Summary + Findings ToC"
git push origin main
```

---

## Task 8：逐项处置决策与修复 PR（动态阶段）

> **设计要点：** 这一阶段不是预设步骤，而是一个交互模板。对 Findings ToC 中每条状态为 Open 的 finding，按下面流程走一遍。

**对每条 finding F-XX 重复 step 1-5：**

- [ ] **Step 1：通过 AskQuestion 呈现决策点**

```
问题：处置 F-XX <标题>？
- 修复（开 fix/F-XX-<slug> 分支 + TDD + PR）
- Accepted-Risk（标注理由，不修）
- Wont-Fix（标注理由，关闭）
- 跳过本轮（保留 Open，下次再决）
```

- [ ] **Step 2：若选 Accepted-Risk 或 Wont-Fix**

直接修改主报告中该 finding 的 `状态` 字段并追加 `**理由**` 段：

```markdown
**理由（Accepted-Risk）**：
（写明业务取舍 / 触发条件极小 / 已通过其他控制覆盖）
```

```bash
git add docs/security/2026-05-06-security-audit.md
git commit -m "docs(security): F-XX 标记 Accepted-Risk（<简述>）"
git push origin main
```

跳到下一条 finding。

- [ ] **Step 3：若选「修复」，开分支 + 写失败测试**

```bash
git checkout -b fix/F-XX-<slug>
```

> **TDD 强制：** 必须先在 `tests/**` 中加（或扩展）一个测试，能复现该 finding 描述的不安全行为。让它失败。

```bash
npm test -- <test-file-pattern>
# 预期：FAIL，证明问题存在
```

- [ ] **Step 4：实现最小修复**

只改造成 finding 中"修复建议"所述的代码段，不顺便重构其他部分。

```bash
npm test -- <test-file-pattern>
# 预期：PASS

npm test
# 预期：全量 141+ 测试全绿（具体数随之前任务变化）

npm run lint
npm run typecheck
```

- [ ] **Step 5：开 PR + squash merge**

```bash
git add <changed-files>
git commit -m "fix(security): F-XX <简述> (Fixes F-XX)"
git push -u origin fix/F-XX-<slug>

gh pr create \
  --base main \
  --head fix/F-XX-<slug> \
  --title "fix(security): F-XX <简述>" \
  --body "$(cat <<'EOF'
## Summary
- 修复主报告 F-XX 中描述的安全问题
- 详见 docs/security/2026-05-06-security-audit.md#F-XX

## Test plan
- [x] 加新测试 <path>::<name> 复现问题（红）
- [x] 实施修复后该测试通过（绿）
- [x] 全量 vitest 通过
- [x] lint / typecheck 通过

Fixes F-XX
EOF
)"
```

合并 PR：

```bash
gh pr merge --squash --delete-branch
```

回到 main 后更新主报告：

```bash
git checkout main
git pull --ff-only
```

修改主报告中 F-XX 的状态为 `Fixed`、修复 PR 列为 `#NN`，并在 `CHANGELOG.md` 的 `## [Unreleased]` 下加 `### Security` 小节追加：

```markdown
### Security
- F-XX <简述>（PR #NN）
```

提交：

```bash
git add docs/security/2026-05-06-security-audit.md CHANGELOG.md
git commit -m "docs(security): F-XX 标记 Fixed（PR #NN）"
git push origin main
```

跳到下一条 finding。

---

## Task 9：审查闭环与发布

**Files:**
- Modify: `docs/security/2026-05-06-security-audit.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1：确认 Findings ToC 中所有 finding 状态都不是 Open**

```bash
rg -n '\| Open \|' docs/security/2026-05-06-security-audit.md && echo "FAIL: 仍有 Open" || echo "OK: 全部决策完成"
```

- [ ] **Step 2：把主报告 Status 改为 closed**

```markdown
**Status**：Closed · 全部 finding 已处置（YYYY-MM-DD）
```

- [ ] **Step 3：在 CHANGELOG.md 下生成 release notes 段（如需要发版本）**

如本次审查触发了 patch 版本（如 0.1.x → 0.1.y），按现有 CHANGELOG 风格写：

```markdown
## [0.1.y] - YYYY-MM-DD

### Security
- F-01 <简述>（PR #NN）
- F-02 <简述>（PR #NN）
...
```

- [ ] **Step 4：commit + push**

```bash
git add docs/security/2026-05-06-security-audit.md CHANGELOG.md
git commit -m "docs(security): 安全审查闭环（全部 finding 已处置）"
git push origin main
```

- [ ] **Step 5：按 finishing-a-development-branch skill 决定后续**

由于本次工作直接在 main 上推进（每条 fix 单独走 PR），到此 main 已为最终态，不需要额外的合并/PR 决策。如未来重启审查，按 `YYYY-MM-DD` 新 spec/plan 走新一轮。

---

## Self-Review

针对 spec [`2026-05-06-security-audit-design.md`](../specs/2026-05-06-security-audit-design.md) 的覆盖检查：

| Spec 节 | Plan 任务 | 覆盖 |
|---|---|---|
| §1 背景 / §2 资产分级 / §3 信任边界 | T0 Step 1 | ✅ 落到 threat-model.md |
| §4 D1 Secret 检查项 | T1 Step 1-4 | ✅ |
| §4 D2 依赖检查项 | T2 Step 1-5 | ✅ |
| §4 D3 Telegram 检查项 | T3 Step 1-6 | ✅ |
| §4 D4 Cursor SDK 检查项 | T4 Step 1-5 | ✅ |
| §4 D5 代码审计检查项（6 子类） | T5 Step 1-6 | ✅ |
| §4 D6 文件系统检查项 | T6 Step 1-6 | ✅ |
| §5 Finding 模板 | T0 Step 2（骨架）+ 各 Tx Step "写 finding" | ✅ |
| §6 输出文件结构（threat-model + 主报告 + findings/） | T0 Step 1 + 主报告骨架 | ✅ |
| §7 工作流 4 阶段（威胁模型 / 各域审查 / 总报告整合 / 逐项 PR） | T0 / T1-T6 / T7 / T8 一一对应 | ✅ |
| §8 验收标准 1-7 | T9 Step 1-4 | ✅ |
| §9 工具依赖 | T1 Step 1（gitleaks fallback）/ T2 Step 1（npm audit） | ✅ |
| §10 风险（评估主观性 / public 仓库已有 fork） | T0 Step 1 §4 + T7 Step 5 一致性说明 | ✅ |

**Placeholder 扫描**：

- 没有 "TODO" / "TBD" / "implement later" / "fill in details"
- 所有 grep / ripgrep 模式都是具体可执行的
- 所有 commit message 都给了完整字符串
- 唯一动态部分：T8 中具体改哪些代码 — 这是按 finding 决定的，不是 placeholder 而是设计上的动态分支

**类型一致性**：

- 各任务对 main 报告路径都用同一字符串 `docs/security/2026-05-06-security-audit.md`
- 严重级集合统一为 Critical / High / Medium / Low / Info
- 状态集合统一为 Open / Fixed / Accepted-Risk / Wont-Fix
- Finding ID 统一为 F-XX 风格

**已识别小修**：

- spec 中 §4 D2 描述写了"telegraf"，实际项目用 grammy。本 plan 中已用 grammy。建议在执行前先把 spec 修一处。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-06-security-audit.md`.

**Per project rule (禁止 subagent)，仅一种执行选项：**

**Inline Execution** — 主 agent 在当前会话用 `executing-plans` skill 按 task 顺序执行，每完成一个 task 通过 AskQuestion 设置 checkpoint 供 review。
