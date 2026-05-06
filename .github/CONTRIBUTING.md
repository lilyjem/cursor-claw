# Contributing to cursor-claw

Thank you for considering a contribution! cursor-claw is a small, opinionated project. The contribution loop is intentionally tight; please skim this once before opening your first PR.

- [Quick loop](#quick-loop)
- [Development setup](#development-setup)
- [Test-driven workflow (mandatory)](#test-driven-workflow-mandatory)
- [Code style](#code-style)
- [Architecture rules](#architecture-rules)
- [Commit & PR conventions](#commit--pr-conventions)
- [Reporting issues](#reporting-issues)

---

## Quick loop

```bash
git checkout -b your-branch-name
# write a failing test
npm test                  # confirm RED
# implement minimal code
npm test                  # confirm GREEN
npm run typecheck         # tsc --noEmit
npm run lint              # eslint src tests
git add . && git commit -m "feat(scope): subject"
git push -u origin your-branch-name
gh pr create
```

PRs that don't run all four checks (`test` / `typecheck` / `lint` / formatting) won't be merged.

## Development setup

See **[docs/INSTALL.md](../docs/INSTALL.md)** for the full path. TL;DR:

```bash
git clone https://github.com/jem-li/cursor-claw.git
cd cursor-claw
npm install
cp config.example.json config.json   # not required for unit tests, but you'll want it eventually
```

## Test-driven workflow (mandatory)

cursor-claw is developed strictly TDD. Every behavioural change starts with a failing test:

1. **RED** &mdash; Write the smallest test that captures the desired behaviour. `npm test` should now show one new failure.
2. **GREEN** &mdash; Write the smallest implementation that makes the test pass. Don't refactor yet.
3. **REFACTOR** &mdash; Now clean up. Tests stay green throughout.
4. **COMMIT** &mdash; One commit per RED-GREEN-REFACTOR cycle, ideally.

We don't accept implementation-only PRs ("trust me, I tested manually"). If a behaviour is hard to test, please raise it in an issue first &mdash; we'll figure out the right test boundary together.

### Where the seams live

- **Unit tests** &mdash; `tests/unit/` &mdash; pure functions, parsers, single classes.
- **Integration tests** &mdash; `tests/integration/` &mdash; cross-module flows. Use `tests/helpers/StubMessenger.ts` and `tests/helpers/StubAgent.ts` to avoid real Telegram / SDK dependencies.
- **Manual smoke** &mdash; `tests/manual/` &mdash; checklists and `tsx` scripts that talk to real Telegram / Cursor SDK. Don't add manual tests as a substitute for unit/integration coverage; use them for end-to-end confidence after a milestone.

`vitest.config.ts` runs unit + integration but **not** `tests/manual/`.

## Code style

- **Formatter**: `prettier` (config in `.prettierrc`). Run `npm run format` to auto-fix.
- **Linter**: `eslint` (config in `eslint.config.js`). Run `npm run lint`. CI fails on any warning.
- **TypeScript**: `tsc --noEmit` must succeed. Strict mode is on.
- **Comments**: Add Chinese comments to source code where the *intent* or *non-obvious trade-off* needs explaining. **Don't** narrate what the code does; only explain *why*. (English comments are also accepted; use whichever the surrounding file uses.)
- **No `any`**: Use proper types or `unknown` + narrowing. If a third-party library forces `any`, isolate it in a small adapter.
- **No `console.log`**: Use the `pino` logger from `src/logger.ts`.

## Architecture rules

A few invariants that PRs must respect:

1. **Orchestrator is platform-agnostic**. `src/core/orchestrator/` must never import from `src/adapters/telegram/` or `@cursor/sdk` directly. Cross those seams only through `IMessenger` and `IAgentRuntime`.
2. **Adapters do not own state**. State (workspaces, sessions, reminders, attachments) lives in `src/core/`. Adapters are dumb pipes.
3. **Persistence is atomic**. Anything that hits disk goes through `JsonStore` (write-tmp + rename) or an append-only JSONL queue. No partial writes, ever.
4. **Secrets never appear in logs**. The pino logger has redaction wired up &mdash; preserve it. New config fields holding secrets must be added to the redact list.
5. **Public abstractions live in `src/<area>/types.ts`**. Don't bury type definitions inside implementation files; collocate them so future adapters (WeChat, Slack, &hellip;) can import the types cleanly.

## Commit & PR conventions

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) form:

```
<type>(<scope>): <subject>

[optional body]
```

Common types in this repo:

| Type | When to use |
| --- | --- |
| `feat` | new feature / capability |
| `fix` | bug fix |
| `refactor` | code change without behaviour change |
| `chore` | build, deps, tooling |
| `docs` | documentation-only |
| `test` | add tests without changing implementation |

Subject can be Chinese or English. Examples from the existing log:

```
feat(reminders): ReminderScheduler 启停 + busy 重排（M2-C）
fix(render): 跨 chunk markdown 整体渲染避免成对标记被切丢
docs(plan): M2 实现计划（17 个 TDD 任务，~4 day）
```

### PR checklist

Before opening a PR, verify:

- [ ] `npm test` &mdash; all unit + integration tests pass
- [ ] `npm run typecheck` &mdash; clean
- [ ] `npm run lint` &mdash; no warnings, no errors
- [ ] At least one new test covers the change (or you've explicitly explained why)
- [ ] No secrets, tokens, or `config.json` are committed (run `git diff --cached` before commit)
- [ ] Commit messages follow Conventional Commits
- [ ] If your change adds a config field, `config.example.json` is updated
- [ ] If your change changes user-visible behaviour, `CHANGELOG.md` (under `[Unreleased]`) is updated
- [ ] If your change touches `src/adapters/telegram/`, you've considered whether the change should also be reflected in (or compatible with) the future WeChat adapter

### PR description template

A short description goes a long way:

```markdown
## What
One sentence on the change.

## Why
What problem this solves; what user behaviour changes.

## How
Architectural notes, if relevant.

## Tests
- [x] tests/unit/foo.test.ts &mdash; new
- [x] tests/integration/orchestrator.test.ts &mdash; updated

## Related
- Closes #123
- Spec: docs/superpowers/specs/...
```

## Reporting issues

When opening a bug report, please include:

- **What you did**: 1-2 line repro.
- **What happened**: copy-paste of the actual log line / error message.
- **What you expected**: one sentence.
- **Environment**: `node --version`, OS, `npm ls @cursor/sdk` output.
- **Logs**: bump `logging.level` to `debug` and attach 20 surrounding lines if possible.

For security issues (token leakage, command-injection, &hellip;) please **don't** open a public issue &mdash; email the maintainer or open a private security advisory on GitHub.

---

Thanks again for taking the time. Patches that come with tests, clear commit messages, and a small description always get merged faster.
