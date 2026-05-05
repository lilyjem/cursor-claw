// 工具状态行字数限制：太长在 Telegram 上会被挤掉正文
const MAX_LEN = 60;

function trim(s: string): string {
  if (s.length <= MAX_LEN) return s;
  return s.slice(0, MAX_LEN) + "…";
}

function pickPath(a: Record<string, unknown> | undefined): string {
  // SDK 各工具传 path 用的字段不一致，做兜底
  return (
    (a?.path as string | undefined) ??
    (a?.relative_path as string | undefined) ??
    ""
  );
}

/**
 * 把 SDK 的工具调用 args 概括成一行展示文本。
 *
 * SDK 文档明确说"args / result schema 不稳定，视为 unknown 防御式解析"，
 * 因此所有访问都走可选链 + as cast，并在字段缺失时给空字符串兜底，绝不抛异常。
 */
export function summarizeTool(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : undefined) as
    | Record<string, unknown>
    | undefined;

  switch (name) {
    case "shell":
      return `shell: ${trim((a?.command as string) ?? "")}`;
    case "read":
      return `read: ${pickPath(a)}`;
    case "write":
      return `write: ${pickPath(a)}`;
    case "edit":
      return `edit: ${pickPath(a)}`;
    case "grep":
      return `grep: ${trim((a?.pattern as string) ?? "")}`;
    case "glob":
      return `glob: ${trim((a?.pattern as string) ?? "")}`;
    case "ls":
      return `ls: ${(a?.path as string | undefined) ?? "."}`;
    case "task":
      return `subagent: ${trim((a?.description as string) ?? "")}`;
    default:
      return name;
  }
}
