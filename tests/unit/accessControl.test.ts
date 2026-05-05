import { describe, it, expect } from "vitest";
import { AccessControl } from "../../src/core/access/AccessControl.js";

describe("AccessControl", () => {
  it("白名单用户 → allow", () => {
    const ac = new AccessControl([1, 2, 3]);
    expect(ac.isAllowed(1)).toBe(true);
    expect(ac.isAllowed(3)).toBe(true);
  });

  it("非白名单用户 → deny", () => {
    const ac = new AccessControl([1, 2]);
    expect(ac.isAllowed(99)).toBe(false);
  });

  it("空白名单 → 总是 deny", () => {
    const ac = new AccessControl([]);
    expect(ac.isAllowed(1)).toBe(false);
  });

  it("primary userId 等于白名单第一个", () => {
    const ac = new AccessControl([42, 7]);
    expect(ac.primaryUserId()).toBe(42);
  });
});
