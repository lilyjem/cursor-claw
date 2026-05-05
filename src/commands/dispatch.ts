import type { IMessenger } from "../core/messenger/IMessenger.js";
import type { WorkspaceRegistry } from "../core/workspace/WorkspaceRegistry.js";
import type { SessionStore } from "../core/session/SessionStore.js";
import type { AgentOrchestrator } from "../core/orchestrator/AgentOrchestrator.js";
import type { ParsedCommand } from "./parser.js";
import { handleHelp } from "./handlers/help.js";
import { handleWs } from "./handlers/ws.js";
import { handleReset } from "./handlers/reset.js";
import { handleCancel } from "./handlers/cancel.js";
import { handleStatus } from "./handlers/status.js";
import { handleModel } from "./handlers/model.js";

// 派发器持有的所有能力句柄；handlers 不直接 new 这些对象，便于测试注入
export interface CommandContext {
  chatId: string;
  messenger: IMessenger;
  registry: WorkspaceRegistry;
  session: SessionStore;
  orchestrator: AgentOrchestrator;
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
    default:
      await ctx.messenger.sendText(
        ctx.chatId,
        `未知命令：/${cmd.name}。/help 查看可用命令。`,
      );
  }
}
