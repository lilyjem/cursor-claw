# Prerequisites

cursor-claw needs three small things before it can run. None of them require payment, none of them take more than a few minutes.

1. [A Telegram bot token](#1-telegram-bot-token-via-botfather)
2. [Your own Telegram user ID](#2-your-own-telegram-user-id)
3. [A Cursor API key](#3-cursor-api-key)

Once you have all three, drop them into `config.json` (or set them as env vars) and `npm run dev` will start successfully.

---

## 1. Telegram bot token (via BotFather)

[`@BotFather`](https://t.me/BotFather) is Telegram's built-in bot for creating other bots. The flow is:

1. In Telegram, search **`@BotFather`** and tap **Start**.
2. Send `/newbot`.
3. BotFather will ask for a **display name** (free text, e.g. "Jem Personal Claw").
4. Then for a **username** (must end in `bot`, e.g. `jem_claw_bot`).
5. BotFather replies with:
   ```
   Use this token to access the HTTP API:
   123456789:AAEhBP0av-XXXXXXXXXXXXXXXXXXXXXX
   ```
   That string &mdash; the part after the colon, plus the digits before &mdash; is your **bot token**. Treat it like a password.

Place the full token in `config.json`:

```json
{
  "telegram": {
    "botToken": "123456789:AAEhBP0av-XXXXXXXXXXXXXXXXXXXXXX",
    "...": "..."
  }
}
```

Or as env var (overrides config):

```bash
# bash / zsh
export TELEGRAM_BOT_TOKEN="123456789:AAEhBP0av-XXXXXXXXXXXXXXXXXXXXXX"
```

```powershell
# PowerShell
$env:TELEGRAM_BOT_TOKEN = "123456789:AAEhBP0av-XXXXXXXXXXXXXXXXXXXXXX"
```

### BotFather follow-up settings (recommended)

While still talking to BotFather, also do:

- `/setprivacy` &rarr; **Enable** privacy mode (bot only sees messages addressed to it in groups; for a personal 1-on-1 bot this doesn't matter much, but is a safe default).
- `/setjoingroups` &rarr; **Disable** so randoms can't drag your bot into groups.
- `/setinline` &rarr; **Disable** unless you specifically want inline-mode features.
- `/setdescription` &rarr; short blurb shown to users when they open the bot.
- `/setcommands` &rarr; paste the following so Telegram shows nice command suggestions:

  ```
  help - Show help
  ws - Workspace management
  reset - Reset agent for current workspace
  cancel - Cancel current run
  status - Show current agent / workspace / model
  model - Switch default model
  remind - Manage reminders
  ```

> **Lost your token?** `/token` to BotFather, pick the bot. **Compromised?** `/revoke` to invalidate the old token and get a new one.

---

## 2. Your own Telegram user ID

cursor-claw uses an allow-list (`telegram.allowedUserIds`) to drop messages from anyone but you. To add yourself, you need your numeric Telegram user ID.

The easiest way:

1. In Telegram, search **`@userinfobot`** and tap **Start**.
2. The bot replies immediately with something like:
   ```
   Id: 123456789
   First: Jem
   Last: Li
   ```
3. The number after `Id:` is your user ID.

Put it in `config.json`:

```json
{
  "telegram": {
    "botToken": "...",
    "allowedUserIds": [123456789]
  }
}
```

Multiple owners? Add more numbers: `[123456789, 987654321]`.

> **Privacy note**: `@userinfobot` is a public third-party bot. If you'd rather not give it your data, you can also derive your ID via:
>
> ```bash
> # 1. Send any message to your own bot first.
> # 2. Then:
> curl "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"
> ```
>
> The reply contains `"from": { "id": 123456789, ... }` &mdash; that's your ID.

---

## 3. Cursor API key

cursor-claw drives Cursor agents through `@cursor/sdk`, which authenticates via API key.

1. Open Cursor docs: <https://cursor.com/cn/docs/sdk/typescript>.
2. In the Cursor desktop app, go to **Settings** &rarr; **API Keys** (or follow the link in the doc).
3. Click **Generate new key**, copy it.
4. Paste into `config.json`:

   ```json
   {
     "cursor": {
       "apiKey": "key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
       "defaultModel": { "id": "default", "params": [] },
       "settingSources": ["project", "user"]
     }
   }
   ```

   Or as env var (overrides config):

   ```bash
   export CURSOR_API_KEY="key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   ```

   ```powershell
   $env:CURSOR_API_KEY = "key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   ```

### Picking the default model

`cursor.defaultModel.id` controls which model the agent uses when no `/model <id>` override is active.

| Value | Meaning |
| --- | --- |
| `"default"` | Whatever your Cursor account currently has selected as default in the IDE. Recommended starting point. |
| `"<exact-model-id>"` | Pin to a specific model (e.g. a Claude or GPT variant). Check `@cursor/sdk` docs for current IDs. |

You can swap at any time from Telegram with `/model <id>`. The change takes effect for the **next** new session.

### Quota & cost

Cursor SDK runs are billed against your Cursor account. cursor-claw doesn't impose any local quota; if you forget about a long-running agent, it can burn through tokens. Two safety nets:

- `/cancel` &mdash; stop the current run cleanly.
- `!<text>` &mdash; force-interrupt and start a new run with new text.

Set up `telegram.allowedUserIds` correctly so an attacker can't trigger expensive runs through your bot.

---

## Putting it all together

After step 1, 2, 3, your `config.json` should look like:

```json
{
  "telegram": {
    "botToken": "123456789:AAEhBP0av-XXXXXXXXXXXXXXXXXXXXXX",
    "allowedUserIds": [123456789],
    "parseMode": "HTML"
  },
  "cursor": {
    "apiKey": "key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "defaultModel": { "id": "default", "params": [] },
    "settingSources": ["project", "user"]
  },
  "workspaces": { "autoRegisterCwd": true },
  "paths": { "dataDir": "./data" },
  "logging": { "level": "info" },
  "reminders": { "timezone": "Asia/Shanghai", "maxAheadDays": 30 },
  "attachments": { "maxFileSizeBytes": 20971520, "maxAttachmentsPerFlush": 10, "maxRetries": 3 },
  "images": {
    "maxImagesPerPrompt": 8,
    "defaultPromptSingle": "请分析这张图片",
    "defaultPromptMulti": "请分析这些图片",
    "mediaGroupDebounceMs": 800
  }
}
```

> **Never commit `config.json` to git.** The repo's `.gitignore` already excludes it. For production, prefer env vars (`TELEGRAM_BOT_TOKEN`, `CURSOR_API_KEY`) so secrets stay out of disk-resident config files.
