import type { CommandContext } from "../dispatch.js";

// /model <id> 切换 default model；只更新 sessionStore，
// 不会立刻把已存在的 agent 重建（如要立刻生效让用户 /reset）
export async function handleModel(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const id = args[0];
  if (!id) {
    await ctx.messenger.sendText(
      ctx.chatId,
      "用法：/model <id>，如 /model auto",
    );
    return;
  }
  const w = ctx.registry.getActive();
  if (!w) {
    await ctx.messenger.sendText(ctx.chatId, "（没有活跃工作区）");
    return;
  }
  const s = ctx.session.get(w.name) ?? {};
  await ctx.session.set(w.name, { ...s, model: id });
  await ctx.messenger.sendText(
    ctx.chatId,
    `下次新会话将使用模型 <code>${id}</code>。已存在的 agent 会沿用之前的模型；如需立刻生效，请 /reset。`,
    { parseMode: "HTML" },
  );
}
