# FAQ &mdash; Common errors and what they mean

If your problem isn't here, please open a [GitHub issue](https://github.com/lilyjem/cursor-claw/issues) with:

- exact error message
- `node --version`, OS / shell, and `npm ls @cursor/sdk` output
- minimum repro steps

---

## Startup errors

### `Error: ENOENT: no such file or directory, open 'config.json'`

You forgot step 2 of Quickstart:

```bash
cp config.example.json config.json   # macOS / Linux / WSL2
Copy-Item config.example.json config.json   # PowerShell
```

Or run with `CLAW_CONFIG=/path/to/your/config.json`.

---

### `ZodError: telegram.botToken: Required` (or similar)

Your `config.json` is missing a required field, **and** the corresponding env var (`TELEGRAM_BOT_TOKEN` / `CURSOR_API_KEY`) wasn't set either. Either fix the JSON or export the env var.

---

### `Cannot find module '@cursor/sdk'`

`npm install` didn't run cleanly, or you copied the source without `node_modules`. Re-run from the repo root:

```bash
rm -rf node_modules package-lock.json
npm install
```

If the SDK install itself errors, check Node version (`node --version` must be **&ge; 20.10.0**).

---

### `Local SDK agents require an explicit 'model'`

The Cursor SDK 1.0.x removed the implicit "use whatever default" mode for local agents. cursor-claw now passes the model explicitly on every `agent.create()` and `agent.resume()`. If you still see this:

1. Confirm `config.json` has a valid `cursor.defaultModel` (e.g. `{ "id": "default", "params": [] }` is fine).
2. Confirm you haven't manually set `cursor.defaultModel` to `null` or an empty string.
3. Run `git pull` &mdash; this regression was fixed in the M2 polish phase; older checkouts have a buggy `ensureAgent` path.

---

## Telegram errors

### `Telegram API error: 401 Unauthorized` during polling

Your `botToken` is wrong, or the bot was deleted / revoked from BotFather. Verify by hitting the Bot API directly:

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getMe"
```

A correct token returns `{"ok":true,"result":{"id":..., "username":..., ...}}`. A wrong token returns 401.

If the token *was* leaked: `/revoke` to BotFather to invalidate it, then `/token` to get a fresh one.

---

### `Telegram: 400 Bad Request: can't parse entities: Unsupported start tag "..."`

Telegram tried to render a literal `<word>` as an HTML tag. cursor-claw's bundled commands all use `parseMode: "plain"` for usage / error messages that contain angle brackets (`<time>`, `<id>`, ...). If you wrote a custom handler:

- Send the offending text with `{ parseMode: "plain" }`, **or**
- Escape the angle brackets: `&lt;time&gt;`

---

### Bot receives messages but never replies

Most likely your Telegram user ID isn't in the allow-list:

