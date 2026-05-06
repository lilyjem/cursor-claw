<h1 align="center">cursor-claw</h1>

<p align="center">
  <b>Telegram &harr; Cursor SDK 桥接</b><br/>
  把 Cursor agent 的能力从 IDE 解放到你的手机上。
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.10-43853d?logo=node.js&logoColor=white" alt="Node version"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.x-3178c6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://cursor.com/cn/docs/sdk/typescript"><img src="https://img.shields.io/badge/%40cursor%2Fsdk-1.0.x-7d56f4" alt="Cursor SDK"></a>
  <img src="https://img.shields.io/badge/tests-141%20passing-brightgreen" alt="Tests"/>
</p>

<p align="center">
  <a href="./README.md">English</a>
  &nbsp;·&nbsp;
  <b>简体中文</b>
</p>

<p align="center">
  <i>（截图占位 — 后续替换为 <code>docs/screenshots/hero.png</code>）</i>
</p>

---

## 这个项目是干什么的

Cursor agent 很强，但它只活在**你桌面上的 IDE 里**。一旦你离开电脑，agent 也就跟你"失联"了。

`cursor-claw` 是一个跑在你 dev 机上的小常驻进程，把 Cursor agent 的能力暴露到你随身带的 messenger：当前是 **Telegram**，roadmap 里还有 **微信** 等其他通道。你给 bot 发消息，bot 在你本地仓库里驱动 Cursor agent，结果再实时流式推回到对话里。**bot token 是你的、API key 是你的、shell 跑在你机器上**——没有任何第三方中间人。

> 在外面遛狗时，发一条 `/ws use myproj` → `修一下 main 上跑挂的那个测试`。两分钟后回家，dev 机上躺着一份干净的 test 输出。

## 主要能力

- 🤖 **端到端文本对话** — 完整的 Cursor agent 能力（shell / 改文件 / 工具），节流流式渲染（默认 800ms）
- 🗂 **多工作区** — 注册多个本地仓库，`/ws use <name>` 切换 agent
- 🧰 **命令系统** — `/help` `/ws` `/reset` `/cancel` `/status` `/model` `/remind`，以及 `!<text>` 强制打断
- 🖼 **入站图片** — 给 bot 发图（含相册多图），agent 自动接收并分析
- 📎 **出站附件** — agent 在 shell tool 里调 `claw-attach-image /tmp/x.png`，文件直接发到对话里
- ⏰ **Reminders** — 支持相对、绝对、当日时间；可以是纯文本提醒，也可以是"到点自动喂给 agent"的 prompt
- 🛡 **白名单访问控制** — 只有你列出的 Telegram userId 能跟 bot 对话，其他消息静默丢弃
- ✋ **取消 / 中断** — 软取消 `/cancel`，硬中断 `!新文本`
- 🐧 **服务化友好** — 干净的 SIGTERM 退出，适合 systemd / pm2 / launchd
- 🧪 **TDD 优先** — 141+ 单元 & 集成测试；`IMessenger` / `IAgentRuntime` 双抽象边界，orchestrator 完全不感知 Telegram 与 Cursor SDK

## 快速开始（60 秒）

> 想看更详细的安装路径？戳 **[docs/INSTALL.md](./docs/INSTALL.md)**。

### macOS / Linux / WSL2

```bash
git clone https://github.com/lilyjem/cursor-claw.git
cd cursor-claw
npm install
cp config.example.json config.json
# 编辑 config.json 填 botToken / allowedUserIds / apiKey
# 或者用环境变量（优先级高于 config.json）：

export TELEGRAM_BOT_TOKEN="123456:abcdef..."
export CURSOR_API_KEY="key_..."
npm run dev
```

### Windows（原生 PowerShell）

```powershell
git clone https://github.com/lilyjem/cursor-claw.git
cd cursor-claw
npm install
Copy-Item config.example.json config.json
# 编辑 config.json 填 botToken / allowedUserIds / apiKey
# 或者用环境变量：

$env:TELEGRAM_BOT_TOKEN = "123456:abcdef..."
$env:CURSOR_API_KEY     = "key_..."
npm run dev
```

打开 Telegram → 与你的 bot 私聊 → 输入 `/start` → 应该能收到欢迎消息。

## 前置准备

