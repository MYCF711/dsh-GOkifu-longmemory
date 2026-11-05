# T292 · 子代理局的失败教训有没有真的归并到父局（只读）

> `[本] 2026-11-06 07:50 +08:00` · **只读**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 脚本：`scripts/subagent-merge-audit.mjs` · 真库 **848 局**（子代理 **726**，有失败 **530**，失败总数 **2939**）

## 0 · 一句话结论

**归并率 ≈ 10.00%（9/90）** —— 归并**不是"没发生"，而是"只发生了十分之一"**。
按 530 个带失败的子代理局、2939 次失败外推，**约 2600+ 条子代理失败没有进入父局 claim**。
**这是一个真实的洞**（"不重复踩坑"的第一验收面被漏掉），**但不是"设计如此"能解释的**——AGENTS §5 陷阱 10 说的是"归并到父局"，实际只归并了 10%。

## 1 · 总量

```
$ node scripts/subagent-merge-audit.mjs --sample 30
T292 · 子代理局失败归并 · 局 848（子代理 726，有失败 530，失败总数 2939）
抽样 30 局 · 检查失败 90 条 · **归并 9（10.00%）** · 找不到父局 0
```

| 指标 | 值 |
|---|---|
| 总局数 | 848 |
| 子代理局（depth>0） | **726** |
| 其中带失败信号 | **530** |
| 子代理失败总数 | **2939** |
| 抽样局 / 检查失败 | 30 / 90 |
| **归并成功** | **9（10.00%）** |
| 找不到父局 | 0（`parentSessionId` 全部可解析） |

## 2 · 逐条（子代理失败原文 vs 父局 claim）

```
ep-006269a7 → 父 ep-62bcb7d2 · 失败11 · 父局 claim 208 · **未归并** · 「Updated todo list: 4 pending, 1 in progress, 0 completed.」
ep-006269a7 → 父 ep-62bcb7d2 · 失败11 · 父局 claim 208 · 归并到 c-08ebcc47 · 「/c/Users/Administrator/AppData/Local/Temp/dsh-ui-structure-d」
ep-006269a7 → 父 ep-62bcb7d2 · 失败11 · 父局 claim 208 · **未归并** · 「docs/e1-result.md\ndocs/e2-result.md\ndocs/verdict.md\ndocs/」
ep-00be4723 → 父 ep-62bcb7d2 · 失败19 · 父局 claim 208 · **未归并** · 「{"turn":1,"step":1,"message":{"role":"tool","source":{"kind"」
ep-00be4723 → 父 ep-62bcb7d2 · 失败19 · 父局 claim 208 · 归并到 c-08ebcc47 · 「/c/Users/Administrator/AppData/Local/Temp/dsh-ui-json-hot-re」
ep-00be4723 → 父 ep-62bcb7d2 · 失败19 · 父局 claim 208 · **未归并** · 「<path>/c/Users/Administrator/AppData/Local/Temp/dsh-ui-json-」
ep-00d6d725 → 父 ep-1e82afca · 失败1 · 父局 claim 360 · **未归并** · 「Updated todo list: 4 pending, 1 in progress, 0 completed.」
ep-00d6d725 → 父 ep-1e82afca · 失败1 · 父局 claim 360 · **未归并** · 「Hindsight memory is disabled for this workspace.」
ep-0271b3e0 → 父 ep-62bcb7d2 · 失败12 · 父局 claim 208 · **未归并** · 「{"turn":1,"step":1,"message":{"role":"tool","source":{"kind"」
ep-0271b3e0 → 父 ep-62bcb7d2 · 失败12 · 父局 claim 208 · 归并到 c-08ebcc47 · 「/c/Users/Administrator/AppData/Local/Temp/DSH-GO-tui-daily-f」
```

### 3 条逐字对照（父局有对应 claim 的）

| # | 子代理失败原文 | 父局 claim | 判定 |
|---|---|---|---|
| 1 | `/c/Users/Administrator/AppData/Local/Temp/dsh-ui-structure-d…` | `c-08ebcc47`（quote 含同一路径） | **真归并 ✓** |
| 2 | `/c/Users/Administrator/AppData/Local/Temp/dsh-ui-json-hot-re…` | `c-08ebcc47`（同一路径族） | **真归并 ✓** |
| 3 | `/c/Users/Administrator/AppData/Local/Temp/DSH-GO-tui-daily-f…` | `c-08ebcc47` | **真归并 ✓** |

**9 条归并全部来自"同一临时路径"类**（`dsh-ui-*` 系列），说明归并只在**路径字符串完全一致**时发生。

## 3 · 未归并的那 81 条是什么

抽样里的"未归并"分两类（**口径噪声 vs 真丢失**）：

| 类型 | 例子 | 是不是真丢失 |
|---|---|---|
| **口径噪声**（我的抽取把非失败当失败） | `Updated todo list: 4 pending…`、`{"turn":1,"step":1,"message":{…}}` | **不是**（正则命中 `pending`/`failed` 子串） |
| **真丢失** | `docs/e1-result.md\ndocs/e2-result.md…`（子代理的产出清单） | **是**：父局没有同文 claim |

⇒ **10% 是下界**；真实归并率可能略高（口径噪声占一部分），但**绝不会高到"设计如此"**——真失败的样本（如产出清单、错误原文）确实没进父局。

## 4 · 该不该补（判据）

| 判据 | 阈值 | 实测 | 结论 |
|---|---|---|---|
| 归并率 | <50% ⇒ 补 | **≈10%** | **触发：该补** |
| 受影响失败数 | >100 ⇒ 补 | **≈2600**（2939 × 90%） | **触发** |
| 父局是否有能力记录（有 claim） | 有 ⇒ 可补 | 父局 claim 208/360 条 | 有能力 |
| 是不是"设计如此" | — | **不是**：设计是"归并"，不是"丢弃" | **是洞** |

## 5 · 建议（未动手）

1. **先修口径**：`subagent-merge-audit.mjs` 的 `failureTexts` 现在按 JSON 子串匹配（`pending`/`failed`），会把 todo/进度消息当失败 —— **这是本刀自身的缺陷**，应改为只认 `tool/result` 里 `isError: true` 或 `[exit code: N]` 的行。
2. **再修归并**：`src/rooms/episode.mjs` 的归并逻辑应把**子代理的失败原文**追加到父局的 `signals` + 生成对应 claim 的 support（**只增不改**，写 `provenanceRepair` 记来源子局）。
3. **优先级**：**高**。这是"不重复踩坑"的第一验收面，且 530 个局 / 2939 次失败不是小数目；但**不能直接重放**（会重复计数），要先做口径修正 + 幂等键（`subEpisode + seq`）。

## 6 · 复现

```bash
node scripts/subagent-merge-audit.mjs --sample 30      # 归并率 + 逐条
node scripts/subagent-merge-audit.mjs --json --sample 50
```
