// 把 @cursor/sdk 的能力抽象成中立的运行时接口，方便：
// 1) 用 StubRuntime 在单测中跑 orchestrator 端到端流程；
// 2) 后续切换到云端 / 自托管 SDK 时只换实现，不改 orchestrator。

export interface IAgentRuntime {
  create(opts: CreateAgentOptions): Promise<RuntimeAgent>;
  resume(agentId: string, opts: ResumeAgentOptions): Promise<RuntimeAgent>;
}

export interface CreateAgentOptions {
  agentId?: string;
  cwd: string;
  model?: { id: string; params?: Array<{ id: string; value: string }> };
  settingSources?: ("project" | "user" | "team" | "mdm" | "plugins" | "all")[];
  mcpServers?: Record<string, unknown>;
  // F-10：透传到 SDK 的 local.sandboxOptions。enabled=true 启用 Cursor SDK 自带沙箱，
  // 沙箱具体规则由 ~/.cursor/sandbox.json 或 <workspace>/.cursor/sandbox.json 配置。
  sandboxOptions?: { enabled: boolean };
}

export interface ResumeAgentOptions {
  cwd: string;
  model?: { id: string; params?: Array<{ id: string; value: string }> };
  settingSources?: ("project" | "user" | "team" | "mdm" | "plugins" | "all")[];
  // F-10：与 CreateAgentOptions.sandboxOptions 对应；resume 路径同样必须传，
  // 否则历史 session 重连后会重新跑成无沙箱状态，等于完全绕过加固。
  sandboxOptions?: { enabled: boolean };
}

export interface RuntimeAgent {
  agentId: string;
  // M2：可选 images 直接透传给 SDK 的 send（用于"图片+文字"类多模态 prompt）
  send(
    text: string,
    opts?: {
      force?: boolean;
      images?: Array<{ data: string; mimeType: string }>;
    },
  ): Promise<RuntimeRun>;
  dispose(): Promise<void>;
}

export interface RuntimeRun {
  status: "running" | "finished" | "error" | "cancelled";
  stream(): AsyncGenerator<RuntimeStreamEvent, void>;
  wait(): Promise<{
    status: "finished" | "error" | "cancelled";
    result?: string;
    durationMs?: number;
  }>;
  cancel(): Promise<void>;
}

// 中立的流事件：去掉 SDK 内部那些不稳定的字段，只保留 orchestrator 真正用到的
export type RuntimeStreamEvent =
  | { type: "assistant"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call";
      status: "running" | "completed" | "error";
      name: string;
      args?: unknown;
    };
