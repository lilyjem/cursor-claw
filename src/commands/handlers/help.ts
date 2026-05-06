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

📅 <b>Reminders</b>
<code>/remind add text &lt;时间&gt; &lt;内容&gt;</code>  一次性纯文本提醒
<code>/remind add prompt &lt;时间&gt; &lt;prompt&gt;</code>  到点跑 agent
<code>/remind list</code>
<code>/remind del &lt;id&gt;</code>
时间格式：相对 (10m, 1h30m) | 当日 HH:MM | YYYY-MM-DDTHH:MM

📎 <b>Agent 端附件</b>（在 Cursor agent 的 shell tool 内）
<code>claw-attach-image /path/to/x.png [--caption "..."]</code>
<code>claw-attach-file  /path/to/x.pdf [--caption "..."]</code>
本次 run 结束时自动发回 Telegram

🖼 <b>给 bot 发图</b> / 多图 album → 自动转给 agent 分析

普通文本 → 作为 prompt
以 <code>!</code> 开头的文本 → 强制打断当前 run`;

export async function handleHelp(ctx: CommandContext): Promise<void> {
  await ctx.messenger.sendText(ctx.chatId, HELP_TEXT, { parseMode: "HTML" });
}
