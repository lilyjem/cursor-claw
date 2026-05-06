import { mkdtemp, mkdir, realpath, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPathWithinAllowedRoots } from "../../src/core/workspace/pathPolicy.js";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("workspace path policy", () => {
  it("允许 allowed root 内的路径", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-policy-"));
    const root = join(dir, "repo");
    const child = join(root, "child");
    await mkdir(child, { recursive: true });
    expect(await isPathWithinAllowedRoots(child, [root])).toBe(true);
  });

  it("拒绝 sibling 绕过：/repo_evil 不属于 /repo", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-policy-"));
    const root = join(dir, "repo");
    const evil = join(dir, "repo_evil");
    await mkdir(root, { recursive: true });
    await mkdir(evil, { recursive: true });
    expect(await isPathWithinAllowedRoots(evil, [root])).toBe(false);
  });

  it("通过 realpath 解析 symlink，拒绝指向 root 外部的链接", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-policy-"));
    const root = join(dir, "repo");
    const outside = join(dir, "outside");
    const link = join(root, "link-outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, link);
    expect(await isPathWithinAllowedRoots(await realpath(link), [root])).toBe(
      false,
    );
  });
});
