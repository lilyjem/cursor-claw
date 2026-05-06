# cursor-claw Threat Model

**Date**：2026-05-06
**Repo**：lilyjem/cursor-claw（public，commit `810a3d9` 公开化时刻）
**Scope**：Telegram ↔ Cursor SDK 桥接 Node.js 服务

---

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

```
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
```

## 3. 攻击者画像

| 画像 | 能力 | 目标 |
|---|---|---|
| Internet 上的随机扫描者 | 可读 public 仓库源码、可在 Telegram 上发消息 | 找泄露 token / 公开依赖 CVE |
| 已被加进 `allowedUserIds` 但已撤销信任的前用户 | 可发任意 Telegram 消息到 bot | 横向滥用 Cursor agent / 越权读取私人数据 |
| 钓鱼 / 社会工程 | 诱导 owner 把恶意指令贴给 bot | Prompt injection → agent 在主机执行 |
| 第三方依赖被 typosquat / 投毒 | 通过 supply chain 进入运行时 | 长期潜伏 / 数据外传 |

## 4. public 化的事实约束

- **历史不可改写**：仓库公开后，旧 commit 永久可读。本次审查在 commit `810a3d9` 公开化时刻已验证 git 全历史不含 secret / 私人 data，但任何后续 secret 误提交无法仅靠 force-push 撤销 —— 必须撤销并轮换 token。
- **fork 已可能存在**：public 化后 GitHub 不能阻止任何人 fork。安全策略应预设 fork 已经存在；任何 secret 一旦进入历史即视为永久泄露。
- **Issue / Discussion 公开**：不要在 issue / PR 描述中粘贴真实 token / 路径 / 用户 ID。

## 5. 信任假设（明确写出）

- Telegram 平台本身可信（但单条消息内容不可信）
- Cursor 平台本身可信（但 agent 输出应视为 untrusted —— prompt injection 可让 agent 输出恶意建议）
- 运行 cursor-claw 的主机本身可信（cursor-claw 不防御 root 攻击者）
- `config.json` 文件由 owner 手工放置且文件权限正确（cursor-claw 不强制要求）
