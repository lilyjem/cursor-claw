import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// 发布后 smoke 发现：tsup banner 已统一给 bin 加 shebang，
// 如果源码入口自己也带 shebang，dist 会出现双 shebang，node 直接运行会 SyntaxError。

describe("bin shebang source policy", () => {
  it("cursor-claw source entry does not duplicate tsup banner shebang", async () => {
    const src = await readFile("src/bin/cursor-claw.ts", "utf8");
    expect(src.startsWith("#!")).toBe(false);
  });
});
