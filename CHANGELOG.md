# Changelog

All notable changes to **cursor-claw** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned (M3)
- WeChat adapter skeleton (validates `IMessenger` extensibility &mdash; multi-platform was the M2 design driver)
- Clawfox browser integration
- MCP config hot-reload

### Documentation
- Add full bilingual README, MIT `LICENSE`, and `docs/{INSTALL,PREREQUISITES,DEPLOYMENT,FAQ}.md`
- Add `.github/CONTRIBUTING.md`
- Security audit baseline: `docs/security/2026-05-06-{threat-model,security-audit}.md` (14 findings identified, 0 Critical / 2 High)

### Security
- **F-05 (High)** Enforce `maxFileSizeBytes` cap across the photo download path with three gates (file_size pre-check / content-length / streaming accumulator). Closes the OOM DoS attack a single allowed user could trigger by sending oversized files. Side-effect: closes one of the F-01 user-side leak vectors by sanitizing fetch error messages. ([PR #1](https://github.com/lilyjem/cursor-claw/pull/1))
- **F-14 (Medium)** Enforce `pendingRoot` boundary in `AttachmentDispatcher`. Reject any `queue.jsonl` entry whose path resolves outside the dispatcher's pending directory before any `readFile` / `unlink` / `sendImage`. Closes a path-traversal primitive that would let a successful prompt-injection (or queue-tampering) attacker exfiltrate arbitrary host files to the user's chat and `unlink` them. Uses `+ sep` prefix matching to also block sibling-directory bypass (`pendingRoot_evil/...`). ([PR #2](https://github.com/lilyjem/cursor-claw/pull/2))
- **F-13 (Medium)** Enforce `0o700` directory / `0o600` file mode across `dataDir`, `JsonStore`, `AttachmentQueue`, and the attach CLI (`attach-image` / `attach-file`). Prevents same-host other-user reads of session history, reminders, attachment originals, and chatId/userId. Includes POSIX-only unit and integration mode assertions. ([PR #3](https://github.com/lilyjem/cursor-claw/pull/3))
- **F-01 (Medium) + F-11 (Low)** Add string-content sanitizer (`src/util/sanitize.ts`) and wire it into both pino `formatters.log` (Layer B on top of existing path-based redact) and the user-facing `handleText` / `handleImageGroup` echo paths in `bin/cursor-claw.ts`. Catches `bot<token>/` Telegram bot URL fragments and `crsr_<hex>` Cursor API keys before they land in logs or Telegram chat. Independent of F-05's source-side fetch wrap; defense-in-depth for any future error source. ([PR #4](https://github.com/lilyjem/cursor-claw/pull/4))
- **F-03 (Medium)** Force-upgrade install-time transitive chain via `package.json` `overrides`: `tar` → 7.5.11+, `cacache` → 18, `make-fetch-happen` → 13, `node-gyp` → 10.3.1+, `http-proxy-agent` → 7, `@tootallnate/once` → 2 (re-mapped). Drops `npm audit` from 10 vulnerabilities (7 high) to 3 (1 high) — the 3 remaining are exactly the F-02 `undici` chain (Accepted-Risk). ([PR #5](https://github.com/lilyjem/cursor-claw/pull/5))
- **F-10 (Medium)** Wire `cursor.sandboxOptions` through `bin → orchestrator → cursorSdkRuntime → @cursor/sdk` (`local.sandboxOptions` on both `Agent.create` and `Agent.resume`). Schema default flips from undefined to `{ enabled: true }`, hardening the agent against prompt-injection (F-09) by default. Sandbox specifics live in `~/.cursor/sandbox.json` per the [Cursor sandbox.json reference](https://cursor.com/docs/reference/sandbox). Operators needing the old unrestricted behavior can opt out via `cursor.sandboxOptions.enabled = false` in `config.json`. ([PR #6](https://github.com/lilyjem/cursor-claw/pull/6))
- **F-06 (Medium)** Add three-layer resource caps: `TokenBucket` / `RateLimiter` for messenger message flood and `agentCreate` cached-miss throttling, plus `ReminderQuota` for per-user reminder totals. Defaults: message bucket capacity 4 with 2 msg/s refill, agent-create capacity 10 with 10/min refill, reminders max 100/user. Exceeded limits return Chinese retry/quota hints and log `warn` for owner diagnostics. ([PR #7](https://github.com/lilyjem/cursor-claw/pull/7), [#8](https://github.com/lilyjem/cursor-claw/pull/8), [#9](https://github.com/lilyjem/cursor-claw/pull/9), [#10](https://github.com/lilyjem/cursor-claw/pull/10), [#11](https://github.com/lilyjem/cursor-claw/pull/11))
- **F-04 (Low)** Add GitHub Actions CI plus `npm run audit:security`, an npm audit JSON gate that allows only the documented F-02 accepted-risk undici chain by package name and advisory source ID. New unallowlisted `moderate` / `high` / `critical` advisories fail CI. ([PR #12](https://github.com/lilyjem/cursor-claw/pull/12))
- **F-07 (Info)** Restrict `/ws add` to allowed workspace roots. Adds `workspaces.allowedRoots`, realpath-based boundary checks, sibling bypass protection (`/repo_evil` vs `/repo`), and a compatibility default of current cwd plus existing workspace paths. ([PR #13](https://github.com/lilyjem/cursor-claw/pull/13))
- **F-08 (Low)** Escape Telegram HTML output for command responses that include user-controlled workspace names, paths, reminder IDs, text, prompts, and workspace IDs. Adds shared `escapeHtml()` and tests for `<script>` / `<b>` / `&` payloads. ([PR #14](https://github.com/lilyjem/cursor-claw/pull/14))
- **F-09 (Info)** Wrap every user prompt before `agent.send()` in a `<user_request>` boundary envelope, preserving the original text while instructing the model not to treat user content as system/developer instructions. Applies to text, image, and reminder prompt flows. ([PR #15](https://github.com/lilyjem/cursor-claw/pull/15))
- **F-12 (Low)** Add schema validation for persisted JSON/JSONL inputs. `JsonStore` now supports validators; `WorkspaceRegistry`, `SessionStore`, and `ReminderStore` validate persisted files with zod; `AttachmentQueue` validates each JSONL entry and skips malformed shapes with a warning. ([PR #16](https://github.com/lilyjem/cursor-claw/pull/16))
- **F-02 (High)** Marked **Accepted-Risk**: `undici` ≤ 6.23.0 transitive vulnerabilities are not exploitable in this project's runtime call pattern (no HTTP server ingress; HTTP smuggling N/A; gzip-bomb requires MITM of Telegram CDN, blocked by TLS + threat-model trust assumption). Awaiting upstream `@cursor/sdk` / `@connectrpc/connect-node` upgrade. See `docs/security/2026-05-06-security-audit.md` F-02 for the full per-GHSA exposure matrix.

---

## [0.1.0] &mdash; 2026-05-06

First milestone release. Covers **M0 (scaffold)**, **M1 (text e2e)**, **M2 (attachments + reminders + images)** and the **M2 polish** post-smoke fix pass.

### Added &mdash; M0 (scaffold)

- TypeScript / ESM project skeleton (`tsup` + `vitest` + `eslint` + `prettier`).
- `pino`-based structured logger with auto-mask for sensitive fields.
- `JsonStore` &mdash; atomic JSON read/write with `.tmp` self-heal on crash.
- `zod`-validated config loader with environment-variable override (`TELEGRAM_BOT_TOKEN`, `CURSOR_API_KEY`, ...).

### Added &mdash; M1 (Telegram + Cursor SDK end-to-end)

- `IMessenger` abstraction + `StubMessenger` test double.
- `IAgentRuntime` abstraction + `StubAgentRuntime` test double.
- `WorkspaceRegistry` &mdash; multi-workspace switching with persistence.
- `SessionStore` &mdash; workspace &rarr; agentId mapping with persistence.
- `AccessControl` &mdash; allow-list filter on Telegram user IDs.
- `CommandParser` &mdash; parses `/cmd@bot args` form, exposes `rest` text.
- Command handlers: `/help`, `/ws (list|use|add|remove|path)`, `/reset`, `/cancel`, `/status`, `/model`.
- `parseForcePrefix` (`!<text>` &mdash; force-interrupt prefix) + `decideBusyAction` busy-policy.
- `summarizeTool` &mdash; defensive tool-call summary for the chat status line.
- `markdownToHtml` &mdash; minimalist Telegram-HTML renderer (code blocks, inline code, bold/italic, links).
- `StreamRenderer` &mdash; throttled `editMessageText` + status-line + long-message rotation.
- `AgentOrchestrator` MVP + 5 integration tests (Stub messenger + Stub runtime).
- Telegram adapter on `grammy` &mdash; implements `IMessenger`, includes inbound photo callback.
- `cursor-claw` main entry: `CursorSdkRuntime` wiring + Telegram bot + command dispatch.

### Added &mdash; M2 (images / attachments / reminders)

- **M2-A &mdash; Inbound images**:
  - `ImageGroupBuffer` &mdash; debounced media-group buffer (default 800ms).
  - `IMessenger.imageGroup` event + Telegram adapter wiring.
  - `AgentOrchestrator.runPromptWithImages` &mdash; passes images through to the SDK.
  - Wires `imageGroup` events to the orchestrator end-to-end.
- **M2-B &mdash; Outbound attachments**:
  - `AttachmentQueue` &mdash; JSONL append-only queue read/write.
  - `claw-attach-image` / `claw-attach-file` CLI tools (fast cold start).
  - `AttachmentDispatcher` &mdash; flush + retry + failure notification.
  - Orchestrator calls `dispatcher.flushForCwd` after each run.
- **M2-C &mdash; Reminders**:
  - `timeParser` &mdash; supports relative (`10m`, `1h30m`, `45s`, `2d`), HH:MM (today/daily), and absolute (`YYYY-MM-DDTHH:mm`) formats.
  - `ReminderStore` &mdash; persistence layer for active reminders.
  - `AgentOrchestrator.runReminder` &mdash; supports `text` and `prompt` reminder types.
  - `ReminderScheduler` &mdash; start/stop + busy-aware re-scheduling.
  - `/remind add|list|del` command routing + handler.
- **M2-D &mdash; Wiring**:
  - Main entry assembles dispatcher + scheduler.
  - Writes `<workspace>/.claw/data-dir.txt` so `claw-attach-*` CLIs can locate the data dir.
- Three new config sections: `reminders.*`, `attachments.*`, `images.*`.

### Fixed &mdash; M2 polish (post-smoke)

- **Album splitting**: `bot.on("message:photo")` was an `async` handler that `await`ed image downloads, serialising photo updates and stretching media-group debounce. Split into a synchronous push (`dataPromise`) + async `Promise.all` inside the buffer's `fire` callback.
- **Resume without model**: `AgentOrchestrator.ensureAgent` did not pass the model on `runtime.resume()`, breaking after a dev restart on Cursor SDK 1.0.x. Now passes `sess.model` + `sess.modelParams` (or `defaultModel` fallback).
- **`parseMode` for usage messages**: `/help`, `/ws`, `/model`, `/remind` usage texts contained literal `<time>` / `<id>` etc. and were sent with HTML parse mode, triggering Telegram 400. All such texts now use `{ parseMode: "plain" }`.
- **`/remind add` body parsing**: dispatcher passed full `cmd.rest` (incl. `add` subcommand) to `handleAdd`. Added `stripFirstToken` to remove the subcommand cleanly.
- **Cross-chunk markdown rendering**: `AgentOrchestrator` was calling `markdownToHtml` on each incremental chunk, breaking pairs (`**`, `` ` ``, ``` ``` ```) split across chunks. Refactored `StreamRenderer` to store raw markdown in `textBuffer` and convert once during `compose()`. Added `finalizeExtra` for HTML appended via `finalize(extra)`. `StreamRenderer` now wraps the render in try/catch with an HTML-escaped fallback.

### Changed

- `streamOptions.maxLen`: 3500 &rarr; 3000 to leave headroom for HTML expansion.
- `images.mediaGroupDebounceMs`: 200ms &rarr; 800ms (matches real Telegram media-group cadence).
- `cursor.defaultModel.id`: `"auto"` &rarr; `"default"` (Cursor SDK 1.0.x).

### Tests

- 141 unit + integration tests passing (vitest).
- `StubMessenger` + `StubAgentRuntime` drive end-to-end orchestrator tests with no Telegram / Cursor dependencies.
- New M2-polish regression tests:
  - `tests/unit/streamRenderer.test.ts` &mdash; cross-chunk markdown (bold, inline code, fenced code, links, HTML escape, `finalize(extra)`, status + buffer).
  - `tests/unit/remindCommand.test.ts` &mdash; `parseMode: "plain"` + body extraction.
  - `tests/integration/orchestrator.test.ts` &mdash; resume passes model from session.
- Manual smoke checklist: `tests/manual/m2-smoke.md`.

### Documentation

- Design specs:
  - `docs/superpowers/specs/2026-05-05-cursor-claw-design.md` (M1)
  - `docs/superpowers/specs/2026-05-05-cursor-claw-m2-design.md` (M2)
  - `docs/superpowers/specs/2026-05-06-streamrenderer-markdown-design.md` (polish)
- Implementation plans:
  - `docs/superpowers/plans/2026-05-05-cursor-claw-m1.md`
  - `docs/superpowers/plans/2026-05-05-cursor-claw-m2.md`
  - `docs/superpowers/plans/2026-05-06-streamrenderer-markdown.md`

[Unreleased]: https://github.com/lilyjem/cursor-claw/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lilyjem/cursor-claw/releases/tag/v0.1.0
