import { logger } from "../../logger.js";
import type { IMessenger } from "../messenger/IMessenger.js";
import type { WorkspaceRegistry } from "../workspace/WorkspaceRegistry.js";
import type { SessionStore } from "../session/SessionStore.js";
import { StreamRenderer, type StreamRendererOptions } from "./streamRenderer.js";
import { summarizeTool } from "./toolSummary.js";
import { decideBusyAction, type RunStatus } from "./busyPolicy.js";
import { markdownToHtml } from "../render/markdownToHtml.js";
import type { IAgentRuntime, RuntimeAgent, RuntimeRun } from "./runtime.js";

// HTML 转义：错误文本里可能含 < > & 之类，直接拼到 HTML parse_mode 会破坏标签
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface OrchestratorDeps {
  messenger: IMessenger;
  runtime: IAgentRuntime;
  registry: WorkspaceRegistry;
  session: SessionStore;
  streamOptions: StreamRendererOptions;
  defaultModel: { id: string; params: Array<{ id: string; value: string }> };
}

interface PoolEntry {
  agent: RuntimeAgent;
  activeRun?: RuntimeRun;
}

/**
 * cursor-claw 的"心脏"：把消息平台 + SDK runtime 编排起来。
 *
 * 关键责任：
 * - 按 workspace name 维护 SDKAgent 池（每个 workspace 一个独立 agent）
 * - 接收 prompt 文本，按忙状态策略决定 run / reject / force-replace
 * - 把 SDK 的流式事件渲染成 IMessenger 上的主消息更新
 * - 提供 cancel / reset / dispose 给上层命令使用
 */
export class AgentOrchestrator {
  private readonly pool = new Map<string, PoolEntry>();

  constructor(private readonly deps: OrchestratorDeps) {}

  async runPrompt(input: {
    chatId: string;
    text: string;
    force: boolean;
  }): Promise<void> {
    await this.runInternal(input);
  }

  // M2：与 runPrompt 同路径，但给 SDK.send 多带一个 images 字段
  async runPromptWithImages(input: {
    chatId: string;
    text: string;
    force: boolean;
    images: Array<{ data: string; mimeType: string }>;
  }): Promise<void> {
    await this.runInternal(input);
  }

  // 共享路径：text-only / images 两种入口的实际工作流。
  // 抽成私有方法是为了：
  // 1. 不重复 ensureAgent / busyPolicy / streamRenderer 的样板代码
  // 2. 让 images 透传只是 send 的额外字段，单点变更
  private async runInternal(input: {
    chatId: string;
    text: string;
    force: boolean;
    images?: Array<{ data: string; mimeType: string }>;
  }): Promise<void> {
    const ws = this.deps.registry.getActive();
    if (!ws) {
      await this.deps.messenger.sendText(
        input.chatId,
        "没有活跃的工作区，请先 /ws add 一个。",
      );
      return;
    }
    const wsId = ws.name;

    const entry = await this.ensureAgent(wsId, ws.path);
    const action = decideBusyAction({
      activeRunStatus: entry.activeRun?.status as RunStatus | undefined,
      force: input.force,
    });

    if (action === "reject") {
      await this.deps.messenger.sendText(
        input.chatId,
        `Agent 正在工作区 <b>${ws.name}</b> 上工作中；请 /cancel 后重试，或在消息前加 ! 强制打断。`,
        { parseMode: "HTML" },
      );
      return;
    }

    const renderer = new StreamRenderer(
      this.deps.messenger,
      input.chatId,
      this.deps.streamOptions,
    );
    await renderer.start("⏳ thinking...");

    let run: RuntimeRun;
    try {
      run = await entry.agent.send(input.text, {
        force: action === "force-replace",
        images: input.images,
      });
    } catch (e) {
      const msg = (e as Error).message;
      logger.error({ err: msg }, "agent.send failed");
      // 错误文本可能含 < > 等会破坏 Telegram HTML，先 escape 再发；并裁掉过长内容
      await renderer.finalize(`\n⚠️ Error: ${escapeHtml(msg.slice(0, 400))}`);
      return;
    }
    entry.activeRun = run;

    try {
      for await (const event of run.stream()) {
        switch (event.type) {
          case "assistant":
            await renderer.pushText(markdownToHtml(event.text));
            break;
          case "thinking":
            renderer.setStatus("🤔 thinking...");
            break;
          case "tool_call":
            if (event.status === "running") {
              renderer.setStatus(`🔧 ${summarizeTool(event.name, event.args)}`);
            } else if (event.status === "completed") {
              renderer.setStatus("🤔 thinking...");
            } else {
              renderer.setStatus(`⚠️ ${event.name} failed`);
            }
            break;
        }
      }
      const r = await run.wait();
      if (r.status === "cancelled") {
        await renderer.finalize("\n<i>(已取消)</i>");
      } else if (r.status === "error") {
        // SDK 把错误描述放在 result 字段，server 端打全文 + Telegram 端展示前 N 字以便排错
        logger.error(
          { err: r.result, durationMs: r.durationMs },
          "run finished with error",
        );
        const tail = r.result
          ? `\n⚠️ Error: ${escapeHtml(r.result.slice(0, 400))}`
          : "\n⚠️ Error";
        await renderer.finalize(tail);
      } else {
        await renderer.finalize();
      }
    } finally {
      if (entry.activeRun === run) entry.activeRun = undefined;
    }
  }

  async cancel(workspaceId: string): Promise<void> {
    const entry = this.pool.get(workspaceId);
    if (entry?.activeRun) await entry.activeRun.cancel();
  }

  // /reset 命令：丢弃当前 agent 实例 + 清空 sessionStore 中的 agentId
  async resetWorkspace(workspaceId: string): Promise<void> {
    const entry = this.pool.get(workspaceId);
    if (entry) {
      await entry.agent.dispose();
      this.pool.delete(workspaceId);
    }
    await this.deps.session.clear(workspaceId);
  }

  // 进程退出时调用：取消所有 active run，释放所有 SDKAgent
  async dispose(): Promise<void> {
    for (const e of this.pool.values()) {
      try {
        await e.activeRun?.cancel();
      } catch {
        /* ignore */
      }
      try {
        await e.agent.dispose();
      } catch {
        /* ignore */
      }
    }
    this.pool.clear();
  }

  // 懒加载 agent：先看 SessionStore 有没有 agentId 用 resume；没有则 create
  private async ensureAgent(workspaceId: string, cwd: string): Promise<PoolEntry> {
    const cached = this.pool.get(workspaceId);
    if (cached) return cached;

    const sess = this.deps.session.get(workspaceId);
    let agent: RuntimeAgent;
    if (sess?.agentId) {
      agent = await this.deps.runtime.resume(sess.agentId, { cwd });
    } else {
      agent = await this.deps.runtime.create({
        cwd,
        model: this.deps.defaultModel,
      });
      await this.deps.session.set(workspaceId, {
        agentId: agent.agentId,
        model: this.deps.defaultModel.id,
        modelParams: this.deps.defaultModel.params,
      });
    }
    const entry: PoolEntry = { agent };
    this.pool.set(workspaceId, entry);
    return entry;
  }
}
