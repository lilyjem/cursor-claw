# cursor-claw M1 Implementation Plan（端到端 Telegram MVP）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 macOS / Linux 上能跑起来一个 Node 进程：白名单 Telegram 用户在私聊里给 bot 发文本，agent 通过 `@cursor/sdk` 流式回复，主消息上有工具状态行；支持多工作区切换、`/cancel`、`!force`、模型管理；本里程碑**不含**附件、入站图片、reminders、clawfox、systemd、微信。

**Architecture:** 分层单进程；`adapters/telegram` 实现平台中立的 `IMessenger` 接口；`core/AgentOrchestrator` 是唯一 SDK 调用者，依赖 `IMessenger` 把流式事件渲染回去；持久化全部走 `data/*.json`（原子写）。

**Tech Stack:** Node.js 20+ ESM、TypeScript 5.5、`@cursor/sdk`、`grammy`、`zod`、`pino`、`vitest`、`tsx`、`tsup`。

**Spec 引用：** `docs/superpowers/specs/2026-05-05-cursor-claw-design.md`（路线图第 1-7 步）。

---

## File Structure (M1 范围内)

```
cursor-claw/
├── package.json                          [T1]
├── tsconfig.json                         [T1]
├── tsup.config.ts                        [T1]
├── eslint.config.js                      [T1]
├── .prettierrc                           [T1]
├── vitest.config.ts                      [T1]
├── .gitignore                            [既有 / T1 复核]
├── config.example.json                   [T4]
├── src/
│   ├── logger.ts                         [T2]
│   ├── core/
│   │   ├── persist/jsonStore.ts          [T3]
│   │   ├── access/AccessControl.ts       [T5]
│   │   ├── workspace/WorkspaceRegistry.ts[T6]
│   │   ├── session/SessionStore.ts       [T7]
│   │   ├── messenger/{IMessenger.ts, types.ts}  [T8]
│   │   ├── render/markdownToHtml.ts      [T9]
│   │   └── orchestrator/
│   │       ├── toolSummary.ts            [T10]
│   │       ├── busyPolicy.ts             [T11]
│   │       ├── streamRenderer.ts         [T12]
│   │       └── AgentOrchestrator.ts      [T13]
│   ├── config/{schema.ts, loadConfig.ts} [T4]
│   ├── commands/
│   │   ├── parser.ts                     [T14]
│   │   └── handlers/{help.ts, ws.ts, reset.ts, cancel.ts, status.ts, model.ts}  [T15]
│   ├── adapters/telegram/
│   │   ├── grammyClient.ts               [T16]
│   │   └── TelegramMessenger.ts          [T16]
│   └── bin/cursor-claw.ts                [T17]
├── tests/
│   ├── helpers/
│   │   ├── StubMessenger.ts              [T8]
│   │   └── StubAgent.ts                  [T13]
│   ├── unit/
│   │   ├── jsonStore.test.ts             [T3]
│   │   ├── loadConfig.test.ts            [T4]
│   │   ├── accessControl.test.ts         [T5]
│   │   ├── workspaceRegistry.test.ts     [T6]
│   │   ├── sessionStore.test.ts          [T7]
│   │   ├── markdownToHtml.test.ts        [T9]
│   │   ├── toolSummary.test.ts           [T10]
│   │   ├── busyPolicy.test.ts            [T11]
│   │   ├── streamRenderer.test.ts        [T12]
│   │   ├── commandParser.test.ts         [T14]
│   │   └── commandHandlers.test.ts       [T15]
│   ├── integration/
│   │   └── orchestrator.test.ts          [T13]
│   └── manual/
│       └── sdk_smoke.ts                  [T17]
└── README.md                              [T17]
```

---

## Task 1：项目脚手架（package.json / tsconfig / 工具链）

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `.prettierrc`
- Modify: `.gitignore`（追加 `coverage/`）

- [ ] **Step 1：创建 `package.json`**

```json
{
  "name": "cursor-claw",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.10.0" },
  "bin": {
    "cursor-claw": "./dist/bin/cursor-claw.js"
  },
  "scripts": {
    "dev": "tsx watch src/bin/cursor-claw.ts",
    "build": "tsup",
    "start": "node dist/bin/cursor-claw.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src tests",
    "format": "prettier --write \"src/**/*.ts\" \"tests/**/*.ts\"",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@cursor/sdk": "^0.1.0",
    "grammy": "^1.30.0",
    "zod": "^3.23.8",
    "pino": "^9.4.0",
    "pino-pretty": "^11.2.2",
    "dayjs": "^1.11.13",
    "mime-types": "^2.1.35",
    "commander": "^12.1.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.10",
    "@types/mime-types": "^2.1.4",
    "typescript": "^5.5.3",
    "tsx": "^4.16.2",
    "tsup": "^8.1.0",
    "vitest": "^2.0.4",
    "eslint": "^9.7.0",
    "@typescript-eslint/eslint-plugin": "^7.16.1",
    "@typescript-eslint/parser": "^7.16.1",
    "prettier": "^3.3.3"
  }
}
```

> 备注：`@cursor/sdk` 的版本号请安装时改为 `npm view @cursor/sdk version` 的实际最新版；其它包版本同样以 `npm install` 装到的为准（这里是给一个合理底线）。

- [ ] **Step 2：创建 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "outDir": "dist",
    "rootDir": ".",
    "lib": ["ES2023"],
    "types": ["node"]
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3：创建 `tsup.config.ts`、`vitest.config.ts`、`eslint.config.js`、`.prettierrc`**

`tsup.config.ts`：
```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin/cursor-claw.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node20",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  shims: false,
  banner: { js: "#!/usr/bin/env node" },
});
```

`vitest.config.ts`：
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
    },
  },
});
```

`eslint.config.js`（flat config，最小可用版）：
```javascript
import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2023, sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
  { ignores: ["dist/", "coverage/", "node_modules/"] },
];
```

`.prettierrc`：
```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100
}
```

> `@eslint/js` 是 flat config 必需依赖，`npm install` 时若缺，运行 `npm i -D @eslint/js`。

- [ ] **Step 4：扩充 `.gitignore`，并安装依赖、跑 typecheck**

把 `coverage/` 加入 `.gitignore`（已有的 `dist/`、`node_modules/`、`data/`、`config.json`、`.env*` 保留）。

执行：
```bash
npm install
npm install -D @eslint/js
npm run typecheck
```
预期：`typecheck` 退出码 0（项目当前没有源代码，但依赖与 tsconfig 都通过）。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "chore(scaffold): TypeScript/ESM 项目骨架 + 工具链（tsup/vitest/eslint/prettier）"
```

---

## Task 2：logger（pino 封装 + redact 敏感字段）

**Files:**
- Create: `src/logger.ts`
- Create: `tests/unit/logger.test.ts`

- [ ] **Step 1：写失败测试**

`tests/unit/logger.test.ts`：
```typescript
import { describe, it, expect } from "vitest";
import { redactSensitive } from "../../src/logger.js";

describe("redactSensitive", () => {
  it("把 botToken 替换为 ***", () => {
    const out = redactSensitive({ botToken: "1234:abcdef" });
    expect(out).toEqual({ botToken: "***" });
  });

  it("把 apiKey 替换为 ***", () => {
    const out = redactSensitive({ apiKey: "secret" });
    expect(out).toEqual({ apiKey: "***" });
  });

  it("递归处理嵌套对象", () => {
    const out = redactSensitive({
      cursor: { apiKey: "sk-...", model: "auto" },
      telegram: { botToken: "t1", parseMode: "HTML" },
    });
    expect(out).toEqual({
      cursor: { apiKey: "***", model: "auto" },
      telegram: { botToken: "***", parseMode: "HTML" },
    });
  });

  it("非敏感字段保持不变", () => {
    const out = redactSensitive({ a: 1, b: "ok" });
    expect(out).toEqual({ a: 1, b: "ok" });
  });

  it("处理数组", () => {
    const out = redactSensitive([{ apiKey: "x" }, { ok: true }]);
    expect(out).toEqual([{ apiKey: "***" }, { ok: true }]);
  });
});
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/unit/logger.test.ts
```
预期：失败（`redactSensitive` 未导出）。

- [ ] **Step 3：实现 `src/logger.ts`**

```typescript
import pino from "pino";

const SENSITIVE_KEYS = new Set([
  "botToken",
  "apiKey",
  "TELEGRAM_BOT_TOKEN",
  "CURSOR_API_KEY",
  "token",
  "secret",
]);

export function redactSensitive<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) ? "***" : redactSensitive(v);
    }
    return out as unknown as T;
  }
  return value;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "telegram.botToken",
      "cursor.apiKey",
      "*.botToken",
      "*.apiKey",
      "headers.authorization",
    ],
    censor: "***",
  },
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } },
});

export type Logger = typeof logger;
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/unit/logger.test.ts
```
预期：5 个测试全 pass。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(logger): 基于 pino 的日志器，敏感字段自动 mask"
```

---

## Task 3：jsonStore（原子读写 + 锁保护）

**Files:**
- Create: `src/core/persist/jsonStore.ts`
- Create: `tests/unit/jsonStore.test.ts`

- [ ] **Step 1：写失败测试**

`tests/unit/jsonStore.test.ts`：
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../../src/core/persist/jsonStore.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jsonstore-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Foo { x: number; y?: string }

describe("JsonStore", () => {
  it("readOrInit 返回默认值并写盘", async () => {
    const store = new JsonStore<Foo>(join(dir, "foo.json"), { x: 0 });
    const data = await store.readOrInit();
    expect(data).toEqual({ x: 0 });
    const onDisk = JSON.parse(await readFile(join(dir, "foo.json"), "utf8"));
    expect(onDisk).toEqual({ x: 0 });
  });

  it("write 后 read 能拿到新值", async () => {
    const store = new JsonStore<Foo>(join(dir, "foo.json"), { x: 0 });
    await store.readOrInit();
    await store.write({ x: 7, y: "hi" });
    const back = await store.read();
    expect(back).toEqual({ x: 7, y: "hi" });
  });

  it("原子写：写入过程中不会出现 *.tmp 残留", async () => {
    const store = new JsonStore<Foo>(join(dir, "foo.json"), { x: 0 });
    await store.write({ x: 99 });
    const onDisk = JSON.parse(await readFile(join(dir, "foo.json"), "utf8"));
    expect(onDisk).toEqual({ x: 99 });
    await expect(stat(join(dir, "foo.json.tmp"))).rejects.toThrow();
  });

  it("启动时若发现遗留 *.tmp 文件则删除并日志告警", async () => {
    await writeFile(join(dir, "foo.json.tmp"), "garbage", "utf8");
    const store = new JsonStore<Foo>(join(dir, "foo.json"), { x: 1 });
    await store.readOrInit();
    await expect(stat(join(dir, "foo.json.tmp"))).rejects.toThrow();
  });

  it("update 能基于当前值写回", async () => {
    const store = new JsonStore<Foo>(join(dir, "foo.json"), { x: 1 });
    await store.readOrInit();
    await store.update((cur) => ({ ...cur, x: cur.x + 10 }));
    expect((await store.read()).x).toBe(11);
  });
});
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/unit/jsonStore.test.ts
```
预期：失败（`JsonStore` 未导出）。

- [ ] **Step 3：实现 `src/core/persist/jsonStore.ts`**

