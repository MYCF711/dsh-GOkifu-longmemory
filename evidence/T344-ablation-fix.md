# T344 · ablation 实验的另两个致命漏洞修复 —— 出题防泄漏 + 机械判复发

> `[本] 2026-11-06` · 修 `scripts/ablation-live.mjs`（漏洞 ②③；漏洞 ① 已在 0.4.1/T341 修）。
> 评审来源：`evidence/ablation-设计评审.md`（precision-auditor，2026-11-06）。

## 0 · 一句话

**原脚本会让这个实验得出假结论**：题目提示就是错误原文（A 臂卡片里就有答案），复发还要人手工填 0/1。
本刀把提示改成**只给动作**、判分改成**归一签名比对**，并给两者都配了 tombstone。

## 1 · 两个漏洞与修法

### 漏洞 ③ 考卷泄漏（最致命）

**原来**：`listCandidates` 把 `quote`（错误原文）当 `errorText` 输出，指南又让人拿它当提示
⇒ A 臂注入的卡里**就写着这道题的答案** ⇒ 测的是"抄答案"，不是"少踩坑"。

**现在**（`scripts/ablation-live.mjs`）：
- `actionPromptAt(events, seq)`：从失败 seq **往回**找最近的 `tool/call`，题目提示 = `name + 命令/文件参数`（**只含动作**）。
- `leaksAnswer(prompt, errorText)`：提示里出现错误原文（前 30 字）或归一签名 ⇒ 判泄漏。
- `listCandidates`：取不到动作 **或** 提示泄漏 ⇒ `promptSafe:false`，**默认不出题**；
  只有显式 `--allow-unsafe` 才放行，且该题**不得用于判「记忆有用」**。
- 字段用途分开：`taskPrompt`（发模型）/ `signature`（只给判分，**严禁进提示**）/ `errorText`（只给人追溯）。

### 漏洞 ② 判据不机械

**原来**：`--record --recurred 0|1` 全靠人填 ⇒ 违反「计数不是打分」（AGENTS §2.3）。

**现在**：
- `judgeRecurrence({tasks, events})`：把运行日志里**所有失败行**归一成签名（复用 R09 的 `errorKeyOf`：
  路径 → `<path>`、按错误类归一），与任务 `signature` 求交 ⇒ `recurred=true/false`。**零模型判断、不读 claim。**
- CLI：`--judge --tasks <tasks.json> --log <会话日志> [--variant A|B] [--record]`。
- 手工 `--record --recurred` 仍保留（兼容），但指南改为走 `--judge`。

## 2 · 验收

`test/ablation-live.test.mjs` 从 4 条扩到 10 条（全绿）：

| # | 断言 |
|---|---|
| T344 ① | 只差路径的两条错误 ⇒ 同一归一签名 |
| T344 ② | 题目提示取自动作；无 `tool/call` / seq 不存在 ⇒ `null` |
| T344 ③ | 提示含错误原文 ⇒ 判泄漏；动作干净 ⇒ 不泄漏 |
| T344 ④ | **tombstone**：出题默认不含泄漏；会泄漏的默认不出；`--allow-unsafe` 才放行且必须标 `promptSafe:false` |
| T344 ⑤ | 机械判复发：运行里再现同签名（只差路径）⇒ `recurred=true`，无关任务 ⇒ `false` |
| T344 ⑥ | 没有失败事件 ⇒ 全 `false`（不编）；空任务 ⇒ `[]` |

全量：**1030 条 / 1024 pass / 0 fail**；`node scripts/check.mjs` PASS。
T307 原有 4 条统计/记分测试保持通过（其中出题用例显式 `allowUnsafe:true`，只测筛选口径）。

## 3 · 同步更新

`docs/ablation-运行指南.md` 重写为"现在的做法"（原来 §1.4 还写着"必须改配置、不是环境变量"，已过时）：
- 新增字段用途表（`taskPrompt` 发模型 / `signature` 只给判分 / `errorText` 不进提示 / `promptSafe` 守门）；
- B 臂关法改为 `GOKIFU_INJECT=off`（0.4.1 起真实生效）或设置 UI；
- 判分改 `--judge`，并标注"读到 0 条失败 ⇒ 日志路径不对"这类常见失败。

## 4 · 仍未验（不冒充）

- **实验本身仍未跑**：需要**新会话**（本宿主所有会话都注入，做不了无注入对照）。
  现在三件套齐了（开关真、题目无泄漏、判分机械），但"记忆有用/没用"的结论**一条都还没有**。
- 判分按**签名**比对：同一错误类在不同任务间会互相命中（宁可保守，不放过真复发）；跨错误类不命中。
