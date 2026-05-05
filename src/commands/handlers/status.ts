import type { CommandContext } from "../dispatch.js";

// HTML 模式下的简单转义（status 显示路径里可能含 & < > 等）
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function handleStatus(ctx: CommandContext): Promise<void> {
  const w = ctx.registry.getActive();
  if (!w) {
    await ctx.messenger.sendText(ctx.chatId, "（没有活跃工作区）");
    return;
  }
  const s = ctx.session.get(w.name);
  const lines = [
    `<b>工作区</b>: ${escapeHtml(w.name)}`,
    `<b>路径</b>: <code>${escapeHtml(w.path)}</code>`,
    `<b>agentId</b>: <code>${escapeHtml(s?.agentId ?? "(尚未创建)")}</code>`,
    `<b>模型</b>: <code>${escapeHtml(s?.model ?? "(默认)")}</code>`,
  ];
  await ctx.messenger.sendText(ctx.chatId, lines.join("\n"), {
    parseMode: "HTML",
  });
}
