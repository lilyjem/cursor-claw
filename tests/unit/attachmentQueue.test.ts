import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
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

  // F-13：AttachmentQueue 写入的 jsonl 文件应限制为 0600
  // queue.jsonl 含 chatId / cwd / 文件路径，默认 0644 在多用户主机上会泄露。
  it.skipIf(process.platform === "win32")(
    "F-13: append 后文件 mode 必须是 0o600",
    async () => {
      const q = new AttachmentQueue(queuePath);
      await q.append({ cwd: "/a", kind: "image", path: "/p1", queuedAt: 1 });
      const st = await stat(queuePath);
      expect(st.mode & 0o777).toBe(0o600);
    },
  );

  // F-13：rewrite 通过 tmp + rename，rename 后文件 mode 也应是 0o600
  it.skipIf(process.platform === "win32")(
    "F-13: rewrite 后文件 mode 必须是 0o600",
    async () => {
      const q = new AttachmentQueue(queuePath);
      await q.append({ cwd: "/a", kind: "image", path: "/p1", queuedAt: 1 });
      await q.rewrite([
        { cwd: "/a", kind: "image", path: "/q", queuedAt: 1 },
      ]);
      const st = await stat(queuePath);
      expect(st.mode & 0o777).toBe(0o600);
    },
  );

  // F-13：AttachmentQueue 创建父目录时应是 0o700
  it.skipIf(process.platform === "win32")(
    "F-13: 父目录被 mkdir 时 mode 必须是 0o700",
    async () => {
      const sub = join(dir, "nested");
      const q = new AttachmentQueue(join(sub, "queue.jsonl"));
      await q.append({ cwd: "/a", kind: "image", path: "/p1", queuedAt: 1 });
      const st = await stat(sub);
      expect(st.mode & 0o777).toBe(0o700);
    },
  );

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
