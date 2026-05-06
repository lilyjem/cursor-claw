import { describe, it, expect } from "vitest";
import { sanitizeForOutput } from "../../src/util/sanitize.js";

// F-01 / F-11 的深度防御工具：在 logger 输出 + 用户端 echo 之前
// 对字符串内容做正则脱敏，覆盖以下敏感形态：
//
// 1. Telegram 文件下载 URL：
//    https://api.telegram.org/file/bot<token>/<file_path>
//    其中 botToken 形如 "12345:AAFlC1Sfv1G..." 的合规字符串。
//    必须把 bot<token>/ 整段替换为 "bot***/"，避免 token 落地日志或 echo 给用户。
//
// 2. Cursor API key 前缀 crsr_<hex>：64 字符 hex（公开文档可见格式）。
//    必须替换为 "crsr_***"。
//
// 3. 普通字符串：必须保持不变（不能误伤 trace 信息）。
describe("sanitizeForOutput (F-01 / F-11)", () => {
  // --- F-01 主线 ---

  it("替换 Telegram 文件下载 URL 中的 botToken：bot<token>/...", () => {
    const input =
      "fetch failed: https://api.telegram.org/file/bot8235339221:AAFlC1Sfv1GDyiXDG6Y5rnfWMHwV_6KkNsU/photos/file_1.jpg";
    const out = sanitizeForOutput(input);
    expect(out).not.toContain("8235339221:AAFlC1Sfv1G");
    expect(out).not.toContain("AAFlC1Sfv1GDyiXDG6Y5rnfWMHwV_6KkNsU");
    expect(out).toContain("bot***/");
    expect(out).toContain("https://api.telegram.org/file/");
  });

  it("替换 botToken 即使其后接 path（无斜杠分隔）", () => {
    const input =
      "request to https://api.telegram.org/file/bot8235339221:AAFlC1Sfv1GDyiXDG6Y5rnfWMHwV_6KkNsU/abc.jpg failed";
    const out = sanitizeForOutput(input);
    expect(out).not.toContain("8235339221:");
    expect(out).toContain("bot***/");
  });

  it("不替换合法的 'bot' 单词（不带 token 形态）", () => {
    const input = "the bot started";
    expect(sanitizeForOutput(input)).toBe("the bot started");
  });

  // --- F-11 联动：crsr_ key ---

  it("替换 Cursor API key crsr_<hex>", () => {
    const input =
      "config dump: cursor.apiKey=crsr_a552bbb9a669ee23ea155eca41de033d38161af8eb2ac208bcb921fa3613fffb";
    const out = sanitizeForOutput(input);
    expect(out).not.toContain("a552bbb9");
    expect(out).toContain("crsr_***");
  });

  it("crsr_ 出现在路径中也要替换（防完整 URL 场景）", () => {
    const input =
      "see https://example.com/api?key=crsr_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const out = sanitizeForOutput(input);
    expect(out).not.toContain("crsr_abcdef");
    expect(out).toContain("crsr_***");
  });

  // --- 边界 ---

  it("空字符串保持空", () => {
    expect(sanitizeForOutput("")).toBe("");
  });

  it("普通错误 message 保持不变", () => {
    const input = "Telegram 文件下载请求失败 (file_id=AgACAgIAAxkBAAOTaO...)";
    expect(sanitizeForOutput(input)).toBe(input);
  });

  it("文件路径（如 /Users/me/.ssh/id_rsa）不在脱敏范围（由 F-11 后续单独处理）", () => {
    // 此测试用于固化 sanitizeForOutput 的边界：
    // 它只负责 token / key 等明确"字符串本身就是机密"的形态；
    // 用户名 / 路径等"主机环境信息"由 F-11 的 logger redact hook 单独处理。
    const input = "open /Users/me/.ssh/id_rsa failed";
    expect(sanitizeForOutput(input)).toBe(input);
  });

  it("非 string 输入回空字符串（防御调用方 typo）", () => {
    expect(sanitizeForOutput(undefined as unknown as string)).toBe("");
    expect(sanitizeForOutput(null as unknown as string)).toBe("");
  });
});
