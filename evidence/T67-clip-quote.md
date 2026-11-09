# T67 · 引文截断加了省略号：`support.quote` 因此**必然**不是原文子串

> 2026-11-09 · 接 T66 的分桶诊断。这条是 T66 里"整局找不到"那一桶的一个**机械可修**子集。

## 一、病灶

`clip()` 截断长文本时会**追加一个 `…`**：

```js
function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}
```

而 `support.quote` 的契约是「**必须是 (episode, seq) 原文的逐字子串**」—— 它是个**可机械核验的出处指针**，不是展示文本。
往里面塞一个原文没有的 `…`，等于让每一条超长引文**必然**判红。

**实测**（4315 条 support 引用）：

```
以 … 结尾 : 400 条（9.3%）
长度 ≥199 : 405 条
```

## 二、改法

新增 `clipQuote(text, max)`：**同样的空白归一 + 截断，但不加省略号**。
展示层要省略号就在渲染时加，别写进证据字段。

改到的位置（都是"引文"语义）：

- `src/rooms/claim.mjs`：6 处 `addSupport(...)` / `support.push(...)` 的 `quote:`；
- `src/rooms/extract.mjs`：`deriveFalsifiableWhen()` 的 `text-pattern` 引文。

`clip()` 本身**不动**（它还给 `claim.text` 之类的展示字段用）。

## 三、验收

```
node --test test/t67-clip-quote.test.mjs → 3/3
  ✔ ① 截断后仍然是原文的**逐字子串**（且不以 … 结尾）
  ✔ ② 短引文原样返回；空白归一（与审计口径一致）
  ✔ ③ 空值不炸

node --test "test/*.test.mjs" → 1266 条 / 1260 pass / 0 fail / 6 skip
node scripts/check.mjs        → PASS
```

## 四、诚实说明：**指标不会立刻变**

`support.quote` 是**只增不改**的数据（AGENTS §2.3）。这次改的是**生成侧**：

- **新归档的 claim** 不再带 `…` ⇒ 那 9.3% 会随新数据消失；
- **已有的 400 条**保持原样 —— 不做回填改写（那会破"只增不改"，而且改写证据字段比留着更危险）。

所以 `provenance-p2` 的 `ok` 数**这一版不会跳**，要从新 claim 上看。

## 五、过程中的一个教训（记下来）

我第一版只改了 `extract.mjs` 的**调用点**、没插进函数定义（脚本里 `if anchor in s` 没命中却仍打印了成功），
于是 `clipQuote is not defined` 被归档管线的 `try/catch` 吞成 `skipped` ⇒ **一条 claim 都产不出来**。
是**全量测试**（45 条红）抓住的，不是代码审查。

**纪律**：改完必须跑全量；`check.mjs`（只查文档/台账）**不会**发现这类问题。
