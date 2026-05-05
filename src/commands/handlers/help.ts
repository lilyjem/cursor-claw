import type { CommandContext } from "../dispatch.js";

const HELP_TEXT = `<b>cursor-claw</b>
<code>/start</code> 或 <code>/help</code>  本帮助
<code>/ws list</code>  列出工作区
<code>/ws use &lt;name&gt;</code>  切换工作区
<code>/ws add &lt;name&gt; &lt;abs-path&gt;</code>  注册工作区
<code>/ws remove &lt;name&gt;</code>  注销工作区
<code>/ws path</code>  当前路径
<code>/reset</code>  重置当前工作区会话
<code>/cancel</code>  取消当前 run
<code>/status</code>  当前 agent / 工作区 / 模型
<code>/model &lt;id&gt;</code>  切换默认模型
普通文本 → 作为 prompt
以 <code>!</code> 开头的文本 → 强制打断当前 run`;

export async function handleHelp(ctx: CommandContext): Promise<void> {
  await ctx.messenger.sendText(ctx.chatId, HELP_TEXT, { parseMode: "HTML" });
}
