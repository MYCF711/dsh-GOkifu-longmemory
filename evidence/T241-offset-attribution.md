# T241 · `offset` 到底偏多少？（归因，只诊断）

> `[本] 2026-11-05T08:11:44.134Z` · **只读**：不写库、不改任何判据；未跑全量测试、未重启 DSH。
> 脚本 `scripts/offset-attribution.mjs` · 复现用 `scripts/audit-card-samples.mjs` 的 `auditRows`（window=±10）

## 0 · 一句话

**两个数测的不是同一件事**：T232 量的是"把 ±4 seq 的偏移算成失败"（母集 = 全库 2455 条 support，单位 = `support.quote`，容差 0）；T239 量的是"超过 ±10 seq 才算 offset"（母集 = 抽样 1199 条卡片引用，单位 = 卡片行正文，容差 ±10）。所以 T232 的 `1–4: 1455` 在 T239 的尺子下**根本不会进 offset**（≤10 记 at-seq）。

## 1 · 复现 T239（原样）

```
card-samples 576 行 · 引用 1199 条 · window=±10
offset 98（near≤20: 4 / far: 94）· 中位距离 4994
```

## 2 · 94 条远偏移的 distance 直方图

```
1-4     0
5-20    4
21-100  0
>100    94
```

（far 定义就是 >20，所以前两档必为 0 —— 这本身就是对账的一部分：T232 的 `1–4` 与 T239 的 `far` **不可能有交集**。）

## 3 · 94 条远偏移的"同一次 vs 另一次"

```
{
 "different-occurrence": 94
}
```

判据：用卡片正文（quote）在**命中 seq** 与**声明 seq** 各取前后 40 字；两段逐字相同 ⇒ `same-occurrence`；声明那格没有这段文字 ⇒ `different-occurrence`（= 另一次出现）；声明那格根本没有文本 ⇒ `no-text-at-declared`。

## 4 · 逐条清单（94 条远偏移）

