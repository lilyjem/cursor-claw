// CLI 公共逻辑：解析 argv → 复制文件到 pending → append 到 queue.jsonl。
// 故意不依赖 logger / config / zod，保持冷启动快（agent 端被频繁短任务调用）。
import { mkdir, copyFile, stat, readFile, appendFile } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";

export type AttachKind = "image" | "file";

interface ParsedArgs {
  filePath: string;
  caption?: string;
  dataDirOverride?: string;
}

// 极简 argv 解析：第一个非 flag 参数视为文件路径，flag 仅支持 --caption / --data-dir
function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new Error("usage: <file> [--caption <text>] [--data-dir <path>]");
  }
  let filePath: string | undefined;
  let caption: string | undefined;
  let dataDirOverride: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--caption") {
      caption = argv[++i];
    } else if (a === "--data-dir") {
      dataDirOverride = argv[++i];
    } else if (!filePath) {
      filePath = a;
    } else {
      throw new Error(`unexpected arg: ${a}`);
    }
  }
  if (!filePath) throw new Error("file path required");
  return { filePath: resolve(filePath), caption, dataDirOverride };
}

// 找数据目录的策略（顺序）：
// 1. --data-dir flag
// 2. CLAW_DATA_DIR env
// 3. 从 cwd 向上找 .claw/data-dir.txt（cursor-claw 主进程启动时写入）
async function locateDataDir(override?: string): Promise<string> {
  if (override) return resolve(override);
  if (process.env.CLAW_DATA_DIR) return resolve(process.env.CLAW_DATA_DIR);
  let cur = process.cwd();
  for (let i = 0; i < 32; i++) {
    const marker = join(cur, ".claw", "data-dir.txt");
    try {
      const txt = (await readFile(marker, "utf8")).trim();
      if (txt) return resolve(txt);
    } catch {
      // 继续向上找
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error(
    "could not locate cursor-claw data dir; set CLAW_DATA_DIR or run cursor-claw once in this workspace",
  );
}

export async function runAttach(
  kind: AttachKind,
  argv: string[],
): Promise<void> {
  const { filePath, caption, dataDirOverride } = parseArgs(argv);
  const dataDir = await locateDataDir(dataDirOverride);
  // stat 不存在会抛 ENOENT，由顶层入口 catch 翻成 exit 1
  const st = await stat(filePath);
  if (!st.isFile()) throw new Error(`not a file: ${filePath}`);

  const pendingDir = join(dataDir, "attachments", "pending");
  await mkdir(pendingDir, { recursive: true });
  // 用 ISO 时间戳（冒号、点替换为连字符）+ 原 basename 防重名
  const isoTs = new Date().toISOString().replace(/[:.]/g, "-");
  const destPath = join(pendingDir, `${isoTs}-${basename(filePath)}`);
  await copyFile(filePath, destPath);

  const entry = {
    cwd: process.cwd(),
    kind,
    path: destPath,
    caption,
    queuedAt: Date.now(),
  };
  const queuePath = join(dataDir, "attachments", "queue.jsonl");
  await appendFile(queuePath, JSON.stringify(entry) + "\n", "utf8");

  // 给 agent 一个能 grep 的成功标志
  process.stdout.write(`queued: ${destPath}\n`);
}
