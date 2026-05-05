import { describe, it, expect } from "vitest";
import {
  decideBusyAction,
  parseForcePrefix,
} from "../../src/core/orchestrator/busyPolicy.js";

describe("parseForcePrefix", () => {
  it("以 ! 开头 → force=true、剥掉前缀", () => {
    expect(parseForcePrefix("!fix this")).toEqual({ force: true, text: "fix this" });
  });
  it("普通文本 → force=false", () => {
    expect(parseForcePrefix("hello")).toEqual({ force: false, text: "hello" });
  });
  it("仅 ! 也接受", () => {
    expect(parseForcePrefix("!")).toEqual({ force: true, text: "" });
  });
});

describe("decideBusyAction", () => {
  it("无活跃 run → run", () => {
    expect(decideBusyAction({ activeRunStatus: undefined, force: false })).toBe("run");
  });
  it("有活跃 run + 非 force → reject", () => {
    expect(decideBusyAction({ activeRunStatus: "running", force: false })).toBe("reject");
  });
  it("有活跃 run + force → force-replace", () => {
    expect(decideBusyAction({ activeRunStatus: "running", force: true })).toBe(
      "force-replace",
    );
  });
  it("活跃 run 已结束 → run", () => {
    expect(decideBusyAction({ activeRunStatus: "finished", force: false })).toBe("run");
  });
});
