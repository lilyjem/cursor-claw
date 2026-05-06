import type { Reminder, ReminderStore } from "./ReminderStore.js";
import { ReminderQuotaExceededError } from "./errors.js";

export interface ReminderQuotaOptions {
  maxPerUser: number;
}

/**
 * F-06：Reminder 数量上限包装层。
 *
 * 设计上不修改 ReminderStore 本体：
 * - ReminderStore 只负责持久化 / list / add / remove
 * - ReminderQuota 只负责在 add 前按 createdBy 做 cap 检查
 *
 * 依赖类型用 Pick<ReminderStore, "list" | "add">，所以生产可传 ReminderScheduler
 * （它同样暴露 list/add），测试也可传 fake store。
 */
export class ReminderQuota {
  constructor(
    private readonly store: Pick<ReminderStore, "list" | "add">,
    private readonly opts: ReminderQuotaOptions,
  ) {}

  async checkAndAdd(item: Reminder): Promise<void> {
    const used = this.store
      .list()
      .filter((r) => r.createdBy === item.createdBy).length;
    if (used >= this.opts.maxPerUser) {
      throw new ReminderQuotaExceededError(used, this.opts.maxPerUser);
    }
    await this.store.add(item);
  }
}
