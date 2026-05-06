import { describe, it, expect, vi } from "vitest";
import { handleRemind } from "../../src/commands/handlers/remind.js";
import { ReminderQuota } from "../../src/core/reminders/ReminderQuota.js";

// F-06 PR e：/remind add 接入 ReminderQuota 的端到端测试

function makeFakeMessenger() {
  const sent: Array<{ chatId: string; text: string }> = [];
  return {
    sent,
    sendText: vi.fn(async (chatId: string, text: string) => {
      sent.push({ chatId, text });
      return { messageId: `m-${sent.length}` };
    }),
  };
}

function makeFakeRegistry() {
  return {
    getActive: () => ({ name: "ws1", path: "/tmp/ws1" }),
  };
}

function makeFakeScheduler(initialItems: unknown[] = []) {
  const items = [...initialItems];
  return {
    items,
    list: () => [...items],
    add: vi.fn(async (r: unknown) => {
      items.push(r);
    }),
    remove: vi.fn(async () => {}),
  };
}

describe("handleRemind + ReminderQuota", () => {
  it("第 101 个 reminder 收到中文超限提示，且未写入 store", async () => {
    const messenger = makeFakeMessenger();
    const initial = Array.from({ length: 100 }, (_, i) => ({
      id: `r${i}`,
      createdAt: 0,
      createdBy: 1,
      chatId: "C",
      kind: "text",
      at: 60_000,
      tz: "UTC",
      text: "x",
    }));
    const scheduler = makeFakeScheduler(initial);
    const quota = new ReminderQuota(scheduler as never, { maxPerUser: 100 });

    await handleRemind(
      ["add", "text", "1m", "测试"],
      "add text 1m 测试",
      {
        chatId: "C",
        userId: 1,
        messenger: messenger as never,
        scheduler: scheduler as never,
        registry: makeFakeRegistry() as never,
        now: () => 0,
        tz: "UTC",
        maxAheadDays: 30,
        reminderQuota: quota,
      },
    );

    expect(scheduler.items.length).toBe(100);
    expect(scheduler.add).not.toHaveBeenCalled();
    expect(messenger.sent[messenger.sent.length - 1]?.text).toMatch(
      /Reminder 已达上限/,
    );
  });
});
