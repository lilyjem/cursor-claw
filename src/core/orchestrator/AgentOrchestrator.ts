import { logger } from "../../logger.js";
import type { IMessenger } from "../messenger/IMessenger.js";
import type { WorkspaceRegistry } from "../workspace/WorkspaceRegistry.js";
import type { SessionStore } from "../session/SessionStore.js";
import { StreamRenderer, type StreamRendererOptions } from "./streamRenderer.js";
import { summarizeTool } from "./toolSummary.js";
import { decideBusyAction, type RunStatus } from "./busyPolicy.js";
import { markdownToHtml } from "../render/markdownToHtml.js";
import type { IAgentRuntime, RuntimeAgent, RuntimeRun } from "./runtime.js";

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
      });
    } catch (e) {
      logger.error({ err: (e as Error).message }, "agent.send failed");
      await renderer.finalize(`\n⚠️ Error: ${(e as Error).message}`);
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
        await renderer.finalize(`\n⚠️ Error`);
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
