import { describe, it, expect } from "vitest";
import { sanitizeForOutput } from "../../src/util/sanitize.js";

// 测试中所有 "token" / "key" 形态都是**合成**值，不与任何真实 Telegram bot
// 或 Cursor API key 的位字段对应。我们只关心正则形态匹配，不关心数值。
//
// 合成 token：bot<digits>:<base58-ish>，长度 ≥ 20。
// 合成 key  ：crsr_<hex-ish>，长度 ≥ 16。
//
// 历史背景：v0.1.0 安全审查首版的本测试文件曾误把真实 token 写进 fixture，
// 已在后续 commit 替换为合成值。如果你回看 git 历史看到形如"真"的字符串，
// 请优先 revoke / rotate 对应凭据，而不是依赖历史值做任何还原。
const SYNTHETIC_BOT_TOKEN = "0000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA00000";
const SYNTHETIC_BOT_TOKEN_FRAGMENT = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA00000";
const SYNTHETIC_CURSOR_KEY =
  "crsr_0000111122223333444455556666777788889999aaaabbbbccccddddeeee";
const SYNTHETIC_CURSOR_KEY_FRAGMENT = "0000111122223333";

describe("sanitizeForOutput (F-01 / F-11)", () => {
  // --- F-01 主线 ---

  it("替换 Telegram 文件下载 URL 中的 botToken：bot<token>/...", () => {
    const input = `fetch failed: https://api.telegram.org/file/bot${SYNTHETIC_BOT_TOKEN}/photos/file_1.jpg`;
    const out = sanitizeForOutput(input);
    expect(out).not.toContain(SYNTHETIC_BOT_TOKEN);
    expect(out).not.toContain(SYNTHETIC_BOT_TOKEN_FRAGMENT);
    expect(out).toContain("bot***/");
    expect(out).toContain("https://api.telegram.org/file/");
  });

  it("替换 botToken 即使其后接 path（无斜杠分隔）", () => {
    const input = `request to https://api.telegram.org/file/bot${SYNTHETIC_BOT_TOKEN}/abc.jpg failed`;
    const out = sanitizeForOutput(input);
    expect(out).not.toContain(SYNTHETIC_BOT_TOKEN);
    expect(out).toContain("bot***/");
  });

  it("不替换合法的 'bot' 单词（不带 token 形态）", () => {
    const input = "the bot started";
    expect(sanitizeForOutput(input)).toBe("the bot started");
  });

  // --- F-11 联动：crsr_ key ---

  it("替换 Cursor API key crsr_<hex>", () => {
    const input = `config dump: cursor.apiKey=${SYNTHETIC_CURSOR_KEY}`;
    const out = sanitizeForOutput(input);
    expect(out).not.toContain(SYNTHETIC_CURSOR_KEY);
    expect(out).not.toContain(SYNTHETIC_CURSOR_KEY_FRAGMENT);
    expect(out).toContain("crsr_***");
  });

  it("crsr_ 出现在路径中也要替换（防完整 URL 场景）", () => {
    const input = `see https://example.com/api?key=${SYNTHETIC_CURSOR_KEY}`;
    const out = sanitizeForOutput(input);
    expect(out).not.toContain(SYNTHETIC_CURSOR_KEY);
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
