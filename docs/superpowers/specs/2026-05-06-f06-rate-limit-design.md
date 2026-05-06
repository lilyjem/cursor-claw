# F-06 Rate Limiting · Design Spec

- 创建日期：2026-05-06
- 关联 finding：F-06（无单用户速率/flood/资源 cap，Medium，CWE-770）
- 上游审计报告：`docs/security/2026-05-06-security-audit.md`
- 状态：Approved（brainstorming 阶段三段全部 user-approved）

---

## 1. 背景与目标

`cursor-claw` 当前虽用 `allowedUserIds` 白名单挡住了陌生人，但白名单内的用户（包括 owner 自己、被 social-engineering 攻击的合法账号、token 泄漏后的伪造账号）可以无约束触发以下三类资源耗尽：

1. **`/remind add prompt` 灌爆 ReminderStore**：到点全部触发 agent 调用 → 烧穿 Cursor API quota + 拉爆主机内存（每 timer 占内存）。
2. **消息洪水**：连续短时间发文本/图片，触发频繁 `agent.send` / `MediaGroupBuffer` 累积。
3. **agent 创建洪水**：连续切换不同 cwd 触发 `Agent.create` → SDK / Cursor 后端被密集调用。

**本 spec 的目标**：在三层引入资源 cap，让"误操作 / 凭据被盗" 的破坏面被严格约束，且不损害 owner 正常使用体验。

---

## 2. 范围（已与 user 确认）

| 项 | 决策 | 来源 |
|---|---|---|
| Scope 套餐 | **Balanced**：reminder cap + 消息限速 + agent.create 限速 | 澄清 1/3 |
| 阈值组 | **Balanced**：reminder 100 / msg 2-per-sec / agent.create 10-per-min | 澄清 2/3 |
| 超限 UX | **Reply with retry-after** + `logger.warn`（不静默） | 澄清 3/3 |

**out of scope**：

- /ws add 路径白名单（属 F-07）
- HTML escape 缺失（属 F-08）
- 持久化 schema 校验（属 F-12）
- 跨进程共享 bucket（单进程产品，无需）

---

## 3. 架构

### 3.1 模块切分

新增四个**职责单一**的模块（合计约 215 行），不改任何现有模块的接口契约，仅在 4 个 caller 处 ≤ 5 行的接入点。

| 模块 | 路径 | 行数 | 职责 |
|---|---|---|---|
| TokenBucket | `src/core/rateLimit/TokenBucket.ts` | ~70 | 纯算法：refill rate + capacity，`take()` / `inspect()` |
| RateLimiter | `src/core/rateLimit/RateLimiter.ts` | ~100 | 多 bucket 容器：按 `(userId, key)` 索引；LRU 清 idle |
| ReminderQuota | `src/core/reminders/ReminderQuota.ts` | ~30 | 包装 `ReminderStore.add` 检查 user-cap，超限抛错 |
| rateLimitMessages | `src/util/rateLimitMessages.ts` | ~15 | 把 `retryAfterMs` 渲染为中文用户文本 |

**接入点**（共 4 处）：

- A. `bin/cursor-claw.ts` `onText` handler：入口处 `limiter.check(userId, "msg")`
- B. `bin/cursor-claw.ts` `onImageGroup` handler：同 A
- C. `AgentOrchestrator.ensureAgent`：cached 命中跳过；miss 时 `limiter.check(userId, "agent.create")`
- D. `commands/handlers/remind.ts` `handleAdd`：`quota.checkAndAdd(userId, item)`

### 3.2 不变量

1. messenger-层限速**先于**所有业务逻辑，最便宜的拒绝。
2. **cached agent 不触发 `agent.create` 限速**——避免误伤正常使用，限速对象是"建池"动作而非"复用池"。
3. 失败路径**永远 `logger.warn({ userId, key, retryAfterMs })`**，便于 owner 排查。
4. ReminderQuota 不改 `ReminderStore` 内部结构，只在外侧包一层（保持持久化层职责单一）。
5. 配置全部带 `.default()`：现有 `config.json` 不动也能升级。

---

## 4. 配置 Schema 扩充

新增到 `src/config/schema.ts`：

```ts
rateLimit: z.object({
  // 单用户消息限速
  message: z.object({
    capacity: z.number().int().min(1).default(4),       // 突发桶容量
    refillPerSec: z.number().min(0.1).default(2),       // 稳定 2 msg/s
  }).default({}),

  // agent.create 限速（首次创建/复用 miss 时触发）
  agentCreate: z.object({
    capacity: z.number().int().min(1).default(10),
    refillPerSec: z.number().min(0.01).default(10 / 60), // 10/分钟 ≈ 0.1667/s
  }).default({}),

  // reminder 数量上限
  reminders: z.object({
    maxPerUser: z.number().int().min(1).default(100),
  }).default({}),
}).default({}),
```

`config.example.json` 同步增加示例段（带注释 default）。

---

## 5. 数据流

### 5.1 消息洪水路径

