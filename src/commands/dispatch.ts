import type { IMessenger } from "../core/messenger/IMessenger.js";
import type { WorkspaceRegistry } from "../core/workspace/WorkspaceRegistry.js";
import type { SessionStore } from "../core/session/SessionStore.js";
import type { AgentOrchestrator } from "../core/orchestrator/AgentOrchestrator.js";
import type { ReminderScheduler } from "../core/reminders/ReminderScheduler.js";
import type { ParsedCommand } from "./parser.js";
import { handleHelp } from "./handlers/help.js";
import { handleWs } from "./handlers/ws.js";
import { handleReset } from "./handlers/reset.js";
import { handleCancel } from "./handlers/cancel.js";
import { handleStatus } from "./handlers/status.js";
import { handleModel } from "./handlers/model.js";
import { handleRemind } from "./handlers/remind.js";

// 派发器持有的所有能力句柄；handlers 不直接 new 这些对象，便于测试注入
export interface CommandContext {
  chatId: string;
  // M2：/remind 需要知道 userId（写到 reminder.createdBy）；M1 既有命令不消费它
  userId?: number;
  messenger: IMessenger;
  registry: WorkspaceRegistry;
  session: SessionStore;
  orchestrator: AgentOrchestrator;
  // M2：reminder 相关依赖；不注入则 /remind 命令回错误提示
  scheduler?: ReminderScheduler;
  reminderConfig?: { tz: string; maxAheadDays: number };
}

export async function dispatchCommand(
  cmd: ParsedCommand,
  ctx: CommandContext,
): Promise<void> {
  switch (cmd.name) {
    case "start":
    case "help":
      return handleHelp(ctx);
    case "ws":
      return handleWs(cmd.args, ctx);
    case "reset":
      return handleReset(ctx);
    case "cancel":
      return handleCancel(ctx);
    case "status":
      return handleStatus(ctx);
    case "model":
      return handleModel(cmd.args, ctx);
    case "remind":
      if (!ctx.scheduler || !ctx.reminderConfig) {
        await ctx.messenger.sendText(
          ctx.chatId,
          "/remind 暂未启用（reminder scheduler 未注入）",
        );
        return;
      }
      return handleRemind(cmd.args, cmd.rest, {
        chatId: ctx.chatId,
        userId: ctx.userId ?? 0,
        messenger: ctx.messenger,
        scheduler: ctx.scheduler,
        registry: ctx.registry,
        now: () => Date.now(),
        tz: ctx.reminderConfig.tz,
        maxAheadDays: ctx.reminderConfig.maxAheadDays,
      });
    default:
      await ctx.messenger.sendText(
        ctx.chatId,
        `未知命令：/${cmd.name}。/help 查看可用命令。`,
      );
  }
}
