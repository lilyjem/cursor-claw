# Installation Guide

This document covers the four supported installation paths in detail. If you just want a 60-second copy-paste, see the [Quickstart](../README.md#quickstart-60-seconds) in the main README.

- [System requirements](#system-requirements)
- [macOS](#macos)
- [Linux](#linux)
- [Windows (native, PowerShell)](#windows-native-powershell)
- [WSL2 (Windows + Ubuntu)](#wsl2-windows--ubuntu)
- [Optional: install attach CLI globally](#optional-install-attach-cli-globally)
- [Verify the install](#verify-the-install)
- [Run as a long-lived service](#run-as-a-long-lived-service)

## System requirements

| Item | Minimum | Recommended |
| --- | --- | --- |
| Node.js | 20.10.0 | 22 LTS |
| npm | 10.x | comes with Node 22 |
| Disk | ~ 300 MB (deps + Cursor SDK cache) | 1 GB |
| RAM | 256 MB free for the process | 512 MB+ during agent runs |
| OS | macOS 12+, Ubuntu 20.04+, Windows 10 21H2+ | latest LTS |

> Cursor SDK itself spins up additional sub-processes (the agent shell). Plan for ~ 200–500 MB extra during a busy run.

## macOS

```bash
# 1. Install Node 20+ (use the official installer or Homebrew)
brew install node@22
brew link --force --overwrite node@22

# 2. Clone & install
git clone https://github.com/lilyjem/cursor-claw.git
cd cursor-claw
npm install

# 3. Configure
cp config.example.json config.json
# Open config.json, fill telegram.botToken / allowedUserIds / cursor.apiKey
# (Or skip and use env vars below.)

# 4. Run in dev mode
export TELEGRAM_BOT_TOKEN="123456:abcdef..."
export CURSOR_API_KEY="key_..."
npm run dev
```

## Linux

```bash
# 1. Install Node 20+ via nvm (recommended) or your distro's package
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
exec $SHELL
nvm install 22
nvm use 22

# 2. Clone & install
git clone https://github.com/lilyjem/cursor-claw.git
cd cursor-claw
npm install

# 3. Configure (same as macOS)
cp config.example.json config.json
# Edit config.json or set env vars

# 4. Run
export TELEGRAM_BOT_TOKEN="123456:abcdef..."
export CURSOR_API_KEY="key_..."
npm run dev
```

For long-lived Linux deploys, see [DEPLOYMENT.md (systemd)](./DEPLOYMENT.md#linux--systemd-user-unit).

## Windows (native, PowerShell)

> Native Windows works for the basics, but a few internals (file watchers, signals) are smoother under WSL2. If you can install WSL2, we recommend it.

```powershell
# 1. Install Node 20+ via winget or the official installer
winget install OpenJS.NodeJS.LTS
# Restart PowerShell so PATH picks up node/npm

node --version    # should print v20.10+ or v22.x
npm --version

# 2. Clone & install
git clone https://github.com/lilyjem/cursor-claw.git
cd cursor-claw
npm install

# 3. Configure
Copy-Item config.example.json config.json
# Open config.json in your editor and fill in tokens, OR use env vars:

$env:TELEGRAM_BOT_TOKEN = "123456:abcdef..."
$env:CURSOR_API_KEY     = "key_..."

# (To make these persist across PowerShell sessions, use [Environment]::SetEnvironmentVariable
#  with the User scope, or put them in your $PROFILE.)

# 4. Run
npm run dev
```

### Windows-specific gotchas

- The `bin` field in `package.json` (`cursor-claw`, `claw-attach-image`, `claw-attach-file`) is installed by npm as a `.cmd` shim plus a Bash launcher. Both work from PowerShell and CMD.
- The agent's shell tool runs `cmd.exe` by default on Windows, so any examples that say `bash`-style command substitution may need translating. cursor-claw itself does not assume bash.
- `tsx watch` on native Windows occasionally misses file rewrites done by editors that use `move` instead of `write` (VSCode is fine; some editors are not). If you see `npm run dev` not reloading, try `tsx --watch --watch-mode=poll src/bin/cursor-claw.ts`.
- Long paths: enable Win32 long-path support if your repo lives deep inside `C:\Users\<you>\OneDrive\...`.

## WSL2 (Windows + Ubuntu)

If you run Windows but want the Linux experience, WSL2 is the path of least friction.

```powershell
# (In an elevated PowerShell on Windows, once-per-machine)
wsl --install -d Ubuntu-22.04
# Reboot, finish Ubuntu first-run setup
```

Then **inside the Ubuntu shell**, follow the [Linux steps](#linux) above as normal. `npm run dev` will run inside WSL2 and connect to Telegram normally; you can edit files from VSCode on the Windows side via the WSL2 Remote extension.

## Optional: install attach CLI globally

The agent's shell tool calls `claw-attach-image` / `claw-attach-file` to send files back to your chat. These bins ship inside the cursor-claw package, but to make them available on the agent's `PATH`, do **one** of:

```bash
# A. Build the project, then link locally (recommended for dev)
npm run build
npm link

# B. Or globally install from your local checkout
npm run build
npm install -g .
```

Both put `claw-attach-image` / `claw-attach-file` on your `PATH`. Verify:

```bash
claw-attach-image --help
claw-attach-file --help
```

> The CLIs locate cursor-claw's data directory through `<workspace>/.claw/data-dir.txt`, written automatically when an agent starts. If that breakcrumb is missing, set `CLAW_DATA_DIR=/path/to/cursor-claw/data` explicitly.

## Verify the install

```bash
# 1. Build & smoke
npm run build
npm test               # all unit & integration tests should pass
npm run typecheck

# 2. Start in dev mode
npm run dev
```

You should see structured logs from `pino-pretty`, then something like:

```
INFO: Bot connected as @your_bot
INFO: Workspaces loaded: 1
```

In Telegram, message your bot:

```
/start
```

If you receive the welcome message, you're done.

## Run as a long-lived service

For 24/7 operation, hand the process to a supervisor:

- **Linux** &mdash; [`systemd` user unit](./DEPLOYMENT.md#linux--systemd-user-unit)
- **Cross-platform** &mdash; [`pm2`](./DEPLOYMENT.md#pm2-cross-platform)
- **macOS** &mdash; [`launchd` user agent](./DEPLOYMENT.md#macos--launchd-user-agent)
- **Windows** &mdash; [NSSM (Node as Windows Service)](./DEPLOYMENT.md#windows--nssm)
