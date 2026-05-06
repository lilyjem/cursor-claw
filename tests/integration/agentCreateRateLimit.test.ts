import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator } from "../../src/core/orchestrator/AgentOrchestrator.js";
import { RateLimiter } from "../../src/core/rateLimit/RateLimiter.js";
import type { OrchestratorDeps } from "../../src/core/orchestrator/AgentOrchestrator.js";

// F-06 PR d：agent.create 限速集成测试
// - cached miss 进入 create 路径才计入限速；命中 cached 不计入
// - 超限抛 RateLimitedError，被 runInternal catch 后渲染为中文用户提示

function makeFakeRuntime() {
  const created: string[] = [];
  return {
    created,
    create: vi.fn(async (opts: { cwd: string }) => {
      created.push(opts.cwd);
      return {
        agentId: `a-${created.length}`,
        send: vi.fn(async () => ({
          stream: async function* () {},
          wait: async () => ({ status: "finished" as const, durationMs: 0 }),
          cancel: async () => {},
        })),
        dispose: vi.fn(async () => {}),
      };
    }),
    resume: vi.fn(),
  };
}

function makeFakeMessenger() {
  const sent: Array<{ chatId: string; text: string }> = [];
  return {
    sent,
    sendText: vi.fn(async (chatId: string, text: string) => {
      sent.push({ chatId, text });
      return { messageId: `m-${sent.length}` };
    }),
    editText: vi.fn(async () => {}),
    sendDocument: vi.fn(async () => {}),
    sendImage: vi.fn(async () => ({ messageId: "img-1" })),
    sendTyping: vi.fn(async () => {}),
  };
}

function makeFakeSession() {
  return {
    get: () => undefined,
    set: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
}

describe("AgentOrchestrator agent.create 限速", () => {
  it("capacity=2 时第 3 个新 cwd 触发 RateLimitedError 并被 finalize 渲染为错误", async () => {
    const runtime = makeFakeRuntime();
    const messenger = makeFakeMessenger();
    let activeWs: { name: string; path: string } = { name: "ws1", path: "/tmp/ws1" };
    const registry = { getActive: () => activeWs };

    const limiter = new RateLimiter({
      // 极小正数：测试中近似不回血，同时避免 retryAfterMs 变成 Infinity。
      buckets: { agentCreate: { capacity: 2, refillPerSec: 0.0001 } },
      now: () => 0,
    });

    const deps: Partial<OrchestratorDeps> = {
      messenger: messenger as unknown as OrchestratorDeps["messenger"],
      runtime: runtime as unknown as OrchestratorDeps["runtime"],
      registry: registry as unknown as OrchestratorDeps["registry"],
      session: makeFakeSession() as unknown as OrchestratorDeps["session"],
      streamOptions: { throttleMs: 0, maxLen: 1000 },
      defaultModel: { id: "default", params: [] },
      rateLimiter: limiter,
    };

    const orch = new AgentOrchestrator(deps as OrchestratorDeps);

    activeWs = { name: "ws1", path: "/tmp/ws1" };
    await orch.runPrompt({ chatId: "C", text: "hi", force: false, userId: 42 });
    activeWs = { name: "ws2", path: "/tmp/ws2" };
    await orch.runPrompt({ chatId: "C", text: "hi", force: false, userId: 42 });
    activeWs = { name: "ws3", path: "/tmp/ws3" };
    await orch.runPrompt({ chatId: "C", text: "hi", force: false, userId: 42 });

    expect(runtime.created).toEqual(["/tmp/ws1", "/tmp/ws2"]);
    expect(runtime.create).toHaveBeenCalledTimes(2);
    const last = messenger.sent[messenger.sent.length - 1]?.text ?? "";
    expect(last).toMatch(/创建 agent 过多/);
  });

  it("cached 命中不计入 agent.create 限速", async () => {
    const runtime = makeFakeRuntime();
    const messenger = makeFakeMessenger();
    const registry = { getActive: () => ({ name: "ws1", path: "/tmp/ws1" }) };

    const limiter = new RateLimiter({
      buckets: { agentCreate: { capacity: 1, refillPerSec: 0.0001 } },
      now: () => 0,
    });

    const deps: Partial<OrchestratorDeps> = {
      messenger: messenger as unknown as OrchestratorDeps["messenger"],
      runtime: runtime as unknown as OrchestratorDeps["runtime"],
      registry: registry as unknown as OrchestratorDeps["registry"],
      session: makeFakeSession() as unknown as OrchestratorDeps["session"],
      streamOptions: { throttleMs: 0, maxLen: 1000 },
      defaultModel: { id: "default", params: [] },
      rateLimiter: limiter,
    };

    const orch = new AgentOrchestrator(deps as OrchestratorDeps);

    for (let i = 0; i < 5; i++) {
      await orch.runPrompt({ chatId: "C", text: "hi", force: false, userId: 42 });
    }
    expect(runtime.create).toHaveBeenCalledTimes(1);
  });
});
