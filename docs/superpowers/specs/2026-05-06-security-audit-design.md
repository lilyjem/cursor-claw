# cursor-claw 项目安全审查 — Design Spec

**Status**：approved 待实施
**Date**：2026-05-06
**Owner**：Jem
**Trigger**：仓库 `lilyjem/cursor-claw` 刚 public（commit `810a3d9`），需做一次系统化安全审查并按需修复
**Scope**：覆盖 secret/敏感面、依赖供应链、Telegram 输入与权限、Cursor SDK 调用与 prompt injection、运行时代码安全、文件系统与持久化六个领域；输出主报告 + 威胁模型 + 逐项修复 PR
**Out-of-Scope**：渗透测试、模糊测试、二进制反逆向、对 Telegram / Cursor 平台本身的安全性评估

---

## 1. 背景

`lilyjem/cursor-claw` 是一个把 Telegram 与 Cursor SDK 桥接的 Node.js / TypeScript 服务，让用户能在手机上驱动 Cursor agent 在桌面 workspace 内工作。仓库已包含：

- 141 个测试通过、`src/`、`bin/`、`tests/`、`docs/`、`config.example.json`、`README` 中英文双语
- 敏感运行时数据：Telegram Bot Token、Cursor API Key、`allowedUserIds` 白名单、`data/` 目录中的会话历史 / 定时任务 / 附件队列 / 聊天 ID
- 已正确写好 `.gitignore`（本次 push 前已验证 `config.json`、`.env`、`data/`、`.claw/` 均未进入历史）

将仓库公开后，攻击者可在 Internet 上读取所有源码、commit 历史、CI 配置。本次审查在 public 化的"窗口期"完成基线档案，并把可识别的修复落地。

## 2. 资产分级

| 资产 | 等级 | 一旦泄露/被攻陷的影响 |
|---|---|---|
| Telegram Bot Token | **Critical** | 攻击者冒充 bot 给所有授权用户发任意消息、读取全部更新 |
| Cursor API Key | **Critical** | 攻击者代你调 Cursor SDK，烧 quota、操纵 agent、可能联动账号 |
| `allowedUserIds` 白名单值 | High | 决定谁能驱动 bot；间接定位真实用户 |
| `data/` 会话 / 附件 / 定时任务 | High | 含历史对话、可能私人信息、附件原始字节 |
| `data/` 落盘文件名与路径 | Medium | 路径穿越可能写入主机任意位置 |
| 运行 bot 的进程 / 主机 | Critical | 命令注入 / RCE 直接接管主机 |
| Cursor agent 在 workspace 写权限 | High | 通过 prompt injection 让 agent 在主机执行 tool |

## 3. 信任边界

```
[Internet]
    │ Telegram MTProto
[Telegram Server]   ← 信任边界 1：Telegram 平台可信，但消息内容不可信
    │ getUpdates / sendMessage
[cursor-claw 进程]
  ├─ TelegramAdapter   ← 攻击面 A1：消息文本/命令/附件 = 不可信输入
  ├─ Config Loader     ← 攻击面 A2：config.json 持久化敏感数据
  ├─ Workspace Router  ← 攻击面 A3：cwd / 路径决策可能受消息影响
  ├─ Cursor SDK Client ← 攻击面 A4：prompt 由用户消息构造 → prompt injection
  └─ Data Store        ← 攻击面 A5：data/ 落盘、附件下载
        │
[Cursor Agent / 主机文件系统]   ← 信任边界 2：agent tool 真实写主机
```

## 4. 审查领域分解

