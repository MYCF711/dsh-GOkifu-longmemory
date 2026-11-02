# Q19-B 预置：`preferenceHardOnly` 开关（2026-11-03）

## 做了什么
- `buildMemoryCard` 新增 `preferenceHardOnly`（默认 **false**）：为 true 时丢弃 `kind=preference` 且 `level!=='hard'` 的条目，
  并计入 `dropped.softPreference`。
- 插件 `DEFAULT_CONFIG` 增同名键（默认 false）+ 归一化 + 透传；**默认行为零变化**。
- 修一个真 bug：`storeView` 投影 claim 时**丢掉了 `level`**，导致任何"按 hard/soft 分流"的逻辑都拿不到值
  （这轮写测试时才发现；已在投影里补 `level`）。

## 为什么默认关
Q19 仍是待裁项（`docs/拷问记录.md`）：偏好要不要收紧属产品方向。开关先做出来、默认关，
裁定为 B 时只需把默认值翻成 true（一行），不必重做逻辑。

## 实测（真实数据）
| 口径 | 结果 |
|---|---|
| 单测 | 新增「flag=true ⇒ soft 不进卡、hard 保留；默认 false ⇒ soft 仍在」，401 条全绿 |
| 12 局真实会话首条消息 | **默认与开启结果一致**（这 12 局的首条消息都没命中 preference 条目）⇒ 暂无可观测差异 |
| 目标会话 ep-8cc34e32 | 两种配置均 5 行、无 `理由：`/`你持续去` 行（说明卡片内容随时点/命中变化，之前的样本不可复现） |

## 结论
- 开关就绪、默认关、有单测；**不是"已修好噪声"，而是"修好噪声的开关已接好"**。
- 要在真实卡片上看到差异，需要一次命中 soft 偏好的会话；`replay-live` 的 12 局里没有——如实记录。
