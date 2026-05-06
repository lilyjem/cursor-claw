import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubMessenger } from "../helpers/StubMessenger.js";
import { StubAgentRuntime } from "../helpers/StubAgent.js";
import { AgentOrchestrator } from "../../src/core/orchestrator/AgentOrchestrator.js";
import { WorkspaceRegistry } from "../../src/core/workspace/WorkspaceRegistry.js";
import { SessionStore } from "../../src/core/session/SessionStore.js";

let dir: string;
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeOrchestrator(extra?: {
  sandboxOptions?: { enabled: boolean };
}) {
  dir = await mkdtemp(join(tmpdir(), "orch-"));
  const registry = new WorkspaceRegistry(join(dir, "workspaces.json"));
  await registry.init({ autoRegisterCwd: true, cwd: dir });
  const session = new SessionStore(join(dir, "sessions.json"));
  await session.init();
  const messenger = new StubMessenger();
  const runtime = new StubAgentRuntime();
  const orch = new AgentOrchestrator({
    messenger,
    runtime,
    registry,
    session,
    streamOptions: { throttleMs: 10, maxLen: 1000 },
    defaultModel: { id: "auto", params: [] },
    sandboxOptions: extra?.sandboxOptions,
  });
  return { orch, messenger, runtime, registry, session };
}

