# M5 机械评测：LOO repeatFailureRate（2026-11-02）

> 生成：`node scripts/eval.mjs --root $DSH_HOME --store tmp/memory-context --evidence evidence/M5-eval.md`
> 运行时刻：2026-11-05T06:16:46.207Z（UTC；epoch ms 1793859406207）· 零模型调用 · 只读 · 耗时 14475 ms

## 1 · 口径（分子 / 分母 / 时点 / 树）

| 项 | 定义 |
|---|---|
| 失败签名 | 规范化失败原文（去绝对路径/行号列号/时间戳/十六进制；压空白；小写） |
| memory(E) | 其它 root 局中 startedAt 严格更早者（不用未来信息；同一时刻互不可见） |
| repeat(E) | E 的签名 ∈ memory 的条数（按"每局每签名一次"计） |
| novel(E) | E 的签名 ∉ memory 的条数 |
| **repeatFailureRate** | **Σrepeat ÷ (Σrepeat + Σnovel)；分母 0 ⇒ null** |
| 无记忆基线 | 0（没有 memory 时每条签名都是 novel） |
| coverage | 有 ≥1 条失败签名的 root 局数 ÷ 全部 root 局数 |
| 时点 | startedAt（会话 header.createdAt，epoch ms） |

**分子** = Σrepeat（逐局把"签名已在更早的局里出现过"的条数相加，同一局同一签名只算一次）。
**分母** = Σrepeat + Σnovel = 有失败签名的局里"每局去重后签名"的总条数。分母为 0 时输出 `null`，不写 0。
**树 / 语料**：工作树 `tmp/memory-context`（入档产物）+ 只读原件 `$DSH_HOME/sessions`、`$DSH_HOME/chess-context`。

## 2 · 三口径对照（同一批 root 局，失败来源不同）

| 口径 | root 局 | 有签名 | coverage | repeat | novel | repeatFailureRate |
|---|---|---|---|---|---|---|
| `both` | 116 | 93 | 80.2% | 234 | 1130 | **17.2%** |
| `edge` | 116 | 80 | 69.0% | 228 | 1067 | **17.6%** |
| `event` | 116 | 83 | 71.6% | 144 | 581 | **19.9%** |

- `edge` = R03 `extractSignals` 的失败边（方案 §8.2 的原始口径）；真实语料只有部分局有棋谱 ⇒ coverage 低。
- `event` = 事件侧兜底（`tool/result` 以 `[exit code: N≠0]` 结尾，DSH 自己的标记）；覆盖没有棋谱的局。
- `both`（本文件主口径）= 逐局**优先 edge**，该局没有失败边时回退 event（不重复计入）。

## 3 · 主口径结果（`both`）

- root 局 **116** · 有失败签名 **93**（coverage **80.2%**）
- 签名总数 **1364** · 去重后 **1130** · 出现重复的局 **70**
- **repeat 234 / novel 1130 ⇒ repeatFailureRate = 17.2%**（无记忆基线 0）

### 3.1 逐局表