| 需要什么 | 怎么拿 |
| --- | --- |
| Node.js **>= 20.10** | <https://nodejs.org/> |
| **Telegram bot token** | 找 [@BotFather](https://t.me/BotFather) → `/newbot` → 拷贝 token |
| **你自己的 Telegram userId** | 给 [@userinfobot](https://t.me/userinfobot) 发 `/start` → 把数字 ID 填进 `telegram.allowedUserIds` |
| **Cursor API key** | <https://cursor.com/cn/docs/sdk/typescript> → settings → API keys |

详细图文步骤见 **[docs/PREREQUISITES.md](./docs/PREREQUISITES.md)**。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 帮助 |
| `/ws list` | 列出已注册工作区 |
| `/ws use <name>` | 切换当前工作区 |
| `/ws add <name> <abs-path>` | 注册一个工作区 |
| `/ws remove <name>` | 注销工作区 |
| `/ws path` | 打印当前工作区路径 |
| `/reset` | 重置当前工作区会话（销毁 agent 实例、清掉 sessionStore 中的 agentId） |
| `/cancel` | 优雅取消当前 run |
| `/status` | 当前 agent / 工作区 / 模型 |
| `/model <id>` | 切换默认模型（下次新会话生效） |
| `/remind add text 10m 喝水` | 单次文本提醒，10 分钟后触发 |
| `/remind add prompt 09:00 看 BTC 价格` | 每日定时 prompt，到点自动喂给 agent |
| `/remind list` / `/remind cancel <id>` | 管理活跃提醒 |
| _（普通文本）_ | 作为 prompt 发给当前工作区的 agent |
| `!<文本>` | **强制打断**当前 run 并用新文本重启（agent 跑飞时用） |

### 入站图片

直接给 bot 发图（或多图相册，最多 8 张）。可附 caption，会与图片一起作为 prompt 发给 agent。默认每个 prompt 最多 8 图、相册去抖 800ms，可在 `config.json` 的 `images.*` 调整。

### 出站附件

agent 在 shell tool 里可以这样调：

```bash
claw-attach-image /path/to/screenshot.png
claw-attach-file /path/to/report.pdf
```

cursor-claw 通过 `<workspace>/.claw/data-dir.txt` 定位 data 目录（agent 启动时自动写入）。如果失败，可显式 `CLAW_DATA_DIR=/path/to/data` 注入。

### Reminders 时间格式

- 相对：`10m` `1h30m` `45s` `2d`
- 当日 / 每日：`09:00` `22:30`
- 绝对：`2026-05-06T09:00`

默认时区 `Asia/Shanghai`，可在 `config.json` 的 `reminders.timezone` 覆盖。

## 架构

| 层 | 模块 |
| --- | --- |
| 入口 | `src/bin/cursor-claw.ts` |
| 适配器 | `src/adapters/telegram/`（grammy，实现 `IMessenger`） |
| 命令 | `src/commands/`（parser + dispatcher + handlers） |
| 编排核心 | `src/core/orchestrator/`（`AgentOrchestrator` + `StreamRenderer` + busy-policy + `cursorSdkRuntime`） |
| 工作区 / 会话 / 访问控制 | `src/core/{workspace,session,access}/` |
| Reminders / 附件 | `src/core/{reminders,attachments}/` |
| 持久化 | `src/core/persist/jsonStore.ts` |
| 配置 / 日志 | `src/config/`、`src/logger.ts` |
| CLI 工具 | `src/tools/attach-image.ts`、`src/tools/attach-file.ts` |

抽象边界：`IMessenger` 与 `IAgentRuntime` 让 orchestrator 完全不感知 Telegram 和 Cursor SDK。单测用 `StubMessenger` + `StubAgentRuntime` 跑端到端流程。

完整设计文档：[`docs/superpowers/specs/2026-05-05-cursor-claw-design.md`](./docs/superpowers/specs/2026-05-05-cursor-claw-design.md)。

## 测试

```bash
npm test            # 141+ 单元 & 集成测试（vitest）
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src tests
```

手工烟囱（需要真的 API key、真的 Telegram 对话）：

```bash
export CURSOR_API_KEY="..."
npx tsx tests/manual/sdk_smoke.ts          # 仅 Cursor SDK
# tests/manual/m2-smoke.md                   # 完整 M2 e2e 清单
```

## 部署

`cursor-claw` 是一个常驻单进程。挑你平台上熟悉的 supervisor 跑：

- **Linux** — `systemd` user unit（推荐）
- **Linux / macOS / Windows** — `pm2`（Node 原生跨平台）
- **macOS** — `launchd` user agent
- **Windows** — NSSM（把 Node 跑成 Windows Service）
- **Docker** — 规划中，本里程碑暂不提供（进程需要直接读写 host 文件系统 + 调 Cursor SDK）

具体 unit 文件 + 步骤见 **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)**。

## 路线图

- ✅ **M1** — 端到端文本对话、工作区切换、命令、流式渲染、cancel、白名单、systemd-friendly 退出
- ✅ **M2** — 双向附件、入站图片、reminders
- 🚧 **M3** — 微信适配器骨架、Clawfox 浏览器集成、MCP 配置热更

## 安全

这种 bot 本质上是**一个 messenger 后面挂着一个 shell**，要按这个心态对待：

- `TELEGRAM_BOT_TOKEN` 和 `CURSOR_API_KEY` 绝不能进 git。仓库的 `.gitignore` 已经排掉 `config.json` 和 `.claw/`。生产上请用环境变量
- `telegram.allowedUserIds` **只填你自己的 Telegram userId**。其他人的消息会被静默丢弃
- 如果你的 bot 名字被搜出来了（`@yourbot` 可被搜索），关闭群组功能、保持 bot 私有；或者直接换 token
- 用一个**非 root 系统用户**跑 bot，文件系统权限只给到你项目所在目录
- 把 Cursor SDK 当成"远程被授权执行 bash"来对待——因为它**就是**

## 常见问题

错误码与对应解释：**[docs/FAQ.md](./docs/FAQ.md)**。

几个高频：

- _"Local SDK agents require an explicit 'model'"_ → 升级了 `@cursor/sdk` 1.0.x 之后；`AgentOrchestrator` 现在已经在 resume 时透传 model，但要保证 `config.json` 里 `cursor.defaultModel` 配置正确
- _"Telegram: 400 Bad Request: can't parse entities"_ → HTML 模式被字面 `<word>` 卡住。usage 消息已经统一改 `parseMode: "plain"`；如果是你自定义代码触发的，记得 escape 尖括号或切换 parse mode
- _"`claw-attach-image: command not found`"_ → `npm install` 之后没 `npm link` 或没全局安装；agent 跑命令时拿不到本地 bin

## 贡献

欢迎 PR 和 issue。详见 **[.github/CONTRIBUTING.md](./.github/CONTRIBUTING.md)**。

简短开发循环：

```bash
npm test           # 红 / 绿
npm run typecheck  # 类型安全
npm run lint       # 风格
```

PR 前请修掉所有 lint 错误；项目坚持 TDD（先写测试）。

## License

[MIT](./LICENSE) &copy; 2026 Jem Li