```typescript
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../../logger.js";

export class JsonStore<T> {
  private cache?: T;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly defaults: T,
  ) {}

  async readOrInit(): Promise<T> {
    if (this.cache !== undefined) return this.cache;
    await this.cleanupTmp();
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.cache = JSON.parse(raw) as T;
      return this.cache;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        await this.write(this.defaults);
        return this.defaults;
      }
      throw e;
    }
  }

  async read(): Promise<T> {
    if (this.cache !== undefined) return this.cache;
    return this.readOrInit();
  }

  async write(value: T): Promise<void> {
    this.cache = value;
    this.writing = this.writing.then(() => this.flush(value));
    return this.writing;
  }

  async update(fn: (current: T) => T | Promise<T>): Promise<T> {
    const current = await this.read();
    const next = await fn(current);
    await this.write(next);
    return next;
  }

  private async flush(value: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }

  private async cleanupTmp(): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    try {
      await stat(tmp);
      await unlink(tmp);
      logger.warn({ tmp }, "Removed stale tmp file");
    } catch {
      /* not exist; ignore */
    }
  }
}
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/unit/jsonStore.test.ts
```
预期：5 个测试全 pass。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(persist): JsonStore 提供原子读写 + 残留 .tmp 自愈"
```

---

## Task 4：Config schema + loader

**Files:**
- Create: `src/config/schema.ts`
- Create: `src/config/loadConfig.ts`
- Create: `tests/unit/loadConfig.test.ts`
- Create: `config.example.json`

- [ ] **Step 1：写失败测试**

`tests/unit/loadConfig.test.ts`：
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/loadConfig.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cfg-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.CURSOR_API_KEY;
});

describe("loadConfig", () => {
  it("从 JSON 文件加载并套用默认值", async () => {
    const p = join(dir, "config.json");
    await writeFile(p, JSON.stringify({
      telegram: { botToken: "T", allowedUserIds: [42] },
      cursor:   { apiKey: "K" },
    }), "utf8");
    const cfg = await loadConfig({ configPath: p });
    expect(cfg.telegram.botToken).toBe("T");
    expect(cfg.telegram.parseMode).toBe("HTML");
    expect(cfg.telegram.allowedUserIds).toEqual([42]);
    expect(cfg.cursor.apiKey).toBe("K");
    expect(cfg.cursor.defaultModel.id).toBe("auto");
    expect(cfg.cursor.settingSources).toEqual(["project", "user"]);
    expect(cfg.paths.dataDir).toBe("./data");
  });

  it("环境变量覆盖文件值", async () => {
    const p = join(dir, "config.json");
    await writeFile(p, JSON.stringify({
      telegram: { botToken: "T_FILE", allowedUserIds: [1] },
      cursor:   { apiKey: "K_FILE" },
    }), "utf8");
    process.env.TELEGRAM_BOT_TOKEN = "T_ENV";
    process.env.CURSOR_API_KEY = "K_ENV";
    const cfg = await loadConfig({ configPath: p });
    expect(cfg.telegram.botToken).toBe("T_ENV");
    expect(cfg.cursor.apiKey).toBe("K_ENV");
  });

  it("缺失必填字段应抛出 ConfigError", async () => {
    const p = join(dir, "config.json");
    await writeFile(p, JSON.stringify({
      telegram: { allowedUserIds: [1] },
      cursor:   { apiKey: "K" },
    }), "utf8");
    await expect(loadConfig({ configPath: p })).rejects.toThrow(/telegram\.botToken/);
  });

  it("allowedUserIds 必须至少一个", async () => {
    const p = join(dir, "config.json");
    await writeFile(p, JSON.stringify({
      telegram: { botToken: "T", allowedUserIds: [] },
      cursor:   { apiKey: "K" },
    }), "utf8");
    await expect(loadConfig({ configPath: p })).rejects.toThrow(/allowedUserIds/);
  });
});
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/unit/loadConfig.test.ts
```
预期：失败（`loadConfig` 不存在）。

- [ ] **Step 3：实现**

`src/config/schema.ts`：
```typescript
import { z } from "zod";

export const ConfigSchema = z.object({
  telegram: z.object({
    botToken: z.string().min(1),
    allowedUserIds: z.array(z.number().int()).min(1),
    parseMode: z.enum(["HTML", "Markdown", "plain"]).default("HTML"),
  }),
  cursor: z.object({
    apiKey: z.string().min(1),
    defaultModel: z
      .object({
        id: z.string().default("auto"),
        params: z
          .array(z.object({ id: z.string(), value: z.string() }))
          .default([]),
      })
      .default({ id: "auto", params: [] }),
    settingSources: z
      .array(z.enum(["project", "user", "team", "mdm", "plugins", "all"]))
      .default(["project", "user"]),
    sandboxOptions: z.object({ enabled: z.boolean() }).optional(),
  }),
  workspaces: z
    .object({ autoRegisterCwd: z.boolean().default(true) })
    .default({ autoRegisterCwd: true }),
  mcpServers: z.record(z.unknown()).optional(),
  paths: z
    .object({ dataDir: z.string().default("./data") })
    .default({ dataDir: "./data" }),
  logging: z
    .object({ level: z.enum(["debug", "info", "warn", "error"]).default("info") })
    .default({ level: "info" }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ConfigError";
  }
}
```

`src/config/loadConfig.ts`：
```typescript
import { readFile } from "node:fs/promises";
import { ConfigSchema, ConfigError, type AppConfig } from "./schema.js";

export interface LoadConfigOptions {
  configPath?: string;
}

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<AppConfig> {
  const path = opts.configPath ?? "./config.json";
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`config file not found: ${path}`);
    }
    throw new ConfigError(`failed to parse config: ${(e as Error).message}`);
  }

  const overlay = applyEnvOverlay(raw);
  const parsed = ConfigSchema.safeParse(overlay);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`config validation failed:\n${issues}`);
  }
  return parsed.data;
}

function applyEnvOverlay(raw: unknown): unknown {
  const r = (raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {}) as {
    telegram?: Record<string, unknown>;
    cursor?: Record<string, unknown>;
  };
  if (process.env.TELEGRAM_BOT_TOKEN) {
    r.telegram = { ...(r.telegram ?? {}), botToken: process.env.TELEGRAM_BOT_TOKEN };
  }
  if (process.env.CURSOR_API_KEY) {
    r.cursor = { ...(r.cursor ?? {}), apiKey: process.env.CURSOR_API_KEY };
  }
  return r;
}
```

`config.example.json`：
```json
{
  "telegram": {
    "botToken": "REPLACE_OR_SET_TELEGRAM_BOT_TOKEN_ENV",
    "allowedUserIds": [123456789],
    "parseMode": "HTML"
  },
  "cursor": {
    "apiKey": "REPLACE_OR_SET_CURSOR_API_KEY_ENV",
    "defaultModel": { "id": "auto", "params": [] },
    "settingSources": ["project", "user"]
  },
  "workspaces": { "autoRegisterCwd": true },
  "paths": { "dataDir": "./data" },
  "logging": { "level": "info" }
}
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/unit/loadConfig.test.ts
```
预期：4 个测试全 pass。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(config): zod 校验 + 环境变量覆盖 + config.example.json"
```

---

## Task 5：AccessControl（白名单）

**Files:**
- Create: `src/core/access/AccessControl.ts`
- Create: `tests/unit/accessControl.test.ts`

- [ ] **Step 1：写失败测试**

`tests/unit/accessControl.test.ts`：
```typescript
import { describe, it, expect } from "vitest";
import { AccessControl } from "../../src/core/access/AccessControl.js";

describe("AccessControl", () => {
  it("白名单用户 → allow", () => {
    const ac = new AccessControl([1, 2, 3]);
    expect(ac.isAllowed(1)).toBe(true);
    expect(ac.isAllowed(3)).toBe(true);
  });

  it("非白名单用户 → deny", () => {
    const ac = new AccessControl([1, 2]);
    expect(ac.isAllowed(99)).toBe(false);
  });

  it("空白名单 → 总是 deny", () => {
    const ac = new AccessControl([]);
    expect(ac.isAllowed(1)).toBe(false);
  });

  it("primary userId 等于白名单第一个", () => {
    const ac = new AccessControl([42, 7]);
    expect(ac.primaryUserId()).toBe(42);
  });
});
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/unit/accessControl.test.ts
```
预期：失败（`AccessControl` 未导出）。

- [ ] **Step 3：实现**

`src/core/access/AccessControl.ts`：
```typescript
export class AccessControl {
  private readonly set: Set<number>;
  private readonly first?: number;

  constructor(allowedUserIds: number[]) {
    this.set = new Set(allowedUserIds);
    this.first = allowedUserIds[0];
  }

  isAllowed(userId: number): boolean {
    return this.set.has(userId);
  }

  primaryUserId(): number | undefined {
    return this.first;
  }
}
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/unit/accessControl.test.ts
```
预期：4 个测试全 pass。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(access): 白名单 AccessControl"
```

---

## Task 6：WorkspaceRegistry

**Files:**
- Create: `src/core/workspace/WorkspaceRegistry.ts`
- Create: `tests/unit/workspaceRegistry.test.ts`

- [ ] **Step 1：写失败测试**

`tests/unit/workspaceRegistry.test.ts`：
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceRegistry, WorkspaceError } from "../../src/core/workspace/WorkspaceRegistry.js";

let dir: string;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "wsr-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("WorkspaceRegistry", () => {
  it("init 时若 active 不存在，自动注册 cwd 为 default", async () => {
    const reg = new WorkspaceRegistry(join(dir, "workspaces.json"));
    await reg.init({ autoRegisterCwd: true, cwd: dir });
    expect(reg.getActive()?.name).toBe("default");
    expect(reg.getActive()?.path).toBe(dir);
  });

  it("add / use / list", async () => {
    const reg = new WorkspaceRegistry(join(dir, "workspaces.json"));
    await reg.init({ autoRegisterCwd: true, cwd: dir });
    reg.add("alpha", dir);
    reg.use("alpha");
    expect(reg.getActive()?.name).toBe("alpha");
    const list = reg.list();
    expect(list.map((w) => w.name).sort()).toEqual(["alpha", "default"]);
    await reg.persist();
  });

  it("add 重名 → 抛错", async () => {
    const reg = new WorkspaceRegistry(join(dir, "workspaces.json"));
    await reg.init({ autoRegisterCwd: true, cwd: dir });
    reg.add("alpha", dir);
    expect(() => reg.add("alpha", dir)).toThrow(WorkspaceError);
  });

  it("use 不存在的工作区 → 抛错", async () => {
    const reg = new WorkspaceRegistry(join(dir, "workspaces.json"));
    await reg.init({ autoRegisterCwd: true, cwd: dir });
    expect(() => reg.use("ghost")).toThrow(WorkspaceError);
  });

  it("remove active → 抛错", async () => {
    const reg = new WorkspaceRegistry(join(dir, "workspaces.json"));
    await reg.init({ autoRegisterCwd: true, cwd: dir });
    expect(() => reg.remove("default")).toThrow(WorkspaceError);
  });

  it("持久化后能恢复", async () => {
    const p = join(dir, "workspaces.json");
    const a = new WorkspaceRegistry(p);
    await a.init({ autoRegisterCwd: true, cwd: dir });
    a.add("alpha", dir);
    a.use("alpha");
    await a.persist();

    const b = new WorkspaceRegistry(p);
    await b.init({ autoRegisterCwd: false, cwd: dir });
    expect(b.getActive()?.name).toBe("alpha");
  });
});
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/unit/workspaceRegistry.test.ts
```
预期：失败。

- [ ] **Step 3：实现**

`src/core/workspace/WorkspaceRegistry.ts`：
```typescript
import { JsonStore } from "../persist/jsonStore.js";

export interface Workspace {
  name: string;
  path: string;
}

interface RegistryFile {
  active?: string;
  items: Record<string, Workspace>;
}

export class WorkspaceError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "WorkspaceError";
  }
}

export class WorkspaceRegistry {
  private readonly store: JsonStore<RegistryFile>;
  private state: RegistryFile = { items: {} };

  constructor(filePath: string) {
    this.store = new JsonStore<RegistryFile>(filePath, { items: {} });
  }

  async init(opts: { autoRegisterCwd: boolean; cwd: string }): Promise<void> {
    this.state = await this.store.readOrInit();
    if (opts.autoRegisterCwd && !this.state.active) {
      this.state.items["default"] = { name: "default", path: opts.cwd };
      this.state.active = "default";
      await this.persist();
    }
  }