1. Send `/start` to [@userinfobot](https://t.me/userinfobot), copy `Id:` number.
2. Add it to `config.json`:

   ```json
   "telegram": { "allowedUserIds": [123456789] }
   ```

3. Restart cursor-claw. Non-allow-listed messages are **silently dropped** by design (no reply, no log noise) so you can't tell from the bot side.

To debug: bump logging to `debug` (`logging.level: "debug"`) and watch for `dropped non-allowlisted message` lines.

---

### Sending an album of photos &mdash; bot replies multiple times

(M2 regression, fixed in the smoke-test polish.)

Photos in a Telegram media group arrive on separate update events. cursor-claw debounces them via `images.mediaGroupDebounceMs` (default **800ms**). If you increased the debounce too high, the bot can timeout the album. If you lowered it too aggressively, the album splits.

Recommended: keep the default. If you have a slow network, raise it gradually (1000–1500 ms).

---

## Agent errors

### `claw-attach-image: command not found`

The agent's `PATH` doesn't include cursor-claw's bins. Two fixes:

```bash
# Option A &mdash; npm link from the repo
npm run build
npm link

# Option B &mdash; install globally
npm install -g .
```

Then verify:

```bash
which claw-attach-image
claw-attach-image --help
```

If the binary exists but the agent still can't find it, check that the agent's shell uses the same `PATH` as your interactive shell. systemd / launchd / NSSM each have their own `PATH` &mdash; add `Environment=PATH=...` (systemd) or equivalent.

---

### `claw-attach-image: cannot locate cursor-claw data dir`

The CLI tools find the running cursor-claw via `<workspace>/.claw/data-dir.txt`. This breadcrumb is auto-written by the agent on startup, but if it's missing (e.g. the workspace was created before cursor-claw was running), set the env var explicitly:

```bash
export CLAW_DATA_DIR="/absolute/path/to/cursor-claw/data"
claw-attach-image /tmp/x.png
```

For systemd, add `Environment=CLAW_DATA_DIR=/path` to the unit. For launchd, add it to the `EnvironmentVariables` plist dict.

---

### After restart, `agent.send` errors with "Local SDK agents require an explicit 'model'"

Old session has a stored `agentId` but the persisted record didn't include the `model` field. The fix is in current `main`; if you're on an older checkout, run:

```bash
# clear the stored agent ids; cursor-claw will create new ones cleanly
echo "{}" > data/sessions.json
```

(Substitute your actual `paths.dataDir`.)

---

### `tsx watch` doesn't restart on file change

A few editors save files via `move` instead of `write`, which `chokidar` (the underlying watcher) misses on some platforms. Use polling mode:

```bash
npx tsx --watch --watch-mode=poll src/bin/cursor-claw.ts
```

This is slightly more CPU-hungry but never misses a save.

---

## Markdown / streaming output errors

### Bot replies show literal `**` or `\`\`\`` instead of bold / code blocks

(M2 polish bug, fixed.)

`StreamRenderer` now stores raw markdown in its buffer and converts to HTML once during compose, so cross-chunk fragmentation no longer breaks formatting. If you still see literal markdown:

- Pull latest `main`.
- Confirm `streamOptions.maxLen` in `src/bin/cursor-claw.ts` is `3000`, not `3500`.
- Watch the `compose() error` log line; if `markdownToHtml` is throwing on certain content, the renderer falls back to escaped HTML so you'll see literal markdown rather than a Telegram parse error.

---

### Bot reply is truncated mid-sentence

Telegram's per-message hard limit is 4096 characters. cursor-claw rotates to a new message at `streamOptions.maxLen` (default 3000) to leave room for HTML expansion. If your agent regularly produces output longer than this, raise `maxLen` carefully (Telegram may still 400 on exotic content):

```ts
// src/bin/cursor-claw.ts
streamOptions: { throttleMs: 800, maxLen: 3000 },
```

---

## Reminders

### `/remind add ... 09:00 ...` fired immediately, not at 9:00

Your `reminders.timezone` doesn't match what you think. Default is `Asia/Shanghai`. If your machine is in a different TZ and you don't override `reminders.timezone`, cursor-claw still treats `09:00` as **09:00 in Asia/Shanghai**. Set the right timezone in `config.json`:

```json
"reminders": { "timezone": "America/New_York", "maxAheadDays": 30 }
```

### `/remind list` shows weird text body

(M2 dispatch bug, fixed.)

The dispatcher used to pass the raw `cmd.rest` (including the subcommand `add`) to `handleAdd`. Pull latest `main` and the persisted reminders should display correctly.

---

## Debugging tips

- **Bump log level**: set `"logging": { "level": "debug" }` in `config.json` and restart.
- **Run lint+typecheck before reporting bugs**: `npm run lint && npm run typecheck` &mdash; many "bugs" are pre-existing local edits.
- **Run the test suite**: `npm test`. All 141 tests should pass on a clean checkout. If they don't, it's a setup issue, not an upstream regression.
- **Smoke test without Telegram**: `npx tsx tests/manual/sdk_smoke.ts` exercises the Cursor SDK path independent of Telegram.