| # | claim | episode | seq_on_card | seq_found | distance | 同一次/另一次 | claim引文的最近距离 |
|---|---|---|---|---|---|---|---|
| 1 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 2 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 3 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 4 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 5 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 6 | c-1804dc2b,c-d296e620 | ep-8cc34e32 | 2560 | 4744 | 2184 | different-occurrence | 2567（差 7） |
| 7 | c-5175f1dc | ep-8cc34e32 | 17371 | 21414 | 4043 | different-occurrence | 17373（差 2） |
| 8 | c-5175f1dc | ep-fbb43571 | 290 | 1574 | 1284 | different-occurrence | 292（差 2） |
| 9 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 10 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 11 | c-13f0ea15 | ep-c0a5847a | 37854 | 42554 | 4700 | different-occurrence | 37856（差 2） |
| 12 | c-5175f1dc | ep-c0a5847a | 322 | 40751 | 40429 | different-occurrence | 324（差 2） |
| 13 | c-2d4fdcf7 | ep-8a73e06b | 1149 | 35882 | 34733 | different-occurrence | 1151（差 2） |
| 14 | c-4531a6d0 | ep-8a73e06b | 33333 | 35882 | 2549 | different-occurrence | 48959（差 15626） |
| 15 | c-5175f1dc | ep-8a73e06b | 810 | 35882 | 35072 | different-occurrence | 812（差 2） |
| 16 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 17 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 18 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 19 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 20 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 21 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 22 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 23 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 24 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 25 | c-13f0ea15 | ep-c0a5847a | 37854 | 42554 | 4700 | different-occurrence | 37856（差 2） |
| 26 | c-5175f1dc | ep-c0a5847a | 322 | 40751 | 40429 | different-occurrence | 324（差 2） |
| 27 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 28 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 29 | c-1804dc2b,c-d296e620 | ep-8cc34e32 | 2560 | 4744 | 2184 | different-occurrence | 2567（差 7） |
| 30 | c-5175f1dc | ep-8cc34e32 | 17371 | 21414 | 4043 | different-occurrence | 17373（差 2） |
| 31 | c-1804dc2b,c-d296e620 | ep-8cc34e32 | 2560 | 4744 | 2184 | different-occurrence | 2567（差 7） |
| 32 | c-5175f1dc | ep-8cc34e32 | 17371 | 21414 | 4043 | different-occurrence | 17373（差 2） |
| 33 | c-1804dc2b,c-d296e620 | ep-8cc34e32 | 2560 | 4744 | 2184 | different-occurrence | 2567（差 7） |
| 34 | c-5175f1dc | ep-8cc34e32 | 17371 | 21414 | 4043 | different-occurrence | 17373（差 2） |
| 35 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 36 | c-13f0ea15 | ep-c0a5847a | 37854 | 42554 | 4700 | different-occurrence | 37856（差 2） |
| 37 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 38 | c-5175f1dc,c-5175f1dc | ep-62bcb7d2 | 331 | 6547 | 6216 | different-occurrence | 333（差 2） |
| 39 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 40 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 41 | c-13f0ea15 | ep-c0a5847a | 37854 | 42554 | 4700 | different-occurrence | 37856（差 2） |
| 42 | c-5175f1dc | ep-c0a5847a | 322 | 40751 | 40429 | different-occurrence | 324（差 2） |
| 43 | c-13f0ea15 | ep-c0a5847a | 37854 | 42554 | 4700 | different-occurrence | 37856（差 2） |
| 44 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 45 | c-5175f1dc,c-5175f1dc | ep-62bcb7d2 | 331 | 6547 | 6216 | different-occurrence | 333（差 2） |
| 46 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 47 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 48 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 49 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 50 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 51 | c-1804dc2b,c-d296e620 | ep-8cc34e32 | 2560 | 4744 | 2184 | different-occurrence | 2567（差 7） |
| 52 | c-5175f1dc | ep-8cc34e32 | 17371 | 21414 | 4043 | different-occurrence | 17373（差 2） |
| 53 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 54 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 55 | c-13f0ea15 | ep-c0a5847a | 37854 | 42554 | 4700 | different-occurrence | 37856（差 2） |
| 56 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 57 | c-5175f1dc,c-5175f1dc | ep-62bcb7d2 | 331 | 6547 | 6216 | different-occurrence | 333（差 2） |
| 58 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 59 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 60 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 61 | c-13f0ea15 | ep-c0a5847a | 37854 | 42554 | 4700 | different-occurrence | 37856（差 2） |
| 62 | c-5175f1dc | ep-c0a5847a | 322 | 40751 | 40429 | different-occurrence | 324（差 2） |
| 63 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 64 | c-13f0ea15 | ep-c0a5847a | 37854 | 42554 | 4700 | different-occurrence | 37856（差 2） |
| 65 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 66 | c-5175f1dc,c-5175f1dc | ep-62bcb7d2 | 331 | 6547 | 6216 | different-occurrence | 333（差 2） |
| 67 | c-13f0ea15 | ep-c0a5847a | 37854 | 42554 | 4700 | different-occurrence | 37856（差 2） |
| 68 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 69 | c-5175f1dc,c-5175f1dc | ep-62bcb7d2 | 331 | 6547 | 6216 | different-occurrence | 333（差 2） |
| 70 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 71 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 72 | c-13f0ea15 | ep-c0a5847a | 37854 | 42554 | 4700 | different-occurrence | 37856（差 2） |
| 73 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 74 | c-5175f1dc,c-5175f1dc | ep-62bcb7d2 | 331 | 6547 | 6216 | different-occurrence | 333（差 2） |
| 75 | c-1804dc2b,c-d296e620 | ep-8cc34e32 | 2560 | 4744 | 2184 | different-occurrence | 2567（差 7） |
| 76 | c-5175f1dc | ep-8cc34e32 | 17371 | 21414 | 4043 | different-occurrence | 17373（差 2） |
| 77 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 78 | c-2d4fdcf7 | ep-8a73e06b | 1149 | 35882 | 34733 | different-occurrence | 1151（差 2） |
| 79 | c-4531a6d0 | ep-8a73e06b | 33333 | 35882 | 2549 | different-occurrence | 48959（差 15626） |
| 80 | c-5175f1dc | ep-8a73e06b | 810 | 35882 | 35072 | different-occurrence | 812（差 2） |
| 81 | c-13f0ea15 | ep-c0a5847a | 37854 | 42554 | 4700 | different-occurrence | 37856（差 2） |
| 82 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 83 | c-5175f1dc,c-5175f1dc | ep-62bcb7d2 | 331 | 6547 | 6216 | different-occurrence | 333（差 2） |
| 84 | c-13f0ea15 | ep-c0a5847a | 37854 | 42554 | 4700 | different-occurrence | 37856（差 2） |
| 85 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 86 | c-5175f1dc,c-5175f1dc | ep-62bcb7d2 | 331 | 6547 | 6216 | different-occurrence | 333（差 2） |
| 87 | c-13f0ea15 | ep-c0a5847a | 37854 | 42554 | 4700 | different-occurrence | 37856（差 2） |
| 88 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 89 | c-5175f1dc,c-5175f1dc | ep-62bcb7d2 | 331 | 6547 | 6216 | different-occurrence | 333（差 2） |
| 90 | c-2d4fdcf7 | ep-62bcb7d2 | 1141 | 6135 | 4994 | different-occurrence | 1143（差 2） |
| 91 | c-5175f1dc | ep-226dbf4f | 486 | 11029 | 10543 | different-occurrence | 488（差 2） |
| 92 | c-2d4fdcf7 | ep-8a73e06b | 1149 | 35882 | 34733 | different-occurrence | 1151（差 2） |
| 93 | c-4531a6d0 | ep-8a73e06b | 33333 | 35882 | 2549 | different-occurrence | 48959（差 15626） |
| 94 | c-5175f1dc | ep-8a73e06b | 810 | 35882 | 35072 | different-occurrence | 812（差 2） |

