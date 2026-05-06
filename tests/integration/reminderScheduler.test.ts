import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReminderScheduler,
  type SchedulerDeps,
} from "../../src/core/reminders/ReminderScheduler.js";
import {
  ReminderStore,
  type Reminder,
} from "../../src/core/reminders/ReminderStore.js";

describe("ReminderScheduler", () => {
  let dir: string;
  let path: string;
  let store: ReminderStore;
  // 给 vi.fn 显式类型，避免 SchedulerDeps 字段类型推断为 generic Mock
  let runReminder: ReturnType<
    typeof vi.fn<SchedulerDeps["runReminder"]>
  >;
  let sendText: ReturnType<typeof vi.fn<SchedulerDeps["sendText"]>>;
  let scheduler: ReminderScheduler;

  // 等真实 IO（如 fs.rename）完成的小工具：fake timer 不 fake setImmediate
  // 时，setImmediate 会在 native callback 进入 nextTick 队列后真正执行
  async function flushIo(times = 5): Promise<void> {
    for (let i = 0; i < times; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  beforeEach(async () => {
    // 显式只 fake 与定时相关的 API；setImmediate / process.nextTick / queueMicrotask
    // 留给真实运行时，确保 fs/promises 的 native 回调能被冲洗到
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    dir = await mkdtemp(join(tmpdir(), "rsch-"));
    path = join(dir, "reminders.json");
    store = new ReminderStore(path);
    await store.init();
    runReminder = vi.fn<SchedulerDeps["runReminder"]>();
    sendText = vi.fn<SchedulerDeps["sendText"]>();
    const deps: SchedulerDeps = {
      store,
      runReminder,
      sendText,
    };
    scheduler = new ReminderScheduler(deps);
  });
  afterEach(async () => {
    scheduler.dispose();
    // 让 pending IO（如 .tmp rename）完成后再删目录，避免 ENOTEMPTY
    await flushIo(10);
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  const NOW = 1735000000000;

  function textRem(id: string, at: number): Reminder {
    return {
      id,
      createdAt: NOW,
      createdBy: 1,
      chatId: "1",
      kind: "text",
      at,
      tz: "UTC",
      text: "x",
    };
  }

  function promptRem(id: string, at: number): Reminder {
    return {
      id,
      createdAt: NOW,
      createdBy: 1,
      chatId: "1",
      kind: "prompt",
      at,
      tz: "UTC",
      prompt: "p",
      workspaceId: "default",
    };
  }

  it("add → 到点触发 runReminder + 从 store 移除", async () => {
    vi.setSystemTime(NOW);
    runReminder.mockResolvedValue({ delivered: true });
    await scheduler.start();
    await scheduler.add(textRem("r-1", NOW + 1000));
    expect(store.list().length).toBe(1);
    await vi.advanceTimersByTimeAsync(1100);
    await scheduler.waitIdle();
    expect(runReminder).toHaveBeenCalledTimes(1);
    expect(store.list().length).toBe(0);
  });

  it("启动时已过期的丢弃且不触发", async () => {
    vi.setSystemTime(NOW);
    await store.add(textRem("r-old", NOW - 10_000));
    await scheduler.start();
    expect(store.list().length).toBe(0);
    expect(runReminder).not.toHaveBeenCalled();
  });

  it("重启后未触发的 reminder 仍能在原 at 触发", async () => {
    vi.setSystemTime(NOW);
    await store.add(textRem("r-1", NOW + 5000));
    await scheduler.start();
    scheduler.dispose();
    // 模拟重启
    runReminder.mockClear();
    runReminder.mockResolvedValue({ delivered: true });
    const store2 = new ReminderStore(path);
    await store2.init();
    const sch2 = new ReminderScheduler({
      store: store2,
      runReminder,
      sendText,
    });
    await sch2.start();
    await vi.advanceTimersByTimeAsync(5500);
    await sch2.waitIdle();
    expect(runReminder).toHaveBeenCalledTimes(1);
    sch2.dispose();
  });

  it("prompt busy → 重排到 +60s + 写回 store + sendText 通知", async () => {
    vi.setSystemTime(NOW);
    runReminder
      .mockResolvedValueOnce({ delivered: false, busy: true }) // 第一次 busy
      .mockResolvedValueOnce({ delivered: true }); // 60s 后成功
    await scheduler.start();
    await scheduler.add(promptRem("r-1", NOW + 1000));
    await vi.advanceTimersByTimeAsync(1100);
    await scheduler.waitIdle();
    // 第一次：被拒，sendText 通知 + at 改写
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]![1] as string).toMatch(/延后 1 分钟/);
    expect(store.list()[0]!.at).toBe(NOW + 1000 + 60_000);
    // 60s 后再触发：成功
    await vi.advanceTimersByTimeAsync(60_000);
    await scheduler.waitIdle();
    expect(runReminder).toHaveBeenCalledTimes(2);
    expect(store.list().length).toBe(0);
  });

  it("prompt 第二次仍 busy → 退化 sendText + 不再排 + 移除", async () => {
    vi.setSystemTime(NOW);
    runReminder.mockResolvedValue({ delivered: false, busy: true });
    await scheduler.start();
    await scheduler.add(promptRem("r-1", NOW + 1000));
    await vi.advanceTimersByTimeAsync(1100); // 第一次 busy → 重排
    await scheduler.waitIdle();
    await vi.advanceTimersByTimeAsync(60_000); // 第二次 busy → 退化
    await scheduler.waitIdle();
    expect(runReminder).toHaveBeenCalledTimes(2);
    // 第二次后应有 "提醒：" 文本（前缀 ⏰）
    const fallbackCall = sendText.mock.calls.find((c) =>
      (c[1] as string).startsWith("⏰ 提醒"),
    );
    expect(fallbackCall).toBeDefined();
    expect(store.list().length).toBe(0);
  });

  it("remove(id) 取消未触发的 timer", async () => {
    vi.setSystemTime(NOW);
    await scheduler.start();
    await scheduler.add(textRem("r-1", NOW + 5000));
    await scheduler.remove("r-1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runReminder).not.toHaveBeenCalled();
    expect(store.list().length).toBe(0);
  });
});
