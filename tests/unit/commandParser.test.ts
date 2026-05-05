import { describe, it, expect } from "vitest";
import { parseCommand } from "../../src/commands/parser.js";

// 小工具：在测试里把 ParseResult 当成命令断言，避免到处写 if
function asCmd(r: ReturnType<typeof parseCommand>) {
  if (r.type !== "command") {
    throw new Error(`expected command but got text: ${JSON.stringify(r)}`);
  }
  return r;
}

describe("CommandParser", () => {
  it("普通文本不识别为命令", () => {
    const r = parseCommand("hello world");
    expect(r.type).toBe("text");
    if (r.type === "text") expect(r.text).toBe("hello world");
  });

  it("空字符串归类为 text", () => {
    const r = parseCommand("");
    expect(r.type).toBe("text");
    if (r.type === "text") expect(r.text).toBe("");
  });

  it("仅 / 视为文本，不当命令", () => {
    const r = parseCommand("/");
    expect(r.type).toBe("text");
  });

  it("/help → command name=help args=[]", () => {
    const r = asCmd(parseCommand("/help"));
    expect(r.name).toBe("help");
    expect(r.args).toEqual([]);
  });

  it("/ws add proj /tmp/p → 解析多 args", () => {
    const r = asCmd(parseCommand("/ws add proj /tmp/p"));
    expect(r.name).toBe("ws");
    expect(r.args).toEqual(["add", "proj", "/tmp/p"]);
    expect(r.rest).toBe("add proj /tmp/p");
  });

  it("命令名大小写归一化", () => {
    expect(asCmd(parseCommand("/Help")).name).toBe("help");
  });

  it("Telegram bot 后缀 /cmd@MyBot → 去掉 @MyBot", () => {
    const r = asCmd(parseCommand("/ws@MyBot list"));
    expect(r.name).toBe("ws");
    expect(r.args).toEqual(["list"]);
  });

  it("多余空白被压缩", () => {
    expect(asCmd(parseCommand("/ws   add    proj")).args).toEqual([
      "add",
      "proj",
    ]);
  });

  it("命令前后空白裁剪", () => {
    const r = asCmd(parseCommand("   /help   "));
    expect(r.name).toBe("help");
  });

  it("rest 保留空格分隔的原始 payload（如 /remind 的提示文本）", () => {
    const r = asCmd(parseCommand("/remind 5m drink water now"));
    expect(r.name).toBe("remind");
    expect(r.rest).toBe("5m drink water now");
  });

  it("纯数字命令名也认识", () => {
    expect(asCmd(parseCommand("/123")).name).toBe("123");
  });

  it("force 前缀 ! 不属于 CommandParser 解析（保留给 busyPolicy）", () => {
    const r = parseCommand("!hello");
    expect(r.type).toBe("text");
    if (r.type === "text") expect(r.text).toBe("!hello");
  });
});