| # | 日期(UTC) | episode | 失败来源 | 局内签名 | repeat | novel | 逐局率 | memorySize | scope |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-01 | `ep-1710f716` | event | 3 | 0 | 3 | 0.0% | 0 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 2 | 2026-11-01 | `ep-1e82afca` | edge | 106 | 0 | 106 | 0.0% | 3 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 3 | 2026-11-01 | `ep-3618a34d` | event | 3 | 0 | 3 | 0.0% | 109 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 4 | 2026-11-01 | `ep-58fcbd44` | event | 4 | 1 | 3 | 25.0% | 112 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 5 | 2026-11-01 | `ep-270b3a27` | event | 1 | 0 | 1 | 0.0% | 115 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 6 | 2026-11-01 | `ep-7f89d80e` | none | 0 | 0 | 0 | n/a | 116 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 7 | 2026-11-01 | `ep-08e54b9c` | none | 0 | 0 | 0 | n/a | 116 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 8 | 2026-11-01 | `ep-1a49c80a` | event | 8 | 0 | 8 | 0.0% | 116 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 9 | 2026-11-01 | `ep-ee0d63a9` | event | 8 | 0 | 8 | 0.0% | 124 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 10 | 2026-11-01 | `ep-e3ed4aa3` | event | 1 | 0 | 1 | 0.0% | 132 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 11 | 2026-11-01 | `ep-411a2729` | event | 4 | 1 | 3 | 25.0% | 133 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 12 | 2026-11-01 | `ep-b9be6b6f` | event | 4 | 0 | 4 | 0.0% | 136 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 13 | 2026-11-01 | `ep-6294ad9f` | event | 5 | 1 | 4 | 20.0% | 140 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 14 | 2026-11-01 | `ep-c49cc309` | none | 0 | 0 | 0 | n/a | 144 | `w:d:/tmp/hstest` |
| 15 | 2026-11-01 | `ep-d70b7c2f` | edge | 11 | 4 | 7 | 36.4% | 144 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 16 | 2026-11-01 | `ep-1286ce28` | edge | 6 | 3 | 3 | 50.0% | 151 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 17 | 2026-11-01 | `ep-a1aab8ef` | edge | 5 | 2 | 3 | 40.0% | 154 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 18 | 2026-11-01 | `ep-00b50089` | edge | 35 | 10 | 25 | 28.6% | 157 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 19 | 2026-11-01 | `ep-06f150b9` | event | 1 | 0 | 1 | 0.0% | 182 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 20 | 2026-11-01 | `ep-4d31fc71` | event | 7 | 1 | 6 | 14.3% | 183 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 21 | 2026-11-01 | `ep-df4838f0` | none | 0 | 0 | 0 | n/a | 189 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 22 | 2026-11-01 | `ep-7520721a` | edge | 1 | 0 | 1 | 0.0% | 189 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 23 | 2026-11-01 | `ep-22d3bd16` | edge | 4 | 1 | 3 | 25.0% | 190 | `w:d:/DeepSeek Harness/default-workspace` |
| 24 | 2026-11-01 | `ep-8cc34e32` | edge | 70 | 9 | 61 | 12.9% | 193 | `w:d:/DeepSeek Harness/default-workspace/长期记忆系统` |
| 25 | 2026-11-01 | `ep-75e7347e` | edge | 4 | 2 | 2 | 50.0% | 254 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 26 | 2026-11-02 | `ep-e5eb8531` | edge | 2 | 0 | 2 | 0.0% | 256 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 27 | 2026-11-02 | `ep-9becea64` | edge | 11 | 3 | 8 | 27.3% | 258 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 28 | 2026-11-02 | `ep-9d375d75` | edge | 3 | 1 | 2 | 33.3% | 266 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 29 | 2026-11-02 | `ep-ed98c462` | edge | 8 | 3 | 5 | 37.5% | 268 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 30 | 2026-11-02 | `ep-e336b9dd` | edge | 6 | 2 | 4 | 33.3% | 273 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 31 | 2026-11-02 | `ep-c0a5847a` | edge | 132 | 9 | 123 | 6.8% | 277 | `w:d:/DeepSeek Harness/default-workspace/DSH-GO` |
| 32 | 2026-11-02 | `ep-0ef39d3a` | edge | 6 | 0 | 6 | 0.0% | 400 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 33 | 2026-11-02 | `ep-8a73e06b` | edge | 76 | 20 | 56 | 26.3% | 406 | `w:d:/DeepSeek Harness/default-workspace/GOkifu上下文压缩` |
| 34 | 2026-11-02 | `ep-a09a4535` | edge | 22 | 6 | 16 | 27.3% | 462 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 35 | 2026-11-02 | `ep-d52b6ca5` | edge | 7 | 3 | 4 | 42.9% | 478 | `w:d:/DeepSeek Harness/反代` |
| 36 | 2026-11-02 | `ep-5cf57bb4` | edge | 22 | 5 | 17 | 22.7% | 482 | `w:d:/DeepSeek Harness/反代/AIysis code` |
| 37 | 2026-11-02 | `ep-8a787c9f` | edge | 1 | 0 | 1 | 0.0% | 499 | `w:d:/DeepSeek Harness/反代/AIysis code` |
| 38 | 2026-11-02 | `ep-03bc3e53` | edge | 3 | 0 | 3 | 0.0% | 500 | `w:d:/DeepSeek Harness/反代` |
| 39 | 2026-11-02 | `ep-be4fc599` | edge | 2 | 1 | 1 | 50.0% | 503 | `w:d:/DeepSeek Harness/反代` |
| 40 | 2026-11-02 | `ep-f46d6330` | edge | 13 | 2 | 11 | 15.4% | 504 | `w:d:/DeepSeek Harness/反代` |
| 41 | 2026-11-02 | `ep-578d0ef7` | none | 0 | 0 | 0 | n/a | 515 | `w:d:/DeepSeek Harness/反代` |
| 42 | 2026-11-02 | `ep-d512e747` | edge | 8 | 1 | 7 | 12.5% | 515 | `w:d:/DeepSeek Harness/反代` |
| 43 | 2026-11-02 | `ep-f7f835b1` | edge | 4 | 2 | 2 | 50.0% | 522 | `w:d:/DeepSeek Harness/反代` |
| 44 | 2026-11-02 | `ep-b8a92777` | edge | 13 | 4 | 9 | 30.8% | 524 | `w:d:/DeepSeek Harness/反代` |
| 45 | 2026-11-02 | `ep-bc4ab3cb` | edge | 9 | 1 | 8 | 11.1% | 533 | `w:d:/DeepSeek Harness/反代` |
| 46 | 2026-11-02 | `ep-ad38cf8c` | edge | 11 | 5 | 6 | 45.5% | 541 | `w:d:/DeepSeek Harness/反代` |
| 47 | 2026-11-02 | `ep-25af318d` | edge | 1 | 0 | 1 | 0.0% | 547 | `w:d:/DeepSeek Harness/反代` |
| 48 | 2026-11-02 | `ep-858445da` | event | 20 | 1 | 19 | 5.0% | 548 | `w:d:/DeepSeek Harness/default-workspace/DSH-GO` |
| 49 | 2026-11-03 | `ep-1f6c629b` | none | 0 | 0 | 0 | n/a | 567 | `w:d:/DeepSeek Harness/default-workspace` |
| 50 | 2026-11-03 | `ep-d62a520c` | edge | 17 | 6 | 11 | 35.3% | 567 | `w:d:/DeepSeek Harness/default-workspace` |
| 51 | 2026-11-03 | `ep-4188510d` | edge | 7 | 2 | 5 | 28.6% | 578 | `w:d:/DeepSeek Harness/反代/magpie-amgicrew-auth` |
| 52 | 2026-11-03 | `ep-9ce43a15` | edge | 11 | 2 | 9 | 18.2% | 583 | `w:d:/DeepSeek Harness/反代` |
| 53 | 2026-11-03 | `ep-b4664e8f` | edge | 3 | 1 | 2 | 33.3% | 592 | `w:d:/DeepSeek Harness/反代` |
| 54 | 2026-11-03 | `ep-685dfadb` | edge | 3 | 0 | 3 | 0.0% | 594 | `w:d:/DeepSeek Harness/default-workspace` |
| 55 | 2026-11-03 | `ep-bd0161a1` | edge | 9 | 1 | 8 | 11.1% | 597 | `w:d:/DeepSeek Harness/default-workspace` |
| 56 | 2026-11-03 | `ep-1f814ed5` | edge | 5 | 1 | 4 | 20.0% | 605 | `w:d:/DeepSeek Harness/default-workspace/agent吃鸡` |
| 57 | 2026-11-03 | `ep-226dbf4f` | edge | 83 | 9 | 74 | 10.8% | 609 | `w:d:/DeepSeek Harness/default-workspace/DSH-GO` |
| 58 | 2026-11-03 | `ep-62bcb7d2` | edge | 85 | 9 | 76 | 10.6% | 683 | `w:d:/DeepSeek Harness/default-workspace/DSH-GO` |
| 59 | 2026-11-03 | `ep-98239b60` | none | 0 | 0 | 0 | n/a | 759 | `w:d:/DeepSeek Harness/default-workspace/DSH-GO` |
| 60 | 2026-11-03 | `ep-c460d468` | edge | 11 | 0 | 11 | 0.0% | 759 | `w:d:/DeepSeek Harness/反代` |
| 61 | 2026-11-03 | `ep-5e4ee30c` | edge | 9 | 2 | 7 | 22.2% | 770 | `w:d:/DeepSeek Harness/反代` |
| 62 | 2026-11-03 | `ep-aa52f421` | edge | 9 | 2 | 7 | 22.2% | 777 | `w:d:/DeepSeek Harness/反代/magpie-amgicrew-auth` |
| 63 | 2026-11-03 | `ep-a9f16ff0` | edge | 27 | 2 | 25 | 7.4% | 784 | `w:d:/DeepSeek Harness/反代/work buddy` |
| 64 | 2026-11-03 | `ep-32a78774` | edge | 35 | 9 | 26 | 25.7% | 809 | `w:d:/DeepSeek Harness/反代/monkey code` |
| 65 | 2026-11-03 | `ep-2955fa30` | edge | 3 | 0 | 3 | 0.0% | 835 | `w:d:/DeepSeek Harness/default-workspace` |
| 66 | 2026-11-03 | `ep-e5a98b06` | none | 0 | 0 | 0 | n/a | 838 | `w:d:/DeepSeek Harness/反代` |
| 67 | 2026-11-03 | `ep-e23a6a05` | edge | 3 | 2 | 1 | 66.7% | 838 | `w:d:/DeepSeek Harness/反代/work buddy` |
| 68 | 2026-11-03 | `ep-bdd26050` | edge | 4 | 1 | 3 | 25.0% | 839 | `w:d:/DeepSeek Harness/反代` |
| 69 | 2026-11-03 | `ep-0eba65b1` | edge | 6 | 0 | 6 | 0.0% | 842 | `w:d:/DeepSeek Harness/反代/magpie-amgicrew-auth` |
| 70 | 2026-11-03 | `ep-fdbfa78c` | edge | 16 | 3 | 13 | 18.8% | 848 | `w:d:/DeepSeek Harness/反代/work buddy` |
| 71 | 2026-11-03 | `ep-bffc5225` | none | 0 | 0 | 0 | n/a | 861 | `w:d:/DeepSeek Harness/反代` |
| 72 | 2026-11-03 | `ep-11b16270` | none | 0 | 0 | 0 | n/a | 861 | `w:d:/DeepSeek Harness/反代` |
| 73 | 2026-11-03 | `ep-25d39e67` | edge | 16 | 4 | 12 | 25.0% | 861 | `w:d:/DeepSeek Harness/反代` |
| 74 | 2026-11-03 | `ep-b718aab2` | edge | 4 | 1 | 3 | 25.0% | 873 | `w:d:/DeepSeek Harness/反代` |
| 75 | 2026-11-03 | `ep-fdd814b1` | edge | 24 | 2 | 22 | 8.3% | 876 | `w:d:/DeepSeek Harness/default-workspace` |
| 76 | 2026-11-03 | `ep-294c4c1d` | edge | 1 | 1 | 0 | 100.0% | 898 | `w:d:/DeepSeek Harness/default-workspace` |
| 77 | 2026-11-03 | `ep-fbb43571` | edge | 10 | 3 | 7 | 30.0% | 898 | `w:d:/DeepSeek Harness/反代` |
| 78 | 2026-11-03 | `ep-1cf2b33f` | edge | 25 | 5 | 20 | 20.0% | 905 | `w:d:/DeepSeek Harness/反代/wps` |
| 79 | 2026-11-03 | `ep-601f0764` | edge | 21 | 3 | 18 | 14.3% | 925 | `w:d:/DeepSeek Harness/反代/wps` |
| 80 | 2026-11-03 | `ep-3a3fb03c` | edge | 21 | 5 | 16 | 23.8% | 943 | `w:d:/DeepSeek Harness/反代/wps` |
| 81 | 2026-11-03 | `ep-7bba753b` | edge | 9 | 2 | 7 | 22.2% | 959 | `w:d:/DeepSeek Harness/反代/monkey code` |
| 82 | 2026-11-03 | `ep-5e91a1bc` | edge | 2 | 0 | 2 | 0.0% | 966 | `w:d:/DeepSeek Harness/反代` |
| 83 | 2026-11-03 | `ep-28168c77` | edge | 2 | 0 | 2 | 0.0% | 968 | `w:d:/DeepSeek Harness/反代` |
| 84 | 2026-11-03 | `ep-252091a4` | edge | 11 | 4 | 7 | 36.4% | 970 | `w:d:/DeepSeek Harness/反代/wps` |
| 85 | 2026-11-04 | `ep-135c7f7d` | edge | 8 | 2 | 6 | 25.0% | 977 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 86 | 2026-11-04 | `ep-a4827d80` | none | 0 | 0 | 0 | n/a | 983 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 87 | 2026-11-04 | `ep-16d5a1e2` | edge | 3 | 3 | 0 | 100.0% | 983 | `w:d:/DeepSeek Harness/反代/wps` |
| 88 | 2026-11-04 | `ep-8a27caaa` | edge | 6 | 3 | 3 | 50.0% | 983 | `w:d:/DeepSeek Harness/反代` |
| 89 | 2026-11-04 | `ep-c7f6b6d9` | edge | 1 | 0 | 1 | 0.0% | 986 | `w:d:/DeepSeek Harness/反代/magpie-amgicrew-auth` |
| 90 | 2026-11-04 | `ep-62b1cd78` | edge | 8 | 2 | 6 | 25.0% | 987 | `w:d:/DeepSeek Harness/default-workspace` |
| 91 | 2026-11-04 | `ep-2ddf0a19` | edge | 12 | 2 | 10 | 16.7% | 993 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 92 | 2026-11-04 | `ep-c650bcea` | none | 0 | 0 | 0 | n/a | 1003 | `w:d:/DeepSeek Harness/default-workspace/GOkifu上下文压缩` |
| 93 | 2026-11-04 | `ep-147f0bf4` | edge | 7 | 2 | 5 | 28.6% | 1003 | `w:d:/DeepSeek Harness/反代/magpie-amgicrew-auth` |
| 94 | 2026-11-04 | `ep-b5586316` | edge | 17 | 4 | 13 | 23.5% | 1008 | `w:d:/DeepSeek Harness/default-workspace` |
| 95 | 2026-11-04 | `ep-543cf0b2` | edge | 12 | 5 | 7 | 41.7% | 1021 | `w:d:/DeepSeek Harness/反代/work buddy` |
| 96 | 2026-11-04 | `ep-bf742774` | edge | 3 | 3 | 0 | 100.0% | 1028 | `w:d:/DeepSeek Harness/default-workspace` |
| 97 | 2026-11-04 | `ep-41514e25` | edge | 15 | 1 | 14 | 6.7% | 1028 | `w:d:/DeepSeek Harness/default-workspace` |
| 98 | 2026-11-04 | `ep-3f03c71c` | edge | 4 | 0 | 4 | 0.0% | 1042 | `w:d:/DeepSeek Harness/反代` |
| 99 | 2026-11-04 | `ep-f0e51ab3` | edge | 4 | 1 | 3 | 25.0% | 1046 | `w:d:/DeepSeek Harness/反代` |
| 100 | 2026-11-04 | `ep-bde12afa` | edge | 78 | 8 | 70 | 10.3% | 1049 | `w:d:/DeepSeek Harness/default-workspace` |
| 101 | 2026-11-04 | `ep-1c84e464` | none | 0 | 0 | 0 | n/a | 1119 | `w:d:/DeepSeek Harness/反代/work buddy` |
| 102 | 2026-11-04 | `ep-62e04fbd` | none | 0 | 0 | 0 | n/a | 1119 | `w:d:/DeepSeek Harness/default-workspace` |
| 103 | 2026-11-04 | `ep-1692d1a9` | none | 0 | 0 | 0 | n/a | 1119 | `w:d:/DeepSeek Harness/default-workspace/DSH-GO` |
| 104 | 2026-11-04 | `ep-9c2cbede` | edge | 8 | 4 | 4 | 50.0% | 1119 | `w:d:/DeepSeek Harness/default-workspace` |
| 105 | 2026-11-04 | `ep-edd954a1` | none | 0 | 0 | 0 | n/a | 1123 | `w:d:/DeepSeek Harness/default-workspace` |
| 106 | 2026-11-04 | `ep-a1c6f5c5` | none | 0 | 0 | 0 | n/a | 1123 | `w:d:/DeepSeek Harness/反代/work buddy` |
| 107 | 2026-11-04 | `ep-upgradep` | none | 0 | 0 | 0 | n/a | 1123 | `w:d:/DeepSeek Harness/default-workspace` |
| 108 | 2026-11-04 | `ep-edf70ff3` | edge | 7 | 4 | 3 | 57.1% | 1123 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 109 | 2026-11-04 | `ep-08da81e8` | edge | 5 | 2 | 3 | 40.0% | 1126 | `w:d:/DeepSeek Harness/default-workspace` |
| 110 | 2026-11-04 | `ep-f4e6c960` | edge | 2 | 1 | 1 | 50.0% | 1129 | `w:d:/DeepSeek Harness/反代` |
| 111 | 2026-11-04 | `ep-acba9e05` | none | 0 | 0 | 0 | n/a | 1130 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 112 | 2026-11-04 | `ep-c87420d3` | none | 0 | 0 | 0 | n/a | 1130 | `w:d:/DeepSeek Harness/default-workspace/DSH-GO` |
| 113 | 2026-11-04 | `ep-3349861f` | none | 0 | 0 | 0 | n/a | 1130 | `w:d:/DeepSeek Harness/default-workspace/DSH-GO` |
| 114 | 2026-11-04 | `ep-821c88d9` | edge | 1 | 1 | 0 | 100.0% | 1130 | `w:d:/DeepSeek Harness/default-workspace/DSH-GO` |
| 115 | 2026-11-04 | `ep-eb9b65ea` | none | 0 | 0 | 0 | n/a | 1130 | `w:d:/DeepSeek Harness/default-workspace` |
| 116 | 2026-11-04 | `ep-forgewor` | none | 0 | 0 | 0 | n/a | 1130 | `w:d:/DeepSeek Harness/default-workspace/tmp/dsh-upgrade-0.2.2-rc.1/worktree-test/runs/2026-11-04T18-33-21-095Z-32736-9197390e/repo` |

