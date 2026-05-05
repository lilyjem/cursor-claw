import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubMessenger } from "../helpers/StubMessenger.js";
import { StubAgentRuntime } from "../helpers/StubAgent.js";
import { WorkspaceRegistry } from "../../src/core/workspace/WorkspaceRegistry.js";
import { SessionStore } from "../../src/core/session/SessionStore.js";
import { AgentOrchestrator } from "../../src/core/orchestrator/AgentOrchestrator.js";
import { dispatchCommand } from "../../src/commands/dispatch.js";

let dir: string;
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setup() {
  dir = await mkdtemp(join(tmpdir(), "cmd-"));
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
    streamOptions: { throttleMs: 5, maxLen: 1000 },
    defaultModel: { id: "auto", params: [] },
  });
  return { messenger, registry, session, orch, runtime };
}

function lastSent(messenger: StubMessenger): string {
  const sent = [...messenger.calls].reverse().find((c) => c.kind === "sendText");
  return sent && sent.kind === "sendText" ? sent.text : "";
}

describe("dispatchCommand", () => {
  it("/help → 发送帮助信息", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand(
      { type: "command", name: "help", args: [], rest: "" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(lastSent(messenger)).toContain("/start");
  });

  it("/ws list 显示当前为 default", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand(
      { type: "command", name: "ws", args: ["list"], rest: "list" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(lastSent(messenger)).toContain("default");
  });

  it("/ws add name path → 注册成功", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand(
      {
        type: "command",
        name: "ws",
        args: ["add", "alpha", dir],
        rest: `add alpha ${dir}`,
      },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(registry.get("alpha")?.path).toBe(dir);
  });

  it("/ws use ghost → 报错（包含 not found）", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand(
      { type: "command", name: "ws", args: ["use", "ghost"], rest: "use ghost" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(lastSent(messenger)).toMatch(/not found/i);
  });

  it("/reset 清空 session 中 default 的 agentId", async () => {
    const { messenger, registry, session, orch } = await setup();
    await session.set("default", { agentId: "agent-x" });
    await dispatchCommand(
      { type: "command", name: "reset", args: [], rest: "" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(session.get("default")?.agentId).toBeUndefined();
  });

  it("/cancel 没有活跃 run 时也优雅返回", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand(
      { type: "command", name: "cancel", args: [], rest: "" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(lastSent(messenger)).toMatch(/取消/);
  });

  it("/status 显示当前工作区与模型", async () => {
    const { messenger, registry, session, orch } = await setup();
    await session.set("default", { agentId: "agent-y", model: "auto" });
    await dispatchCommand(
      { type: "command", name: "status", args: [], rest: "" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(lastSent(messenger)).toContain("default");
  });

  it("/model composer-2 写回 session", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand(
      { type: "command", name: "model", args: ["composer-2"], rest: "composer-2" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(session.get("default")?.model).toBe("composer-2");
  });

  it("未知命令 → 回提示", async () => {
    const { messenger, registry, session, orch } = await setup();
    await dispatchCommand(
      { type: "command", name: "nonexistent", args: [], rest: "" },
      { chatId: "c1", messenger, registry, session, orchestrator: orch },
    );
    expect(lastSent(messenger)).toMatch(/未知命令|Unknown/);
  });
});
