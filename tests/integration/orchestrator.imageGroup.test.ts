import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentOrchestrator } from "../../src/core/orchestrator/AgentOrchestrator.js";
import { WorkspaceRegistry } from "../../src/core/workspace/WorkspaceRegistry.js";
import { SessionStore } from "../../src/core/session/SessionStore.js";
import { StubMessenger } from "../helpers/StubMessenger.js";
import { StubAgentRuntime } from "../helpers/StubAgent.js";

// 与异步竞争的辅助：等异步副作用就绪
async function waitFor<T>(fn: () => T | undefined, retries = 200): Promise<T> {
  for (let i = 0; i < retries; i++) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timeout");
}

describe("AgentOrchestrator.runPromptWithImages", () => {
  let dataDir: string;
  let messenger: StubMessenger;
  let registry: WorkspaceRegistry;
  let session: SessionStore;
  let runtime: StubAgentRuntime;
  let orch: AgentOrchestrator;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ig-orch-"));
    messenger = new StubMessenger();
    registry = new WorkspaceRegistry(join(dataDir, "ws.json"));
    await registry.init({ autoRegisterCwd: true, cwd: dataDir });
    session = new SessionStore(join(dataDir, "sess.json"));
    await session.init();
    runtime = new StubAgentRuntime();
    orch = new AgentOrchestrator({
      messenger,
      runtime,
      registry,
      session,
      streamOptions: { throttleMs: 1, maxLen: 1000 },
      defaultModel: { id: "default", params: [] },
    });
  });

  afterEach(async () => {
    await orch.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("把 images 透传给 agent.send（单图）", async () => {
    // 与 M1 集成测试一致的流程：先发起 run，再等 stub 出现注入剧本
    const p = orch.runPromptWithImages({
      chatId: "1",
      text: "这是什么？",
      images: [{ data: "AAA=", mimeType: "image/jpeg" }],
      force: false,
    });
    const agent = await waitFor(() => runtime.agents[0]);
    const run = await waitFor(() => agent.currentRun);
    run.setScript([{ type: "assistant", text: "看到了" }]);
    await p;

    // 透传校验：text + images
    expect(agent.lastSend?.text).toBe("这是什么？");
    expect(agent.lastSend?.images).toEqual([
      { data: "AAA=", mimeType: "image/jpeg" },
    ]);
    expect(agent.lastSend?.force).toBe(false);
  });

  it("多张图透传 + 默认 force=false", async () => {
    const p = orch.runPromptWithImages({
      chatId: "1",
      text: "看",
      images: [
        { data: "A", mimeType: "image/png" },
        { data: "B", mimeType: "image/png" },
        { data: "C", mimeType: "image/png" },
      ],
      force: false,
    });
    const agent = await waitFor(() => runtime.agents[0]);
    const run = await waitFor(() => agent.currentRun);
    run.setScript([{ type: "assistant", text: "x" }]);
    await p;

    expect(agent.lastSend?.images?.length).toBe(3);
    expect(agent.lastSend?.force).toBe(false);
  });

  it("无活跃 workspace 时回提示且不调 send", async () => {
    // 用一个空 registry 的 orchestrator 单独跑此用例
    const empty = new WorkspaceRegistry(join(dataDir, "empty.json"));
    await empty.init({ autoRegisterCwd: false, cwd: dataDir });
    const messenger2 = new StubMessenger();
    const runtime2 = new StubAgentRuntime();
    const orch2 = new AgentOrchestrator({
      messenger: messenger2,
      runtime: runtime2,
      registry: empty,
      session,
      streamOptions: { throttleMs: 1, maxLen: 1000 },
      defaultModel: { id: "default", params: [] },
    });
    await orch2.runPromptWithImages({
      chatId: "1",
      text: "看",
      images: [{ data: "A", mimeType: "image/jpeg" }],
      force: false,
    });
    expect(runtime2.agents.length).toBe(0);
    expect(
      messenger2.sentTexts.some((m) => m.text.includes("没有活跃")),
    ).toBe(true);
    await orch2.dispose();
  });
});
