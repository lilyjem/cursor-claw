<h1 align="center">cursor-claw</h1>

<p align="center">
  <b>Telegram &harr; Cursor SDK bridge</b><br/>
  Drive Cursor agents on your local repos &mdash; from your phone.
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.10-43853d?logo=node.js&logoColor=white" alt="Node version"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.x-3178c6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://cursor.com/cn/docs/sdk/typescript"><img src="https://img.shields.io/badge/%40cursor%2Fsdk-1.0.x-7d56f4" alt="Cursor SDK"></a>
  <img src="https://img.shields.io/badge/tests-141%20passing-brightgreen" alt="Tests"/>
</p>

<p align="center">
  <b>English</b> &nbsp;·&nbsp;
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <i>(screenshot &mdash; TBD: replace with <code>docs/screenshots/hero.png</code>)</i>
</p>

---

## Why cursor-claw

Cursor's agent capability is amazing &mdash; but it lives **inside the IDE on your desk**. The moment you walk away, you also walk away from your agent.

`cursor-claw` is a tiny single-process service that runs on your dev machine and exposes Cursor agents through messengers you already carry: today **Telegram**, with **WeChat** and other channels in the roadmap. You text your bot, the bot drives Cursor agents on your local repos, the bot streams answers back. Everything runs on **your** hardware with **your** API keys &mdash; no third-party middleman.

> Walking the dog &mdash; tap **`/ws use myproj`** &rarr; **`fix the failing test on main`**. Two minutes later your home dev box has a clean test run waiting for you.

## Features

- 🤖 **End-to-end text conversation** &mdash; full Cursor agent capability (shell, edits, tools), with throttled streaming back to the chat (default 800ms)
- 🗂 **Multi-workspace** &mdash; register many local repos and `/ws use <name>` to switch agents
- 🧰 **Command system** &mdash; `/help` `/ws` `/reset` `/cancel` `/status` `/model` `/remind` and a `!<text>` interrupt prefix
- 🖼 **Inbound images** &mdash; send a photo (or an album) to the bot, the agent receives and analyses them automatically
- 📎 **Outbound attachments** &mdash; the agent calls `claw-attach-image /tmp/x.png` from inside its shell tool, the file is delivered to your chat
- ⏰ **Reminders** &mdash; absolute, relative or daily times; either plain text reminders or "prompt-on-fire" reminders that auto-trigger the agent
- 🛡 **Allow-list access control** &mdash; only the Telegram user IDs you list can talk to the bot; everyone else is silently dropped
- ✋ **Cancel & interrupt** &mdash; soft `/cancel`, hard `!new prompt`
- 🐧 **Service-friendly** &mdash; clean `SIGTERM` handling, suitable for `systemd` / `pm2` / `launchd`
- 🧪 **TDD-first** &mdash; 141+ unit & integration tests, full `IMessenger` / `IAgentRuntime` abstractions so the orchestrator never knows about Telegram or the Cursor SDK directly

## Quickstart (60 seconds)

> Need a more detailed walkthrough? See **[docs/INSTALL.md](./docs/INSTALL.md)**.

### macOS / Linux / WSL2

```bash
git clone https://github.com/lilyjem/cursor-claw.git
cd cursor-claw
npm install
cp config.example.json config.json
# Edit config.json (botToken, allowedUserIds, apiKey) -- or use env vars below

export TELEGRAM_BOT_TOKEN="123456:abcdef..."
export CURSOR_API_KEY="key_..."
npm run dev
```

### Windows (PowerShell, native)

```powershell
git clone https://github.com/lilyjem/cursor-claw.git
cd cursor-claw
npm install
Copy-Item config.example.json config.json
# Edit config.json (botToken, allowedUserIds, apiKey) -- or use env vars below

$env:TELEGRAM_BOT_TOKEN = "123456:abcdef..."
$env:CURSOR_API_KEY     = "key_..."
npm run dev
```

Open Telegram &rarr; private chat with your bot &rarr; type `/start` &rarr; you should see a welcome message.

## Prerequisites

