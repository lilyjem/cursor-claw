import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentQueue } from "../../src/core/attachments/AttachmentQueue.js";

describe("AttachmentQueue", () => {
  let dir: string;
  let queuePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aq-"));
    queuePath = join(dir, "queue.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("readAll：文件不存在视为空", async () => {
    const q = new AttachmentQueue(queuePath);
    expect(await q.readAll()).toEqual([]);
  });

  it("append + readAll：返回顺序", async () => {
    const q = new AttachmentQueue(queuePath);
    await q.append({
      cwd: "/a",
      kind: "image",
      path: "/p1",
      queuedAt: 1,
    });
    await q.append({
      cwd: "/b",
      kind: "file",
      path: "/p2",
      caption: "x",
      queuedAt: 2,
    });
    const items = await q.readAll();
    expect(items).toEqual([
      { cwd: "/a", kind: "image", path: "/p1", queuedAt: 1 },
      { cwd: "/b", kind: "file", path: "/p2", caption: "x", queuedAt: 2 },
    ]);
  });

  it("filterByCwd：只返该 cwd 的条目", async () => {
    const q = new AttachmentQueue(queuePath);
    await q.append({ cwd: "/a", kind: "image", path: "/1", queuedAt: 1 });
    await q.append({ cwd: "/b", kind: "image", path: "/2", queuedAt: 2 });
    await q.append({ cwd: "/a", kind: "file", path: "/3", queuedAt: 3 });
    expect(await q.filterByCwd("/a")).toEqual([
      { cwd: "/a", kind: "image", path: "/1", queuedAt: 1 },
      { cwd: "/a", kind: "file", path: "/3", queuedAt: 3 },
    ]);
  });

  it("rewrite：保留指定条目，atomic 替换", async () => {
    const q = new AttachmentQueue(queuePath);
    await q.append({ cwd: "/a", kind: "image", path: "/1", queuedAt: 1 });
    await q.append({ cwd: "/a", kind: "image", path: "/2", queuedAt: 2 });
    await q.rewrite([{ cwd: "/a", kind: "image", path: "/2", queuedAt: 2 }]);
    expect(await q.readAll()).toEqual([
      { cwd: "/a", kind: "image", path: "/2", queuedAt: 2 },
    ]);
  });

  it("空行 / 损坏行被跳过且不抛错", async () => {
    await writeFile(
      queuePath,
      [
        '{"cwd":"/a","kind":"image","path":"/p1","queuedAt":1}',
        "",
        "not-json",
        '{"cwd":"/a","kind":"file","path":"/p2","queuedAt":2}',
      ].join("\n"),
    );
    const q = new AttachmentQueue(queuePath);
    const items = await q.readAll();
    expect(items.length).toBe(2);
    expect(items[0]!.path).toBe("/p1");
    expect(items[1]!.path).toBe("/p2");
  });
});
