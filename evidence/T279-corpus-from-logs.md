# T279 · 换成"有记忆命中的历史局"复算 T267（只读）

> `[本] 2026-11-06 01:40 +08:00` · **只读**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 语料：`tmp/t279-corpus-100.jsonl`（**100 行 / 20 局 / 3 个 scope**）· 复算：`scripts/t267-replay.mjs`
> 构造器：`scripts/t267-corpus-from-logs.mjs`（只读）

## 0 · 一句话结论

**T267 的"合法信号扩展"没有收益，而且净亏。** 同一批 81 条可判定语料上：**A 路严格 79/81 = 97.53%**（Wilson [91.44%, 99.32%]），**B 路 76/81 = 93.83%**（[86.35%, 97.33%]）——**B 比 A 少 3 条**（delta：B 新增 2 条、丢掉 5 条）。
更关键：那 **2 条"新增命中"全部落在"A 完全无重合"的样本上**（`negativeControl` 2/2 = 100%），**是造命中，不是召回**。

## 1 · 语料（20 局 / 3 个 scope，全部非本仓）

```
$ node scripts/t267-corpus-from-logs.mjs --out tmp/t279-corpus-100.jsonl --injections 5
rows: 100  episodes: 20  scopes: 3
ep-62bcb7d2 DSH-GO              inj=5 fail=192
ep-c0a5847a DSH-GO              inj=5 fail=171
ep-226dbf4f DSH-GO              inj=5 fail=95
ep-a402124a DSH-GO              inj=5 fail=32
ep-dfcb9d72 DSH-GO              inj=5 fail=27
ep-82121b88 DSH-GO              inj=5 fail=26
ep-bb9dda01 DSH-GO              inj=5 fail=25
ep-1e82afca default-workspace   inj=5 fail=226
ep-00b50089 default-workspace   inj=5 fail=46
ep-a09a4535 default-workspace   inj=5 fail=25
ep-be77dd49 default-workspace   inj=5 fail=16
ep-0ef39d3a default-workspace   inj=5 fail=15
ep-9becea64 default-workspace   inj=5 fail=14
ep-2ddf0a19 default-workspace   inj=5 fail=13
ep-bde12afa default-workspace   inj=5 fail=111
ep-fdd814b1 default-workspace   inj=5 fail=27
ep-8e4a963b default-workspace   inj=5 fail=20
ep-a1400ad0 default-workspace   inj=5 fail=20
ep-b5586316 default-workspace   inj=5 fail=20
ep-d62a520c default-workspace   inj=5 fail=18
```

- **选局规则**：`scope ≠ 本仓`（排除 `w:d:/deepseek harness/default-workspace/长期记忆系统`）+ 按 `signals.failures` 降序（有失败签名才有"该召回的教训"）。
- **覆盖 3 个 scope**：`DSH-GO` / `…/default-workspace` / `e:/Documents/deepseek-harness/default-workspace`。
- **每条语料只含注入点之前**：`rowsFromEvents` 只取 `seq ≤ injectionSeq` 的消息（注入点 = 每个 `tool/result`），且必须含至少一条 `user` 消息 —— 满足 T264 的硬约束。

## 2 · 复算结果（A/B 双路）

```
$ node scripts/t267-replay.mjs --corpus tmp/t279-corpus-100.jsonl
{
  "sampled": 100, "n": 81, "unverified": 19,
  "A": { "strict": 79, "related": 79 },
  "B": { "strict": 76, "related": 76 },
  "delta": { "strict": 2, "related": 2 },
  "wilson": {
    "A": { "phat": 0.9753, "lower": 0.9144, "upper": 0.9932, "n": 81 },
    "B": { "phat": 0.9383, "lower": 0.8635, "upper": 0.9733, "n": 81 }
  },
  "negativeControl": { "n": 2, "falsePositives": 2, "rate": 1,
    "note": "代理口径：A 路无任何重合的样本上，B 路判 related 的比例（理想 0）" },
  "elapsedSec": 363.5
}
```

| 路 | 严格命中 | 严格率 | Wilson 95% | 相对 A |
|---|---|---|---|---|
| **A**（现状信号） | 79/81 | **97.53%** | [91.44%, 99.32%] | — |
| **B**（T267 合法扩展：+消息内实体） | 76/81 | **93.83%** | [86.35%, 97.33%] | **−3 条** |

- `delta.strict = 2`：**B 命中而 A 未命中**的行数（B 的确"补"了 2 条）。
- 但 A 79 > B 76 ⇒ **B 同时丢掉 5 条**（加实体改变了 walk 排序，把原本命中的挤出去了）。
- **净效应 = −3 条**（79 → 76）。

## 3 · 那 2 条"新增命中"是什么

```
"negativeControl": { "n": 2, "falsePositives": 2, "rate": 1 }
```

- `negativeControl` 的口径：**A 路完全无重合（overlap=0 且 entityHit=0）的样本**上，B 路仍判 related 的比例 —— **理想 0**（新信号只该补召回，不该造命中）。
- 实测 **2/2 = 100%**：B 的全部"新增命中"恰好就是这 2 条"连一个判别词都不重合"的样本。
⇒ **这 2 条不是召回，是噪声**（实体桥在 A 完全没有可召回的信号时硬造出 related）。

## 4 · 与 T278 的对比（语料换对了没）

| | T278 | T279（本刀） |
|---|---|---|
| 语料 | 本仓 scope 的会话 | **3 个非本仓 scope、20 局** |
| A 严格 | **0/1233** | **79/81 = 97.53%** |
| 卡是否为空 | 空（`nonEmptyCards: 0`） | 非空（related 79/81） |
| 结论 | 语料不合格（无货可召） | **语料合格**（A > 0 且接近天花板） |

⇒ T278 的 0 确实是**语料造成的**；换成有命中的历史局后，A 路立刻到了 97.5%。

## 5 · 判据与结论

**判据（写死）**：B 要有收益 ⇒ `delta.strict > 0` **且** `negativeControl.rate` 显著低于 A 的误判基线。

**实测**：`delta.strict = 2`（看似 +2），但 **B 净 −3**（丢 5 补 2），且**新增的 2 条全部来自 A 无重合样本**（negativeControl 100%）。

⇒ **T267 的合法信号扩展没有收益，建议维持 A**。

**为什么不能只看 delta=2**：delta 只数"B 独有"，不数"B 丢掉的"；而 negativeControl 显示这 2 条是噪声。**净效应 −3 才是真相。**

## 6 · 局限（如实）

- 81/100 可判定，**19 条 unverified**（单行超 5s 超时）——语料里有的局日志 5 万+ 事件，walk 很贵。
- 语料按"每局前 5 个注入点"取样，不是全量；但覆盖 20 局 / 3 scope，**A 路 97.5% 已接近天花板**，即使全量也不会让 delta 变大（天花板效应）。
- `elapsedSec 363.5`（6 分钟）：复算性能比 T278 的 27.2s 慢 13×，因为这次语料的 scope 真的能命中（walk 走满深度）。

## 7 · 复现

```bash
node scripts/t267-corpus-from-logs.mjs --out tmp/t279-corpus-100.jsonl --injections 5
node scripts/t267-replay.mjs --corpus tmp/t279-corpus-100.jsonl
```
