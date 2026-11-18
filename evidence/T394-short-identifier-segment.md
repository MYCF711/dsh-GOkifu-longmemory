# T394 · 短标识符必须整词出现（`ui api db` 命中 247 → 186）

> 2026-11-19 · T393 的续刀。`api` / `ui` / `add` 这类短标识符仍会"钻"进长串中间。

## 一、实测（真库 topics 6593）

| 信号 | T393 后 | T394 后 |
|---|---|---|
| `ui api db` | **247** | **186** |
| `add a button` | 33 | **10** |
| `扫描隐私 头部 没找到` | 3 | **3** |
| `scanPrivacy 头部没找到` | 3 | **3** |

## 二、修复

`overlaps()` 增加一条：**短的一侧是纯 ASCII 且 ≤5 字符 ⇒ 必须作为整段出现**（按非字母数字切段后 `includes`）。

```js
if (shorter.length <= 5 && /^[a-z0-9][a-z0-9_.-]*$/.test(shorter)) {
  return longer.split(/[^a-z0-9]+/).includes(shorter);
}
```

**中文不走这条**：中文没有分隔符，子串匹配本来就是对的（中文噪声由 T392 停用词挡）。

## 三、还剩多少（诚实）

`ui api db` 仍命中 186 —— 这些是 `api-terminal-controller`、`ui-settings`、`db.js` 这类**整段命中**，
按现行规则是"合法"的。要再降就得引入「命中数上限」或「最少不同词数」这类阈值，
那会改变召回语义（**有代价**）⇒ 记入待决策清单，不自裁。

## 四、门禁

```
node --test "test/*.test.mjs"   → 1302 / 1296 通过 / 0 失败 / 6 跳过
node scripts/metrics-guard.mjs  → PASS
  A2b 严格=46.6% 覆盖=79.7%（n=118）  ← 与修复前逐项相同
```
