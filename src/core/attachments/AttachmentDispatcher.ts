import { readFile, unlink } from "node:fs/promises";
import type { IMessenger } from "../messenger/IMessenger.js";
import { logger } from "../../logger.js";
import type { AttachmentQueue, AttachmentEntry } from "./AttachmentQueue.js";

export interface AttachmentDispatcherOptions {
  queue: AttachmentQueue;
  messenger: IMessenger;
  // 单条 entry 投递失败 attempt 数允许的上限：attempt > maxRetries 时丢弃 + 告诉用户
  maxRetries: number;
  // 单次 flushForCwd 最多处理的条目数（仅作 sanity 警告，不强制截断）
  maxPerFlush: number;
}

/**
 * 在 run.wait() 之后调 flushForCwd，把 attach CLI 入队的文件发回给用户。
 *
 * 重试模型：
 * - 内存里维护 entry.path → attemptCount，进程重启重置
 *   （轻量、避免污染队列结构；进程重启后即重新计数）
 * - 失败一次 attempt++，仍保留在 queue（下次 flush 仍尝试）
 * - attempt > maxRetries（即第 maxRetries+1 次）→ sendText 告知用户后从 queue 丢弃
 *
 * 文件清理：
 * - 投递成功 / 主动放弃：unlink pending 文件 + 队列剔除
 * - pending 文件已不存在：当作放弃处理（agent 自己删 / 上次成功后没清干净）
 */
export class AttachmentDispatcher {
  private readonly attempts = new Map<string, number>();

  constructor(private readonly opts: AttachmentDispatcherOptions) {}

  // 把当前 cwd 名下的所有 entry 顺次发出去，更新 queue
  async flushForCwd(cwd: string, chatId: string): Promise<void> {
    const all = await this.opts.queue.readAll();
    const own = all.filter((e) => e.cwd === cwd);
    if (own.length === 0) return;

    if (own.length > this.opts.maxPerFlush) {
      // 仅 warn 不截断：让 agent / 用户感知，但不要丢条目
      logger.warn(
        { cwd, n: own.length, cap: this.opts.maxPerFlush },
        "queue 中条目超过 maxPerFlush",
      );
    }

    const sortedOwn = [...own].sort((a, b) => a.queuedAt - b.queuedAt);
    const survivors: AttachmentEntry[] = []; // 本 cwd 留下的
    const others = all.filter((e) => e.cwd !== cwd); // 其他 cwd 原样保留

    for (const e of sortedOwn) {
      const result = await this.tryDeliver(e, chatId);
      if (result === "delivered" || result === "drop") {
        // 成功或放弃：删 pending 文件 + 不保留 entry
        try {
          await unlink(e.path);
        } catch {
          // 已不存在视作清理过
        }
        this.attempts.delete(e.path);
      } else {
        // retry：留给下次 flush
        survivors.push(e);
      }
    }

    await this.opts.queue.rewrite([...others, ...survivors]);
  }

  // 单条投递：返回 'delivered' / 'retry' / 'drop'
  private async tryDeliver(
    e: AttachmentEntry,
    chatId: string,
  ): Promise<"delivered" | "retry" | "drop"> {
    // pending 文件不存在 → drop（agent 自己删了 / 上次成功后没清干净）
    let buf: Buffer;
    try {
      buf = await readFile(e.path);
    } catch {
      logger.warn({ path: e.path }, "pending 文件已不存在，丢弃 entry");
      return "drop";
    }

    try {
      if (e.kind === "image") {
        await this.opts.messenger.sendImage(
          chatId,
          { data: buf, mimeType: "image/jpeg", filename: pickName(e.path) },
          e.caption,
        );
      } else {
        await this.opts.messenger.sendDocument(
          chatId,
          { data: buf, filename: pickName(e.path) },
          e.caption,
        );
      }
      return "delivered";
    } catch (err) {
      const attempt = (this.attempts.get(e.path) ?? 0) + 1;
      this.attempts.set(e.path, attempt);
      logger.error(
        { err: (err as Error).message, attempt, path: e.path },
        "附件投递失败",
      );
      if (attempt > this.opts.maxRetries) {
        // 超出上限：告知用户后丢弃，避免一直占着 queue
        try {
          await this.opts.messenger.sendText(
            chatId,
            `⚠️ 附件投递失败 ${attempt} 次：${pickName(e.path)}（已丢弃）`,
          );
        } catch {
          /* sendText 也失败：不再升级，下次 flush 时 entry 已被 drop */
        }
        return "drop";
      }
      return "retry";
    }
  }
}

// 用 path 末尾 segment 作为 filename，但去掉前面的 isoTs 时间戳前缀。
// pending 文件名格式：`${isoTs}-${basename}`。简单实现：找到第一个 '-' 后跟非数字的位置。
function pickName(p: string): string {
  const last = p.split("/").pop() ?? p;
  const dash = last.search(/-\D/);
  if (dash > 0) return last.slice(dash + 1);
  return last;
}