describe("AgentOrchestrator", () => {
  it("text → 创建 agent → 流式渲染 assistant 文本到 messenger", async () => {
    const { orch, messenger, runtime } = await makeOrchestrator();
    const run = orch.runPrompt({ chatId: "c1", text: "hello", force: false, userId: 0 });
    expect(runtime.created.length).toBe(1);
    const agent = runtime.agents[0]!;
    // 等 send 被调用一次，再注入剧本
    await waitFor(() => agent.currentRun);
    const stub = agent.currentRun!;
    stub.setScript([
      { type: "assistant", text: "Hi! " },
      { type: "assistant", text: "There." },
    ]);
    await run;
    const finalEdit = [...messenger.calls]
      .reverse()
      .find((c) => c.kind === "editText");
    const txt = finalEdit && finalEdit.kind === "editText" ? finalEdit.text : "";
    expect(txt).toContain("Hi! There.");
  });

  it("第二次 send 复用同一个 agentId", async () => {
    const { orch, runtime, session } = await makeOrchestrator();
    await orch.runPrompt({ chatId: "c1", text: "one", force: false, userId: 0 });
    await orch.runPrompt({ chatId: "c1", text: "two", force: false, userId: 0 });
    expect(runtime.created.length).toBe(1);
    expect(session.get("default")?.agentId).toBe(runtime.agents[0]!.agentId);
  });

  // 回归测试：进程重启后 sess.agentId 还在，ensureAgent 走 resume 路径。
  // 真实 SDK（@cursor/sdk 1.0.x）的 Agent.resume 不会自己恢复 model，必须由调用方显式传入；
  // 否则 send 时报 "Local SDK agents require an explicit `model`."
  // 修复：orchestrator 在 resume 时把 sess 持久化的 model + modelParams 还原成 model 对象传进 runtime.resume。
  it("已有 sess.agentId（模拟重启）→ resume 必须把 sess 持久化的 model 透传给 runtime", async () => {
    const { orch, runtime, session } = await makeOrchestrator();
    // 模拟"重启前已有 session 持久化"：直接写 sess
    await session.set("default", {
      agentId: "agent-existing-x",
      model: "gpt-5.3-codex",
      modelParams: [
        { id: "reasoning", value: "extra-high" },
        { id: "fast", value: "false" },
      ],
    });

    const p = orch.runPrompt({ chatId: "c1", text: "hi", force: false, userId: 0 });
    const agent = await waitFor(() => runtime.agents[0]);
    const stub = await waitFor(() => agent.currentRun);
    stub.setScript([{ type: "assistant", text: "ok" }]);
    await p;

    // 走的是 resume 而不是 create
    expect(runtime.created.length).toBe(0);
    expect(runtime.resumed.length).toBe(1);
    const resumed = runtime.resumed[0]!;
    expect(resumed.agentId).toBe("agent-existing-x");
    // ★ 修复目标：resume.opts.model 必须由 sess 持久化字段还原而来
    expect(resumed.opts.model?.id).toBe("gpt-5.3-codex");
    expect(resumed.opts.model?.params).toEqual([
      { id: "reasoning", value: "extra-high" },
      { id: "fast", value: "false" },
    ]);
  });

  it("活跃 run 时再发文本（非 force）→ 拒绝并提示", async () => {
    const { orch, messenger, runtime } = await makeOrchestrator();
    const p1 = orch.runPrompt({ chatId: "c1", text: "long task", force: false, userId: 0 });
    const agent0 = await waitFor(() => runtime.agents[0]);
    const stub = await waitFor(() => agent0.currentRun);
    stub.setScript([{ type: "assistant", text: "..." }]);
    const p2 = orch.runPrompt({ chatId: "c1", text: "second", force: false, userId: 0 });
    await Promise.all([p1, p2]);
    const sends = messenger.calls.filter((c) => c.kind === "sendText");
    expect(
      sends.some((c) => c.kind === "sendText" && c.text.includes("正在工作")),
    ).toBe(true);
  });

  it("cancel 把 status 置 cancelled 并在主消息追加 (已取消)", async () => {
    const { orch, messenger, runtime } = await makeOrchestrator();
    const p = orch.runPrompt({ chatId: "c1", text: "long", force: false, userId: 0 });
    const agent0 = await waitFor(() => runtime.agents[0]);
    const stub = await waitFor(() => agent0.currentRun);
    stub.setScript([{ type: "assistant", text: "before" }]);
    await orch.cancel("default");
    await p;
    const lastEdit = [...messenger.calls]
      .reverse()
      .find((c) => c.kind === "editText");
    const txt = lastEdit && lastEdit.kind === "editText" ? lastEdit.text : "";
    expect(txt).toMatch(/已取消/);
  });

  // F-10：Cursor SDK 沙箱 / tool 限制
  // 当前 schema 已声明 cursor.sandboxOptions 字段，但 orchestrator → runtime 这条管线
  // 之前没把它透传到 SDK Agent.create / Agent.resume —— 等同于"配置承诺没兑现"。
  // 修复后 deps.sandboxOptions 必须沿 runtime.create / runtime.resume 一路传到 SDK。
  it("F-10: deps.sandboxOptions 透传到 runtime.create", async () => {
    const { orch, runtime } = await makeOrchestrator({
      sandboxOptions: { enabled: true },
    });
    const p = orch.runPrompt({ chatId: "c1", text: "hi", force: false, userId: 0 });
    const agent0 = await waitFor(() => runtime.agents[0]);
    const stub = await waitFor(() => agent0.currentRun);
    stub.setScript([{ type: "assistant", text: "ok" }]);
    await p;

    expect(runtime.created.length).toBe(1);
    expect(runtime.created[0]?.sandboxOptions).toEqual({ enabled: true });
  });

  it("F-10: deps.sandboxOptions 也透传到 runtime.resume", async () => {
    const { orch, runtime, session } = await makeOrchestrator({
      sandboxOptions: { enabled: true },
    });
    // 模拟"重启前已有 session 持久化" → 走 resume 路径
    await session.set("default", {
      agentId: "agent-existing-y",
      model: "gpt-5.3-codex",
      modelParams: [],
    });
    const p = orch.runPrompt({ chatId: "c1", text: "hi", force: false, userId: 0 });
    const agent0 = await waitFor(() => runtime.agents[0]);
    const stub = await waitFor(() => agent0.currentRun);
    stub.setScript([{ type: "assistant", text: "ok" }]);
    await p;

    expect(runtime.created.length).toBe(0);
    expect(runtime.resumed.length).toBe(1);
    expect(runtime.resumed[0]?.opts.sandboxOptions).toEqual({ enabled: true });
  });

  it("F-10: 未传 sandboxOptions 时 runtime.create 收到的 sandboxOptions 为 undefined（向后兼容）", async () => {
    // 不传 sandboxOptions → orchestrator 不应自己造默认值，由配置层负责默认。
    // 这条契约让 schema 默认变更（如 enabled: true）能集中在一个位置审计。
    const { orch, runtime } = await makeOrchestrator(); // 无 sandboxOptions
    const p = orch.runPrompt({ chatId: "c1", text: "hi", force: false, userId: 0 });
    const agent0 = await waitFor(() => runtime.agents[0]);
    const stub = await waitFor(() => agent0.currentRun);
    stub.setScript([{ type: "assistant", text: "ok" }]);
    await p;

    expect(runtime.created[0]?.sandboxOptions).toBeUndefined();
  });

  it("tool_call 在状态行可视化", async () => {
    const { orch, messenger, runtime } = await makeOrchestrator();
    const p = orch.runPrompt({ chatId: "c1", text: "task", force: false, userId: 0 });
    const agent0 = await waitFor(() => runtime.agents[0]);
    const stub = await waitFor(() => agent0.currentRun);
    stub.setScript([
      { type: "tool_call", status: "running", name: "shell", args: { command: "ls" } },
      { type: "assistant", text: "ok" },
      { type: "tool_call", status: "completed", name: "shell" },
    ]);
    await p;
    const allTexts = messenger.calls
      .filter((c) => c.kind === "editText")
      .map((c) => (c.kind === "editText" ? c.text : ""))
      .join("\n");
    expect(allTexts).toContain("shell: ls");
  });
});

// 在异步竞争场景下等候副作用就绪
async function waitFor<T>(fn: () => T | undefined, retries = 200): Promise<T> {
  for (let i = 0; i < retries; i++) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timeout");
}
