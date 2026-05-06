import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceRegistry } from "../../src/core/workspace/WorkspaceRegistry.js";
import { ReminderStore } from "../../src/core/reminders/ReminderStore.js";
import { AttachmentQueue } from "../../src/core/attachments/AttachmentQueue.js";

describe("F-12 persisted schema validation", () => {
  it("WorkspaceRegistry 拒绝非法 persisted shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schema-ws-"));
    try {
      const p = join(dir, "ws.json");
      await writeFile(p, JSON.stringify({ active: 123, items: [] }), "utf8");
      const registry = new WorkspaceRegistry(p);
      await expect(
        registry.init({ autoRegisterCwd: false, cwd: dir }),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ReminderStore 拒绝非法 reminder item", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schema-rem-"));
    try {
      const p = join(dir, "reminders.json");
      await writeFile(p, JSON.stringify({ items: [{ kind: "text" }] }), "utf8");
      const store = new ReminderStore(p);
      await expect(store.init()).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("AttachmentQueue 跳过 JSON object shape 不合法的行", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schema-queue-"));
    try {
      const p = join(dir, "queue.jsonl");
      await writeFile(
        p,
        JSON.stringify({ cwd: "/w", kind: "image", path: "/x", queuedAt: 1 }) +
          "\n" +
          JSON.stringify({ cwd: "/w", kind: "evil", path: 123 }) +
          "\n",
        "utf8",
      );
      const q = new AttachmentQueue(p);
      const items = await q.readAll();
      expect(items).toHaveLength(1);
      expect(items[0]?.kind).toBe("image");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
