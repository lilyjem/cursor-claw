import { Agent } from "@cursor/sdk";
import type { SDKAgent, Run } from "@cursor/sdk";
import type {
  IAgentRuntime,
  RuntimeAgent,
  RuntimeRun,
  RuntimeStreamEvent,
  CreateAgentOptions,
  ResumeAgentOptions,
} from "./runtime.js";
import { logger } from "../../logger.js";

/**
 * 把 IAgentRuntime 桥到真实 @cursor/sdk。
 *
 * 关键差异处理：
 * - SDK 的 Run.stream 返回 SDKMessage union（system/user/assistant/tool_call/thinking/status/...），
 *   我们只把 orchestrator 关心的 assistant text + thinking + tool_call 转出去。
 * - SDK 的 force 参数是 SendOptions.local.force，不是顶级 force。
 * - LocalAgent 的 model 必填，fallback 用 SDK 内置的 "default"（注意：不是 "auto"，
 *   "auto" 会被 SDK 的 ConfigurationError 拒绝）。
 */
export class CursorSdkRuntime implements IAgentRuntime {
  constructor(private readonly apiKey: string) {}

  async create(opts: CreateAgentOptions): Promise<RuntimeAgent> {
    const model = opts.model
      ? { id: opts.model.id, params: opts.model.params }
      : { id: "default" };
    logger.info({ cwd: opts.cwd, model }, "Agent.create");
    const sdk = await Agent.create({
      apiKey: this.apiKey,
      agentId: opts.agentId,
      model,
      local: {
        cwd: opts.cwd,
        settingSources: opts.settingSources ?? ["project", "user"],
      },
      mcpServers: opts.mcpServers as
        | Parameters<typeof Agent.create>[0]["mcpServers"]
        | undefined,
    });
    return new SdkAgentWrapper(sdk);
  }

  async resume(agentId: string, opts: ResumeAgentOptions): Promise<RuntimeAgent> {
    const sdk = await Agent.resume(agentId, {
      apiKey: this.apiKey,
      model: opts.model
        ? { id: opts.model.id, params: opts.model.params }
        : undefined,
      local: {
        cwd: opts.cwd,
        settingSources: opts.settingSources ?? ["project", "user"],
      },
    });
    return new SdkAgentWrapper(sdk);
  }
}

class SdkAgentWrapper implements RuntimeAgent {
  agentId: string;
  constructor(private readonly inner: SDKAgent) {
    this.agentId = inner.agentId;
  }

  async send(text: string, opts?: { force?: boolean }): Promise<RuntimeRun> {
    const run = await this.inner.send(
      text,
      opts?.force ? { local: { force: true } } : undefined,
    );
    return new SdkRunWrapper(run);
  }

  async dispose(): Promise<void> {
    await this.inner[Symbol.asyncDispose]();
  }
}

class SdkRunWrapper implements RuntimeRun {
  status: "running" | "finished" | "error" | "cancelled" = "running";

  constructor(private readonly inner: Run) {
    this.status = inner.status;
    // 持续同步 SDK 的 status 到 wrapper：cancel/finish 后 orchestrator 才能正确判断
    inner.onDidChangeStatus((s) => {
      this.status = s;
    });
  }

  async *stream(): AsyncGenerator<RuntimeStreamEvent, void> {
    for await (const e of this.inner.stream()) {
      switch (e.type) {
        case "assistant": {
          for (const block of e.message.content) {
            if (block.type === "text") {
              yield { type: "assistant", text: block.text };
            }
          }
          break;
        }
        case "thinking":
          yield { type: "thinking", text: e.text };
          break;
        case "tool_call":
          yield {
            type: "tool_call",
            status: e.status,
            name: e.name,
            args: e.args,
          };
          break;
        case "status":
          // SDK 报错的真正描述往往在这里：status=ERROR + message="...."
          logger.info(
            { status: e.status, message: e.message },
            "sdk status event",
          );
          break;
        case "system":
          logger.debug({ subtype: e.subtype, model: e.model }, "sdk system");
          break;
        case "task":
          logger.debug({ status: e.status, text: e.text }, "sdk task");
          break;
        default:
          break;
      }
    }
  }

  async wait(): Promise<{
    status: "finished" | "error" | "cancelled";
    result?: string;
    durationMs?: number;
  }> {
    const r = await this.inner.wait();
    return {
      status: r.status,
      result: r.result,
      durationMs: r.durationMs,
    };
  }

  async cancel(): Promise<void> {
    await this.inner.cancel();
  }
}
