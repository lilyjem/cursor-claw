import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../../logger.js";

/**
 * 简易 JSON 持久化存储：
 * - 读取走内存缓存；写入串行化避免竞态。
 * - 写入采用 tmp + rename 原子替换，避免半写文件。
 * - 启动时若发现遗留的 .tmp 文件则清理（视为上次进程崩溃残留）。
 */
export class JsonStore<T> {
  // 内存缓存，避免每次 read 都打盘
  private cache?: T;
  // 串行化写入：保证多次 write 顺序落盘，不互相覆盖
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly defaults: T,
  ) {}

  async readOrInit(): Promise<T> {
    if (this.cache !== undefined) return this.cache;
    await this.cleanupTmp();
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.cache = JSON.parse(raw) as T;
      return this.cache;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        await this.write(this.defaults);
        return this.defaults;
      }
      throw e;
    }
  }

  async read(): Promise<T> {
    if (this.cache !== undefined) return this.cache;
    return this.readOrInit();
  }

  async write(value: T): Promise<void> {
    this.cache = value;
    this.writing = this.writing.then(() => this.flush(value));
    return this.writing;
  }

  async update(fn: (current: T) => T | Promise<T>): Promise<T> {
    const current = await this.read();
    const next = await fn(current);
    await this.write(next);
    return next;
  }

  // 真正落盘：先写到 .tmp 再 rename，rename 在同一文件系统下是原子的
  private async flush(value: T): Promise<void> {
    // F-13：dataDir 含 session/reminder/userId 等隐私数据，目录限定 0700、文件 0600，
    // 避免多用户主机下被同主机其他账户读取。
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, this.filePath);
  }

  // 启动时清理上次崩溃留下的 .tmp 残留，避免数据被误读
  private async cleanupTmp(): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    try {
      await stat(tmp);
      await unlink(tmp);
      logger.warn({ tmp }, "Removed stale tmp file");
    } catch {
      /* not exist; ignore */
    }
  }
}