```
Telegram → grammy bot.on("message:text") → messenger 派发
                                              │
                                              ▼
                       bin/cursor-claw.ts onText(msg)
                                              │
                                              ▼
                      access.isAllowed(userId)? ── no ──→ 静默
                                              │ yes
                                              ▼
                      limiter.check(userId, "msg")
                              │
            ┌─────────────────┴────────────────┐
            ▼ ALLOW                            ▼ DENY (retryMs)
     handleText(...)              messenger.sendText(chatId,
                                    "请求过于频繁，请 X 秒后重试",
                                    { parseMode: "plain" });
                                  logger.warn({ userId, key:"msg",
                                                 retryMs }, "rate limited")
                                  return;
```

### 5.2 agent.create 限速路径

```
runInternal → ensureAgent(wsId, cwd)
                  │
                  ▼
              cached?  ── yes ──→ 直接复用（无限速）
                  │ no
                  ▼
        limiter.check(userId, "agent.create")
                  │
        ┌─────────┼─────────┐
        ▼ ALLOW              ▼ DENY (retryMs)
   runtime.create(...)  throw new RateLimitedError("agent.create", retryMs)
                              │
                              ▼ runInternal catch
                       renderer.finalize("⚠️ 短时间内创建 agent 过多，
                                          请 X 秒后重试")
```

### 5.3 reminder cap 路径

```
handleAdd(...) → quota.checkAndAdd(userId, item)
                       │
                ┌──────┴──────┐
                ▼ ok           ▼ ReminderQuotaExceededError(used, cap)
            scheduler.add  messenger.sendText(chatId,
                              `Reminder 已达上限（${used}/${cap}），
                               请先 /remind del 释放再添加。`)
                           logger.warn({ userId, used, cap }, "reminder quota")
```

---

## 6. 错误层次

```ts
// src/core/rateLimit/errors.ts
export class RateLimitedError extends Error {
  constructor(
    public readonly key: string,
    public readonly retryAfterMs: number,
  ) {
    super(`rate limited: ${key}, retry in ${retryAfterMs}ms`);
    this.name = "RateLimitedError";
  }
}

// src/core/reminders/errors.ts
export class ReminderQuotaExceededError extends Error {
  constructor(
    public readonly used: number,
    public readonly cap: number,
  ) {
    super(`reminders quota: ${used}/${cap}`);
    this.name = "ReminderQuotaExceededError";
  }
}
```

| 抛出点 | 捕获点 | 用户文本 |
|---|---|---|
| `RateLimitedError("msg")` | `onText` / `onImageGroup` | `请求过于频繁，请 X 秒后重试` |
| `RateLimitedError("agent.create")` | `runInternal` catch | `短时间内创建 agent 过多，请 X 秒后重试` |
| `ReminderQuotaExceededError` | `handleAdd` catch | `Reminder 已达上限（${used}/${cap}），请先 /remind del 释放再添加。` |

---

## 7. 测试策略（TDD 强制 RED → GREEN）

| 测试文件 | 用例 |
|---|---|
| `tests/unit/tokenBucket.test.ts` | 满桶 take ✓ / 空桶 take ✗ / 时间推进自动 refill / refill 不超 capacity / `retryAfterMs` 计算精确 |
| `tests/unit/rateLimiter.test.ts` | 不同 (userId,key) 互不干扰 / 多次同 user 命中同 bucket / LRU 清 idle / `inspect()` 不消耗 token |
| `tests/unit/reminderQuota.test.ts` | 99→100 通过 / 第 101 抛 / 同 user 删后能再加 / 不同 user 互不干扰 |
| `tests/integration/messageRateLimit.test.ts` | 同 user 短时发 8 条文本，第 5 条起被拒并收到 retry-after |
| `tests/integration/agentCreateRateLimit.test.ts` | 11 个不同 cwd 触发 11 次 ensureAgent，第 11 次拒；cached 复用不计数 |
| `tests/integration/reminderQuota.test.ts` | 通过 handleAdd 加 100 条 → 第 101 条用户收到中文超限提示 |

**纪律要求**：每个 GREEN 实现前必须先看到对应 RED 输出（fail 截图或日志），否则违反 TDD skill。

---

## 8. 实施拆分（5 个独立 PR）

每个 PR 自带 unit/integration tests + user-facing echo + 中文 commit message：

1. **PR a**：TokenBucket（unit only，无任何接入）
2. **PR b**：RateLimiter + LRU（unit only，无接入）
3. **PR c**：配置 schema 扩充 + onText / onImageGroup 接入（messenger 限速生效）
4. **PR d**：ensureAgent 接入 agent.create 限速
5. **PR e**：ReminderQuota + handleAdd 接入

每个 PR 可独立 review、独立 merge，失败回滚成本最小。

---

## 9. 验收

- 所有 6 个测试文件 GREEN
- `config.example.json` 含新段并注释含义
- `CHANGELOG.md` 在 Security 段加 F-06 条目，链接 PR a/b/c/d/e
- `docs/security/2026-05-06-security-audit.md` 把 F-06 状态从 Open 改 **Fixed**，引用 PR
- 端到端手测：在 Telegram 里 1 秒内连发 6 条 `测试`，第 5 条起收到中文 retry-after 提示

---

## 10. 后续延伸（不在本 spec）

- 跨进程共享 bucket（多机部署时）→ 单独 spec
- 按命令分级限速（`/remind` 比普通文本严格）→ 若实战中 owner 觉得 100 不够细可加
- 限速命中度量（Prometheus exporter）→ 若部署到生产环境可加
