import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../../src/core/persist/jsonStore.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jsonstore-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Foo {
  x: number;
  y?: string;
}

describe("JsonStore", () => {
  it("readOrInit 返回默认值并写盘", async () => {
    const store = new JsonStore<Foo>(join(dir, "foo.json"), { x: 0 });
    const data = await store.readOrInit();
    expect(data).toEqual({ x: 0 });
    const onDisk = JSON.parse(await readFile(join(dir, "foo.json"), "utf8"));
    expect(onDisk).toEqual({ x: 0 });
  });

  it("write 后 read 能拿到新值", async () => {
    const store = new JsonStore<Foo>(join(dir, "foo.json"), { x: 0 });
    await store.readOrInit();
    await store.write({ x: 7, y: "hi" });
    const back = await store.read();
    expect(back).toEqual({ x: 7, y: "hi" });
  });

  it("原子写：写入完成后不会留下 *.tmp", async () => {
    const store = new JsonStore<Foo>(join(dir, "foo.json"), { x: 0 });
    await store.write({ x: 99 });
    const onDisk = JSON.parse(await readFile(join(dir, "foo.json"), "utf8"));
    expect(onDisk).toEqual({ x: 99 });
    await expect(stat(join(dir, "foo.json.tmp"))).rejects.toThrow();
  });

  it("启动时若发现遗留 *.tmp 文件则清理", async () => {
    await writeFile(join(dir, "foo.json.tmp"), "garbage", "utf8");
    const store = new JsonStore<Foo>(join(dir, "foo.json"), { x: 1 });
    await store.readOrInit();
    await expect(stat(join(dir, "foo.json.tmp"))).rejects.toThrow();
  });

  it("update 能基于当前值写回", async () => {
    const store = new JsonStore<Foo>(join(dir, "foo.json"), { x: 1 });
    await store.readOrInit();
    await store.update((cur) => ({ ...cur, x: cur.x + 10 }));
    expect((await store.read()).x).toBe(11);
  });

  // F-13：JsonStore 落盘文件应限制为 0600（仅 owner 可读写）
  // 跨主机的 dataDir 经常含会话历史 / reminder 内容 / 用户标识，
  // 默认 0644 在多用户主机上可被同主机其他用户读取。
  it.skipIf(process.platform === "win32")(
    "F-13: write 后文件 mode 必须是 0o600（仅 owner 读写）",
    async () => {
      const target = join(dir, "perm.json");
      const store = new JsonStore<Foo>(target, { x: 0 });
      await store.write({ x: 1 });
      const st = await stat(target);
      expect(st.mode & 0o777).toBe(0o600);
    },
  );

  // F-13：父目录若被 JsonStore 创建，权限应是 0o700
  it.skipIf(process.platform === "win32")(
    "F-13: 父目录被 mkdir 时 mode 必须是 0o700",
    async () => {
      const sub = join(dir, "subdir");
      const store = new JsonStore<Foo>(join(sub, "perm.json"), { x: 0 });
      await store.write({ x: 1 });
      const st = await stat(sub);
      expect(st.mode & 0o777).toBe(0o700);
    },
  );
});