  add(name: string, path: string): void {
    if (this.state.items[name]) {
      throw new WorkspaceError(`workspace already exists: ${name}`);
    }
    this.state.items[name] = { name, path };
  }

  remove(name: string): void {
    if (!this.state.items[name]) {
      throw new WorkspaceError(`workspace not found: ${name}`);
    }
    if (this.state.active === name) {
      throw new WorkspaceError(`cannot remove active workspace: ${name}`);
    }
    delete this.state.items[name];
  }

  use(name: string): void {
    if (!this.state.items[name]) {
      throw new WorkspaceError(`workspace not found: ${name}`);
    }
    this.state.active = name;
  }

  getActive(): Workspace | undefined {
    return this.state.active ? this.state.items[this.state.active] : undefined;
  }

  get(name: string): Workspace | undefined {
    return this.state.items[name];
  }

  list(): Workspace[] {
    return Object.values(this.state.items);
  }

  async persist(): Promise<void> {
    await this.store.write(this.state);
  }
}
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/unit/workspaceRegistry.test.ts
```
预期：6 个测试全 pass。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(workspace): WorkspaceRegistry 多工作区切换 + 持久化"
```

---

## Task 7：SessionStore

**Files:**
- Create: `src/core/session/SessionStore.ts`
- Create: `tests/unit/sessionStore.test.ts`

- [ ] **Step 1：写失败测试**

`tests/unit/sessionStore.test.ts`：
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/core/session/SessionStore.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "ss-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("SessionStore", () => {
  it("初始时 get 返回 undefined", async () => {
    const ss = new SessionStore(join(dir, "sessions.json"));
    await ss.init();
    expect(ss.get("default")).toBeUndefined();
  });

  it("set + get", async () => {
    const ss = new SessionStore(join(dir, "sessions.json"));
    await ss.init();
    await ss.set("default", { agentId: "agent-x", model: "auto" });
    expect(ss.get("default")?.agentId).toBe("agent-x");
  });

  it("clear 删除条目", async () => {
    const ss = new SessionStore(join(dir, "sessions.json"));
    await ss.init();
    await ss.set("default", { agentId: "agent-x" });
    await ss.clear("default");
    expect(ss.get("default")).toBeUndefined();
  });

  it("持久化后能恢复", async () => {
    const p = join(dir, "sessions.json");
    const a = new SessionStore(p);
    await a.init();
    await a.set("default", { agentId: "agent-y", model: "composer-2",
      modelParams: [{ id: "thinking", value: "high" }] });

    const b = new SessionStore(p);
    await b.init();
    expect(b.get("default")).toEqual({
      agentId: "agent-y", model: "composer-2",
      modelParams: [{ id: "thinking", value: "high" }],
    });
  });
});
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/unit/sessionStore.test.ts
```

- [ ] **Step 3：实现**

`src/core/session/SessionStore.ts`：
```typescript
import { JsonStore } from "../persist/jsonStore.js";

export interface SessionEntry {
  agentId?: string;
  model?: string;
  modelParams?: Array<{ id: string; value: string }>;
}

interface SessionFile {
  workspaces: Record<string, SessionEntry>;
}

export class SessionStore {
  private readonly store: JsonStore<SessionFile>;
  private state: SessionFile = { workspaces: {} };

  constructor(filePath: string) {
    this.store = new JsonStore<SessionFile>(filePath, { workspaces: {} });
  }

  async init(): Promise<void> {
    this.state = await this.store.readOrInit();
  }

  get(workspaceId: string): SessionEntry | undefined {
    return this.state.workspaces[workspaceId];
  }

  async set(workspaceId: string, entry: SessionEntry): Promise<void> {
    this.state.workspaces[workspaceId] = entry;
    await this.store.write(this.state);
  }

  async clear(workspaceId: string): Promise<void> {
    delete this.state.workspaces[workspaceId];
    await this.store.write(this.state);
  }
}
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/unit/sessionStore.test.ts
```
预期：4 个测试全 pass。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(session): SessionStore 持久化 workspace→agentId"
```

---

## Task 8：IMessenger 接口 + StubMessenger

**Files:**
- Create: `src/core/messenger/types.ts`
- Create: `src/core/messenger/IMessenger.ts`
- Create: `tests/helpers/StubMessenger.ts`
- Create: `tests/unit/stubMessenger.test.ts`

- [ ] **Step 1：写失败测试**

`tests/unit/stubMessenger.test.ts`：
```typescript
import { describe, it, expect } from "vitest";
import { StubMessenger } from "../helpers/StubMessenger.js";

describe("StubMessenger", () => {
  it("sendText 累积调用，返回递增 messageId", async () => {
    const m = new StubMessenger();
    const a = await m.sendText("c1", "hi");
    const b = await m.sendText("c1", "ho");
    expect(a.messageId).toBe("m-1");
    expect(b.messageId).toBe("m-2");
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0]).toEqual({ kind: "sendText", chatId: "c1", text: "hi" });
  });

  it("editText 记录调用", async () => {
    const m = new StubMessenger();
    await m.editText("c1", "m-1", "edited");
    expect(m.calls[0]).toEqual({ kind: "editText", chatId: "c1", messageId: "m-1", text: "edited" });
  });

  it("emit text 触发监听器", async () => {
    const m = new StubMessenger();
    const got: string[] = [];
    m.on("text", (msg) => got.push(msg.text));
    m.emitText({ chatId: "c1", userId: "u1", text: "hello" });
    expect(got).toEqual(["hello"]);
  });
});
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/unit/stubMessenger.test.ts
```

- [ ] **Step 3：实现**

`src/core/messenger/types.ts`：
```typescript
export interface IncomingTextMessage {
  chatId: string;
  userId: number;
  username?: string;
  text: string;
}

export interface IncomingImageMessage {
  chatId: string;
  userId: number;
  username?: string;
  data: string;
  mimeType: string;
  caption?: string;
}

export interface SendOptions {
  parseMode?: "HTML" | "Markdown" | "plain";
  replyToMessageId?: string;
}

export interface MessageHandle {
  messageId: string;
}

export interface ImagePayload {
  data: Buffer;
  mimeType: string;
  filename?: string;
}

export interface FilePayload {
  data: Buffer;
  mimeType?: string;
  filename: string;
}
```

`src/core/messenger/IMessenger.ts`：
```typescript
import type {
  IncomingTextMessage,
  IncomingImageMessage,
  MessageHandle,
  SendOptions,
  ImagePayload,
  FilePayload,
} from "./types.js";

export interface IMessenger {
  start(): Promise<void>;
  stop(): Promise<void>;

  on(event: "text", h: (msg: IncomingTextMessage) => void): void;
  on(event: "image", h: (msg: IncomingImageMessage) => void): void;

  sendText(chatId: string, text: string, opts?: SendOptions): Promise<MessageHandle>;
  editText(chatId: string, messageId: string, text: string, opts?: SendOptions): Promise<void>;
  sendImage(chatId: string, image: ImagePayload, caption?: string): Promise<MessageHandle>;
  sendDocument(chatId: string, file: FilePayload, caption?: string): Promise<MessageHandle>;

  sendTyping(chatId: string): Promise<void>;
}
```

`tests/helpers/StubMessenger.ts`：
```typescript
import type {
  IMessenger,
} from "../../src/core/messenger/IMessenger.js";
import type {
  IncomingTextMessage, IncomingImageMessage,
  MessageHandle, ImagePayload, FilePayload, SendOptions,
} from "../../src/core/messenger/types.js";

type Call =
  | { kind: "sendText"; chatId: string; text: string; opts?: SendOptions }
  | { kind: "editText"; chatId: string; messageId: string; text: string; opts?: SendOptions }
  | { kind: "sendImage"; chatId: string; caption?: string; mimeType: string; size: number }
  | { kind: "sendDocument"; chatId: string; caption?: string; filename: string; size: number }
  | { kind: "sendTyping"; chatId: string };

export class StubMessenger implements IMessenger {
  public calls: Call[] = [];
  public textListeners: Array<(m: IncomingTextMessage) => void> = [];
  public imageListeners: Array<(m: IncomingImageMessage) => void> = [];

  private idCounter = 0;
  private nextId(): string { return `m-${++this.idCounter}`; }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  on(event: "text", h: (m: IncomingTextMessage) => void): void;
  on(event: "image", h: (m: IncomingImageMessage) => void): void;
  on(event: "text" | "image", h: (m: never) => void): void {
    if (event === "text") this.textListeners.push(h as (m: IncomingTextMessage) => void);
    else this.imageListeners.push(h as (m: IncomingImageMessage) => void);
  }

  emitText(m: IncomingTextMessage): void { for (const l of this.textListeners) l(m); }
  emitImage(m: IncomingImageMessage): void { for (const l of this.imageListeners) l(m); }

  async sendText(chatId: string, text: string, opts?: SendOptions): Promise<MessageHandle> {
    this.calls.push({ kind: "sendText", chatId, text, opts });
    return { messageId: this.nextId() };
  }
  async editText(chatId: string, messageId: string, text: string, opts?: SendOptions): Promise<void> {
    this.calls.push({ kind: "editText", chatId, messageId, text, opts });
  }
  async sendImage(chatId: string, image: ImagePayload, caption?: string): Promise<MessageHandle> {
    this.calls.push({ kind: "sendImage", chatId, caption, mimeType: image.mimeType, size: image.data.length });
    return { messageId: this.nextId() };
  }
  async sendDocument(chatId: string, file: FilePayload, caption?: string): Promise<MessageHandle> {
    this.calls.push({ kind: "sendDocument", chatId, caption, filename: file.filename, size: file.data.length });
    return { messageId: this.nextId() };
  }
  async sendTyping(chatId: string): Promise<void> {
    this.calls.push({ kind: "sendTyping", chatId });
  }
}
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/unit/stubMessenger.test.ts
```
预期：3 个测试全 pass。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(messenger): IMessenger 接口与 StubMessenger 测试桩"
```

---

## Task 9：markdown → HTML 渲染（Telegram HTML 模式）

**Files:**
- Create: `src/core/render/markdownToHtml.ts`
- Create: `tests/unit/markdownToHtml.test.ts`

- [ ] **Step 1：写失败测试**

`tests/unit/markdownToHtml.test.ts`：
```typescript
import { describe, it, expect } from "vitest";
import { markdownToHtml } from "../../src/core/render/markdownToHtml.js";