| ID | 领域 | 关键检查项 |
|---|---|---|
| **D1** | Secret / 敏感面 | git 全历史 secret 扫描（gitleaks 或等价 regex 集）；`.gitignore` 完整性；README/docs 示例中是否误写真 token；log 输出是否会打印 token / API key |
| **D2** | 依赖供应链 | `npm audit`；关键依赖（telegraf、cursor-sdk）人工 review；`package-lock.json` 完整性；`postinstall` / `preinstall` 等 script 渗透面；过时依赖；license 合规 |
| **D3** | Telegram 输入 / 权限 | `allowedUserIds` 白名单实施位置（每个 handler 都检查吗？）；命令解析时的输入校验；附件下载 `maxFileSizeBytes` 是否真正强制（而不仅是文档承诺）；速率/flood 防护；`parseMode: HTML` 下用户文本是否会被 Telegram 客户端解析为 HTML |
| **D4** | Cursor SDK / Prompt Injection | 用户消息进入 prompt 时是否做边界标记；agent 是否被允许执行任意 tool（特别是文件写）；`settingSources` 配置安全性；Cursor API key 是否仅来自 env / config（不会被 prompt 写入日志）；错误消息是否回显 |
| **D5** | 运行时代码审计 | 命令注入（`child_process` / `spawn`）、路径穿越（凡是拼接 `data/`、附件路径处）、SSRF（fetch 用户给定 URL）、不安全反序列化（`JSON.parse` 用户内容据此执行）、错误信息泄露（catch 后向 Telegram 回传堆栈/绝对路径）、资源耗尽（图像/附件无限大、timer 无上限、map 无大小约束） |
| **D6** | 文件系统 / 持久化 | `data/` 目录权限（应 0700）、附件文件名 sanitize、临时文件清理、`config.json` 文件权限（应 0600）、`.claw/` 标记目录写位置安全、不会跨 workspace 串扰 |

## 5. Finding 模板

每条 finding 必备字段：

```markdown
### F-XX · <简明标题>

| 字段 | 内容 |
|---|---|
| 严重级 | Critical / High / Medium / Low / Info |
| CWE / CVE | 如适用 |
| 领域 | D1-D6 |
| 位置 | `src/foo/bar.ts:42-58` 或配置项 / 依赖名 |
| 状态 | Open / Fixed / Accepted-Risk / Wont-Fix |
| 修复 PR | 待补 / `#NN` |

**复现 / 触发条件**
（最少必要复现路径，未必含 PoC）

**影响**
（不修，攻击者能做什么 / 资产受损面）

**修复建议**
（具体到代码层面，含 minimal patch 思路）

**修复成本**
S（< 30 min）/ M（< 半天）/ L（≥ 半天 + 设计变更）
```

严重级评估锚点（自定）：

| 级别 | 含义 |
|---|---|
| Critical | 远程可利用，无需用户交互，资产为 Critical 等级 |
| High | 远程可利用但需特定条件，或资产为 High 等级 |
| Medium | 受限场景或需用户/管理员配合 |
| Low | 防御深度 / 最佳实践偏离，单独不可利用 |
| Info | 仅观察，不视为问题 |

## 6. 输出文件结构

```
docs/security/
├─ 2026-05-06-threat-model.md          ← 威胁模型骨架（基于 §2 §3 扩展）
├─ 2026-05-06-security-audit.md        ← 主报告（D1-D6 finding 汇总 + 摘要表）
└─ findings/                            ← 复杂 finding 的展开（finding 正文 > 200 字才独立成文件）
   ├─ F-01-<slug>.md
   └─ ...
```

主报告头部含：

- **Executive Summary**：1 段话 + 严重级分布表
- **Top 3 Priority**：最先该修的三个
- **Findings ToC**：F-01 ~ F-NN 一览（标题 / 严重级 / 状态 / PR）

## 7. 工作流（与已建立的分支保护规则契合）

```
brainstorming（已完成 → 本文档）
    ↓
writing-plans  ← 把本设计转成 implementation plan（含逐域任务，2-5 分钟粒度）
    ↓
