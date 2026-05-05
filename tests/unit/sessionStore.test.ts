import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/core/session/SessionStore.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ss-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("初始时 get 返回 undefined", async () => {
    const ss = new SessionStore(join(dir, "sessions.json"));
    await ss.init();
    expect(ss.get("default")).toBeUndefined();
  });

  it("set + get", async () => {
    const ss = new SessionStore(join(dir, "sessions.json"));
    await ss.init();
    await ss.set("default", { agentId: "agent-x", model: "auto" });
    expect(ss.get("default")?.agentId).toBe("agent-x");
  });

  it("clear 删除条目", async () => {
    const ss = new SessionStore(join(dir, "sessions.json"));
    await ss.init();
    await ss.set("default", { agentId: "agent-x" });
    await ss.clear("default");
    expect(ss.get("default")).toBeUndefined();
  });

  it("持久化后能恢复", async () => {
    const p = join(dir, "sessions.json");
    const a = new SessionStore(p);
    await a.init();
    await a.set("default", {
      agentId: "agent-y",
      model: "composer-2",
      modelParams: [{ id: "thinking", value: "high" }],
    });

    const b = new SessionStore(p);
    await b.init();
    expect(b.get("default")).toEqual({
      agentId: "agent-y",
      model: "composer-2",
      modelParams: [{ id: "thinking", value: "high" }],
    });
  });
});
