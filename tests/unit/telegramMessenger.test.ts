import { describe, it, expect } from "vitest";
import { TelegramMessenger } from "../../src/adapters/telegram/TelegramMessenger.js";

describe("TelegramMessenger", () => {
  it("可以构造，且未 start 时 stop 不抛错", async () => {
    const m = new TelegramMessenger({
      botToken: "1234:fake-not-used",
      parseMode: "HTML",
    });
    await expect(m.stop()).resolves.toBeUndefined();
  });

  it("未 start 时 sendText 抛 '未启动'", async () => {
    const m = new TelegramMessenger({
      botToken: "1234:fake-not-used",
      parseMode: "HTML",
    });
    await expect(m.sendText("1", "hi")).rejects.toThrow(/未启动/);
  });
});
