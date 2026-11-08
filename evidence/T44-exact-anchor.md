# T44 · 结构化精确锚定检索（同一 repo / 同一错误签名 / 同一任务链）

> 日期：2026-11-09 · 改动：`src/rooms/abstain.mjs`（`hasExactAnchor` + 三个抽取器 + 兜底接线）、`test/abstain.test.mjs`（T44 ①–⑤）
> 依据：`evidence/T43-semantic-retrieval.md`（语义相似在 A2b 口径下输给机械判据：AUC 0.839 vs 0.850；全库 hit@5 0.33 vs 0.67）——要认的是「同一件事」，不是「相似的事」。

## 0 · 结论（先看不好的那条）

**实现了，但在 T11 的 79 判定点重放集上一致率没有提升：`100% → 100%`（0 条判定变化）。** 这不是实现问题，是**集合已饱和**：T12 修完误杀后，79 个判定点的相关性判定与人工标注已经全对（tp 63 / tn 16 / fp 0 / fn 0），没有可提升空间。锚定作为**兜底**只可能在"字面 + 桥都判不相关、但其实是同一件事"的**新**输入上生效，本批没有这种输入。

**另一条要说清的**：本刀**不可能**提高 A2b 严格 46.6% —— `hasRelevantClaim` 只决定**整张卡要不要注入**（abstain 闸），不决定**卡里渲染哪几行**（那是 walk 的排序）。A2b strict 的分母是"渲染出来的 5 行"，改 abstain 动不了它。要把 A2b 抬上去，得改 walk 的候选打分/排序（不在本刀可写路径内）。

## 1 · 实现（`src/rooms/abstain.mjs`）

三条锚定，全部机械（正则 + 归一化，无模型、无阈值打分）：

| 锚定 | 判据 | 导出 |
|---|---|---|
| 同一 repo/remote | 两侧出现同一个 `github.com/<owner>/<repo>`（或 `gitee.com`；`git@github.com:` 也算；去掉 `.git`） | `repoKeysOf` |
| 同一错误签名 | 错误行（`Error`/`Exception`/`fatal` 开头）归一化后**逐字相同**：小写、压空白、**引号外**的路径/数字换成 `<path>`/`<n>`，**引号内主体保留**（host/包名/tag 是身份的一部分） | `errorSignaturesOf` |
| 同一任务链 | 同一条命令的「动作 + 对象」：`git push/pull/fetch/clone/worktree add/…  <obj>`、`gh release create/release edit/pr create/pr merge/api <obj>`、`pnpm/npm/yarn add/install/run/publish <obj>`；对象必须相同（不同 tag/路径不算） | `taskChainsOf` |

**接线位置**（关键，对应任务 ④「只增相关不增拒绝」）：

```js
// hasRelevantClaim 末尾：字面（实体/词/中文 bigram）→ 坑类/工具族桥 → **精确锚定** → false
if (hasPitClassBridge(claims, signalText)) return true;
if (exactAnchor && hasExactAnchor(claims, signalText)) return true;   // T44 兜底
return false;
```

- 只在前面**全不命中**时兜底 ⇒ 锚定只能把"拒绝"翻成"相关"，**不会**把"相关"翻成"拒绝"。
- `hasRelevantClaim(card, text, {exactAnchor:false})` ⇒ 与改动前**逐字节一致**（tombstone，T44 ④ 断言"关掉不可能比开着更相关"）。

## 2 · 79 判定点重放（T11 集，`tmp/t12-cases-after.json` + `tmp/t12-eval.json`）

```bash
node tmp/t44-replay.mjs      # 前后对照
```

| 口径 | 关闭锚定（改动前） | 打开锚定（改动后） |
|---|---|---|
| tp / fp / tn / fn | 63 / 0 / 16 / 0 | 63 / 0 / 16 / 0 |
| **与人工标注一致率** | **100%** | **100%** |
| 判定变化条数 | — | **0** |
| 5 条正确拒绝（#3/#7/#10/#21/#26） | 仍拒 | **仍拒（5/5）** |
| 锚定命中 | — | 仅 `(other)#11`（相关样本）；**不相关样本 0 命中** |

⇒ **本刀在这个集上不可见（0pp）**。这是集合饱和的直接结果，不是锚定失效：锚定的触发条件（同一 repo/签名/任务链）在这批 AgentTeams 任务分配信号里极少出现，而 T12 的桥已经把该救的都救了。

## 3 · 锚定的**精度**（另一个真实语料：A2b holdout 403 对）

用 `evidence/a2b-holdout.json` 的 118 题 × walk 渲染的 5 行（403 对，78 个 strict 正例），把 `hasExactAnchor` 当"相关性判定器"：

```bash
node tmp/t44-holdout-anchor.mjs
```

| 指标 | 值 |
|---|---|
| TP / FP / FN / TN | 10 / 1 / 68 / 324 |
| **精确率** | **0.909** |
| 召回率 | 0.128 |

