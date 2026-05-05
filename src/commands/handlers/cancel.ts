import type { CommandContext } from "../dispatch.js";

export async function handleCancel(ctx: CommandContext): Promise<void> {
  const w = ctx.registry.getActive();
  if (!w) {
    await ctx.messenger.sendText(ctx.chatId, "（没有活跃工作区）");
    return;
  }
  await ctx.orchestrator.cancel(w.name);
  await ctx.messenger.sendText(ctx.chatId, "已请求取消当前 run。");
}
