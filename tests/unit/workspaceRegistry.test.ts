import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceRegistry,
  WorkspaceError,
} from "../../src/core/workspace/WorkspaceRegistry.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wsr-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("WorkspaceRegistry", () => {
  it("init 时若 active 不存在，自动注册 cwd 为 default", async () => {
    const reg = new WorkspaceRegistry(join(dir, "workspaces.json"));
    await reg.init({ autoRegisterCwd: true, cwd: dir });
    expect(reg.getActive()?.name).toBe("default");
    expect(reg.getActive()?.path).toBe(dir);
  });

  it("add / use / list", async () => {
    const reg = new WorkspaceRegistry(join(dir, "workspaces.json"));
    await reg.init({ autoRegisterCwd: true, cwd: dir });
    reg.add("alpha", dir);
    reg.use("alpha");
    expect(reg.getActive()?.name).toBe("alpha");
    const list = reg.list();
    expect(list.map((w) => w.name).sort()).toEqual(["alpha", "default"]);
    await reg.persist();
  });

  it("add 重名 → 抛错", async () => {
    const reg = new WorkspaceRegistry(join(dir, "workspaces.json"));
    await reg.init({ autoRegisterCwd: true, cwd: dir });
    reg.add("alpha", dir);
    expect(() => reg.add("alpha", dir)).toThrow(WorkspaceError);
  });

  it("use 不存在的工作区 → 抛错", async () => {
    const reg = new WorkspaceRegistry(join(dir, "workspaces.json"));
    await reg.init({ autoRegisterCwd: true, cwd: dir });
    expect(() => reg.use("ghost")).toThrow(WorkspaceError);
  });

  it("remove active → 抛错", async () => {
    const reg = new WorkspaceRegistry(join(dir, "workspaces.json"));
    await reg.init({ autoRegisterCwd: true, cwd: dir });
    expect(() => reg.remove("default")).toThrow(WorkspaceError);
  });

  it("持久化后能恢复", async () => {
    const p = join(dir, "workspaces.json");
    const a = new WorkspaceRegistry(p);
    await a.init({ autoRegisterCwd: true, cwd: dir });
    a.add("alpha", dir);
    a.use("alpha");
    await a.persist();

    const b = new WorkspaceRegistry(p);
    await b.init({ autoRegisterCwd: false, cwd: dir });
    expect(b.getActive()?.name).toBe("alpha");
  });
});