describe("markdownToHtml", () => {
  it("转义 < > &", () => {
    expect(markdownToHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("行内代码 → <code>", () => {
    expect(markdownToHtml("foo `bar` baz")).toBe("foo <code>bar</code> baz");
  });

  it("粗体 → <b>", () => {
    expect(markdownToHtml("a **bold** b")).toBe("a <b>bold</b> b");
  });

  it("斜体（_..._）→ <i>", () => {
    expect(markdownToHtml("a _it_ b")).toBe("a <i>it</i> b");
  });

  it("代码块 ``` ... ``` → <pre><code>", () => {
    const md = "before\n```\nlet a = 1;\n```\nafter";
    const html = markdownToHtml(md);
    expect(html).toContain("<pre><code>let a = 1;\n</code></pre>");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("代码块内的 < > & 必须转义", () => {
    const md = "```\n<x> & </x>\n```";
    expect(markdownToHtml(md)).toContain("<pre><code>&lt;x&gt; &amp; &lt;/x&gt;\n</code></pre>");
  });

  it("链接 [text](url) → <a>", () => {
    expect(markdownToHtml("[hi](https://example.com)")).toBe('<a href="https://example.com">hi</a>');
  });

  it("空字符串", () => {
    expect(markdownToHtml("")).toBe("");
  });
});
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/unit/markdownToHtml.test.ts
```

- [ ] **Step 3：实现**

`src/core/render/markdownToHtml.ts`：
```typescript
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 极简 markdown → Telegram HTML 渲染。
 *
 * 支持：
 * - 三反引号代码块（含可选语言标签，渲染时被忽略）
 * - 行内代码 `code`
 * - **粗体** _斜体_
 * - [text](url)
 *
 * 实现策略：先把代码块切走（避免内部被其它规则误伤），剩余部分做 HTML 转义和行内规则。
 */
export function markdownToHtml(input: string): string {
  if (!input) return "";

  const fenceRe = /```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```/g;
  const segments: Array<{ kind: "text" | "code"; value: string }> = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = fenceRe.exec(input)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ kind: "text", value: input.slice(lastIndex, m.index) });
    }
    segments.push({ kind: "code", value: m[1] ?? "" });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < input.length) {
    segments.push({ kind: "text", value: input.slice(lastIndex) });
  }

  return segments
    .map((s) => {
      if (s.kind === "code") {
        return `<pre><code>${escapeHtml(s.value)}\n</code></pre>`;
      }
      return renderInline(s.value);
    })
    .join("");
}

function renderInline(text: string): string {
  let out = escapeHtml(text);

  out = out.replace(/`([^`\n]+)`/g, (_, inner: string) => `<code>${inner}</code>`);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, inner: string) => `<b>${inner}</b>`);
  out = out.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, (_, pre: string, inner: string) =>
    `${pre}<i>${inner}</i>`,
  );
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );

  return out;
}
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/unit/markdownToHtml.test.ts
```
预期：8 个测试全 pass。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(render): markdownToHtml 极简渲染（代码块/行内/粗斜体/链接）"
```

---

## Task 10：toolSummary（工具调用 → 状态行短摘要）

**Files:**
- Create: `src/core/orchestrator/toolSummary.ts`
- Create: `tests/unit/toolSummary.test.ts`

- [ ] **Step 1：写失败测试**

`tests/unit/toolSummary.test.ts`：
```typescript
import { describe, it, expect } from "vitest";
import { summarizeTool } from "../../src/core/orchestrator/toolSummary.js";

describe("summarizeTool", () => {
  it("shell 取 command", () => {
    expect(summarizeTool("shell", { command: "pnpm test" })).toBe("shell: pnpm test");
  });

  it("read 取 path", () => {
    expect(summarizeTool("read", { path: "src/auth.ts" })).toBe("read: src/auth.ts");
  });

  it("read 取 relative_path 兜底", () => {
    expect(summarizeTool("read", { relative_path: "src/x.ts" })).toBe("read: src/x.ts");
  });

  it("grep 取 pattern", () => {
    expect(summarizeTool("grep", { pattern: "TODO" })).toBe("grep: TODO");
  });

  it("过长的命令被截断到 60 字符", () => {
    const long = "a".repeat(120);
    const out = summarizeTool("shell", { command: long });
    expect(out.length).toBeLessThanOrEqual("shell: ".length + 60 + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("未知工具 → 只返回 name", () => {
    expect(summarizeTool("nonsense", { whatever: 1 })).toBe("nonsense");
  });

  it("args 缺失 / null → 不抛异常", () => {
    expect(summarizeTool("shell", undefined)).toBe("shell: ");
    expect(summarizeTool("shell", null)).toBe("shell: ");
  });

  it("task 取 description", () => {
    expect(summarizeTool("task", { description: "review the patch" })).toBe("subagent: review the patch");
  });
});
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/unit/toolSummary.test.ts
```

- [ ] **Step 3：实现**

`src/core/orchestrator/toolSummary.ts`：
```typescript
const MAX_LEN = 60;

function trim(s: string): string {
  if (s.length <= MAX_LEN) return s;
  return s.slice(0, MAX_LEN) + "…";
}

function pickPath(a: Record<string, unknown> | undefined): string {
  return (
    (a?.path as string | undefined) ??
    (a?.relative_path as string | undefined) ??
    ""
  );
}

export function summarizeTool(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : undefined) as
    | Record<string, unknown>
    | undefined;

  switch (name) {
    case "shell":
      return `shell: ${trim((a?.command as string) ?? "")}`;
    case "read":
      return `read: ${pickPath(a)}`;
    case "write":
      return `write: ${pickPath(a)}`;
    case "edit":
      return `edit: ${pickPath(a)}`;
    case "grep":
      return `grep: ${trim((a?.pattern as string) ?? "")}`;
    case "glob":
      return `glob: ${trim((a?.pattern as string) ?? "")}`;
    case "ls":
      return `ls: ${(a?.path as string | undefined) ?? "."}`;
    case "task":
      return `subagent: ${trim((a?.description as string) ?? "")}`;
    default:
      return name;
  }
}
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/unit/toolSummary.test.ts
```
预期：8 个测试全 pass。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(orchestrator): summarizeTool 防御式工具摘要"
```

---

## Task 11：busyPolicy（忙状态判定）

**Files:**
- Create: `src/core/orchestrator/busyPolicy.ts`
- Create: `tests/unit/busyPolicy.test.ts`

- [ ] **Step 1：写失败测试**

`tests/unit/busyPolicy.test.ts`：
```typescript
import { describe, it, expect } from "vitest";
import { decideBusyAction, parseForcePrefix } from "../../src/core/orchestrator/busyPolicy.js";

describe("parseForcePrefix", () => {
  it("以 ! 开头 → force=true、剥掉前缀", () => {
    expect(parseForcePrefix("!fix this")).toEqual({ force: true, text: "fix this" });
  });
  it("普通文本 → force=false", () => {
    expect(parseForcePrefix("hello")).toEqual({ force: false, text: "hello" });
  });
  it("仅 ! 也接受", () => {
    expect(parseForcePrefix("!")).toEqual({ force: true, text: "" });
  });
});

describe("decideBusyAction", () => {
  it("无活跃 run → run", () => {
    expect(decideBusyAction({ activeRunStatus: undefined, force: false })).toBe("run");
  });
  it("有活跃 run + 非 force → reject", () => {
    expect(decideBusyAction({ activeRunStatus: "running", force: false })).toBe("reject");
  });
  it("有活跃 run + force → force-replace", () => {
    expect(decideBusyAction({ activeRunStatus: "running", force: true })).toBe("force-replace");
  });
  it("活跃 run 已结束 → run", () => {
    expect(decideBusyAction({ activeRunStatus: "finished", force: false })).toBe("run");
  });
});
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/unit/busyPolicy.test.ts
```

- [ ] **Step 3：实现**

`src/core/orchestrator/busyPolicy.ts`：
```typescript
export type BusyAction = "run" | "reject" | "force-replace";
export type RunStatus = "running" | "finished" | "error" | "cancelled";

export function parseForcePrefix(text: string): { force: boolean; text: string } {
  if (text.startsWith("!")) {
    return { force: true, text: text.slice(1) };
  }
  return { force: false, text };
}

export function decideBusyAction(input: {
  activeRunStatus: RunStatus | undefined;
  force: boolean;
}): BusyAction {
  if (!input.activeRunStatus || input.activeRunStatus !== "running") return "run";
  return input.force ? "force-replace" : "reject";
}
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/unit/busyPolicy.test.ts
```
预期：6 个测试全 pass。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(orchestrator): parseForcePrefix + decideBusyAction"
```

---

## Task 12：StreamRenderer（节流编辑 + 长消息切分）

**Files:**
- Create: `src/core/orchestrator/streamRenderer.ts`
- Create: `tests/unit/streamRenderer.test.ts`

`StreamRenderer` 负责把流式 token 累积写到主消息（节流），并在超长时切分。它**不知道** SDKMessage 的存在——只知道 `pushText / setStatus / finalize`。AgentOrchestrator 负责把 SDKMessage 翻译成这些调用。

- [ ] **Step 1：写失败测试**

`tests/unit/streamRenderer.test.ts`：
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StubMessenger } from "../helpers/StubMessenger.js";
import { StreamRenderer } from "../../src/core/orchestrator/streamRenderer.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("StreamRenderer", () => {
  it("第一次 pushText 立即 sendText", async () => {
    const m = new StubMessenger();
    const r = new StreamRenderer(m, "c1", { throttleMs: 100, maxLen: 1000 });
    await r.start("⏳ thinking...");
    await r.pushText("hello");
    expect(m.calls.find((c) => c.kind === "sendText")).toBeTruthy();
  });

  it("节流：连续 pushText 在窗口内只 edit 一次", async () => {
    const m = new StubMessenger();
    const r = new StreamRenderer(m, "c1", { throttleMs: 100, maxLen: 1000 });
    await r.start("⏳");
    await r.pushText("a");
    await r.pushText("b");
    await r.pushText("c");
    await vi.advanceTimersByTimeAsync(150);
    const edits = m.calls.filter((c) => c.kind === "editText");
    expect(edits.length).toBe(1);
  });

  it("setStatus 仅渲染状态行 + 已有正文", async () => {
    const m = new StubMessenger();
    const r = new StreamRenderer(m, "c1", { throttleMs: 50, maxLen: 1000 });
    await r.start("⏳");
    await r.pushText("body");
    r.setStatus("🔧 shell: pnpm test");
    await vi.advanceTimersByTimeAsync(100);
    const lastEdit = [...m.calls].reverse().find((c) => c.kind === "editText");
    expect(lastEdit && lastEdit.kind === "editText" ? lastEdit.text : "").toContain("🔧 shell: pnpm test");
    expect(lastEdit && lastEdit.kind === "editText" ? lastEdit.text : "").toContain("body");
  });

  it("finalize 清掉状态行，只留正文", async () => {
    const m = new StubMessenger();
    const r = new StreamRenderer(m, "c1", { throttleMs: 50, maxLen: 1000 });
    await r.start("⏳");
    r.setStatus("🤔 thinking...");
    await r.pushText("done.");
    await r.finalize();
    const lastEdit = [...m.calls].reverse().find((c) => c.kind === "editText");
    expect(lastEdit && lastEdit.kind === "editText" ? lastEdit.text : "").toBe("done.");
  });

  it("超过 maxLen → 切分新消息，新 push 走新消息", async () => {
    const m = new StubMessenger();
    const r = new StreamRenderer(m, "c1", { throttleMs: 50, maxLen: 20 });
    await r.start("⏳");
    await r.pushText("a".repeat(15));
    await r.pushText("b".repeat(20));
    await vi.advanceTimersByTimeAsync(100);
    const sends = m.calls.filter((c) => c.kind === "sendText");
    expect(sends.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/unit/streamRenderer.test.ts
```

- [ ] **Step 3：实现**

`src/core/orchestrator/streamRenderer.ts`：
```typescript
import type { IMessenger } from "../messenger/IMessenger.js";

export interface StreamRendererOptions {
  throttleMs: number;
  maxLen: number;
}

/**
 * 在一条主消息上滚动渲染 assistant text + 状态行。
 * 超过 maxLen 自动开新消息。
 *
 * 渲染格式：
 *   [状态行（可选）]
 *
 *   <textBuffer>
 */
export class StreamRenderer {
  private currentMsgId?: string;
  private status: string = "";
  private textBuffer: string = "";
  private flushTimer?: NodeJS.Timeout;
  private dirty = false;
  private finalized = false;

  constructor(
    private readonly messenger: IMessenger,
    private readonly chatId: string,
    private readonly opts: StreamRendererOptions,
  ) {}

  async start(initialPlaceholder: string): Promise<void> {
    this.status = initialPlaceholder;
    const handle = await this.messenger.sendText(this.chatId, this.compose());
    this.currentMsgId = handle.messageId;
  }

  setStatus(line: string): void {
    this.status = line;
    this.dirty = true;
    this.scheduleFlush();
  }

  async pushText(chunk: string): Promise<void> {
    if (this.textBuffer.length + chunk.length > this.opts.maxLen) {
      const remaining = Math.max(0, this.opts.maxLen - this.textBuffer.length);
      const head = chunk.slice(0, remaining);
      const rest = chunk.slice(remaining);
      this.textBuffer += head;
      this.dirty = true;
      await this.flushNow();
      await this.rotate();
      if (rest.length > 0) {
        await this.pushText(rest);
      }
      return;
    }
    this.textBuffer += chunk;
    this.dirty = true;
    this.scheduleFlush();
  }

  async finalize(extra?: string): Promise<void> {
    this.finalized = true;
    this.status = "";
    if (extra) this.textBuffer += extra;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.flushNow();
  }

  private compose(): string {
    const lines: string[] = [];
    if (this.status) {
      lines.push(this.status, "");
    }
    if (this.textBuffer) lines.push(this.textBuffer);
    if (lines.length === 0) lines.push("⏳");
    return lines.join("\n");
  }

  private scheduleFlush(): void {
    if (this.finalized) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushNow();
    }, this.opts.throttleMs);
  }

  private async flushNow(): Promise<void> {
    if (!this.dirty || !this.currentMsgId) return;
    this.dirty = false;
    await this.messenger.editText(this.chatId, this.currentMsgId, this.compose());
  }

  private async rotate(): Promise<void> {
    this.textBuffer = "";
    this.dirty = false;
    const handle = await this.messenger.sendText(this.chatId, "⏳ continuing...");
    this.currentMsgId = handle.messageId;
    this.dirty = true;
  }
}
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/unit/streamRenderer.test.ts
```
预期：5 个测试全 pass。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(orchestrator): StreamRenderer 节流编辑 + 状态行 + 长消息切分"
```

---

## Task 13：AgentOrchestrator MVP（用桩 SDK 接通端到端）

`@cursor/sdk` 在测试中不便真调，所以引入 `IAgentRuntime` 接口让 orchestrator 与具体 SDK 解耦；测试用 `StubAgentRuntime`，生产用 `CursorSdkRuntime`（直接转发到 `@cursor/sdk`）。

**Files:**
- Create: `src/core/orchestrator/runtime.ts`
- Create: `src/core/orchestrator/AgentOrchestrator.ts`
- Create: `tests/helpers/StubAgent.ts`
- Create: `tests/integration/orchestrator.test.ts`

- [ ] **Step 1：写失败测试**

`tests/helpers/StubAgent.ts`：
```typescript
import type { IAgentRuntime, RuntimeAgent, RuntimeRun, RuntimeStreamEvent }
  from "../../src/core/orchestrator/runtime.js";

export class StubAgentRuntime implements IAgentRuntime {
  public agents: StubAgent[] = [];
  public created: { agentId?: string; cwd: string }[] = [];

  async create(opts: { agentId?: string; cwd: string }): Promise<RuntimeAgent> {
    const a = new StubAgent(opts.agentId ?? `agent-stub-${this.agents.length + 1}`);
    this.agents.push(a);
    this.created.push(opts);
    return a;
  }

  async resume(agentId: string, opts: { cwd: string }): Promise<RuntimeAgent> {
    return this.create({ agentId, cwd: opts.cwd });
  }
}

export class StubAgent implements RuntimeAgent {
  public sentTexts: string[] = [];
  public currentRun?: StubRun;
  constructor(public agentId: string) {}

  async send(text: string, opts?: { force?: boolean }): Promise<RuntimeRun> {
    this.sentTexts.push(text);
    const run = new StubRun(text, opts?.force ?? false);
    this.currentRun = run;
    return run;
  }
  async dispose(): Promise<void> {}
}

export class StubRun implements RuntimeRun {
  status: "running" | "finished" | "error" | "cancelled" = "running";
  public scripted: RuntimeStreamEvent[] = [];
  constructor(public text: string, public force: boolean) {}

  setScript(events: RuntimeStreamEvent[]): void { this.scripted = events; }

  async *stream(): AsyncGenerator<RuntimeStreamEvent, void> {
    for (const e of this.scripted) {
      if (this.status === "cancelled") break;
      yield e;
    }
    this.status = this.status === "cancelled" ? "cancelled" : "finished";
  }
  async wait(): Promise<{ status: "finished" | "error" | "cancelled"; result?: string }> {
    return { status: this.status === "running" ? "finished" : this.status };
  }
  async cancel(): Promise<void> { this.status = "cancelled"; }
}
```

`tests/integration/orchestrator.test.ts`：
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubMessenger } from "../helpers/StubMessenger.js";
import { StubAgentRuntime } from "../helpers/StubAgent.js";
import { AgentOrchestrator } from "../../src/core/orchestrator/AgentOrchestrator.js";
import { WorkspaceRegistry } from "../../src/core/workspace/WorkspaceRegistry.js";
import { SessionStore } from "../../src/core/session/SessionStore.js";

let dir: string;
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function makeOrchestrator() {
  dir = await mkdtemp(join(tmpdir(), "orch-"));
  const registry = new WorkspaceRegistry(join(dir, "workspaces.json"));
  await registry.init({ autoRegisterCwd: true, cwd: dir });
  const session = new SessionStore(join(dir, "sessions.json"));
  await session.init();
  const messenger = new StubMessenger();
  const runtime = new StubAgentRuntime();
  const orch = new AgentOrchestrator({
    messenger, runtime, registry, session,
    streamOptions: { throttleMs: 10, maxLen: 1000 },
    defaultModel: { id: "auto", params: [] },
  });
  return { orch, messenger, runtime, registry, session };
}

describe("AgentOrchestrator", () => {
  it("text → 创建 agent → 流式渲染 assistant 文本到 messenger", async () => {
    const { orch, messenger, runtime } = await makeOrchestrator();
    const run = orch.runPrompt({ chatId: "c1", text: "hello", force: false });
    expect(runtime.created.length).toBe(1);
    const agent = runtime.agents[0]!;
    const stub = agent.currentRun!;
    stub.setScript([
      { type: "assistant", text: "Hi! " },
      { type: "assistant", text: "There." },
    ]);
    await run;
    const finalEdit = [...messenger.calls].reverse()
      .find((c) => c.kind === "editText");
    expect(finalEdit && finalEdit.kind === "editText" ? finalEdit.text : "")
      .toContain("Hi! There.");
  });

  it("第二次 send 复用同一个 agentId", async () => {
    const { orch, runtime, session } = await makeOrchestrator();
    await orch.runPrompt({ chatId: "c1", text: "one", force: false });
    await orch.runPrompt({ chatId: "c1", text: "two", force: false });
    expect(runtime.created.length).toBe(1);
    expect(session.get("default")?.agentId).toBe(runtime.agents[0]!.agentId);
  });

  it("活跃 run 时再发文本（非 force）→ 拒绝并提示", async () => {
    const { orch, messenger, runtime } = await makeOrchestrator();
    const p1 = orch.runPrompt({ chatId: "c1", text: "long task", force: false });
    const agent0 = await waitFor(() => runtime.agents[0]);
    const stub = agent0.currentRun!;
    stub.setScript([{ type: "assistant", text: "..." }]);
    const p2 = orch.runPrompt({ chatId: "c1", text: "second", force: false });
    await Promise.all([p1, p2]);
    const sends = messenger.calls.filter((c) => c.kind === "sendText");
    expect(sends.some((c) => c.kind === "sendText" && c.text.includes("正在工作")))
      .toBe(true);
  });

  it("cancel 把 status 置 cancelled 并在主消息追加 (已取消)", async () => {
    const { orch, messenger, runtime } = await makeOrchestrator();
    const p = orch.runPrompt({ chatId: "c1", text: "long", force: false });
    const agent0 = await waitFor(() => runtime.agents[0]);
    const stub = agent0.currentRun!;
    stub.setScript([{ type: "assistant", text: "before" }]);
    await orch.cancel("default");
    await p;
    const lastEdit = [...messenger.calls].reverse().find((c) => c.kind === "editText");
    expect(lastEdit && lastEdit.kind === "editText" ? lastEdit.text : "")
      .toMatch(/已取消/);
  });

  it("tool_call 在状态行可视化", async () => {
    const { orch, messenger, runtime } = await makeOrchestrator();
    const p = orch.runPrompt({ chatId: "c1", text: "task", force: false });
    const agent0 = await waitFor(() => runtime.agents[0]);
    const stub = agent0.currentRun!;
    stub.setScript([
      { type: "tool_call", status: "running", name: "shell", args: { command: "ls" } },
      { type: "assistant", text: "ok" },
      { type: "tool_call", status: "completed", name: "shell" },
    ]);
    await p;
    const allTexts = messenger.calls
      .filter((c) => c.kind === "editText")
      .map((c) => c.kind === "editText" ? c.text : "")
      .join("\n");
    expect(allTexts).toContain("shell: ls");
  });
});

async function waitFor<T>(fn: () => T | undefined, retries = 50): Promise<T> {
  for (let i = 0; i < retries; i++) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timeout");
}
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/integration/orchestrator.test.ts
```
预期：失败（`AgentOrchestrator` 不存在）。

- [ ] **Step 3：实现**

`src/core/orchestrator/runtime.ts`：
```typescript
export interface IAgentRuntime {
  create(opts: CreateAgentOptions): Promise<RuntimeAgent>;
  resume(agentId: string, opts: ResumeAgentOptions): Promise<RuntimeAgent>;
}

export interface CreateAgentOptions {
  agentId?: string;
  cwd: string;
  model?: { id: string; params?: Array<{ id: string; value: string }> };
  settingSources?: ("project" | "user" | "team" | "mdm" | "plugins" | "all")[];
  mcpServers?: Record<string, unknown>;
}

export interface ResumeAgentOptions {
  cwd: string;
  model?: { id: string; params?: Array<{ id: string; value: string }> };
  settingSources?: ("project" | "user" | "team" | "mdm" | "plugins" | "all")[];
}

export interface RuntimeAgent {
  agentId: string;
  send(text: string, opts?: { force?: boolean }): Promise<RuntimeRun>;
  dispose(): Promise<void>;
}

export interface RuntimeRun {
  status: "running" | "finished" | "error" | "cancelled";
  stream(): AsyncGenerator<RuntimeStreamEvent, void>;
  wait(): Promise<{ status: "finished" | "error" | "cancelled"; result?: string; durationMs?: number }>;
  cancel(): Promise<void>;
}

export type RuntimeStreamEvent =
  | { type: "assistant"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; status: "running" | "completed" | "error"; name: string; args?: unknown };
```

`src/core/orchestrator/AgentOrchestrator.ts`：
```typescript
import { logger } from "../../logger.js";
import type { IMessenger } from "../messenger/IMessenger.js";
import type { WorkspaceRegistry } from "../workspace/WorkspaceRegistry.js";
import type { SessionStore } from "../session/SessionStore.js";
import { StreamRenderer, type StreamRendererOptions } from "./streamRenderer.js";
import { summarizeTool } from "./toolSummary.js";
import { decideBusyAction, parseForcePrefix, type RunStatus } from "./busyPolicy.js";
import { markdownToHtml } from "../render/markdownToHtml.js";
import type { IAgentRuntime, RuntimeAgent, RuntimeRun } from "./runtime.js";

export interface OrchestratorDeps {
  messenger: IMessenger;
  runtime: IAgentRuntime;
  registry: WorkspaceRegistry;
  session: SessionStore;
  streamOptions: StreamRendererOptions;
  defaultModel: { id: string; params: Array<{ id: string; value: string }> };
}

interface PoolEntry {
  agent: RuntimeAgent;
  activeRun?: RuntimeRun;
}

export class AgentOrchestrator {
  private readonly pool = new Map<string, PoolEntry>();

  constructor(private readonly deps: OrchestratorDeps) {}

  async runPrompt(input: { chatId: string; text: string; force: boolean }): Promise<void> {
    const ws = this.deps.registry.getActive();
    if (!ws) {
      await this.deps.messenger.sendText(input.chatId, "没有活跃的工作区，请先 /ws add 一个。");
      return;
    }
    const wsId = ws.name;

    const entry = await this.ensureAgent(wsId, ws.path);
    const action = decideBusyAction({
      activeRunStatus: entry.activeRun?.status as RunStatus | undefined,
      force: input.force,
    });

    if (action === "reject") {
      await this.deps.messenger.sendText(
        input.chatId,
        `Agent 正在工作区 <b>${ws.name}</b> 上工作中；请 /cancel 后重试，或在消息前加 ! 强制打断。`,
        { parseMode: "HTML" },
      );
      return;
    }

    const renderer = new StreamRenderer(this.deps.messenger, input.chatId, this.deps.streamOptions);
    await renderer.start("⏳ thinking...");

    let run: RuntimeRun;
    try {
      run = await entry.agent.send(input.text, { force: action === "force-replace" });
    } catch (e) {
      logger.error({ err: (e as Error).message }, "agent.send failed");
      await renderer.finalize(`\n⚠️ Error: ${(e as Error).message}`);
      return;
    }
    entry.activeRun = run;

    try {
      for await (const event of run.stream()) {
        switch (event.type) {
          case "assistant":
            await renderer.pushText(markdownToHtml(event.text));
            break;
          case "thinking":
            renderer.setStatus("🤔 thinking...");
            break;
          case "tool_call":
            if (event.status === "running") {
              renderer.setStatus(`🔧 ${summarizeTool(event.name, event.args)}`);
            } else if (event.status === "completed") {
              renderer.setStatus("🤔 thinking...");
            } else {
              renderer.setStatus(`⚠️ ${event.name} failed`);
            }
            break;
        }
      }
      const r = await run.wait();
      if (r.status === "cancelled") {
        await renderer.finalize("\n<i>(已取消)</i>");
      } else if (r.status === "error") {
        await renderer.finalize(`\n⚠️ Error`);
      } else {
        await renderer.finalize();
      }
    } finally {
      if (entry.activeRun === run) entry.activeRun = undefined;
    }
  }

  async cancel(workspaceId: string): Promise<void> {
    const entry = this.pool.get(workspaceId);
    if (entry?.activeRun) await entry.activeRun.cancel();
  }

  async resetWorkspace(workspaceId: string): Promise<void> {
    const entry = this.pool.get(workspaceId);
    if (entry) {
      await entry.agent.dispose();
      this.pool.delete(workspaceId);
    }
    await this.deps.session.clear(workspaceId);
  }

  async dispose(): Promise<void> {
    for (const e of this.pool.values()) {
      try { await e.activeRun?.cancel(); } catch { /* ignore */ }
      try { await e.agent.dispose(); } catch { /* ignore */ }
    }
    this.pool.clear();
  }

  private async ensureAgent(workspaceId: string, cwd: string): Promise<PoolEntry> {
    const cached = this.pool.get(workspaceId);
    if (cached) return cached;

    const sess = this.deps.session.get(workspaceId);
    let agent: RuntimeAgent;
    if (sess?.agentId) {
      agent = await this.deps.runtime.resume(sess.agentId, { cwd });
    } else {
      agent = await this.deps.runtime.create({
        cwd,
        model: this.deps.defaultModel,
      });
      await this.deps.session.set(workspaceId, {
        agentId: agent.agentId,
        model: this.deps.defaultModel.id,
        modelParams: this.deps.defaultModel.params,
      });
    }
    const entry: PoolEntry = { agent };
    this.pool.set(workspaceId, entry);
    return entry;
  }
}
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/integration/orchestrator.test.ts
```
预期：5 个集成测试全 pass。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(orchestrator): AgentOrchestrator 端到端流式编排（运行时抽象 + 桩接通）"
```

---

## Task 14：CommandParser

**Files:**
- Create: `src/commands/parser.ts`
- Create: `tests/unit/commandParser.test.ts`

- [ ] **Step 1：写失败测试**

`tests/unit/commandParser.test.ts`：
```typescript
import { describe, it, expect } from "vitest";
import { parseCommand } from "../../src/commands/parser.js";

describe("parseCommand", () => {
  it("普通文本 → null", () => {
    expect(parseCommand("hello world")).toBeNull();
  });

  it("/start", () => {
    expect(parseCommand("/start")).toEqual({ name: "start", args: [] });
  });

  it("/ws use alpha", () => {
    expect(parseCommand("/ws use alpha")).toEqual({ name: "ws", args: ["use", "alpha"] });
  });

  it("/ws add name /abs/path", () => {
    expect(parseCommand("/ws add name /a/b/c")).toEqual({ name: "ws", args: ["add", "name", "/a/b/c"] });
  });

  it("路径含空格 → 第三段为剩余整段", () => {
    expect(parseCommand('/ws add name "/a b/c"'))
      .toEqual({ name: "ws", args: ["add", "name", "/a b/c"] });
  });

  it("/model composer-2", () => {
    expect(parseCommand("/model composer-2")).toEqual({ name: "model", args: ["composer-2"] });
  });

  it("不区分前后空白", () => {
    expect(parseCommand("   /help  ")).toEqual({ name: "help", args: [] });
  });

  it("/remind add YYYY-MM-DD HH:MM 多词 prompt", () => {
    expect(parseCommand("/remind add 2026-05-06 08:00 wake me up")).toEqual({
      name: "remind",
      args: ["add", "2026-05-06", "08:00", "wake", "me", "up"],
    });
  });
});
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/unit/commandParser.test.ts
```

- [ ] **Step 3：实现**

`src/commands/parser.ts`：
```typescript
export interface ParsedCommand {
  name: string;
  args: string[];
}

export function parseCommand(raw: string): ParsedCommand | null {
  const text = raw.trim();
  if (!text.startsWith("/")) return null;
  const tokens = tokenize(text.slice(1));
  if (tokens.length === 0) return null;
  return { name: tokens[0]!, args: tokens.slice(1) };
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    if (s[i] === '"') {
      i++;
      let buf = "";
      while (i < s.length && s[i] !== '"') {
        buf += s[i++];
      }
      if (s[i] === '"') i++;
      out.push(buf);
    } else {
      let buf = "";
      while (i < s.length && !/\s/.test(s[i]!)) {
        buf += s[i++];
      }
      out.push(buf);
    }
  }
  return out;
}
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/unit/commandParser.test.ts
```
预期：8 个测试全 pass。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(commands): parseCommand 支持引号包裹路径"
```

---

## Task 15：Command Handlers（help / ws / reset / cancel / status / model）

**Files:**
- Create: `src/commands/handlers/help.ts`
- Create: `src/commands/handlers/ws.ts`
- Create: `src/commands/handlers/reset.ts`
- Create: `src/commands/handlers/cancel.ts`
- Create: `src/commands/handlers/status.ts`
- Create: `src/commands/handlers/model.ts`
- Create: `src/commands/dispatch.ts`
- Create: `tests/unit/commandHandlers.test.ts`

由于 7 个文件 + 1 测试比较多，下面按"先写测试 → 一次性实现 → 看绿 → commit"的更紧凑节奏走。

- [ ] **Step 1：写失败测试**

`tests/unit/commandHandlers.test.ts`：
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubMessenger } from "../helpers/StubMessenger.js";
import { StubAgentRuntime } from "../helpers/StubAgent.js";
import { WorkspaceRegistry } from "../../src/core/workspace/WorkspaceRegistry.js";
import { SessionStore } from "../../src/core/session/SessionStore.js";
import { AgentOrchestrator } from "../../src/core/orchestrator/AgentOrchestrator.js";
import { dispatchCommand } from "../../src/commands/dispatch.js";

let dir: string;
async function setup() {
  dir = await mkdtemp(join(tmpdir(), "cmd-"));
  const registry = new WorkspaceRegistry(join(dir, "workspaces.json"));
  await registry.init({ autoRegisterCwd: true, cwd: dir });
  const session = new SessionStore(join(dir, "sessions.json"));
  await session.init();
  const messenger = new StubMessenger();
  const runtime = new StubAgentRuntime();
  const orch = new AgentOrchestrator({
    messenger, runtime, registry, session,
    streamOptions: { throttleMs: 5, maxLen: 1000 },
    defaultModel: { id: "auto", params: [] },
  });
  return { messenger, registry, session, orch, runtime };
}

describe("dispatchCommand", () => {
  it("/help → 发送帮助信息", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand({ name: "help", args: [] }, {
      chatId: "c1", messenger, registry, session, orchestrator: orch,
    });
    const sent = messenger.calls.find((c) => c.kind === "sendText");
    expect(sent && sent.kind === "sendText" ? sent.text : "").toContain("/start");
  });

  it("/ws list 显示当前为 default", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand({ name: "ws", args: ["list"] }, {
      chatId: "c1", messenger, registry, session, orchestrator: orch,
    });
    const sent = messenger.calls.find((c) => c.kind === "sendText");
    expect(sent && sent.kind === "sendText" ? sent.text : "").toContain("default");
  });

  it("/ws add name path → 注册成功", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand({ name: "ws", args: ["add", "alpha", dir] }, {
      chatId: "c1", messenger, registry, session, orchestrator: orch,
    });
    expect(registry.get("alpha")?.path).toBe(dir);
  });

  it("/ws use ghost → 报错", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand({ name: "ws", args: ["use", "ghost"] }, {
      chatId: "c1", messenger, registry, session, orchestrator: orch,
    });
    const sent = messenger.calls.find((c) => c.kind === "sendText");
    expect(sent && sent.kind === "sendText" ? sent.text : "").toMatch(/not found/i);
  });

  it("/reset 清空 session 中 default 的 agentId", async () => {
    const { messenger, registry, session, orch } = await setup();
    await session.set("default", { agentId: "agent-x" });
    await dispatchCommand({ name: "reset", args: [] }, {
      chatId: "c1", messenger, registry, session, orchestrator: orch,
    });
    expect(session.get("default")?.agentId).toBeUndefined();
  });

  it("/status 显示当前工作区与模型", async () => {
    const { messenger, registry, session, orch } = await setup();
    await session.set("default", { agentId: "agent-y", model: "auto" });
    await dispatchCommand({ name: "status", args: [] }, {
      chatId: "c1", messenger, registry, session, orchestrator: orch,
    });
    const sent = messenger.calls.find((c) => c.kind === "sendText");
    expect(sent && sent.kind === "sendText" ? sent.text : "").toContain("default");
  });

  it("/model composer-2 写回 session", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand({ name: "model", args: ["composer-2"] }, {
      chatId: "c1", messenger, registry, session, orchestrator: orch,
    });
    expect(session.get("default")?.model).toBe("composer-2");
  });

  it("未知命令 → 回提示", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand({ name: "nonexistent", args: [] }, {
      chatId: "c1", messenger, registry, session, orchestrator: orch,
    });
    const sent = messenger.calls.find((c) => c.kind === "sendText");
    expect(sent && sent.kind === "sendText" ? sent.text : "").toMatch(/未知命令|Unknown/);
  });
});
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/unit/commandHandlers.test.ts
```

- [ ] **Step 3：实现 7 个文件**

`src/commands/dispatch.ts`：
```typescript
import type { IMessenger } from "../core/messenger/IMessenger.js";
import type { WorkspaceRegistry } from "../core/workspace/WorkspaceRegistry.js";
import type { SessionStore } from "../core/session/SessionStore.js";
import type { AgentOrchestrator } from "../core/orchestrator/AgentOrchestrator.js";
import type { ParsedCommand } from "./parser.js";
import { handleHelp } from "./handlers/help.js";
import { handleWs } from "./handlers/ws.js";
import { handleReset } from "./handlers/reset.js";
import { handleCancel } from "./handlers/cancel.js";
import { handleStatus } from "./handlers/status.js";
import { handleModel } from "./handlers/model.js";

