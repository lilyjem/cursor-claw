// 模型诊断工具：把指定的 ModelSelection 直接喂给 Agent.create + 一次 send，
// 用来快速判断"这个模型 + params 在我的 API key 上到底能不能跑"。
//
// 排错经验：list_models 返回的 variants 是 web/cloud 视角的，并不等于 SDK local
// 模式都能跑。如果 SDK 静默返回 status=ERROR 且 result 为空，几乎可以肯定是
// API key plan / 区域限制把这款模型在 local 模式下挡掉了——换一个能跑的就好。
//
// 用法: CURSOR_API_KEY=... npx tsx tests/manual/test_model.ts
//
// 把下面的 model 对象改成你想验证的组合即可。
import { Agent } from "@cursor/sdk";

async function main(): Promise<void> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    console.error("set CURSOR_API_KEY first");
    process.exit(1);
  }
  const model = {
    id: "gpt-5.3-codex",
    params: [
      { id: "reasoning", value: "extra-high" },
      { id: "fast", value: "false" },
    ],
  };
  console.log("model =", JSON.stringify(model, null, 2));
  const agent = await Agent.create({
    apiKey,
    model,
    local: { cwd: process.cwd(), settingSources: ["project", "user"] },
  });
  console.log("agentId:", agent.agentId);
  console.log("发 prompt …");
  const run = await agent.send("一句话总结这个仓库");
  for await (const e of run.stream()) {
    console.log("[event]", e.type, JSON.stringify(e).slice(0, 200));
  }
  const r = await run.wait();
  console.log("wait result:", JSON.stringify(r));
  await agent[Symbol.asyncDispose]();
  console.log("OK");
}

main().catch((e) => {
  console.error("FAIL:", (e as Error).message);
  process.exit(1);
});
