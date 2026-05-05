import { Bot } from "grammy";

// 单独抽出 Bot 工厂，方便单测桩化（虽然 M1 没有桩用例，但以后真要写就方便）
export function createBot(token: string) {
  return new Bot(token);
}

export type GrammyBot = ReturnType<typeof createBot>;