export interface CommandContext {
  chatId: string;
  messenger: IMessenger;
  registry: WorkspaceRegistry;
  session: SessionStore;
  orchestrator: AgentOrchestrator;
}

export async function dispatchCommand(cmd: ParsedCommand, ctx: CommandContext): Promise<void> {
  switch (cmd.name) {
    case "start":
    case "help":
      return handleHelp(ctx);
    case "ws":
      return handleWs(cmd.args, ctx);
    case "reset":
      return handleReset(ctx);
    case "cancel":
      return handleCancel(ctx);
    case "status":
      return handleStatus(ctx);
    case "model":
      return handleModel(cmd.args, ctx);
    default:
      await ctx.messenger.sendText(ctx.chatId, `未知命令：/${cmd.name}。/help 查看可用命令。`);
  }
}
```

`src/commands/handlers/help.ts`：
```typescript
import type { CommandContext } from "../dispatch.js";

const HELP_TEXT = `<b>cursor-claw</b>
<code>/start</code> 或 <code>/help</code>  本帮助
<code>/ws list</code>  列出工作区
<code>/ws use &lt;name&gt;</code>  切换工作区
<code>/ws add &lt;name&gt; &lt;abs-path&gt;</code>  注册工作区
<code>/ws remove &lt;name&gt;</code>  注销工作区
<code>/ws path</code>  当前路径
<code>/reset</code>  重置当前工作区会话
<code>/cancel</code>  取消当前 run
<code>/status</code>  当前 agent / 工作区 / 模型
<code>/model &lt;id&gt;</code>  切换默认模型
普通文本 → 作为 prompt
以 <code>!</code> 开头的文本 → 强制打断当前 run`;

