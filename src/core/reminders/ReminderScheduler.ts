import { logger } from "../../logger.js";
import type { ReminderStore, Reminder } from "./ReminderStore.js";

// 调用方注入的最小依赖：runReminder（orchestrator）+ sendText（messenger 兜底）
export interface SchedulerDeps {
  store: ReminderStore;
  runReminder: (input: {
    chatId: string;
    kind: "text" | "prompt";
    text?: string;
    prompt?: string;
    workspaceId?: string;
  }) => Promise<{ delivered: boolean; busy?: boolean }>;
  sendText: (chatId: string, text: string) => Promise<void>;
}

// setTimeout 在 32-bit 上限附近（~24.85 天）会立刻触发；保险起见 ~23 天就分段
const SETTIMEOUT_MAX = 2_000_000_000;

/**
 * Reminders 调度器：
 *
 * - start() 全表扫描，过期丢弃，未过期注册 timer
 * - add(item) 写 store + 注册 timer
 * - remove(id) 删 store + clearTimeout
 * - dispose() 清掉所有 timer（不持久化 attempt）
 *
 * Busy 重排：prompt 触发时如返回 busy=true，把 reminder.at 改为 now+60s 写回 store
 * 并重新注册 timer，同时通知用户。再次 busy 则退化 sendText 并丢弃。
 *
 * 进程内 attempts Map 用于跟踪重排次数，进程重启重置——意味着重启后即使触发也仍会
 * 重排一次，这是可接受的代价（避免污染 store schema）。
 */
export class ReminderScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private attempts = new Map<string, number>();
  // 跟踪所有 in-flight fire 调用，便于测试 / dispose 等待全部完成
  private firePromises = new Set<Promise<void>>();
  private disposed = false;

  constructor(private readonly deps: SchedulerDeps) {}

  // 测试辅助：等所有 in-flight fire 完成（含 store.update / sendText）。
  // 不直接放进 dispose() 因为某些测试在 dispose 前就要观察中间状态。
  async waitIdle(): Promise<void> {
    while (this.firePromises.size > 0) {
      await Promise.allSettled([...this.firePromises]);
    }
  }

  async start(): Promise<void> {
    const now = Date.now();
    const items = this.deps.store.list();
    for (const r of items) {
      if (r.at <= now) {
        // 过期 reminder 不触发也不留：避免启动时一次性炸出一堆已过期通知
        logger.warn(
          { id: r.id, at: r.at, now },
          "启动时发现过期 reminder，丢弃",
        );
        await this.deps.store.remove(r.id);
        continue;
      }
      this.scheduleTimer(r);
    }
  }

  async add(item: Reminder): Promise<void> {
    await this.deps.store.add(item);
    this.scheduleTimer(item);
  }

  async remove(id: string): Promise<void> {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.attempts.delete(id);
    await this.deps.store.remove(id);
  }

  list(): Reminder[] {
    return this.deps.store.list();
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.attempts.clear();
  }

  // 注册一个 timer。delay 超过 setTimeout 上限时分段链式注册：
  // 先 sleep 一段，timer 醒来再调用 scheduleTimer 自身。
  private scheduleTimer(r: Reminder): void {
    if (this.disposed) return;
    const delay = Math.max(0, r.at - Date.now());
    if (delay > SETTIMEOUT_MAX) {
      const t = setTimeout(() => this.scheduleTimer(r), SETTIMEOUT_MAX);
      this.timers.set(r.id, t);
      return;
    }
    const t = setTimeout(() => {
      // 把 fire 的 promise 加入跟踪集合，让 waitIdle / dispose 可以等
      const p = this.fire(r.id).finally(() => {
        this.firePromises.delete(p);
      });
      this.firePromises.add(p);
    }, delay);
    this.timers.set(r.id, t);
  }

  private async fire(id: string): Promise<void> {
    if (this.disposed) return;
    this.timers.delete(id);
    const r = this.deps.store.list().find((x) => x.id === id);
    if (!r) return;

    const attempt = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempt);

    try {
      if (r.kind === "text") {
        await this.deps.runReminder({
          chatId: r.chatId,
          kind: "text",
          text: r.text,
        });
        await this.deps.store.remove(id);
        this.attempts.delete(id);
        return;
      }
      // prompt
      const res = await this.deps.runReminder({
        chatId: r.chatId,
        kind: "prompt",
        prompt: r.prompt,
        workspaceId: r.workspaceId,
      });
      if (res.delivered) {
        await this.deps.store.remove(id);
        this.attempts.delete(id);
        return;
      }
      // busy
      if (attempt >= 2) {
        // 第二次仍 busy → 退化 sendText
        try {
          await this.deps.sendText(
            r.chatId,
            `⏰ 提醒：${r.prompt}（agent 一直在忙，未能自动执行）`,
          );
        } catch (e) {
          logger.error(
            { err: (e as Error).message, id },
            "fallback sendText 失败",
          );
        }
        await this.deps.store.remove(id);
        this.attempts.delete(id);
        return;
      }
      // 第一次 busy → 重排到 +60s + 写回 store
      const newAt = Date.now() + 60_000;
      await this.deps.store.update(id, (r0) => ({ ...r0, at: newAt }));
      try {
        await this.deps.sendText(
          r.chatId,
          `⏰ 提醒延后 1 分钟（agent 正忙）：${r.prompt.slice(0, 60)}`,
        );
      } catch (e) {
        logger.error(
          { err: (e as Error).message, id },
          "通知用户重排失败",
        );
      }
      const refreshed = this.deps.store.list().find((x) => x.id === id);
      if (refreshed) this.scheduleTimer(refreshed);
    } catch (e) {
      logger.error({ err: (e as Error).message, id }, "reminder fire 失败");
      // 保守：丢 store + 移除 attempt，避免 timer 已 fire 但 entry 仍在 store 导致下次启动重复触发
      await this.deps.store.remove(id);
      this.attempts.delete(id);
    }
  }
}
