import { describe, expect, it, vi } from "vitest";
import { handleWs } from "../../src/commands/handlers/ws.js";
import { handleRemind } from "../../src/commands/handlers/remind.js";
import { StubMessenger } from "../helpers/StubMessenger.js";
import { ReminderQuota } from "../../src/core/reminders/ReminderQuota.js";

describe("command HTML escaping", () => {
  it("/ws list escapes workspace name/path", async () => {
    const messenger = new StubMessenger();
    const registry = {
      list: () => [{ name: "<b>x</b>", path: "/tmp/a&b" }],
      getActive: () => ({ name: "<b>x</b>", path: "/tmp/a&b" }),
    };

    await handleWs(["list"], {
      chatId: "C",
      messenger,
      registry,
    } as never);

    const text = messenger.sentTexts[0]?.text ?? "";
    expect(text).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(text).toContain("/tmp/a&amp;b");
  });

  it("/remind list escapes reminder text and prompt", async () => {
    const messenger = new StubMessenger();
    const scheduler = {
      list: () => [
        {
          id: "r-1",
          createdAt: 0,
          createdBy: 1,
          chatId: "C",
          kind: "text",
          at: 0,
          tz: "UTC",
          text: "<script>alert(1)</script>",
        },
        {
          id: "r-2",
          createdAt: 0,
          createdBy: 1,
          chatId: "C",
          kind: "prompt",
          at: 1,
          tz: "UTC",
          workspaceId: "<ws>",
          prompt: "show a & b",
        },
      ],
      add: vi.fn(),
      remove: vi.fn(),
    };

    await handleRemind(["list"], "list", {
      chatId: "C",
      userId: 1,
      messenger,
      scheduler: scheduler as never,
      reminderQuota: new ReminderQuota(scheduler as never, { maxPerUser: 100 }),
      registry: { getActive: () => undefined } as never,
      now: () => 0,
      tz: "UTC",
      maxAheadDays: 30,
    });

    const text = messenger.sentTexts[0]?.text ?? "";
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(text).toContain("prompt[&lt;ws&gt;]: show a &amp; b");
  });
});