export async function handleHelp(ctx: CommandContext): Promise<void> {
  await ctx.messenger.sendText(ctx.chatId, HELP_TEXT, { parseMode: "HTML" });
}
```

`src/commands/handlers/ws.ts`：
```typescript
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { CommandContext } from "../dispatch.js";
import { WorkspaceError } from "../../core/workspace/WorkspaceRegistry.js";

export async function handleWs(args: string[], ctx: CommandContext): Promise<void> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list": {
      const items = ctx.registry.list();
      const active = ctx.registry.getActive()?.name;
      if (items.length === 0) {
        await ctx.messenger.sendText(ctx.chatId, "（没有工作区）");
        return;
      }
      const body = items.map((w) => `${w.name === active ? "▶ " : "  "}${w.name} → ${w.path}`).join("\n");
      await ctx.messenger.sendText(ctx.chatId, body);
      return;
    }
    case "use": {
      const name = args[1];
      if (!name) { await ctx.messenger.sendText(ctx.chatId, "用法：/ws use <name>"); return; }
      try { ctx.registry.use(name); await ctx.registry.persist(); }
      catch (e) {
        if (e instanceof WorkspaceError) { await ctx.messenger.sendText(ctx.chatId, e.message); return; }
        throw e;
      }
      await ctx.messenger.sendText(ctx.chatId, `当前工作区：${name}`);
      return;
    }
    case "add": {
      const name = args[1];
      const path = args[2];
      if (!name || !path) { await ctx.messenger.sendText(ctx.chatId, "用法：/ws add <name> <abs-path>"); return; }
      if (!isAbsolute(path)) { await ctx.messenger.sendText(ctx.chatId, "路径必须是绝对路径"); return; }
      try {
        const s = await stat(path);
        if (!s.isDirectory()) { await ctx.messenger.sendText(ctx.chatId, "路径不是目录"); return; }
      } catch { await ctx.messenger.sendText(ctx.chatId, "路径不存在"); return; }
      try { ctx.registry.add(name, path); await ctx.registry.persist(); }
      catch (e) {
        if (e instanceof WorkspaceError) { await ctx.messenger.sendText(ctx.chatId, e.message); return; }
        throw e;
      }
      await ctx.messenger.sendText(ctx.chatId, `已添加工作区：${name}`);
      return;
    }
    case "remove": {
      const name = args[1];
      if (!name) { await ctx.messenger.sendText(ctx.chatId, "用法：/ws remove <name>"); return; }
      try { ctx.registry.remove(name); await ctx.registry.persist(); }
      catch (e) {
        if (e instanceof WorkspaceError) { await ctx.messenger.sendText(ctx.chatId, e.message); return; }
        throw e;
      }
      await ctx.messenger.sendText(ctx.chatId, `已注销工作区：${name}`);
      return;
    }
    case "path": {
      const w = ctx.registry.getActive();
      await ctx.messenger.sendText(ctx.chatId, w ? w.path : "（没有活跃工作区）");
      return;
    }
    default:
      await ctx.messenger.sendText(ctx.chatId, "用法：/ws list|use|add|remove|path");
  }
}
```

`src/commands/handlers/reset.ts`：
```typescript
import type { CommandContext } from "../dispatch.js";

