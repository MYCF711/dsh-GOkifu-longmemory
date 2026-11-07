# T5 · 跨语言「成功/完成」信号映射

> `[本] 2026-11-07` · `src/rooms/abstain.mjs` · 测试 `test/abstain.test.mjs`

## 1 · 问题

T366d 给「**失败**」做了跨语言映射：中文"安装失败" + 英文 `Error: tool call aborted` 讲的是同一件事，
字面零重合，不做映射就会被判成「不相关」而**误杀**（实测 ep-75e7347e）。

但**成功/完成**这一侧一直是空的：

| 信号（用户原话） | claim（工具输出） | 修前 | 修后 |
|---|---|---|---|
| 测试跑通了 | `all tests passed` | 判不相关 ⇒ 误杀 | **相关** |
| 装好了 | `[exit code: 0]` | 判不相关 ⇒ 误杀 | **相关** |
| 这次终于成功了 | `Build success` | 判不相关 ⇒ 误杀 | **相关** |

## 2 · 做法

与失败映射**同构**（同样只认「**中文信号 + 英文 claim**」这一个方向——信号来自用户原话，
claim 来自英文工具输出，反方向没有实际来源）：

```js
isCrossLingualSuccessMatch(signalText, claimText)
  = hasChineseSuccessSignal(signalText) && hasEnglishSuccessSignal(claimText)
```

接进 `hasRelevantClaim` 的判定链（紧挨失败映射那一条），**先于**词重合判据。

## 3 · 词表为什么是这几个（这是本刀最要紧的部分）

```js
const SUCCESS_ZH = ['成功', '跑通', '装好', '搞定', '修好', '已完成', '全部通过', '测试通过', '通过了', '没问题了', '能用了'];
const SUCCESS_EN = /\b(pass|passed|passes|passing|success|successful|succeed|succeeded|all green)\b|\[exit code:\s*0\]/i;
```

**`通过` 单独不进表** —— 它在中文里兼作**介词**：「通过代理访问这个地址」不含任何成功语义，
单用会把无关内容判成相关。只有「全部通过 / 测试通过」这种**完成语义明确**的组合才收。

**`完成` 也不进表** —— 「完成任务」≠ 成功，太宽。

这两条是**故意排除**的，测试里有反例钉住（`hasChineseSuccessSignal('通过代理访问这个地址') === false`）。

## 4 · 不误判（验收 ② 的实证）

| 输入 | 期望 | 实测 |
|---|---|---|
| `isCrossLingualSuccessMatch('成功了', '今天天气不错，适合出去散步')` | false（英文里没有成功信号） | **false** |
| `isCrossLingualSuccessMatch('成功了', 'Error: tool call aborted')` | false（英文是**失败**信号） | **false** |
| `hasChineseSuccessSignal('通过代理访问这个地址')` | false（`通过` 兼作介词） | **false** |
| `hasChineseSuccessSignal('测试通过')` | true（完成语义明确） | **true** |

## 5 · 验收

| 项 | 结果 |
|---|---|
| ① 新增 `isCrossLingualSuccessMatch(signal, claimText)` | ✅ 导出，已接进 `hasRelevantClaim` |
| ② 中文"成功" + 英文无关内容 ⇒ **不算相关** | ✅ 见 §4 |
| ③ 与 `isCrossLingualFailureMatch` 同一判据形态（可复用、可单测） | ✅ 同构：`hasChineseX && hasEnglishX` |
| ④ `node --test test/abstain.test.mjs` | ✅ **17 条 / 17 pass / 0 fail** |

## 6 · 未验 / 边界

- 只做了「中文信号 + 英文 claim」一个方向（与失败映射同形）。反方向（英文信号 + 中文 claim）
  在真实语料里没有来源，**没做**，也没声称做了。
- 词表是**手写**的，没有在 T1 标注集上跑过覆盖率 —— T2 校准可判率时应该把这个词表一起测。