## 5 · 抽样 10 条逐字对照

### 1. `c-2d4fdcf7` · ep-62bcb7d2 · 卡片 seq 1141 → 命中 seq 6135（差 4994）

- 判定：**different-occurrence**
- 卡片正文：`Error: old_string was not found in "/d/DeepSeek Harness/default-workspace/DSH-GO/modules/exec/bash/bash_test.go"`
- 命中处上下文（±40）：`…, 2026-11-02, seq 3466) - [antipattern] [正文] (ep-62bcb7d2, 2026-11-02, seq 1141) - […`
- 声明处上下文：**没有这段正文**（与声明的文字最长公共子串 = 10 字符）

### 2. `c-5175f1dc` · ep-226dbf4f · 卡片 seq 486 → 命中 seq 11029（差 10543）

- 判定：**different-occurrence**
- 卡片正文：`class:fs-read-before-write · Error: cannot modify "/d/DeepSeek Harness/default-workspace/_inbox/magpie-wps-lingxi-image-`
- 命中处上下文（±40）：`…tipattern] class:fs-read-before-write · [正文] … (ep-226dbf4f, 2026-11-01, seq 486) - …`
- 声明处上下文：**没有这段正文**（与声明的文字最长公共子串 = 17 字符）

### 3. `c-2d4fdcf7` · ep-62bcb7d2 · 卡片 seq 1141 → 命中 seq 6135（差 4994）

- 判定：**different-occurrence**
- 卡片正文：`Error: old_string was not found in "/d/DeepSeek Harness/default-workspace/DSH-GO/modules/exec/bash/bash_test.go"`
- 命中处上下文（±40）：`…, 2026-11-02, seq 3466) - [antipattern] [正文] (ep-62bcb7d2, 2026-11-02, seq 1141) - […`
- 声明处上下文：**没有这段正文**（与声明的文字最长公共子串 = 10 字符）

### 4. `c-5175f1dc` · ep-226dbf4f · 卡片 seq 486 → 命中 seq 11029（差 10543）

- 判定：**different-occurrence**
- 卡片正文：`class:fs-read-before-write · Error: cannot modify "/d/DeepSeek Harness/default-workspace/_inbox/magpie-wps-lingxi-image-`
- 命中处上下文（±40）：`…tipattern] class:fs-read-before-write · [正文] … (ep-226dbf4f, 2026-11-01, seq 486) - …`
- 声明处上下文：**没有这段正文**（与声明的文字最长公共子串 = 17 字符）

### 5. `c-5175f1dc` · ep-226dbf4f · 卡片 seq 486 → 命中 seq 11029（差 10543）

- 判定：**different-occurrence**
- 卡片正文：`class:fs-read-before-write · Error: cannot modify "/d/DeepSeek Harness/default-workspace/_inbox/magpie-wps-lingxi-image-`
- 命中处上下文（±40）：`…tipattern] class:fs-read-before-write · [正文] … (ep-226dbf4f, 2026-11-01, seq 486) - …`
- 声明处上下文：**没有这段正文**（与声明的文字最长公共子串 = 17 字符）

### 6. `c-1804dc2b,c-d296e620` · ep-8cc34e32 · 卡片 seq 2560 → 命中 seq 4744（差 2184）