| Requirement | How to get it |
| --- | --- |
| Node.js **>= 20.10** | <https://nodejs.org/> |
| **Telegram bot token** | Talk to [@BotFather](https://t.me/BotFather) &rarr; `/newbot` &rarr; copy token |
| **Telegram user ID** (your own) | Send `/start` to [@userinfobot](https://t.me/userinfobot) &rarr; copy numeric ID into `telegram.allowedUserIds` |
| **Cursor API key** | <https://cursor.com/cn/docs/sdk/typescript> &rarr; settings &rarr; API keys |

Detailed step-by-step (with screenshots) in **[docs/PREREQUISITES.md](./docs/PREREQUISITES.md)**.

## Commands

| Command | Description |
| --- | --- |
| `/help` | Show help |
| `/ws list` | List registered workspaces |
| `/ws use <name>` | Switch active workspace |
| `/ws add <name> <abs-path>` | Register a workspace |
| `/ws remove <name>` | Unregister a workspace |
| `/ws path` | Print current workspace path |
| `/reset` | Reset agent for current workspace (destroy agent, clear stored agentId) |
| `/cancel` | Cancel the current run gracefully |
| `/status` | Show active agent / workspace / model |
| `/model <id>` | Switch the default model (next session) |
| `/remind add text 10m drink water` | One-shot text reminder, fires in 10 minutes |
| `/remind add prompt 09:00 check BTC price` | Daily-time prompt reminder, fires the agent for you |
| `/remind list` / `/remind cancel <id>` | Manage active reminders |
| _(plain message)_ | Sent as a prompt to the active workspace agent |
| `!<text>` | **Interrupt** the running agent and start over with new text |

### Inbound images

Send a photo (or an album of up to 8) to the bot. They are bundled together with an optional caption and forwarded to the agent. Defaults: 8 images per prompt, 800ms album debounce. Configurable in `config.json` under `images.*`.

### Outbound attachments

Inside its shell tool, the agent can call:

```bash
claw-attach-image /path/to/screenshot.png
claw-attach-file /path/to/report.pdf
```

cursor-claw locates its data directory through `<workspace>/.claw/data-dir.txt` (auto-written when the agent runs). If that fails, set `CLAW_DATA_DIR=/path/to/data` explicitly.

### Reminders &mdash; time formats

- Relative: `10m` `1h30m` `45s` `2d`
- Today, daily: `09:00` `22:30`
- Absolute: `2026-05-06T09:00`

Default timezone `Asia/Shanghai`, override with `reminders.timezone` in `config.json`.

## Architecture

| Layer | Module |
| --- | --- |
| Entry | `src/bin/cursor-claw.ts` |
| Adapters | `src/adapters/telegram/` (grammy, implements `IMessenger`) |
| Commands | `src/commands/` (parser + dispatcher + handlers) |
| Orchestrator core | `src/core/orchestrator/` (`AgentOrchestrator` + `StreamRenderer` + busy-policy + `cursorSdkRuntime`) |
| Workspace / session / access | `src/core/{workspace,session,access}/` |
| Reminders / attachments | `src/core/{reminders,attachments}/` |
| Persistence | `src/core/persist/jsonStore.ts` |
| Config & logging | `src/config/`, `src/logger.ts` |
| CLI tools | `src/tools/attach-image.ts`, `src/tools/attach-file.ts` |

The two abstraction boundaries (`IMessenger`, `IAgentRuntime`) keep the orchestrator unaware of Telegram and the Cursor SDK; tests use `StubMessenger` + `StubAgentRuntime` to drive end-to-end flows.

Full design rationale: [`docs/superpowers/specs/2026-05-05-cursor-claw-design.md`](./docs/superpowers/specs/2026-05-05-cursor-claw-design.md).

## Testing

```bash
npm test            # 141+ unit & integration tests (vitest)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src tests
```

Manual smoke tests (require real API keys, real Telegram chat):

```bash
export CURSOR_API_KEY="..."
npx tsx tests/manual/sdk_smoke.ts          # Cursor SDK only
# tests/manual/m2-smoke.md                   # Full M2 e2e checklist
```

## Deployment

`cursor-claw` is a long-running single process. Pick whichever supervisor matches your platform:

- **Linux** &mdash; `systemd` user unit (recommended)
- **Linux / macOS / Windows** &mdash; `pm2` (Node-native cross-platform)
- **macOS** &mdash; `launchd` user agent
- **Windows** &mdash; NSSM (run Node service as Windows Service)
- **Docker** &mdash; planned, not in this milestone (the process needs host filesystem + Cursor SDK access)

Concrete unit files & step-by-step in **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)**.

## Roadmap

- ✅ **M1** &mdash; end-to-end text chat, workspace switching, commands, streaming, cancel, allow-list, systemd-friendly exit
- ✅ **M2** &mdash; bidirectional attachments, inbound images, reminders
- 🚧 **M3** &mdash; WeChat adapter skeleton, Clawfox browser integration, MCP config hot-reload

## Security

A bot of this kind is essentially a **shell behind a messenger**. Treat it accordingly:

- Keep `TELEGRAM_BOT_TOKEN` and `CURSOR_API_KEY` out of git. The repo's `.gitignore` already excludes `config.json` and `.claw/`. Use environment variables in production.
- Always set `telegram.allowedUserIds` to **just your own Telegram user IDs**. Non-listed messages are silently dropped.
- If your bot was discovered (`@yourbot` is searchable), turn off groups & make the bot private; or rotate the token.
- Run as a **non-root** OS user. Don't give the bot more filesystem access than your projects need.
- Treat Cursor SDK runs the same way you treat `bash` executed remotely &mdash; because that is what they are.

## FAQ

Common errors and what they mean: **[docs/FAQ.md](./docs/FAQ.md)**.

A few highlights:

- _"Local SDK agents require an explicit 'model'"_ &rarr; you upgraded `@cursor/sdk` past 1.0.x; `AgentOrchestrator` already passes the model on resume, but make sure your `config.json` has a valid `cursor.defaultModel`.
- _"Telegram: 400 Bad Request: can't parse entities"_ &rarr; HTML mode tried to render a literal `<word>`. Usage messages now use `parseMode: "plain"`; if you see this from custom code, escape angle brackets or switch parse mode.
- _"`claw-attach-image: command not found`"_ &rarr; you ran `npm install` but did not `npm link` or `npm i -g`; the agent's PATH does not see the local-only bin.

## Contributing

PRs and issues welcome. See **[.github/CONTRIBUTING.md](./.github/CONTRIBUTING.md)**.

Quick loop:

```bash
npm test           # red/green
npm run typecheck  # type safety
npm run lint       # style
```

Fix lint errors before opening a PR; the project follows a strict TDD approach (tests first).

## License

[MIT](./LICENSE) &copy; 2026 Jem Li