executing-plans
    │
    ├─ 阶段 1：D0 威胁模型文档 → commit 到 main 分支（直推 OK，因 enforce_admins=false）
    │
    ├─ 阶段 2：D1-D6 各域审查（read-only，不改代码）
    │   每域结束：finding 草稿写入主报告对应章节 → commit
    │
    ├─ 阶段 3：主报告全文整合 + Executive Summary → commit 到 main
    │
    └─ 阶段 4：逐项 PR 决策（贯彻 T5）
        每条 finding 通过 AskQuestion 呈现：标题 / 严重级 / 修复建议 / 修复成本
          ├─ 选「修」     → 创建 fix/F-XX-<slug> 分支 → 实施 → 走 PR 流程
          ├─ 选「跳过」   → 标记 Accepted-Risk，写明理由
          └─ 选「Wont-Fix」→ 关闭，写明理由
```

每个修复 PR 遵循已建立的 main 分支保护规则：

- 必须经过 PR（线性历史强制）
- PR 描述含 `Fixes F-XX` 引用主报告
- 含至少 1 个测试或验证步骤（除非纯文档/配置）
- Squash merge

## 8. 验收标准

1. `docs/security/2026-05-06-threat-model.md` 已 commit 到 main
2. `docs/security/2026-05-06-security-audit.md` 已 commit，含 6 域全部 finding
3. Executive Summary 中严重级分布与 finding 列表一致
4. 每条 finding 至少 4 个核心字段齐备（严重级 / 位置 / 影响 / 修复建议）
5. 每条 finding 已经过逐项决策（Open / Fixed / Accepted-Risk / Wont-Fix 之一）
6. 所有 "Fixed" 的 finding 对应 PR 已合并并通过测试
7. `CHANGELOG.md` 增加 `### Security` 小节，列出已修复项

## 9. 工具依赖

| 工具 | 用途 | 缺失时降级 |
|---|---|---|
| `gitleaks` 或 `trufflehog` | git 全历史 secret 扫描 | 用 `git log -p` + ripgrep regex 集（telegram bot token、`crsr_`、AWS key、PEM 等） |
| `npm audit` | 依赖 CVE 扫描 | 内置 npm，必有 |
| `npm ls` | lockfile 完整性 | 内置 npm，必有 |
| `eslint` + 项目现有 config | 部分代码模式扫描 | 已装 |
| 人工 code review | D3-D6 主体 | 必备 |

## 10. 风险与已知限制

| 风险 | 缓解 |
|---|---|
| 严重级评估带主观性 | 每条 finding 列出影响和复现路径，最终判定权在用户 |
| 审查时间长，节奏可能拖 | 6 个领域分别 commit，随时可暂停回头继续 |
| 修复 PR 可能引入回归 | 每个修复 PR 至少 1 个测试 + 跑全量 vitest（141 个测试基线） |
| public 仓库已有外部克隆 | 即便 main 修复完，旧 commit 仍在历史中可被 fork。本次审查不做 history rewrite（无 secret 泄露事实），但在威胁模型中标注此事实 |
| AI 审查盲区 | 不替代专业渗透测试，不在 SLA 承诺内 |

## 11. 不在范围

- 渗透测试 / 实际利用 PoC / 模糊测试
- 二进制反逆向、依赖二进制 npm 包的 native 部分审计
- 对 Telegram、Cursor SDK、Node.js 运行时本身的安全审计
- DDoS / 网络层防护（属于部署层职责）
- 主机加固（属于运维职责，不在仓库代码范围）

## 12. 自我复审

- ✅ Placeholder 扫描：无 TBD / TODO / FIXME
- ✅ 内部一致性：§4 的 6 个领域与 §6 报告章节、§7 工作流阶段、§8 验收标准 1-1 对应
- ✅ 范围检查：单一焦点（一次安全审查），输出三类资产（威胁模型 + 主报告 + 修复 PR）
- ✅ 模糊性：「严重级」「修复成本」均在 §5 给出锚点定义；T5 逐项决策路径在 §7 阶段 4 有清晰分支
- ✅ 与项目惯例契合：spec 路径 `docs/superpowers/specs/`、命名 `YYYY-MM-DD-<topic>-design.md`、结构对齐已有 spec 风格
