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

async function makeOrchestrator() {
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
  });
  return { orch, messenger, runtime, registry, session };
}

describe("AgentOrchestrator", () => {
  it("text → 创建 agent → 流式渲染 assistant 文本到 messenger", async () => {
    const { orch, messenger, runtime } = await makeOrchestrator();
    const run = orch.runPrompt({ chatId: "c1", text: "hello", force: false });
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
    await orch.runPrompt({ chatId: "c1", text: "one", force: false });
    await orch.runPrompt({ chatId: "c1", text: "two", force: false });
    expect(runtime.created.length).toBe(1);
    expect(session.get("default")?.agentId).toBe(runtime.agents[0]!.agentId);
  });

  it("活跃 run 时再发文本（非 force）→ 拒绝并提示", async () => {
    const { orch, messenger, runtime } = await makeOrchestrator();
    const p1 = orch.runPrompt({ chatId: "c1", text: "long task", force: false });
    const agent0 = await waitFor(() => runtime.agents[0]);
    const stub = await waitFor(() => agent0.currentRun);
    stub.setScript([{ type: "assistant", text: "..." }]);
    const p2 = orch.runPrompt({ chatId: "c1", text: "second", force: false });
    await Promise.all([p1, p2]);
    const sends = messenger.calls.filter((c) => c.kind === "sendText");
    expect(
      sends.some((c) => c.kind === "sendText" && c.text.includes("正在工作")),
    ).toBe(true);
  });

  it("cancel 把 status 置 cancelled 并在主消息追加 (已取消)", async () => {
    const { orch, messenger, runtime } = await makeOrchestrator();
    const p = orch.runPrompt({ chatId: "c1", text: "long", force: false });
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

  it("tool_call 在状态行可视化", async () => {
    const { orch, messenger, runtime } = await makeOrchestrator();
    const p = orch.runPrompt({ chatId: "c1", text: "task", force: false });
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
