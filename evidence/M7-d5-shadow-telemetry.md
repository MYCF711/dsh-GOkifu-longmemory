# D5 影子遥测：开注入之前先看得到触发（2026-11-02）

## 问题
D5（同类失败 ≥2 次补卡）只在 `enabled && !shadow` 时才算；影子模式下完全静默。
结果是：**安装后、开真注入之前，我们对 D5 一无所知**。

## 改动
- `repeatHint` 在 `shadow` 模式下也检测触发，但**不注入**，只写一条遥测（`shadow:true`）；
- 遥测行字段与正式一致：`{at, kind:'repeat-hint', cls, count, tokens:null, digest:null, shadow:true}`；
- 影子模式**绝不改变 messages**（单测断言返回原 decision）。

## 验证
单测：影子配置下喂两次同类错误 ⇒ `repeat-hint.jsonl` 出现 `shadow:true` 行，且 decision.messages 长度不变。

## 用途
安装后先开影子跑一天：
```bash
node scripts/repeat-report.mjs   # 看"本来会补几次卡"、都在哪些类
```
确认触发率与误报可接受，再开 `enabled:true`。
