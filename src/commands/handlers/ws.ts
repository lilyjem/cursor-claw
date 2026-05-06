import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { CommandContext } from "../dispatch.js";
import { WorkspaceError } from "../../core/workspace/WorkspaceRegistry.js";

// /ws 命令家族：
//   /ws list                        显示所有工作区，标记当前为活跃
//   /ws use <name>                  切换活跃工作区（影响后续 prompt 的 cwd）
//   /ws add <name> <abs-path>       注册新工作区（路径必须存在 + 是目录）
//   /ws remove <name>               注销（不能注销活跃工作区）
//   /ws path                        当前路径
export async function handleWs(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list": {
      const items = ctx.registry.list();
      const active = ctx.registry.getActive()?.name;
      if (items.length === 0) {
        await ctx.messenger.sendText(ctx.chatId, "（没有工作区）");
        return;
      }
      const body = items
        .map((w) => `${w.name === active ? "▶ " : "  "}${w.name} → ${w.path}`)
        .join("\n");
      await ctx.messenger.sendText(ctx.chatId, body);
      return;
    }
    case "use": {
      const name = args[1];
      if (!name) {
        await ctx.messenger.sendText(ctx.chatId, "用法：/ws use <name>", {
          parseMode: "plain",
        });
        return;
      }
      try {
        ctx.registry.use(name);
        await ctx.registry.persist();
      } catch (e) {
        if (e instanceof WorkspaceError) {
          await ctx.messenger.sendText(ctx.chatId, e.message);
          return;
        }
        throw e;
      }
      await ctx.messenger.sendText(ctx.chatId, `当前工作区：${name}`);
      return;
    }
    case "add": {
      const name = args[1];
      const path = args[2];
      if (!name || !path) {
        await ctx.messenger.sendText(
          ctx.chatId,
          "用法：/ws add <name> <abs-path>",
          { parseMode: "plain" },
        );
        return;
      }
      if (!isAbsolute(path)) {
        await ctx.messenger.sendText(ctx.chatId, "路径必须是绝对路径");
        return;
      }
      try {
        const s = await stat(path);
        if (!s.isDirectory()) {
          await ctx.messenger.sendText(ctx.chatId, "路径不是目录");
          return;
        }
      } catch {
        await ctx.messenger.sendText(ctx.chatId, "路径不存在");
        return;
      }
      try {
        ctx.registry.add(name, path);
        await ctx.registry.persist();
      } catch (e) {
        if (e instanceof WorkspaceError) {
          await ctx.messenger.sendText(ctx.chatId, e.message);
          return;
        }
        throw e;
      }
      await ctx.messenger.sendText(ctx.chatId, `已添加工作区：${name}`);
      return;
    }
    case "remove": {
      const name = args[1];
      if (!name) {
        await ctx.messenger.sendText(ctx.chatId, "用法：/ws remove <name>", {
          parseMode: "plain",
        });
        return;
      }
      try {
        ctx.registry.remove(name);
        await ctx.registry.persist();
      } catch (e) {
        if (e instanceof WorkspaceError) {
          await ctx.messenger.sendText(ctx.chatId, e.message);
          return;
        }
        throw e;
      }
      await ctx.messenger.sendText(ctx.chatId, `已注销工作区：${name}`);
      return;
    }
    case "path": {
      const w = ctx.registry.getActive();
      await ctx.messenger.sendText(
        ctx.chatId,
        w ? w.path : "（没有活跃工作区）",
      );
      return;
    }
    default:
      await ctx.messenger.sendText(
        ctx.chatId,
        "用法：/ws list|use|add|remove|path",
      );
  }
}
