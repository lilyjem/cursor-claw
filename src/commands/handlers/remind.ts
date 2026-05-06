import type { IMessenger } from "../../core/messenger/IMessenger.js";
import type { WorkspaceRegistry } from "../../core/workspace/WorkspaceRegistry.js";
import type { ReminderScheduler } from "../../core/reminders/ReminderScheduler.js";
import {
  newReminderId,
  type Reminder,
} from "../../core/reminders/ReminderStore.js";
import { parseTimeExpr } from "../../core/reminders/timeParser.js";

export interface RemindContext {
  chatId: string;
  userId: number;
  messenger: IMessenger;
  scheduler: ReminderScheduler;
  registry: WorkspaceRegistry;
  now: () => number;
  tz: string;
  maxAheadDays: number;
}

const USAGE = `用法：
/remind add text   <时间> <内容>
/remind add prompt <时间> <prompt>
/remind list
/remind del <id>

时间格式：相对 (10m, 1h30m) | 当日 HH:MM | YYYY-MM-DDTHH:MM`;

/**
 * /remind 子命令派发：
 * - add：解析 kind / 时间表达式 / body，调 scheduler.add
 * - list：取 scheduler.list() 排序输出
 * - del：scheduler.remove(id)
 *
 * 注意：时间表达式只能是单个 token（不能含空格），所以 `2026-05-06 09:00` 形式
 * 走不通；用 `2026-05-06T09:00` 替代（用 T 分隔）。
 */
export async function handleRemind(
  args: string[],
  rest: string,
  ctx: RemindContext,
): Promise<void> {
  const sub = args[0];
  if (sub === "add") return handleAdd(args.slice(1), rest, ctx);
  if (sub === "list") return handleList(ctx);
  if (sub === "del") return handleDel(args.slice(1), ctx);
  await ctx.messenger.sendText(ctx.chatId, USAGE);
}

async function handleAdd(
  rest: string[],
  fullRest: string,
  ctx: RemindContext,
): Promise<void> {
  const kind = rest[0];
  if (kind !== "text" && kind !== "prompt") {
    await ctx.messenger.sendText(ctx.chatId, USAGE);
    return;
  }
  const expr = rest[1];
  if (!expr) {
    await ctx.messenger.sendText(ctx.chatId, USAGE);
    return;
  }
  // body 文本：去掉前两个 token（text|prompt + 时间表达式），其余原样保留空格
  const body = stripLeading(fullRest, kind, expr);
  if (!body) {
    await ctx.messenger.sendText(ctx.chatId, "内容不能为空。\n" + USAGE);
    return;
  }

  const parsed = parseTimeExpr(expr, {
    now: ctx.now(),
    tz: ctx.tz,
    maxAheadDays: ctx.maxAheadDays,
  });
  if (parsed.error || !parsed.at) {
    await ctx.messenger.sendText(
      ctx.chatId,
      `⚠️ 时间格式 ${parsed.error ?? "不识别"}：${expr}`,
    );
    return;
  }

  const id = newReminderId(parsed.at, ctx.now());
  let item: Reminder;
  if (kind === "text") {
    item = {
      id,
      createdAt: ctx.now(),
      createdBy: ctx.userId,
      chatId: ctx.chatId,
      kind: "text",
      at: parsed.at,
      tz: ctx.tz,
      text: body,
    };
  } else {
    const ws = ctx.registry.getActive();
    if (!ws) {
      await ctx.messenger.sendText(
        ctx.chatId,
        "没有活跃 workspace，先 /ws use 一个再 /remind add prompt。",
      );
      return;
    }
    item = {
      id,
      createdAt: ctx.now(),
      createdBy: ctx.userId,
      chatId: ctx.chatId,
      kind: "prompt",
      at: parsed.at,
      tz: ctx.tz,
      prompt: body,
      workspaceId: ws.name,
    };
  }
  await ctx.scheduler.add(item);
  await ctx.messenger.sendText(
    ctx.chatId,
    `✅ ${id}：将于 ${new Date(parsed.at).toISOString()} 触发`,
  );
}

async function handleList(ctx: RemindContext): Promise<void> {
  const items = ctx.scheduler.list();
  if (items.length === 0) {
    await ctx.messenger.sendText(ctx.chatId, "无 reminder。");
    return;
  }
  const lines = items
    .sort((a, b) => a.at - b.at)
    .map((r) => {
      const when = new Date(r.at).toISOString();
      const summary =
        r.kind === "text"
          ? `text: ${r.text}`
          : `prompt[${r.workspaceId}]: ${r.prompt}`;
      return `${r.id}  ${when}\n  ${summary}`;
    });
  await ctx.messenger.sendText(ctx.chatId, lines.join("\n\n"));
}

async function handleDel(rest: string[], ctx: RemindContext): Promise<void> {
  const id = rest[0];
  if (!id) {
    await ctx.messenger.sendText(ctx.chatId, "用法：/remind del <id>");
    return;
  }
  await ctx.scheduler.remove(id);
  await ctx.messenger.sendText(ctx.chatId, `已删除 ${id}（若存在）。`);
}

// 把 fullRest 里前导的 kind / expr 两个 token 剥掉，保留之后原始空格
function stripLeading(rest: string, kind: string, expr: string): string {
  let s = rest.trimStart();
  if (s.startsWith(kind)) s = s.slice(kind.length).trimStart();
  if (s.startsWith(expr)) s = s.slice(expr.length).trimStart();
  return s;
}
