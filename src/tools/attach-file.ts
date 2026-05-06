import { runAttach } from "./attachShared.js";

// claw-attach-file：与 attach-image 共用 runAttach，唯一区别是 kind=file
// （Telegram 端会用 sendDocument 而非 sendPhoto 投递）
runAttach("file", process.argv.slice(2)).catch((e) => {
  process.stderr.write(`claw-attach-file: ${(e as Error).message}\n`);
  process.exit(1);
});
