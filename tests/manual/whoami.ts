// 一次性工具：启动 bot 等你私聊的第一条消息，把 from.id (你的 userId) 打印出来。
// 用法: TELEGRAM_BOT_TOKEN=... npx tsx tests/manual/whoami.ts
//
// 操作：
//   1. 跑这个脚本
//   2. 在 Telegram 里和 @<你的 bot> 私聊任意一条消息（比如 "hi"）
//   3. 终端里会打印 "你的 userId: <数字>"，并自动退出
//
// 拿到 userId 后填到 config.json 的 telegram.allowedUserIds: [<数字>] 里。
import { Bot } from "grammy";

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("set TELEGRAM_BOT_TOKEN first");
    process.exit(1);
  }
  const bot = new Bot(token);
  console.log("等你私聊 bot 任意一条消息...");
  let done = false;
  bot.on("message", (ctx) => {
    if (done) return;
    done = true;
    const u = ctx.from;
    const c = ctx.chat;
    console.log("\n———");
    console.log("你的 userId:", u?.id);
    console.log("用户名:", u?.username ?? "(未设)");
    console.log("姓名:", `${u?.first_name ?? ""} ${u?.last_name ?? ""}`.trim());
    console.log("chatId（私聊时与 userId 相同）:", c.id);
    console.log("———");
    console.log(`复制下面这行到 config.json 的 telegram.allowedUserIds：`);
    console.log(`[${u?.id}]`);
    void bot.stop().then(() => process.exit(0));
  });
  await bot.start({ drop_pending_updates: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