### 3.2 按 scope 分层

| scope | 局 | 有签名 | repeat | novel | rate |
|---|---|---|---|---|---|
| `w:d:/DeepSeek Harness/default-workspace/DSH-GO` | 9 | 5 | 29 | 292 | 9.0% |
| `w:e:/Documents/deepseek-harness/default-workspace` | 34 | 29 | 48 | 254 | 15.9% |
| `w:d:/DeepSeek Harness/default-workspace` | 19 | 14 | 35 | 160 | 17.9% |
| `w:d:/DeepSeek Harness/反代` | 28 | 24 | 38 | 121 | 23.9% |
| `w:d:/DeepSeek Harness/反代/wps` | 5 | 5 | 20 | 61 | 24.7% |
| `w:d:/DeepSeek Harness/default-workspace/GOkifu上下文压缩` | 2 | 1 | 20 | 56 | 26.3% |
| `w:d:/DeepSeek Harness/default-workspace/长期记忆系统` | 1 | 1 | 9 | 61 | 12.9% |
| `w:d:/DeepSeek Harness/反代/work buddy` | 6 | 4 | 12 | 46 | 20.7% |
| `w:d:/DeepSeek Harness/反代/monkey code` | 2 | 2 | 11 | 33 | 25.0% |
| `w:d:/DeepSeek Harness/反代/magpie-amgicrew-auth` | 5 | 5 | 6 | 24 | 20.0% |
| `w:d:/DeepSeek Harness/反代/AIysis code` | 2 | 2 | 5 | 18 | 21.7% |
| `w:d:/DeepSeek Harness/default-workspace/agent吃鸡` | 1 | 1 | 1 | 4 | 20.0% |
| `w:d:/DeepSeek Harness/default-workspace/tmp/dsh-upgrade-0.2.2-rc.1/worktree-test/runs/2026-11-04T18-33-21-095Z-32736-9197390e/repo` | 1 | 0 | 0 | 0 | n/a |
| `w:d:/tmp/hstest` | 1 | 0 | 0 | 0 | n/a |

