// 把 Telegram / WeChat 进来的纯文本拆成 "普通文本" 或 "命令"。
// 命令格式 (Telegram 兼容)：
//   /name [args...]
//   /name@BotUsername [args...]   ← group 里同时挂了多个 bot 时 Telegram 会带 @suffix
//
// 注意：这里只做语法解析，业务校验（命令是否存在、参数数量、权限等）
// 留给 Command Handlers (T15) 自己处理。

export interface ParsedText {
  type: "text";
  text: string;
}

export interface ParsedCommand {
  type: "command";
  name: string; // 全部小写，去掉前导 /
  args: string[]; // 用空白拆出来的位置参数
  rest: string; // 命令名之后的原始 payload（不做拆分），便于 /remind 等保留原文
}

export type ParseResult = ParsedText | ParsedCommand;

export function parseCommand(input: string): ParseResult {
  // 空白裁剪：用户在手机上常常多打空格
  const trimmed = (input ?? "").trim();
  if (trimmed === "" || !trimmed.startsWith("/") || trimmed === "/") {
    return { type: "text", text: input ?? "" };
  }

  // 取首 token 作为 name；剩下的当作 rest
  // 用单空白切分但保留 rest 的原始字符串（不做空白压缩，rest 给业务自己处理）
  const idxFirstSpace = trimmed.search(/\s/);
  let head: string;
  let rest: string;
  if (idxFirstSpace === -1) {
    head = trimmed.slice(1);
    rest = "";
  } else {
    head = trimmed.slice(1, idxFirstSpace);
    rest = trimmed.slice(idxFirstSpace + 1).trim();
  }

  // 去掉 @BotUsername 后缀（Telegram group 中常见）
  const atIdx = head.indexOf("@");
  if (atIdx !== -1) head = head.slice(0, atIdx);

  if (head === "") {
    // 形如 "/  hello" —— 视作纯文本，不是命令
    return { type: "text", text: input };
  }

  const name = head.toLowerCase();
  const args = rest === "" ? [] : rest.split(/\s+/);
  return { type: "command", name, args, rest };
}
