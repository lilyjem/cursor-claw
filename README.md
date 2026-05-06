# cursor-claw

基于 [`@cursor/sdk`](https://cursor.com/cn/docs/sdk/typescript) 的 Telegram ↔ Cursor agent 桥；从手机指挥 Cursor agent 在你的本机仓库工作。

## 快速开始

```bash
npm install
cp config.example.json config.json
# 编辑 config.json 填入 telegram.botToken / telegram.allowedUserIds / cursor.apiKey
# 或者使用环境变量（优先级高于 config.json）：
export TELEGRAM_BOT_TOKEN="..."
export CURSOR_API_KEY="..."
npm run dev
```

打开 Telegram → 与你的 bot 私聊 → 输入 `/start` → 收到欢迎语。

## 命令

- `/help` — 帮助
- `/ws list|use <name>|add <name> <abs-path>|remove <name>|path` — 工作区管理
- `/reset` — 重置当前工作区会话（销毁 agent 实例，清掉 sessionStore 中的 agentId）
- `/cancel` — 取消当前 run
- `/status` — 当前 agent / 工作区 / 模型
- `/model <id>` — 切换默认模型（下次新会话生效）
- 普通文本 → 作为 prompt 发给当前工作区的 agent
- `!<文本>` → 强制打断当前 run 并用新文本启动（用于 agent 跑飞了的情况）

## 架构

层 | 模块
--- | ---
入口 | `src/bin/cursor-claw.ts`
适配器 | `src/adapters/telegram/`（grammy 实现 IMessenger）
命令 | `src/commands/`（parser + dispatch + handlers）
编排核心 | `src/core/orchestrator/`（AgentOrchestrator + StreamRenderer + busyPolicy + cursorSdkRuntime）
工作区 / 会话 / 访问控制 | `src/core/{workspace,session,access}/`
持久化 | `src/core/persist/jsonStore.ts`
配置 / 日志 | `src/config/`、`src/logger.ts`

抽象边界：`IMessenger` 与 `IAgentRuntime` 让 orchestrator 完全不感知 Telegram 与 Cursor SDK，单测中用 `StubMessenger` + `StubAgentRuntime` 跑端到端流程。

## 测试

```bash
npm test          # 76+ 单元/集成测试
npm run typecheck # tsc --noEmit
npm run lint
```

烟囱测试（需要真 API key）：

```bash
export CURSOR_API_KEY="..."
npx tsx tests/manual/sdk_smoke.ts
```

## M2：入站图片 / 出站附件 / Reminders

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

## 路线图

- **M1** — 端到端文本对话、工作区切换、命令、流式渲染、cancel、白名单、systemd-friendly 退出
- **M2（本里程碑）** — 双向附件、入站图片、reminders
- **M3** — 微信适配器骨架、Clawfox 浏览器集成、MCP 配置热更

详见 `docs/superpowers/specs/2026-05-05-cursor-claw-design.md`。

## 安全

bot 等同于把 shell 控制权交给消息平台。请：

- 严格管理 `TELEGRAM_BOT_TOKEN` 与 `CURSOR_API_KEY`，绝不要 commit 到 git
- 仅把白名单（`telegram.allowedUserIds`）设为你自己的 Telegram userId；非白名单消息将被静默忽略
- 在公开 Telegram bot 名下使用时，请关闭 group 加入与隐私模式之外的功能

## License

MIT
