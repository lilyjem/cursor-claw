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
      pendingRoot: pendingDir,
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
      pendingRoot: pendingDir,
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
      pendingRoot: pendingDir,
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
      pendingRoot: pendingDir,
    });
    await d.flushForCwd("/w", "chat-1");
    expect(messenger.sentImages.length).toBe(0);
    expect((await queue.readAll()).length).toBe(0);
  });

  // F-14：路径越界保护（绝对路径越界）
  // 攻击模型：攻击者通过 prompt injection / 文件系统污染往 queue.jsonl 注入一条
  //   { path: "/etc/passwd", kind: "image", cwd: <受害者 cwd> }
  // 期望：dispatcher 必须把这条 entry 当成污染数据 → 不读、不删 evil 文件、
  //      也不发送任何消息给用户；同时把 entry 从队列剔除避免反复尝试。
  it("拒绝绝对路径越界 entry：不读、不删 evil 文件、不发送、从队列剔除", async () => {
    // 在 pendingDir 之外构造一个"敏感"文件，模拟攻击目标（/etc/passwd 类）
    const outsideDir = await mkdtemp(join(tmpdir(), "ad-outside-"));
    const evilFile = join(outsideDir, "victim.txt");
    await writeFile(evilFile, Buffer.from("important-content"));

    // 同时放一条合法 entry，验证越界拒绝不影响正常流
    const goodFile = await preparePending("good.png", Buffer.from([1, 2, 3]));

    await queue.append({
      cwd: "/w",
      kind: "image",
      path: evilFile,
      caption: "owned",
      queuedAt: 1,
    });
    await queue.append({
      cwd: "/w",
      kind: "image",
      path: goodFile,
      caption: "ok",
      queuedAt: 2,
    });

    const d = new AttachmentDispatcher({
      queue,
      messenger,
      maxRetries: 3,
      maxPerFlush: 10,
      pendingRoot: pendingDir,
    });
    await d.flushForCwd("/w", "chat-1");

    // 越界文件必须仍然存在（未被 unlink）
    await expect(stat(evilFile)).resolves.toBeDefined();
    // 越界文件内容必须没有被发出去：messenger 只看到合法那条
    expect(messenger.sentImages.length).toBe(1);
    expect(messenger.sentImages[0]!.caption).toBe("ok");
    // 没有给用户发任何 sendText（即不暴露被拒绝这件事，也不让攻击者通过失败次数刷消息）
    expect(messenger.sentTexts.length).toBe(0);
    // 队列里两条 entry 都应被清掉（合法那条投递成功 → drop，越界那条 → reject）
    expect((await queue.readAll()).length).toBe(0);

    // 清理 outsideDir
    await rm(outsideDir, { recursive: true, force: true });
  });

  // F-14：路径越界保护（pendingRoot 同级兄弟目录）
  // 这是 startsWith() 检查不带 sep 时的经典误判：
  //   pendingRoot = "/tmp/X/pending"
  //   entry.path  = "/tmp/X/pending_evil/file" → "/tmp/X/pending_evil/file".startsWith("/tmp/X/pending") === true
  // 正确做法是用 "pendingRoot + sep" 比较 / 用 path.relative 判断。
  it("拒绝 pendingRoot 同级兄弟目录中的 path（避免 startsWith 误判）", async () => {
    const sibling = `${pendingDir}_evil`;
    await mkdir(sibling, { recursive: true });
    const evilFile = join(sibling, "x.png");
    await writeFile(evilFile, Buffer.from([1, 2, 3]));

    await queue.append({
      cwd: "/w",
      kind: "image",
      path: evilFile,
      queuedAt: 1,
    });
    const d = new AttachmentDispatcher({
      queue,
      messenger,
      maxRetries: 3,
      maxPerFlush: 10,
      pendingRoot: pendingDir,
    });
    await d.flushForCwd("/w", "chat-1");

    await expect(stat(evilFile)).resolves.toBeDefined();
    expect(messenger.sentImages.length).toBe(0);
    expect((await queue.readAll()).length).toBe(0);

    await rm(sibling, { recursive: true, force: true });
  });
});
