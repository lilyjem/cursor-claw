import type {
  IAgentRuntime,
  RuntimeAgent,
  RuntimeRun,
  RuntimeStreamEvent,
  CreateAgentOptions,
  ResumeAgentOptions,
} from "../../src/core/orchestrator/runtime.js";

/**
 * 把 IAgentRuntime / RuntimeAgent / RuntimeRun 都桩化，使集成测试不依赖网络/真实 SDK。
 * 测试可以在拿到 StubRun 后调用 setScript() 注入"将要发出的事件序列"。
 */
export class StubAgentRuntime implements IAgentRuntime {
  public agents: StubAgent[] = [];
  // M2：记录 create 与 resume 的完整入参，便于断言 model 透传
  public created: CreateAgentOptions[] = [];
  public resumed: Array<{ agentId: string; opts: ResumeAgentOptions }> = [];

  async create(opts: CreateAgentOptions): Promise<RuntimeAgent> {
    const a = new StubAgent(opts.agentId ?? `agent-stub-${this.agents.length + 1}`);
    this.agents.push(a);
    this.created.push(opts);
    return a;
  }

  async resume(agentId: string, opts: ResumeAgentOptions): Promise<RuntimeAgent> {
    this.resumed.push({ agentId, opts });
    const a = new StubAgent(agentId);
    this.agents.push(a);
    return a;
  }
}

export class StubAgent implements RuntimeAgent {
  public sentTexts: string[] = [];
  // M2：记录最近一次 send 的入参，供测试断言（force / images 透传）
  public lastSend?: {
    text: string;
    force?: boolean;
    images?: Array<{ data: string; mimeType: string }>;
  };
  public currentRun?: StubRun;
  constructor(public agentId: string) {}

  async send(
    text: string,
    opts?: {
      force?: boolean;
      images?: Array<{ data: string; mimeType: string }>;
    },
  ): Promise<RuntimeRun> {
    this.sentTexts.push(text);
    this.lastSend = { text, force: opts?.force, images: opts?.images };
    const run = new StubRun(text, opts?.force ?? false);
    this.currentRun = run;
    return run;
  }
  async dispose(): Promise<void> {}
}

export class StubRun implements RuntimeRun {
  status: "running" | "finished" | "error" | "cancelled" = "running";
  public scripted: RuntimeStreamEvent[] = [];
  private scriptReady = false;
  constructor(
    public text: string,
    public force: boolean,
  ) {}

  // 测试通过 setScript 注入"将要发出"的事件序列；
  // 这一步可能在 stream() 已经被消费方调用之后才发生，
  // 所以 stream() 会先轮询等待 scriptReady。
  setScript(events: RuntimeStreamEvent[]): void {
    this.scripted = events;
    this.scriptReady = true;
  }

  async *stream(): AsyncGenerator<RuntimeStreamEvent, void> {
    // 等"测试代码注入了 script" 或 "已经被 cancel"，最多等 ~1s 防止挂死
    let waited = 0;
    while (!this.scriptReady && this.status === "running" && waited < 200) {
      await new Promise((r) => setTimeout(r, 5));
      waited++;
    }
    for (const e of this.scripted) {
      if (this.status === "cancelled") break;
      yield e;
      // 模拟真实流式间隔：给 StreamRenderer 的 throttle timer 留触发窗口
      await new Promise((r) => setTimeout(r, 12));
    }
    this.status = this.status === "cancelled" ? "cancelled" : "finished";
  }

  async wait(): Promise<{
    status: "finished" | "error" | "cancelled";
    result?: string;
  }> {
    return { status: this.status === "running" ? "finished" : this.status };
  }

  async cancel(): Promise<void> {
    this.status = "cancelled";
  }
}
