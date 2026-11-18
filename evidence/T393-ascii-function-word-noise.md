# T393 · 命中面收窄（下）：英文虚词做子串重叠 ⇒ 随口一句话命中 99 个主题

> 2026-11-19 · T392 的下半刀。T392 挡住了中文通用时间词，这刀挡英文虚词。

## 一、实测（生产同一套 `matchTopics` + 真库 topics 6593）

| 信号 | 修复前命中 | 修复后 |
|---|---|---|
| `hello there how are you` | **99** | **0** |
| `let me think about it` | 33 | **0** |
| `扫描隐私 头部 没找到`（真实报错） | 3 | **3** |

修复前 `hello there how are you` 的前三个命中：

```
lmy414/magpie-agent-tare:repo
perfare/il2cppdump:repo
perfare/il2cppdumper:repo
```

## 二、根因

`walk.mjs` 的 `overlaps(needle, key)` 用的是**双向子串判定**（`x.includes(y) || y.includes(x)`）。
于是三个字母的英文虚词在长仓库名里必定撞上：

```
are  ⊂  lmy414/magpie-agent-tare
you  ⊂  …（同类）
how  ⊂  …
```

一句寒暄就能命中近百个 repo 主题 ⇒ 建卡、注入，全是噪声。

## 三、修复

`overlaps` 里加一道闸：**英文虚词只允许完全相等，不许子串重叠**。

```js
const asciiFuncWord = (v) => v.length <= 7 && /^[a-z]+$/.test(v) && ASCII_FUNC_WORDS.has(v);
if (asciiFuncWord(x) || asciiFuncWord(y)) return x === y;
```

`ASCII_FUNC_WORDS` 只收**虚词/高频动词**（`the/and/are/is/how/you/this/that/let/think/know/…`），
**不收名词与标识符** —— 所以 `scanPrivacy`、`dsh-gokifu-longmemory` 这类仍然照常做子串匹配。

> 第一版写的是"**所有**短 ASCII（<5 字符）都不许子串"，结果打红
> `test/walk.test.mjs` 的「R11 作用域: scope 缺失 ⇒ 降级为只放用户层」（该用例靠"claim 文本包含短 key"进来）。
> 改成**只挡虚词**之后 41/41 全绿 —— 这条差别就是"挡噪声"与"挡功能"的分界。

## 四、门禁

```
node --test "test/*.test.mjs"   → 1302 / 1296 通过 / 0 失败 / 6 跳过
node scripts/metrics-guard.mjs  → PASS
  A2b 严格=46.6% 覆盖=79.7%（n=118）   ← 与修复前逐项相同，召回没掉
```

## 五、边界

- 只挡英文虚词；**缩写/短标识符**（如 `ui`、`api`、`db`）仍可能子串撞，属下一刀。
- 中文侧见 T392（通用时间/寒暄词）。
