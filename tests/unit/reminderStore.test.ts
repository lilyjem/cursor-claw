import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReminderStore,
  type Reminder,
} from "../../src/core/reminders/ReminderStore.js";

describe("ReminderStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rs-"));
    path = join(dir, "reminders.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sample = (id: string, at: number): Reminder => ({
    id,
    createdAt: 100,
    createdBy: 1,
    chatId: "1",
    kind: "text",
    at,
    tz: "UTC",
    text: "x",
  });

  it("空文件 init → 空数组", async () => {
    const s = new ReminderStore(path);
    await s.init();
    expect(s.list()).toEqual([]);
  });

  it("add + persist 后再 read 回来", async () => {
    const s1 = new ReminderStore(path);
    await s1.init();
    await s1.add(sample("r-1", 1000));
    const s2 = new ReminderStore(path);
    await s2.init();
    expect(s2.list().map((r) => r.id)).toEqual(["r-1"]);
  });

  it("remove 删除指定 id", async () => {
    const s = new ReminderStore(path);
    await s.init();
    await s.add(sample("r-1", 1));
    await s.add(sample("r-2", 2));
    await s.remove("r-1");
    expect(s.list().map((r) => r.id)).toEqual(["r-2"]);
  });

  it("update 修改 at 字段", async () => {
    const s = new ReminderStore(path);
    await s.init();
    await s.add(sample("r-1", 1));
    await s.update("r-1", (r) => ({ ...r, at: 2 }));
    expect(s.list()[0]!.at).toBe(2);
  });
});
