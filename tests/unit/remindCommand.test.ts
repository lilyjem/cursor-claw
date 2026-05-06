import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReminderScheduler } from "../../src/core/reminders/ReminderScheduler.js";
import {
  handleRemind,
  type RemindContext,
} from "../../src/commands/handlers/remind.js";
import { ReminderQuota } from "../../src/core/reminders/ReminderQuota.js";
import { StubMessenger } from "../helpers/StubMessenger.js";

describe("/remind", () => {
  let messenger: StubMessenger;
  let scheduler: ReminderScheduler;

  beforeEach(() => {
    messenger = new StubMessenger();
    scheduler = {
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockReturnValue([]),
    } as unknown as ReminderScheduler;
  });

  function ctx(): RemindContext {
    return {
      chatId: "1",
      userId: 100,
      messenger,
      scheduler,
      reminderQuota: new ReminderQuota(scheduler, { maxPerUser: 100 }),
      registry: {
        getActive: () => ({ name: "default", path: "/w" }),
      } as unknown as RemindContext["registry"],
      now: () => new Date("2026-05-05T16:00:00Z").getTime(),
      tz: "UTC",
      maxAheadDays: 30,
    };
  }

  it("/remind add text 10m 喝水 → scheduler.add 被调", async () => {
    await handleRemind(["add", "text", "10m", "喝水"], "10m 喝水", ctx());
    expect(
      (scheduler.add as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .length,
    ).toBe(1);
  });

  it("/remind add prompt 1h 看 BTC → kind=prompt 携 prompt 文本", async () => {
    await handleRemind(
      ["add", "prompt", "1h", "看 BTC 价格"],
      "1h 看 BTC 价格",
      ctx(),
    );
    const args = (
      scheduler.add as unknown as {
        mock: { calls: { 0: { kind: string; prompt?: string } }[] };
      }
    ).mock.calls[0]!;
    const r = args[0] as { kind: string; prompt?: string };
    expect(r.kind).toBe("prompt");
    expect(r.prompt).toBe("看 BTC 价格");
  });

  it("/remind add 缺 kind → 友好报错", async () => {
    await handleRemind(["add"], "", ctx());
    expect(messenger.sentTexts.some((m) => m.text.includes("用法"))).toBe(true);
  });

  it("/remind add 时间格式不对 → 友好报错且不调 add", async () => {
    await handleRemind(["add", "text", "abcd", "x"], "abcd x", ctx());
    expect(messenger.sentTexts.some((m) => m.text.includes("不识别"))).toBe(
      true,
    );
    expect(
      (scheduler.add as unknown as { mock: { calls: unknown[] } }).mock.calls
        .length,
    ).toBe(0);
  });

  it("/remind list → 列出现有 + 空时友好提示", async () => {
    await handleRemind(["list"], "", ctx());
    expect(messenger.sentTexts.some((m) => m.text.includes("无"))).toBe(true);
  });

  it("/remind del r-1 → scheduler.remove 被调", async () => {
    await handleRemind(["del", "r-1"], "r-1", ctx());
    expect(
      (scheduler.remove as unknown as { mock: { calls: unknown[] } }).mock
        .calls.length,
    ).toBe(1);
  });

  // 回归测试：dispatch 进来的 rest 形如 "add text 1h 测试"（含 sub 关键字 add）
  // handleAdd 必须把 sub `add` 也剥掉，否则 body 会变成 "add text 1h 测试"。
  it("dispatch 真实 rest 形如 'add text 1h 测试' → body 应只是 '测试'", async () => {
    await handleRemind(
      ["add", "text", "1h", "测试"],
      "add text 1h 测试",
      ctx(),
    );
    const args = (
      scheduler.add as unknown as {
        mock: { calls: { 0: { kind: string; text?: string } }[] };
      }
    ).mock.calls[0]!;
    const r = args[0] as { kind: string; text?: string };
    expect(r.kind).toBe("text");
    expect(r.text).toBe("测试");
  });

  // 回归测试：USAGE 文本里有 <时间>/<内容>/<id>，如果默认走 HTML parseMode
  // Telegram 会把它当成未知标签，直接 400 抛错。所有提示文本必须显式 parseMode: "plain"。
  it("USAGE / 错误提示 / 删除回执都必须用 plain parseMode（不被 Telegram 当 HTML 解析）", async () => {
    // 1. 缺 sub
    await handleRemind([], "", ctx());
    // 2. 缺 kind
    await handleRemind(["add"], "", ctx());
    // 3. 时间格式错（<时间> 走文案分支但不含尖括号；这里只看 USAGE 包含尖括号的 case）
    // 4. del 缺 id
    await handleRemind(["del"], "", ctx());

    // 所有包含尖括号的文本都必须用 plain
    for (const s of messenger.sentTexts) {
      if (/[<>]/.test(s.text)) {
        expect(s.opts?.parseMode, `含尖括号的文案必须 plain：${s.text}`).toBe(
          "plain",
        );
      }
    }
  });
});
