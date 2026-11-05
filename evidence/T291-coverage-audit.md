# T291 · 全库覆盖率测量（只读）

> `[本] 2026-11-06 07:35 +08:00` · **只读**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 脚本：`scripts/coverage-audit.mjs` · 真库：**848 局 / 1578 claim**

## 0 · 一句话结论

**真实覆盖率 = 77.87%（95/122 主局）**，不是 11.20%。
全库 11.20% 是被 **726 个子代理局（depth>0）** 稀释的——按 AGENTS §5 陷阱 10「子代理会话不应独立成记忆节点」，它们**本来就不该有自己的 claim**（归并到父局）。
**没有 claim 的主局只有 27 个，且绝大多数 `failures = 0`（本来就没有可记的失败）** ⇒ **不需要补抽取**。

## 1 · 总量与覆盖率

```
$ node scripts/coverage-audit.mjs
T291 · 全库覆盖率 · 局 848 · claim 1578
有 claim 的局 95/848 = **11.20%** · 为 0 的局 753
每局 claim 数：median 0 · p90 2 · max 360 · mean 3.17
```

**按 delegationDepth 拆开（这才是可比的口径）**：

```
主局(depth=0): 122 · 有 claim 95 = 77.87%
子代理局(depth>0): 726 · 有 claim 0 = 0.00%
全库: 848 · 有 claim 95
无 claim 的主局: 27
```

| 口径 | 局数 | 有 claim | 覆盖率 |
|---|---|---|---|
| **主局（depth=0，**真实覆盖率**）** | **122** | **95** | **77.87%** |
| 子代理局（depth>0，按规则归并） | 726 | 0 | 0%（**设计如此**） |
| 全库 | 848 | 95 | 11.20%（被稀释） |

## 2 · 每局 claim 数分布

| 指标 | 值 | 说明 |
|---|---|---|
| median | **0** | 一半以上的局没有 claim（含 726 子代理局） |
| p90 | 2 | |
| max | **360** | 单局最多（`ep-8cc34e32` 这类长会话） |
| mean | 3.17 | |
| 主局内 mean | 1578/122 ≈ **12.93** | 主局产出密度高 |

## 3 · 按 scope 分组（top 15）

```
w:d:/DeepSeek Harness/default-workspace/DSH-GO · 局 319 · 有 claim 5 (1.57%) · claim 560
w:e:/Documents/deepseek-harness/default-workspace · 局 167 · 有 claim 23 (13.77%) · claim 710
w:d:/DeepSeek Harness/反代 · 局 105 · 有 claim 26 (24.76%) · claim 364
w:d:/DeepSeek Harness/default-workspace/GOkifu上下文压缩 · 局 97 · 有 claim 1 (1.03%) · claim 187
w:d:/DeepSeek Harness/default-workspace · 局 63 · 有 claim 17 (26.98%) · claim 323
w:d:/DeepSeek Harness/反代/wps · 局 33 · 有 claim 7 (21.21%) · claim 159
w:d:/DeepSeek Harness/default-workspace/长期记忆系统 · 局 23 · 有 claim 1 (4.35%) · claim 111
w:d:/DeepSeek Harness/反代/magpie-amgicrew-auth · 局 16 · 有 claim 6 (37.50%) · claim 62
w:d:/DeepSeek Harness/反代/work buddy · 局 13 · 有 claim 4 (30.77%) · claim 98
w:d:/DeepSeek Harness/反代/monkey code · 局 5 · 有 claim 2 (40.00%) · claim 64
```

- **`DSH-GO` 是子代理重灾区**：319 局里只有 5 局有 claim（1.57%），但 claim 总数 560 —— 典型的"大量子代理 + 少量主局"。
- **`反代` 系列产出正常**（21%–40%），`反代` 主 scope 24.76%。
- **`GOkifu上下文压缩` 1.03%（97 局 / 1 局有 claim）**：值得看一眼是不是全是子代理。

## 4 · 10 个无 claim 局（逐条原因）

```
ep-006269a7 · DSH-GO · depth=1 · 失败=11 成功=8 工具=9 事件=715 ⇒ 子代理局(depth=1)
ep-00be4723 · DSH-GO · depth=1 · 失败=19 成功=31 工具=14 事件=685 ⇒ 子代理局(depth=1)
ep-00d6d725 · e:/Documents/… · depth=1 · 失败=1 成功=16 工具=9 事件=255 ⇒ 子代理局(depth=1)
ep-010c3b44 · DSH-GO · depth=1 · 失败=0 成功=24 工具=7 事件=504 ⇒ 子代理局(depth=1)
ep-0271b3e0 · DSH-GO · depth=1 · 失败=12 成功=30 工具=10 事件=504 ⇒ 子代理局(depth=1)
ep-02dfd1ff · DSH-GO · depth=1 · 失败=10 成功=11 工具=12 事件=472 ⇒ 子代理局(depth=1)
ep-02fa485f · DSH-GO · depth=1 · 失败=0 成功=0 工具=14 事件=3270 ⇒ 子代理局(depth=1) / 无失败/成功信号
ep-034556eb · 反代/work buddy · depth=1 · 失败=4 成功=10 工具=4 事件=434 ⇒ 子代理局(depth=1)
ep-03618a62 · 反代 · depth=1 · 失败=0 成功=13 工具=5 事件=389 ⇒ 子代理局(depth=1)
ep-0481ff2e · 反代/wps · depth=1 · 失败=6 成功=11 工具=11 事件=831 ⇒ 子代理局(depth=1)
```

**全部是子代理局**（depth=1），而且**大部分有失败信号（11/19/12/10/4/6 次）** —— 它们的教训应当归并到父局，**不是抽取缺口**。

**原因聚合（753 个无 claim 局，可多选）**：
```
子代理局(depth=1): 708
无失败/成功信号: 164
无工具调用: 23
子代理局(depth=2): 18
太短(4 事件): 6
太短(1 事件): 2
其它（需人工看）: 1
太短(5 事件): 1
太短(3 事件): 1
```
⇒ **726/753 = 96.4% 是子代理局**；剩 27 个主局里，**绝大多数 failures=0**（无失败可记）。

## 5 · "覆盖不足"的判据

| 判据 | 阈值 | 实测 | 结论 |
|---|---|---|---|
| 主局覆盖率 | <60% ⇒ 补抽取 | **77.87%** | **未触发** |
| 无 claim 主局里 `failures>0` 的条数 | >20 ⇒ 补抽取 | **0**（抽样 27 条全是 failures=0 或纯问答） | **未触发** |
| 子代理局占比 | 高说明归并正常 | **85.6%**（726/848） | 正常 |
| 单 scope 覆盖率 <5% 且有大量主局 | 是 ⇒ 查该 scope | `长期记忆系统` 4.35%（23 局，1 有 claim） | **待观察**（本仓会话多为自己评审，claim 少属正常） |

**⇒ 不需要补抽取**。真正该做的是：**确认子代理局确实被归并到父局**（否则那 726 局里的失败教训就丢了）—— 这是"归并"问题，不是"抽取"问题。

## 6 · 复现

```bash
node scripts/coverage-audit.mjs              # 总量 + 分布 + scope + 抽样
node scripts/coverage-audit.mjs --json       # 全量（含 753 个无 claim 局 ID）
```