- 判定：**different-occurrence**
- 卡片正文：`class:sandbox-limit · Error: tool call aborted`
- 命中处上下文（±40）：`…4c84 call_1be0a04463fb4cc5bfeb4c84 text [正文] e0f92b46-2491-4a70-8def-95516bdefdb3 Ab…`
- 声明处上下文：**没有这段正文**（与声明的文字最长公共子串 = 6 字符）

### 7. `c-5175f1dc` · ep-8cc34e32 · 卡片 seq 17371 → 命中 seq 21414（差 4043）

- 判定：**different-occurrence**
- 卡片正文：`class:fs-read-before-write · Error: cannot modify "/d/DeepSeek Harness/default-workspace/_inbox/magpie-wps-lingxi-image-`
- 命中处上下文（±40）：`…tipattern] class:fs-read-before-write · [正文] … (ep-8cc34e32, 2026-11-01, seq 17371) …`
- 声明处上下文：**没有这段正文**（与声明的文字最长公共子串 = 18 字符）

### 8. `c-5175f1dc` · ep-fbb43571 · 卡片 seq 290 → 命中 seq 1574（差 1284）

- 判定：**different-occurrence**
- 卡片正文：`class:fs-read-before-write · Error: cannot modify "/d/DeepSeek Harness/default-workspace/_inbox/magpie-wps-lingxi-image-`
- 命中处上下文（±40）：`…tipattern] class:fs-read-before-write · [正文] … (ep-f46d6330, 2026-11-01, seq 535) - …`
- 声明处上下文：**没有这段正文**（与声明的文字最长公共子串 = 10 字符）

### 9. `c-2d4fdcf7` · ep-62bcb7d2 · 卡片 seq 1141 → 命中 seq 6135（差 4994）

- 判定：**different-occurrence**
- 卡片正文：`Error: old_string was not found in "/d/DeepSeek Harness/default-workspace/DSH-GO/modules/exec/bash/bash_test.go"`
- 命中处上下文（±40）：`…, 2026-11-02, seq 3466) - [antipattern] [正文] (ep-62bcb7d2, 2026-11-02, seq 1141) - […`
- 声明处上下文：**没有这段正文**（与声明的文字最长公共子串 = 10 字符）

### 10. `c-5175f1dc` · ep-226dbf4f · 卡片 seq 486 → 命中 seq 11029（差 10543）

- 判定：**different-occurrence**
- 卡片正文：`class:fs-read-before-write · Error: cannot modify "/d/DeepSeek Harness/default-workspace/_inbox/magpie-wps-lingxi-image-`
- 命中处上下文（±40）：`…tipattern] class:fs-read-before-write · [正文] … (ep-226dbf4f, 2026-11-01, seq 486) - …`
- 声明处上下文：**没有这段正文**（与声明的文字最长公共子串 = 17 字符）

## 6 · 与 T232 的对账

- T232 母集 = **全库 claim 的 support 条目 2468 条**，单位 = `support.quote`；
- T232 的判定是**严格 at-seq**（距离 0 才算 ok），所以"偏 1–4 个 seq"在它那里算失败、在 T239 那里算 `at-seq`（≤±10）；
- T239 母集 = **抽样 1199 条卡片引用**（564 份卡片的行），单位 = 卡片渲染行正文（已被单行化、可能被截断）；
- 交叉验证：94 条 far 里能对回 claim support 的 94 条，其中 claim 引文在 T232 口径下 **≤4 seq 就命中** 的 85 条 ⇒ 仍有一批属同一现象，需单独列出。
- **自指命中（根因）**：94 条 far 里 **88 条**的"命中处"本身就是一张**记忆卡**（文本里带 `[antipattern]` 之类的 marker 与 `(ep-…, date, seq N)` 尾巴） ⇒ 卡片正文只在"被注入过的卡片"里出现过，**不在原始事件里** —— 不是指针错位，是拿改写过的正文去追原文。

## 7 · T232 口径的同库实测（同一次运行里的 `auditP2`）

```
refs 2468 · ok 373 · not-substring 2095 · unreadable 0 · 涉及 claim 1465 个
not-substring 的最近逐字距离分布：{"1-4":730,"not-found":1099,">100":107,"21-100":4,"5-20":155}
其中 ≤4 seq：refs 730 条，但只来自 269 个 claim（同一 claim 的多条 support 会重复计数）
```

⇒ T232 报的 `1–4` 是 **support 条目数**，T239 的 97 是 **卡片引用数** —— 母集不同、单位不同。