- **精确**（命中 11 次里 10 次是 strict），但**窄**（只覆盖 78 个 strict 正例里的 10 个）——符合"精确身份"的定位：机械、可核、宁缺勿编。
- 唯一一个假阳：claim 与信号里出现**同一错误签名**（`URL hostname "raw.githubusercontent.com" resolves to a non-public IP address`），但该 claim 的 `support` 不含这一局的 episode ⇒ 按 A2b 的 strict 定义（要求证据归属）算不相关。这是**口径差异**，不是判据错：从"同一件事"看它确实相关，从"这条记忆是不是这一局的证据"看它不相关。
- 归一化改过一版：最初把引号内容一律换成 `<x>`，`"127.0.0.1"` 与 `"raw.githubusercontent.com"` 被判成同一签名（2 个假阳）⇒ 改成**保留引号内主体**后假阳 2 → 1，精确率 0.846 → 0.909。

## 4 · tombstone

- 关掉锚定（`{exactAnchor:false}`）⇒ 与改动前**逐字节一致**：T44 ④ 在 4 组输入（不相关/同 repo/坑类/无关中文）上断言"关掉 ⇒ 与开着的判定一致（锚定不命中时）且关掉不可能更相关"。
- 锚定不命中时的行为：`hasExactAnchor` 返回 false ⇒ `hasRelevantClaim` 走原来的 `return false`（T44 ⑤：无关文本、空 claims、空信号都不命中）。

## 5 · 测试（`test/abstain.test.mjs` T44 ①–⑤）

| # | 断言 |
|---|---|
| T44 ① | 同一 repo/remote ⇒ 相关；不同 repo ⇒ 不算 |
| T44 ② | 同一错误签名（去路径/数字后逐字相同）⇒ 相关；不同错误 ⇒ 不算 |
| T44 ③ | 同一任务链（`gh release create v0.2.41` / `git worktree add ../t44`）⇒ 相关；**对象不同（v0.2.42）不算** |
| T44 ④ | **只增相关不增拒绝**：关掉锚定不可能更相关；锚定不命中 ⇒ 与现状逐字节一致 |
| T44 ⑤ | 没有身份锚点的无关文本/空输入 ⇒ 不命中（不拿"像"当"同一件事"） |

## 6 · 验收

- 全量：`node --test "test/*.test.mjs"` —— **1209 tests / 1203 pass / 0 fail / 6 skipped**（exit 0）。
- `node scripts/check.mjs` PASS。

## 7 · 复现

```bash
node --test --test-name-pattern "T44" test/abstain.test.mjs
node tmp/t44-replay.mjs            # 79 判定点前后对照（100% → 100%，0 变化）
node tmp/t44-holdout-anchor.mjs    # 锚定精度（P 0.909 / R 0.128）
node --test "test/*.test.mjs"
node scripts/check.mjs
```

**关键数（复核请对这四个）**：
- 79 集一致率：**100% → 100%**（0 条判定变化；5 条正确拒绝仍拒）；
- 锚定在 79 集的命中：相关 1 条 / 不相关 0 条；
- 锚定在 holdout 的精度：**P 0.909 / R 0.128**（10 TP / 1 FP）；
- tombstone：`{exactAnchor:false}` 与改动前逐字节一致（T44 ④）。

## 8 · 建议（下一步该动哪里）

1. **abstain 这条线已经到顶**：79 集 100%、holdout 上 abstain 也不是瓶颈。本刀保留锚定当**兜底**（零成本、纯正则、只增相关），但不要再指望它抬指标。
2. **A2b 严格要动的是 walk 的排序**：46.6% 的分母是"渲染了哪 5 行"。可核的下一步是给 walk 的候选打分加**结构身份**（同 repo / 同错误签名 / 同任务链）作为**排序特征**——同一套抽取器（`repoKeysOf` / `errorSignaturesOf` / `taskChainsOf`）可以直接复用，但那条路径要改 `src/rooms/walk.mjs`，不在本刀可写范围，需另立任务并做 tombstone + A2b 前后对照。
3. **标签口径要统一**：本刀发现的 1 个假阳来自「同一错误签名 vs 证据归属」两种"相关"定义的分歧。若将来把 A2b 的 strict 当唯一口径，结构身份只能在**候选生成/排序**里用，不能当"相关"的最终裁决。
4. 若要进一步提精确率：签名归一化可以保留更多主体（如保留引号内全部内容、只折叠数字）；代价是同一类错误换个 host 就漏（召回更低）。当前版本选择了"留主体"（精度优先）。

## 9 · 限制

1. **79 集是标注集里唯一的固定点**，且 T12 后已饱和；本刀无法在该集上制造提升（也不该制造）。
2. **holdout 的 strict 标签是机械口径**（support 归属 + 词重合），用它评"同一件事"有口径错位（见 §3 假阳）。
3. **锚定是启发式正则**：repo 只认 github/gitee；任务链只认 3 组命令；错误签名只认 `Error/Exception/fatal` 开头的行。都不命中 ⇒ 不判相关（宁缺）。
4. **本刀未改 `hasReliableHandle`**：短指令/纯通用中文仍然不进 abstain 判定面（保持保守）。
5. 未做线上验证：`live-stats.jsonl` 的 abstain 分布需要在宿主重启后观察（本刀只做离线重放）。