export async function handleReset(ctx: CommandContext): Promise<void> {
  const w = ctx.registry.getActive();
  if (!w) { await ctx.messenger.sendText(ctx.chatId, "（没有活跃工作区）"); return; }
  await ctx.orchestrator.resetWorkspace(w.name);
  await ctx.messenger.sendText(ctx.chatId, `已重置工作区会话：${w.name}`);
}
```

`src/commands/handlers/cancel.ts`：
```typescript
import type { CommandContext } from "../dispatch.js";

export async function handleCancel(ctx: CommandContext): Promise<void> {
  const w = ctx.registry.getActive();
  if (!w) { await ctx.messenger.sendText(ctx.chatId, "（没有活跃工作区）"); return; }
  await ctx.orchestrator.cancel(w.name);
  await ctx.messenger.sendText(ctx.chatId, "已请求取消当前 run。");
}
```

`src/commands/handlers/status.ts`：
```typescript
import type { CommandContext } from "../dispatch.js";

export async function handleStatus(ctx: CommandContext): Promise<void> {
  const w = ctx.registry.getActive();
  if (!w) { await ctx.messenger.sendText(ctx.chatId, "（没有活跃工作区）"); return; }
  const s = ctx.session.get(w.name);
  const lines = [
    `<b>工作区</b>: ${w.name}`,
    `<b>路径</b>: <code>${escapeHtml(w.path)}</code>`,
    `<b>agentId</b>: <code>${s?.agentId ?? "(尚未创建)"}</code>`,
    `<b>模型</b>: <code>${s?.model ?? "(默认)"}</code>`,
  ];
  await ctx.messenger.sendText(ctx.chatId, lines.join("\n"), { parseMode: "HTML" });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```

`src/commands/handlers/model.ts`：
```typescript
import type { CommandContext } from "../dispatch.js";

export async function handleModel(args: string[], ctx: CommandContext): Promise<void> {
  const id = args[0];
  if (!id) { await ctx.messenger.sendText(ctx.chatId, "用法：/model <id>，如 /model auto"); return; }
  const w = ctx.registry.getActive();
  if (!w) { await ctx.messenger.sendText(ctx.chatId, "（没有活跃工作区）"); return; }
  const s = ctx.session.get(w.name) ?? {};
  await ctx.session.set(w.name, { ...s, model: id });
  await ctx.messenger.sendText(ctx.chatId, `下次新会话将使用模型 <code>${id}</code>。已存在的 agent 会沿用之前的模型；如需立刻生效，请 /reset。`,
    { parseMode: "HTML" });
}
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/unit/commandHandlers.test.ts
```
预期：8 个测试全 pass。

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(commands): help/ws/reset/cancel/status/model handlers + 派发器"
```

---

## Task 16：Telegram adapter（grammy 实现 IMessenger）

**Files:**
- Create: `src/adapters/telegram/grammyClient.ts`
- Create: `src/adapters/telegram/TelegramMessenger.ts`

由于 grammy 直接对接外部服务，单测仅写"实例化无副作用"，端到端验证留到手动烟囱测试。

- [ ] **Step 1：写"轻量"测试（确保模块能 import）**

`tests/unit/telegramMessenger.test.ts`：
```typescript
import { describe, it, expect } from "vitest";
import { TelegramMessenger } from "../../src/adapters/telegram/TelegramMessenger.js";

describe("TelegramMessenger", () => {
  it("可以构造，且未 start 时 stop 不抛错", async () => {
    const m = new TelegramMessenger({ botToken: "1234:fake-not-used", parseMode: "HTML" });
    await expect(m.stop()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2：跑测试看红**

```bash
npm test -- tests/unit/telegramMessenger.test.ts
```

- [ ] **Step 3：实现**

`src/adapters/telegram/grammyClient.ts`：
```typescript
import { Bot } from "grammy";

export function createBot(token: string) {
  return new Bot(token);
}
export type GrammyBot = ReturnType<typeof createBot>;
```

`src/adapters/telegram/TelegramMessenger.ts`：
```typescript
import { InputFile } from "grammy";
import { createBot, type GrammyBot } from "./grammyClient.js";
import type { IMessenger } from "../../core/messenger/IMessenger.js";
import type {
  IncomingTextMessage, IncomingImageMessage,
  MessageHandle, ImagePayload, FilePayload, SendOptions,
} from "../../core/messenger/types.js";
import { logger } from "../../logger.js";

export interface TelegramMessengerConfig {
  botToken: string;
  parseMode: "HTML" | "Markdown" | "plain";
  allowedUserIds?: number[];
}

export class TelegramMessenger implements IMessenger {
  private bot?: GrammyBot;
  private textListeners: Array<(m: IncomingTextMessage) => void> = [];
  private imageListeners: Array<(m: IncomingImageMessage) => void> = [];

  constructor(private readonly cfg: TelegramMessengerConfig) {}

  async start(): Promise<void> {
    const bot = createBot(this.cfg.botToken);
    this.bot = bot;

    bot.on("message:text", (ctx) => {
      const userId = ctx.from?.id;
      if (userId === undefined) return;
      if (this.cfg.allowedUserIds && !this.cfg.allowedUserIds.includes(userId)) return;
      const chatId = String(ctx.chat.id);
      const text = ctx.message.text;
      for (const l of this.textListeners) l({ chatId, userId, username: ctx.from?.username, text });
    });

    bot.on("message:photo", async (ctx) => {
      const userId = ctx.from?.id;
      if (userId === undefined) return;
      if (this.cfg.allowedUserIds && !this.cfg.allowedUserIds.includes(userId)) return;
      const chatId = String(ctx.chat.id);
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      if (!largest) return;
      try {
        const file = await ctx.api.getFile(largest.file_id);
        const url = `https://api.telegram.org/file/bot${this.cfg.botToken}/${file.file_path}`;
        const res = await fetch(url);
        const buf = Buffer.from(await res.arrayBuffer());
        const mimeType = "image/jpeg";
        const data = buf.toString("base64");
        const caption = ctx.message.caption ?? undefined;
        for (const l of this.imageListeners) {
          l({ chatId, userId, username: ctx.from?.username, data, mimeType, caption });
        }
      } catch (e) {
        logger.error({ err: (e as Error).message }, "下载图片失败");
      }
    });

    bot.start({ drop_pending_updates: true }).catch((e) => {
      logger.error({ err: (e as Error).message }, "grammy 退出");
    });
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = undefined;
    }
  }

  on(event: "text", h: (m: IncomingTextMessage) => void): void;
  on(event: "image", h: (m: IncomingImageMessage) => void): void;
  on(event: "text" | "image", h: (m: never) => void): void {
    if (event === "text") this.textListeners.push(h as (m: IncomingTextMessage) => void);
    else this.imageListeners.push(h as (m: IncomingImageMessage) => void);
  }

  async sendText(chatId: string, text: string, opts?: SendOptions): Promise<MessageHandle> {
    const r = await this.requireBot().api.sendMessage(Number(chatId), text, {
      parse_mode: this.toParseMode(opts?.parseMode ?? this.cfg.parseMode),
      reply_parameters: opts?.replyToMessageId
        ? { message_id: Number(opts.replyToMessageId) }
        : undefined,
    });
    return { messageId: String(r.message_id) };
  }

  async editText(chatId: string, messageId: string, text: string, opts?: SendOptions): Promise<void> {
    try {
      await this.requireBot().api.editMessageText(Number(chatId), Number(messageId), text, {
        parse_mode: this.toParseMode(opts?.parseMode ?? this.cfg.parseMode),
      });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("message is not modified")) return;
      throw e;
    }
  }

  async sendImage(chatId: string, image: ImagePayload, caption?: string): Promise<MessageHandle> {
    const r = await this.requireBot().api.sendPhoto(
      Number(chatId),
      new InputFile(image.data, image.filename),
      { caption, parse_mode: this.toParseMode(this.cfg.parseMode) },
    );
    return { messageId: String(r.message_id) };
  }

  async sendDocument(chatId: string, file: FilePayload, caption?: string): Promise<MessageHandle> {
    const r = await this.requireBot().api.sendDocument(
      Number(chatId),
      new InputFile(file.data, file.filename),
      { caption, parse_mode: this.toParseMode(this.cfg.parseMode) },
    );
    return { messageId: String(r.message_id) };
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.requireBot().api.sendChatAction(Number(chatId), "typing");
  }

  private requireBot(): GrammyBot {
    if (!this.bot) throw new Error("TelegramMessenger 未启动");
    return this.bot;
  }

  private toParseMode(mode: "HTML" | "Markdown" | "plain"): "HTML" | "MarkdownV2" | undefined {
    if (mode === "HTML") return "HTML";
    if (mode === "Markdown") return "MarkdownV2";
    return undefined;
  }
}
```

- [ ] **Step 4：跑测试看绿**

```bash
npm test -- tests/unit/telegramMessenger.test.ts
```

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(adapter-telegram): grammy 适配 IMessenger（含图片输入回调）"
```

