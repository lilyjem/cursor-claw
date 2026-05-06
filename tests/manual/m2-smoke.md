# M2 e2e smoke 验证清单（手工）

> 自动化测试已经覆盖了所有单元 / 集成层（136 tests, 24 files 全绿）。
> 这份清单覆盖**只能在真实 Telegram bot + 真实 Cursor API key 下**才能验证的端到端行为：
> 入站图片、出站附件、reminders 的实际触发与人机交互。
>
> 每条勾选后，建议跑一次 `git status` 与 `npm test -- --run` 确认仓库干净 + 测试绿。
>
> 对应 `docs/superpowers/specs/2026-05-05-cursor-claw-design.md` 第 7 节验收标准。

## 前置准备

1. 准备好 `config.json`（或对应环境变量）：
   - `telegram.botToken`
   - `telegram.allowedUserIds`（必须包含发起测试的 Telegram userId）
   - `cursor.apiKey`
2. 在 active workspace 根目录开一个 shell，跑：
   ```bash
   npm install
   npm run build
   npm link            # 让 PATH 上有 claw-attach-image / claw-attach-file
   ```
3. 建议 active workspace 是一个真实的 git 仓库（agent 才有内容可分析）。

## Step 1：跑全套自动化（已完成 ✅）

```bash
npm test -- --run && npm run typecheck && npm run lint && npm run build
```

预期：

- [x] 136 tests 全绿
- [x] typecheck / lint 干净
- [x] `dist/bin/cursor-claw.js`、`dist/tools/attach-image.js`、`dist/tools/attach-file.js` 三个产物均生成且带 `#!/usr/bin/env node` shebang

## Step 2：启动 dev

```bash
npx tsx src/bin/cursor-claw.ts
```

观察 startup log：

- [ ] `cursor-claw started` 日志出现
- [ ] 没有 grammy 409（说明没有重复实例）
- [ ] active workspace 根下 `.claw/data-dir.txt` 已写入，内容是绝对路径指向 `paths.dataDir`

## Step 3：9 条端到端验收（每条勾选后再勾下一条）

### A 入站图片

- [ ] **A1 单图入站**：用 Telegram 发一张带 caption "这是什么？" 的图给 bot；agent 应有流式回复
- [ ] **A2 album 入站**：用 Telegram 一次发 3 张图（同 album）；server 端应仅一次 `incoming imageGroup` 日志（n: 3）；agent 单 prompt 收到 3 张图

### B 出站附件

- [ ] **B1 出站附件**：让 agent 在 shell 跑：
  ```bash
  echo test > /tmp/clawtest.txt && claw-attach-file /tmp/clawtest.txt --caption "test"
  ```
  run 结束后 Telegram 立即收到该文件
- [ ] **B2 多附件 + 重试**：让 agent 一次 run 中多发 2 张图（`claw-attach-image`）；都送达；`<dataDir>/queue.jsonl` 在送达后为空

### C Reminders

- [ ] **C1 reminders text**：`/remind add text 10s 起床啦`；10 秒后收到 "⏰ 起床啦"；`<dataDir>/reminders.json` 已不含此条
- [ ] **C2 reminders prompt**：`/remind add prompt 10s 一句话总结这个仓库`；10 秒后看到 agent 流式回复
- [ ] **C3 reminders busy 重排**：先 `/remind add prompt 5s 一句话总结仓库`，立刻 `!写一个 200 字小说让 agent 卡住`（超长 prompt）；scheduler 触发时 busy → 收到 "⏰ 提醒延后 1 分钟" 通知；60s 内 agent 仍忙时收到 "⏰ 提醒：..." 退化文本
- [ ] **C4 list / del**：`/remind add text 1h 测试`；`/remind list` 应见此条；记下 id；`/remind del <id>`；再 list 不再显示

## Step 4：每条验收后留干净 git 状态

```bash
git status   # 应输出 nothing to commit
```

## Step 5：M2 收尾 commit

```bash
git commit --allow-empty -m "chore(m2): e2e smoke 全 9 条验收完成"
```
