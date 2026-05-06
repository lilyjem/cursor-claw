import { logger } from "../../logger.js";
import type { IMessenger } from "../messenger/IMessenger.js";
import type { WorkspaceRegistry } from "../workspace/WorkspaceRegistry.js";
import type { SessionStore } from "../session/SessionStore.js";
import { StreamRenderer, type StreamRendererOptions } from "./streamRenderer.js";
import { summarizeTool } from "./toolSummary.js";
import { decideBusyAction, type RunStatus } from "./busyPolicy.js";
import type { IAgentRuntime, RuntimeAgent, RuntimeRun } from "./runtime.js";
import type { AttachmentDispatcher } from "../attachments/AttachmentDispatcher.js";
import type { RateLimiter } from "../rateLimit/RateLimiter.js";
import { RateLimitedError } from "../rateLimit/errors.js";
import { rateLimitedAgentCreateText } from "../../util/rateLimitMessages.js";
import { wrapUserPrompt } from "./promptEnvelope.js";

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
  // M2: 注入后会在每次 runInternal 末尾发当前 cwd 的 attach 队列；不注入则跳过。
  // 设为可选是为了让单测可以独立验证 orchestrator 行为，不受 dispatcher 影响。
  attachmentDispatcher?: AttachmentDispatcher;
  // F-10：把 cfg.cursor.sandboxOptions 沿管线一路传到 runtime.create / runtime.resume。
  // schema 已声明此字段，但之前 orchestrator 与 cursorSdkRuntime 都没接，
  // 等同于"配置承诺没兑现"。修复后必须 create + resume 都透传。
  sandboxOptions?: { enabled: boolean };
  // F-06：cached miss 进入 Agent.create / resume 前做单用户限速；不注入则跳过（便于单测）
  rateLimiter?: RateLimiter;
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
    userId: number;
  }): Promise<void> {
    await this.runInternal(input);
  }

  // M2：与 runPrompt 同路径，但给 SDK.send 多带一个 images 字段
  async runPromptWithImages(input: {
    chatId: string;
    text: string;
    force: boolean;
    images: Array<{ data: string; mimeType: string }>;
    userId: number;
  }): Promise<void> {
    await this.runInternal(input);
  }

  /**
   * M2：触发一条 reminder。
   * - kind='text' → 直接 sendText；不会 busy
   * - kind='prompt' → 走 runInternal；force 永远 false；返回 busy 信号给 scheduler
   *
   * scheduler 拿到 busy=true 后会重排到 +60s（最多一次），第二次仍 busy 则退化为
   * sendText 通知。这里只关心 delivered/busy 二态，重排策略全在 scheduler 侧。
   *
   * 注：kind='prompt' 时 workspaceId 字段当前不切换 active workspace，仅作为
   * 上下文记录；真正的 cross-workspace reminder 留到 M3+。
   */
  async runReminder(input: {
    chatId: string;
    kind: "text" | "prompt";
    text?: string;
    prompt?: string;
    workspaceId?: string;
    userId: number;
  }): Promise<{ delivered: boolean; busy?: boolean }> {
    if (input.kind === "text") {
      const text = input.text ?? "";
      await this.deps.messenger.sendText(input.chatId, `⏰ ${text}`);
      return { delivered: true };
    }
    // prompt 路径：force 永远 false；用 skipBusyMsg 抑制默认的"agent 在忙"用户提示，
    // 让 scheduler 自己决定通知方式（重排 vs 退化）
    const ok = await this.runInternal({
      chatId: input.chatId,
      text: input.prompt ?? "",
      force: false,
      skipBusyMsg: true,
      userId: input.userId,
    });
    return { delivered: ok, busy: !ok };
  }

  // 共享路径：text-only / images / reminder 三种入口的实际工作流。
  // 抽成私有方法是为了：
  // 1. 不重复 ensureAgent / busyPolicy / streamRenderer 的样板代码
  // 2. 让 images 透传只是 send 的额外字段，单点变更
  // 返回值：true=接受执行（已正常 send / 正在 stream），false=被拒（无 ws / busy reject）
  private async runInternal(input: {
    chatId: string;
    text: string;
    force: boolean;
    images?: Array<{ data: string; mimeType: string }>;
    // M2：reminder 走 prompt 路径时让调用方自行处理 busy 通知
    skipBusyMsg?: boolean;
    userId: number;
  }): Promise<boolean> {
    const ws = this.deps.registry.getActive();
    if (!ws) {
      await this.deps.messenger.sendText(
        input.chatId,
        "没有活跃的工作区，请先 /ws add 一个。",
      );
      return false;
    }
    const wsId = ws.name;

    let entry: PoolEntry;
    try {
      entry = await this.ensureAgent(wsId, ws.path, input.userId);
    } catch (e) {
      if (e instanceof RateLimitedError) {
        logger.warn(
          { userId: input.userId, key: e.key, retryMs: e.retryAfterMs },
          "rate limited",
        );
        await this.deps.messenger.sendText(
          input.chatId,
          rateLimitedAgentCreateText(e.retryAfterMs),
          { parseMode: "plain" },
        );
        return false;
      }
      throw e;
    }
    const action = decideBusyAction({
      activeRunStatus: entry.activeRun?.status as RunStatus | undefined,
      force: input.force,
    });

    if (action === "reject") {
      if (!input.skipBusyMsg) {
        await this.deps.messenger.sendText(
          input.chatId,
          `Agent 正在工作区 <b>${ws.name}</b> 上工作中；请 /cancel 后重试，或在消息前加 ! 强制打断。`,
          { parseMode: "HTML" },
        );
      }
      return false;
    }

    const renderer = new StreamRenderer(
      this.deps.messenger,
      input.chatId,
      this.deps.streamOptions,
    );
    await renderer.start("⏳ thinking...");

    let run: RuntimeRun;
    try {
      run = await entry.agent.send(wrapUserPrompt(input.text), {
        force: action === "force-replace",
        images: input.images,
      });
    } catch (e) {
      const msg = (e as Error).message;
      logger.error({ err: msg }, "agent.send failed");
      // 错误文本可能含 < > 等会破坏 Telegram HTML，先 escape 再发；并裁掉过长内容
      await renderer.finalize(`\n⚠️ Error: ${escapeHtml(msg.slice(0, 400))}`);
      // 视为已"接受过"（agent 是被调到了，只是失败），返回 true 让 scheduler 不重排
      return true;
    }
    entry.activeRun = run;

    try {
      for await (const event of run.stream()) {
        switch (event.type) {
          case "assistant":
            // M2 polish：StreamRenderer 内部存 raw markdown + compose 时整体转换；
            // 避免 SDK 把 ** / ` / [ ] 等成对标记切到不同 chunk 后 regex 匹配失败原文残留。
            await renderer.pushText(event.text);
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

    // M2: run 结束（无论 finished / cancelled / error）都尝试把队列里属于
    // 当前 workspace 的附件发给同一 chatId。attach CLI 是 agent 在 run 期间调的，
    // 所以这里清场最稳妥。dispatcher 自己处理失败/重试/丢弃。
    if (this.deps.attachmentDispatcher) {
      try {
        await this.deps.attachmentDispatcher.flushForCwd(ws.path, input.chatId);
      } catch (e) {
        logger.error(
          { err: (e as Error).message },
          "dispatcher.flushForCwd 失败",
        );
      }
    }

    return true;
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
  private async ensureAgent(
    workspaceId: string,
    cwd: string,
    userId: number,
  ): Promise<PoolEntry> {
    const cached = this.pool.get(workspaceId);
    if (cached) return cached;

    // F-06：只在 cached miss 时消耗 agentCreate token，复用已有 agent 不计入限速。
    if (this.deps.rateLimiter) {
      const r = this.deps.rateLimiter.check(userId, "agentCreate");
      if (!r.allowed) {
        throw new RateLimitedError("agentCreate", r.retryAfterMs);
      }
    }

    const sess = this.deps.session.get(workspaceId);
    let agent: RuntimeAgent;
    if (sess?.agentId) {
      // 关键：@cursor/sdk 1.0.x 的 Agent.resume 不会自己恢复 model，必须由调用方显式传。
      // 行为约定：老 agent 沿用创建时的 model（持久化在 sess.model + sess.modelParams 里），
      // 与 /model 命令"下次新会话生效"的语义一致。fallback 到 defaultModel 只兜底旧 sess（M1 时未持久化 model）。
      const resumedModel = sess.model
        ? { id: sess.model, params: sess.modelParams ?? [] }
        : this.deps.defaultModel;
      agent = await this.deps.runtime.resume(sess.agentId, {
        cwd,
        model: resumedModel,
        sandboxOptions: this.deps.sandboxOptions,
      });
    } else {
      agent = await this.deps.runtime.create({
        cwd,
        model: this.deps.defaultModel,
        sandboxOptions: this.deps.sandboxOptions,
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