### 3.3 坑榜（同一签名出现在 ≥2 局；共 20 条）

| 局数 | 签名（规范化后，截 110 字） |
|---|---|
| 34 | `error: deepseek returned no web_search_tool_result blocks; the request may not have triggered native web searc` |
| 17 | `error: tool call aborted` |
| 15 | `filenotfounderror: [errno 2] no such file or directory: '<path>'` |
| 13 | `error: tool call timed out after 30000ms` |
| 12 | `error: enoent: no such file or directory, open '<path>' at object.readfilesync (node:fs:<line>) at [eval]:<lin` |
| 10 | `syntaxerror: invalid or unexpected token at checksyntax (node:internal/main/check_syntax:<line>)` |
| 9 | `error: cannot modify "<path>": file has not been read — read the file, then retry` |
| 9 | `error: this destroys the runtime dsh would need in order to undo it; there is no recovery path` |
| 7 | `error: web fetch failed: typeerror: fetch failed` |
| 7 | `sed: -e expression #<n>, char 1: unknown command: `,'` |
| 5 | `assertionerror` |
| 5 | `error: this goal operation requires a direct human turn on a top-level agent` |
| 5 | `fatal: not a git repository (or any of the parent directories): .git` |
| 4 | `<path>: line <line>: cd: <path> harness/desktop/resources/app.asar/dsh: not a directory` |
| 4 | `error: cannot edit "<path>": file changed since it was read — re-read the file, then retry` |

## 4 · 复现命令

```bash
cd "/d/DeepSeek Harness/default-workspace/长期记忆系统"
node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context            # 文本表
node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context --json     # 机器可读
node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context --source edge  # 只算 R03 边失败
node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context --evidence evidence/M5-eval.md
node --test test/eval.test.mjs
```

## 5 · 口径风险（读数字前先看）

1. **这是"机械代理指标"，不是收益本身**。它只回答"失败原文是否在更早的局里出现过"，
   不回答"模型是否因此真的少走弯路"——后者要 M5 的配对重放（有模型调用）。
2. **`both` 混了两个来源**：edge（棋谱失败边）证据质量高但覆盖低；event（退出码）覆盖高但只取错误行。
   两个分口径的数字都在 §2，引用时必须带口径名。
3. **签名是文本匹配**：同一错误的不同措辞算 novel（**低估** repeat）；同一模板不同参数算 repeat（可能**高估**）。
   规范化只去路径/行号/时间戳/十六进制，不做语义合并（禁止模型判断）。
4. **time 用的是会话 startedAt**：一局内"先犯后犯"同一坑算一次 repeat；跨局严格按开始时间。
5. **无记忆基线 = 0 是定义**，不是实测：没有 memory 时没有"已结算失败"可比。
