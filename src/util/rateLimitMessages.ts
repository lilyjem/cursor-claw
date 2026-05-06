// F-06：把 retryAfterMs 渲染成中文用户可读文本
// 单独抽到 util 是为了让 messenger / orchestrator 两条路径文案一致

// 内部统一的"X 秒"渲染：四舍五入到 0.1s，避免 0 秒/小数点过深
function renderRetryAfter(retryMs: number): string {
  const seconds = Math.max(0.1, retryMs / 1000);
  return `${seconds.toFixed(1)} 秒`;
}

// messenger 入口超限文案：onText / onImageGroup 共用
export function rateLimitedMessageText(retryMs: number): string {
  return `请求过于频繁，请 ${renderRetryAfter(retryMs)} 后重试。`;
}

// agent.create 路径超限文案：runInternal catch 后给 renderer.finalize
export function rateLimitedAgentCreateText(retryMs: number): string {
  return `短时间内创建 agent 过多，请 ${renderRetryAfter(retryMs)} 后重试。`;
}
