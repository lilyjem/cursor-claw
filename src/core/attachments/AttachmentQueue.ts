import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../../logger.js";

export interface AttachmentEntry {
  cwd: string;
  kind: "image" | "file";
  path: string;
  caption?: string;
  queuedAt: number;
}

/**
 * 队列文件 (jsonl)：
 * - append：CLI 子进程并发追加；用 fs.appendFile，内核 O_APPEND 保证整行不互相截断
 *   （前提：每条 entry < POSIX PIPE_BUF 4096 字节；实际 caption 通常远小于此）
 * - readAll：整文件 readFile + 行分割 + JSON.parse；坏行跳过并 warn
 * - rewrite：tmp + rename atomic 替换全文件，用于 dispatcher flush 后刷新剩余条目
 *
 * 之所以选 jsonl 而非整 JSON，是为了支持多 CLI 进程并发 append 不需要锁。
 */
export class AttachmentQueue {
  constructor(private readonly filePath: string) {}

  // 追加一条条目；目录若不存在自动创建
  async append(entry: AttachmentEntry): Promise<void> {
    // F-13：queue.jsonl 含 chatId / cwd / 用户文件路径，限制为 0700/0600
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await appendFile(this.filePath, JSON.stringify(entry) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  // 读取所有条目；文件不存在返回空数组
  async readAll(): Promise<AttachmentEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: AttachmentEntry[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as AttachmentEntry);
      } catch {
        // 损坏行不阻塞整体；记日志便于排查
        logger.warn({ line: t.slice(0, 200) }, "queue 损坏行已跳过");
      }
    }
    return out;
  }

  // 取某 cwd 名下条目（用于 dispatcher 的 flushForCwd 路径）
  async filterByCwd(cwd: string): Promise<AttachmentEntry[]> {
    const all = await this.readAll();
    return all.filter((e) => e.cwd === cwd);
  }

  // 用一组新 entries 原子地替换整文件（tmp + rename）
  async rewrite(items: AttachmentEntry[]): Promise<void> {
    // F-13：见 append 注释，rewrite 落盘也走 0700/0600
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const content =
      items.length === 0
        ? ""
        : items.map((i) => JSON.stringify(i)).join("\n") + "\n";
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}
