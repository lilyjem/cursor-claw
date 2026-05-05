// 手动烟囱测试：验证 CursorSdkRuntime 能跑通 create → send → stream → dispose
// 用法: CURSOR_API_KEY=... npx tsx tests/manual/sdk_smoke.ts
import { CursorSdkRuntime } from "../../src/core/orchestrator/cursorSdkRuntime.js";

async function main(): Promise<void> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    console.error("set CURSOR_API_KEY first");
    process.exit(1);
  }
  const runtime = new CursorSdkRuntime(apiKey);
  const agent = await runtime.create({ cwd: process.cwd() });
  console.log("agentId:", agent.agentId);
  const run = await agent.send("用一句话说明这个仓库的功能");
  for await (const e of run.stream()) {
    if (e.type === "assistant") process.stdout.write(e.text);
  }
  console.log();
  await agent.dispose();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
