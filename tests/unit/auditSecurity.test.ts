import { describe, it, expect } from "vitest";
// @ts-expect-error 测试直接覆盖 Node CLI 的 .mjs 脚本；生产运行由 node 执行。
import { evaluateAudit } from "../../scripts/audit-security.mjs";

// F-04 PR #12：CI audit gate 的核心逻辑
// 当前 F-02 undici chain 是 Accepted-Risk，必须允许；新增未登记风险必须拒绝。

describe("audit-security allowlist", () => {
  it("允许当前 F-02 undici accepted-risk chain", () => {
    const r = evaluateAudit({
      vulnerabilities: {
        undici: {
          severity: "high",
          via: [{ source: 1114638 }, { source: 1114640 }],
        },
        "@connectrpc/connect-node": {
          severity: "moderate",
          via: ["undici"],
        },
        "@cursor/sdk": {
          severity: "moderate",
          via: ["@connectrpc/connect-node"],
        },
      },
    });
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("拒绝新增未登记 high vulnerability", () => {
    const r = evaluateAudit({
      vulnerabilities: {
        evil: {
          severity: "high",
          via: [{ source: 999999 }],
        },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("evil");
  });

  it("拒绝 allowlisted package 上的新 advisory source", () => {
    const r = evaluateAudit({
      vulnerabilities: {
        undici: {
          severity: "high",
          via: [{ source: 1234567 }],
        },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("1234567");
  });
});
