# M7 · D5 二次命中遥测（2026-11-02）

## 为什么
D5 已上线（0.21.0），但**没有观察手段**：装了之后也无法回答"补卡触发了几次、都在哪些类、误报多少"。

## 做了什么
1. `src/plugin.mjs` 的 D5 注入成功后写一行 JSONL 到影子目录：
   `{ at, kind:'repeat-hint', cls, count, tokens, digest }` —— **只放机械量**，不含会话内容/路径；
   任何异常只 warn，不影响本轮注入。
2. `scripts/repeat-report.mjs`：读该台账，输出总次数 / 涉及会话（digest 去重）/ 类别分布 / token 均值；
   没有台账时退出码 2（不伪造 0）。

## 用法（装上之后）
```bash
node scripts/repeat-report.mjs            # 文本
node scripts/repeat-report.mjs --json     # 给程序
```

## 验收口径（写进方案 §8.2d 的 live 部分）
- 触发率 = 触发次数 ÷ 有失败的新会话数；**预期只在"同类失败 ≥2 次"的会话里出现**；
- 误报抽样：人工看 10 条，确认补的卡确实与复发错误同类；
- token 成本：均值应接近 250（当前注入 p50）。

## 测试
2 条单测：writer 只写机械量且不含路径/会话号；report 正确聚合与去重。
