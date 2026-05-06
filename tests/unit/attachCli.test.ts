import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const exec = promisify(execFile);

// 直接用 npx tsx 跑源文件，避免每个 unit test 都需要先 build
const TSX = "npx";
const ARGS = (entry: string, ...rest: string[]): string[] => [
  "tsx",
  resolve("src/tools", entry),
  ...rest,
];

// 每个 spawn 用例都允许较长超时（首次跑 tsx 冷启动可能慢）
const SLOW = 30000;

describe("attach CLI（spawn）", () => {
  let dir: string;
  let dataDir: string;
  let workDir: string;
  let imgPath: string;

  beforeEach(async () => {
    // macOS 的 /var/folders 实际是 /private/var/folders 的 symlink，
    // 子进程 process.cwd() 会解析成 realpath。这里同样 realpath 以便比较一致。
    dir = await realpath(await mkdtemp(join(tmpdir(), "att-")));
    dataDir = join(dir, "data");
    workDir = join(dir, "work");
    await mkdir(dataDir);
    await mkdir(workDir);
    imgPath = join(workDir, "x.png");
    await writeFile(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function runWithEnv(
    entry: string,
    ...rest: string[]
  ): Promise<{ stdout: string; stderr: string }> {
    return exec(TSX, ARGS(entry, ...rest), {
      cwd: workDir,
      env: { ...process.env, CLAW_DATA_DIR: dataDir },
    });
  }

  it(
    "attach-image 写入 pending + queue 一行",
    { timeout: SLOW },
    async () => {
      await runWithEnv("attach-image.ts", imgPath, "--caption", "hi");
      const queueRaw = await readFile(
        join(dataDir, "attachments", "queue.jsonl"),
        "utf8",
      );
      const lines = queueRaw.trim().split("\n");
      expect(lines.length).toBe(1);
      const entry = JSON.parse(lines[0]!);
      expect(entry.kind).toBe("image");
      expect(entry.cwd).toBe(workDir);
      expect(entry.caption).toBe("hi");
      // pending 文件存在
      await stat(entry.path);
      // F-13: pending 拷贝出来的文件 mode 必须是 0o600
      // queue.jsonl 必须是 0o600；pending 目录必须是 0o700
      if (process.platform !== "win32") {
        const pendingFileSt = await stat(entry.path);
        expect(pendingFileSt.mode & 0o777).toBe(0o600);
        const queueSt = await stat(join(dataDir, "attachments", "queue.jsonl"));
        expect(queueSt.mode & 0o777).toBe(0o600);
        const pendingDirSt = await stat(join(dataDir, "attachments", "pending"));
        expect(pendingDirSt.mode & 0o777).toBe(0o700);
      }
    },
  );

  it(
    "attach-file 接受任意扩展",
    { timeout: SLOW },
    async () => {
      const pdf = join(workDir, "y.pdf");
      await writeFile(pdf, "%PDF-1.4");
      await runWithEnv("attach-file.ts", pdf);
      const queueRaw = await readFile(
        join(dataDir, "attachments", "queue.jsonl"),
        "utf8",
      );
      const entry = JSON.parse(queueRaw.trim());
      expect(entry.kind).toBe("file");
    },
  );

  it("源文件不存在 → exit 1", { timeout: SLOW }, async () => {
    await expect(
      runWithEnv("attach-image.ts", "/nonexistent.png"),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("没 CLAW_DATA_DIR 也没 .claw → exit 1", { timeout: SLOW }, async () => {
    await expect(
      exec(TSX, ARGS("attach-image.ts", imgPath), { cwd: workDir }),
    ).rejects.toMatchObject({ code: 1 });
  });
});
