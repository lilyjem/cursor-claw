#!/usr/bin/env node
import { spawnSync } from "node:child_process";

// F-04：npm audit gate allowlist
// 仅允许 F-02 已明确 Accepted-Risk 的 undici 传递依赖链。
// 新增任何未登记 moderate/high/critical vulnerability 都会让 CI 失败。

const ALLOWED_NAMES = new Set(["undici", "@connectrpc/connect-node", "@cursor/sdk"]);
const ALLOWED_SOURCES = new Set([
  1112496, // GHSA-g9mf-h72j-4rw9
  1114594, // GHSA-2mjp-6q6p-2qxm
  1114638, // GHSA-vrm6-8vpv-qv8q
  1114640, // GHSA-v9p9-hfj2-hcw8
  1114642, // GHSA-4992-7rv2-5pvq
]);
const BLOCKING_SEVERITIES = new Set(["moderate", "high", "critical"]);

export function evaluateAudit(auditJson) {
  const vulnerabilities =
    auditJson && typeof auditJson === "object" && "vulnerabilities" in auditJson
      ? auditJson.vulnerabilities
      : {};
  const failures = [];

  for (const [name, vuln] of Object.entries(vulnerabilities ?? {})) {
    const severity = String(vuln?.severity ?? "");
    if (!BLOCKING_SEVERITIES.has(severity)) continue;

    if (!ALLOWED_NAMES.has(name)) {
      failures.push(`${name}: unallowlisted ${severity} vulnerability`);
      continue;
    }

    for (const via of vuln?.via ?? []) {
      if (typeof via === "string") {
        if (!ALLOWED_NAMES.has(via)) {
          failures.push(`${name}: unallowlisted transitive via ${via}`);
        }
        continue;
      }
      const source = Number(via?.source);
      if (!ALLOWED_SOURCES.has(source)) {
        failures.push(`${name}: unallowlisted advisory source ${source}`);
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

function runCli() {
  const audit = spawnSync("npm", ["audit", "--json", "--omit=dev"], {
    encoding: "utf8",
  });
  const stdout = audit.stdout.trim();
  if (!stdout) {
    console.error("npm audit did not produce JSON output");
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    console.error("failed to parse npm audit JSON:", e.message);
    process.exit(1);
  }

  const result = evaluateAudit(parsed);
  if (!result.ok) {
    console.error("npm audit gate failed:");
    for (const f of result.failures) console.error(`- ${f}`);
    process.exit(1);
  }

  const counts = parsed?.metadata?.vulnerabilities ?? {};
  console.log(
    `npm audit gate passed (accepted-risk allowlist only): ${JSON.stringify(counts)}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
