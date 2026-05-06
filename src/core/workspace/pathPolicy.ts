import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

// F-07：workspace 路径白名单策略
// 使用 realpath 解析 symlink，再用 resolve + sep 做边界判断，避免 /repo_evil
// 这类 sibling 目录通过简单 startsWith('/repo') 绕过。

function isWithinRoot(path: string, root: string): boolean {
  const p = resolve(path);
  const r = resolve(root);
  return p === r || p.startsWith(r + sep);
}

export async function isPathWithinAllowedRoots(
  path: string,
  roots: string[],
): Promise<boolean> {
  if (roots.length === 0) return true;
  const realPath = await realpath(path);
  const realRoots = await Promise.all(roots.map((r) => realpath(r)));
  return realRoots.some((root) => isWithinRoot(realPath, root));
}