---

## Task 17：主入口装配 + CursorSDK 运行时 + README + 烟囱测试

**Files:**
- Create: `src/core/orchestrator/cursorSdkRuntime.ts`
- Create: `src/bin/cursor-claw.ts`
- Create: `tests/manual/sdk_smoke.ts`
- Create: `README.md`

- [ ] **Step 1：实现 CursorSdkRuntime（把 IAgentRuntime 桥到真实 @cursor/sdk）**

`src/core/orchestrator/cursorSdkRuntime.ts`：
```typescript
import { Agent, type SDKAgent } from "@cursor/sdk";
import type {
  IAgentRuntime, RuntimeAgent, RuntimeRun, RuntimeStreamEvent,
  CreateAgentOptions, ResumeAgentOptions,
} from "./runtime.js";

export class CursorSdkRuntime implements IAgentRuntime {
  constructor(private readonly apiKey: string) {}

  async create(opts: CreateAgentOptions): Promise<RuntimeAgent> {
    const sdk = await Agent.create({
      apiKey: this.apiKey,
      agentId: opts.agentId,
      model: opts.model ? { id: opts.model.id, params: opts.model.params } : { id: "auto" },
      local: { cwd: opts.cwd, settingSources: opts.settingSources ?? ["project", "user"] },
      mcpServers: opts.mcpServers,
    });
    return new SdkAgentWrapper(sdk);
  }

  async resume(agentId: string, opts: ResumeAgentOptions): Promise<RuntimeAgent> {
    const sdk = await Agent.resume(agentId, {
      apiKey: this.apiKey,
      model: opts.model ? { id: opts.model.id, params: opts.model.params } : undefined,
      local: { cwd: opts.cwd, settingSources: opts.settingSources ?? ["project", "user"] },
    });
    return new SdkAgentWrapper(sdk);
  }
}

class SdkAgentWrapper implements RuntimeAgent {
  agentId: string;
  constructor(private readonly inner: SDKAgent) {
    this.agentId = inner.agentId;
  }
  async send(text: string, opts?: { force?: boolean }): Promise<RuntimeRun> {
    const run = await this.inner.send(text, opts?.force ? { local: { force: true } } : undefined);
    return new SdkRunWrapper(run);
  }
  async dispose(): Promise<void> {
    await this.inner[Symbol.asyncDispose]();
  }
}

class SdkRunWrapper implements RuntimeRun {
  status: "running" | "finished" | "error" | "cancelled" = "running";
  constructor(private readonly inner: Awaited<ReturnType<SDKAgent["send"]>>) {
    this.status = inner.status as RuntimeRun["status"];
    inner.onDidChangeStatus((s) => { this.status = s as RuntimeRun["status"]; });
  }
  async *stream(): AsyncGenerator<RuntimeStreamEvent, void> {
    for await (const e of this.inner.stream()) {
      switch (e.type) {
        case "assistant":
          for (const block of e.message.content) {
            if (block.type === "text") yield { type: "assistant", text: block.text };
          }
          break;
        case "thinking":
          yield { type: "thinking", text: e.text };
          break;
        case "tool_call":
          yield { type: "tool_call", status: e.status, name: e.name, args: e.args };
          break;
        default:
          break;
      }
    }
  }
  async wait() {
    const r = await this.inner.wait();
    return { status: r.status, result: r.result, durationMs: r.durationMs };
  }
  async cancel(): Promise<void> { await this.inner.cancel(); }
}
```

- [ ] **Step 2：实现主入口 `src/bin/cursor-claw.ts`**

```typescript
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "../config/loadConfig.js";
import { logger } from "../logger.js";
import { TelegramMessenger } from "../adapters/telegram/TelegramMessenger.js";
import { WorkspaceRegistry } from "../core/workspace/WorkspaceRegistry.js";
import { SessionStore } from "../core/session/SessionStore.js";
import { AccessControl } from "../core/access/AccessControl.js";
import { AgentOrchestrator } from "../core/orchestrator/AgentOrchestrator.js";
import { CursorSdkRuntime } from "../core/orchestrator/cursorSdkRuntime.js";
import { parseCommand } from "../commands/parser.js";
import { dispatchCommand } from "../commands/dispatch.js";
import { parseForcePrefix } from "../core/orchestrator/busyPolicy.js";

async function main() {
  const cfg = await loadConfig({});
  const dataDir = cfg.paths.dataDir;
  await mkdir(dataDir, { recursive: true });

  const registry = new WorkspaceRegistry(join(dataDir, "workspaces.json"));
  await registry.init({ autoRegisterCwd: cfg.workspaces.autoRegisterCwd, cwd: process.cwd() });

  const session = new SessionStore(join(dataDir, "sessions.json"));
  await session.init();

  const access = new AccessControl(cfg.telegram.allowedUserIds);
  const messenger = new TelegramMessenger({
    botToken: cfg.telegram.botToken,
    parseMode: cfg.telegram.parseMode,
    allowedUserIds: cfg.telegram.allowedUserIds,
  });
  const runtime = new CursorSdkRuntime(cfg.cursor.apiKey);
  const orchestrator = new AgentOrchestrator({
    messenger, runtime, registry, session,
    streamOptions: { throttleMs: 800, maxLen: 3500 },
    defaultModel: cfg.cursor.defaultModel,
  });

  messenger.on("text", (msg) => {
    if (!access.isAllowed(msg.userId)) return;
    void handleText(msg.chatId, msg.text);
  });

  messenger.on("image", (msg) => {
    if (!access.isAllowed(msg.userId)) return;
    void messenger.sendText(msg.chatId, "（M1 暂不处理图片输入；M2 会接入。）");
  });

  await messenger.start();
  logger.info("cursor-claw started");

  const shutdown = async () => {
    logger.info("shutting down...");
    try { await messenger.stop(); } catch (e) { logger.error({ err: (e as Error).message }, "messenger stop"); }
    try { await orchestrator.dispose(); } catch (e) { logger.error({ err: (e as Error).message }, "orch dispose"); }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  async function handleText(chatId: string, text: string): Promise<void> {
    const cmd = parseCommand(text);
    if (cmd) {
      await dispatchCommand(cmd, { chatId, messenger, registry, session, orchestrator });
      return;
    }
    const { force, text: clean } = parseForcePrefix(text);
    await orchestrator.runPrompt({ chatId, text: clean, force });
  }
}

main().catch((e) => {
  logger.error({ err: (e as Error).message }, "fatal");
  process.exit(1);
});
```

- [ ] **Step 3：写 README + 烟囱测试**

`README.md`：
```markdown
# cursor-claw

基于 [`@cursor/sdk`](https://cursor.com/cn/docs/sdk/typescript) 的 Telegram ↔ Cursor agent 桥；从手机指挥 Cursor agent 在你的本机仓库工作。

## 快速开始

```bash
npm install
cp config.example.json config.json
# 编辑 config.json 填入 telegram.botToken / telegram.allowedUserIds / cursor.apiKey
# 或者使用环境变量：
export TELEGRAM_BOT_TOKEN="..."
export CURSOR_API_KEY="..."
npm run dev
```

打开 Telegram → 与你的 bot 私聊 → 输入 `/start` → 收到欢迎语。

## 命令

- `/help` - 帮助
- `/ws list|use|add|remove|path` - 工作区
- `/reset` - 重置当前工作区会话
- `/cancel` - 取消当前 run
- `/status` - 当前状态
- `/model <id>` - 切换模型
- 普通文本 → 作为 prompt
- `!<文本>` → 强制打断当前 run

## 测试

```bash
npm test
```

## 路线图

M1（本里程碑）端到端文本对话；M2 双向附件、入站图片、reminders；M3 systemd、微信骨架。详见 `docs/superpowers/specs/2026-05-05-cursor-claw-design.md`。

## 安全

bot 等同于把 shell 控制权交给消息平台。请：
- 严格管理 `TELEGRAM_BOT_TOKEN` 与 `CURSOR_API_KEY`
- 仅把白名单设为你自己；非白名单消息将被静默忽略
```

`tests/manual/sdk_smoke.ts`：
```typescript
import { CursorSdkRuntime } from "../../src/core/orchestrator/cursorSdkRuntime.js";

async function main() {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    console.error("set CURSOR_API_KEY first");
    process.exit(1);
  }
  const runtime = new CursorSdkRuntime(apiKey);
  const agent = await runtime.create({ cwd: process.cwd() });
  console.log("agentId:", agent.agentId);
  const run = await agent.send("用一句话说明这个仓库的功能");
  for await (const e of run.stream()) {
    if (e.type === "assistant") process.stdout.write(e.text);
  }
  console.log();
  await agent.dispose();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4：跑全部测试 + typecheck + 启动**

```bash
npm run typecheck
npm test
```
预期：typecheck 通过；全部测试 pass。

烟囱测试（需要真 API key + bot）：
```bash
export CURSOR_API_KEY="..."
npx tsx tests/manual/sdk_smoke.ts
# 应当看到 agentId 和一段中文/英文回复
```

启动：
```bash
export TELEGRAM_BOT_TOKEN="..."
export CURSOR_API_KEY="..."
npm run dev
# 在 Telegram 中私聊 bot，发 /start 收到欢迎语；发 "总结这个仓库" 看到流式输出
```

- [ ] **Step 5：commit**

```bash
git add -A
git commit -m "feat(bin): cursor-claw M1 主入口（CursorSdkRuntime + Telegram + 命令派发）"
```

---

## Self-Review 后续记录

> 在执行完最后一个任务前，请按 writing-plans skill 的 self-review 三步对照本计划：
> 1. **Spec coverage**：第 1-7 步路线全部映射到 T1-T17 的任务（基础设施 T1-T3、配置 T4、核心 T5-T7、消息接口 T8、渲染 T9、编排 T10-T13、命令 T14-T15、Telegram T16、装配 T17）。
> 2. **Placeholder scan**：本文件不含 TBD/TODO；每段都有完整代码与命令。
> 3. **Type consistency**：`IMessenger.editText` 在 T8 与 T16 签名一致；`RuntimeStreamEvent.tool_call` 在 T13 与 T17 形态一致；`AgentOrchestrator` 构造参数 `defaultModel` 在测试与生产装配一致。

如果在执行中发现新的 type drift，请在 `tests/integration/orchestrator.test.ts` 末尾追加回归测试再修。

---

## 接下来

M1 完成后，进入 **M2 plan**（路线图 8-12 步）：附件双向、入站图片、reminders、错误重试、clawfox 集成。等 M1 实测有反馈后再写，避免预设过多。
