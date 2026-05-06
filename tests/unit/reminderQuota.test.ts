import { describe, it, expect } from "vitest";
import { ReminderQuota } from "../../src/core/reminders/ReminderQuota.js";
import { ReminderQuotaExceededError } from "../../src/core/reminders/errors.js";
import type { Reminder } from "../../src/core/reminders/ReminderStore.js";

// F-06 PR e：ReminderQuota 单元测试
// quota 基于 store.list() 实时计数，checkAndAdd 只在未达上限时调用底层 add。

function makeReminder(id: string, createdBy: number): Reminder {
  return {
    id,
    createdAt: 0,
    createdBy,
    chatId: "C",
    kind: "text",
    at: 0,
    tz: "UTC",
    text: "x",
  };
}

function makeFakeStore(initial: Reminder[] = []) {
  const items = [...initial];
  return {
    items,
    list: () => [...items],
    add: async (r: Reminder) => {
      items.push(r);
    },
  };
}

describe("ReminderQuota", () => {
  it("99 -> 100 通过；第 101 抛", async () => {
    const store = makeFakeStore(
      Array.from({ length: 99 }, (_, i) => makeReminder(`r${i}`, 1)),
    );
    const q = new ReminderQuota(store, { maxPerUser: 100 });
    await q.checkAndAdd(makeReminder("r99", 1));
    await expect(q.checkAndAdd(makeReminder("r100", 1))).rejects.toThrow(
      ReminderQuotaExceededError,
    );
    expect(store.items.length).toBe(100);
  });

  it("不同 user 互相独立", async () => {
    const items = Array.from({ length: 100 }, (_, i) =>
      makeReminder(`r${i}`, 1),
    );
    const store = makeFakeStore(items);
    const q = new ReminderQuota(store, { maxPerUser: 100 });
    await expect(q.checkAndAdd(makeReminder("rX", 1))).rejects.toThrow(
      ReminderQuotaExceededError,
    );
    await q.checkAndAdd(makeReminder("rY", 2));
    expect(store.items.length).toBe(101);
  });

  it("删除后能再加（quota 基于 store 实时计数）", async () => {
    const items = Array.from({ length: 100 }, (_, i) =>
      makeReminder(`r${i}`, 1),
    );
    const store = makeFakeStore(items);
    const q = new ReminderQuota(store, { maxPerUser: 100 });
    store.items.shift();
    await q.checkAndAdd(makeReminder("rZ", 1));
    expect(store.items.length).toBe(100);
  });
});
