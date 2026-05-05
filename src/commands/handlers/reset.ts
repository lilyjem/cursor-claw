import type { CommandContext } from "../dispatch.js";

export async function handleReset(ctx: CommandContext): Promise<void> {
  const w = ctx.registry.getActive();
  if (!w) {
    await ctx.messenger.sendText(ctx.chatId, "（没有活跃工作区）");
    return;
  }
  await ctx.orchestrator.resetWorkspace(w.name);
  await ctx.messenger.sendText(ctx.chatId, `已重置工作区会话：${w.name}`);
}
