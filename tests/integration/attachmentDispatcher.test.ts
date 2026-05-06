import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentQueue } from "../../src/core/attachments/AttachmentQueue.js";
import { AttachmentDispatcher } from "../../src/core/attachments/AttachmentDispatcher.js";
import { StubMessenger } from "../helpers/StubMessenger.js";

describe("AttachmentDispatcher", () => {
  let dir: string;
  let queuePath: string;
  let pendingDir: string;
  let messenger: StubMessenger;
  let queue: AttachmentQueue;

  async function preparePending(name: string, content: Buffer): Promise<string> {
    const p = join(pendingDir, name);
    await writeFile(p, content);
    return p;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ad-"));
    queuePath = join(dir, "queue.jsonl");
    pendingDir = join(dir, "pending");
    await mkdir(pendingDir);
    messenger = new StubMessenger();
    queue = new AttachmentQueue(queuePath);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("正常 flush：调 sendImage / sendDocument 各一次，删 pending + 删 queue", async () => {
    const p1 = await preparePending("a.png", Buffer.from([1, 2, 3]));
    const p2 = await preparePending("b.pdf", Buffer.from([4, 5]));
    await queue.append({
      cwd: "/w",
      kind: "image",
      path: p1,
      caption: "c1",
      queuedAt: 1,
    });
    await queue.append({ cwd: "/w", kind: "file", path: p2, queuedAt: 2 });
    const d = new AttachmentDispatcher({
      queue,
      messenger,
      maxRetries: 3,
      maxPerFlush: 10,
    });
    await d.flushForCwd("/w", "chat-1");
    expect(messenger.sentImages.length).toBe(1);
    expect(messenger.sentImages[0]!.caption).toBe("c1");
    expect(messenger.sentDocuments.length).toBe(1);
    expect((await queue.readAll()).length).toBe(0);
    await expect(stat(p1)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(p2)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("不同 cwd 不动其他人的", async () => {
    const p1 = await preparePending("a.png", Buffer.from([1]));
    await queue.append({ cwd: "/w1", kind: "image", path: p1, queuedAt: 1 });
    await queue.append({
      cwd: "/w2",
      kind: "image",
      path: "/never",
      queuedAt: 2,
    });
    const d = new AttachmentDispatcher({
      queue,
      messenger,
      maxRetries: 3,
      maxPerFlush: 10,
    });
    await d.flushForCwd("/w1", "chat-1");
    expect(messenger.sentImages.length).toBe(1);
    const remain = await queue.readAll();
    expect(remain.length).toBe(1);
    expect(remain[0]!.cwd).toBe("/w2");
  });

  it("发送失败保留 entry，重试 maxRetries+1 次后告知用户并丢弃", async () => {
    const p1 = await preparePending("a.png", Buffer.from([1]));
    await queue.append({ cwd: "/w", kind: "image", path: p1, queuedAt: 1 });
    messenger.sendImageImpl = async () => {
      throw new Error("boom");
    };
    const d = new AttachmentDispatcher({
      queue,
      messenger,
      maxRetries: 2,
      maxPerFlush: 10,
    });
    // 第 1 次：失败，保留
    await d.flushForCwd("/w", "chat-1");
    expect((await queue.readAll()).length).toBe(1);
    // 第 2 次：失败，保留
    await d.flushForCwd("/w", "chat-1");
    expect((await queue.readAll()).length).toBe(1);
    // 第 3 次：失败，超过 maxRetries=2，告诉用户 + 丢弃
    await d.flushForCwd("/w", "chat-1");
    expect(
      messenger.sentTexts.some((t) => t.text.includes("附件投递失败")),
    ).toBe(true);
    expect((await queue.readAll()).length).toBe(0);
  });

  it("pending 文件已被删 → 跳过 + 删 entry", async () => {
    await queue.append({
      cwd: "/w",
      kind: "image",
      path: "/never",
      queuedAt: 1,
    });
    const d = new AttachmentDispatcher({
      queue,
      messenger,
      maxRetries: 3,
      maxPerFlush: 10,
    });
    await d.flushForCwd("/w", "chat-1");
    expect(messenger.sentImages.length).toBe(0);
    expect((await queue.readAll()).length).toBe(0);
  });
});
