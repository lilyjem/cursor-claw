import { runAttach } from "./attachShared.js";

// claw-attach-image：把指定文件复制到 cursor-claw 数据目录的 pending/，
// 并 append 到 attachments/queue.jsonl，等 run.wait() 之后由 dispatcher 投递。
runAttach("image", process.argv.slice(2)).catch((e) => {
  process.stderr.write(`claw-attach-image: ${(e as Error).message}\n`);
  process.exit(1);
});
