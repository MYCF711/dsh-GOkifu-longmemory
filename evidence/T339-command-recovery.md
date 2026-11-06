# T339 · 命令主体恢复（F3 的第二条腿）—— 覆盖率 4.51% → 11.05%

> `[本] 2026-11-06` · 机制实现 + 真库测量（20 局 / 1575 失败）。
> 复算：`node scripts/extract-recovery.mjs --limit 20`。

## 0 · 一句话

**把「恢复条件」的主体从「文件路径」扩到「触发命令」后，F3 恢复覆盖率从 4.51% 抬到 11.05%（2.45 倍）。**
命令级独抓 131 条、补上文件级抓不到的 103 条 —— 正是 T338 诊断出的那 86.73%「无文件路径主体」的失败。

## 1 · 根因（T338 已诊断）

- F3 恢复覆盖率仅 4.51%，**86.73%（1366/1575）失败没有文件路径主体** ⇒ `findRecovery`「没主体就没恢复」直接放弃。
- 两条死路已被数据排除：放宽恢复信号（接 `recoverySignalOf`）**新增 0**；「错误行前 40 字」兜底对恢复**无效**（成功事件不重述错误文本）。
- 正路：无路径失败大多是「某条命令跑挂了」，主体应是**触发它的那条命令**。

## 2 · 机制（机械、可核）

关联（已验证存在于事件结构）：
```
tool/result.data.message.toolCallId  →  tool/call.data.callId
tool/call.data.name + .arguments     →  命令主体（bash 的 command / write·edit 的 file_path）
```

新增三个纯函数（`scripts/extract-recovery.mjs`）：
| 函数 | 职责 |
|---|---|
| `commandSubjectOf(call)` | tool/call → 命令签名（bash=`bash:<归一化command>`，write/edit=`<name>:<file_path>`，其余=`<name>:<args前80>`） |
| `commandRuns(events)` | 事件 → 命令执行序列 `[{subject, seq, index, failed}]` |
| `findCommandRecovery(runs, i)` | 同主体命令后续有一次**无失败行**的执行 ⇒ `same-command-success` |

`extractRecovery` 整合：**文件级优先，命令级兜底**（并集）。
保留主体约束（命令即主体，**不凑数**）；无 `type` 的旧形态事件不触发命令级（向后兼容）。

## 3 · 实测（20 局 / 1575 失败）

| 判据 | 恢复 | 覆盖率 |
|---|---|---|
| 文件级（旧） | 71 | 4.51% |
| 命令级（新，单独） | 131 / 1072 | 12.22% |
| **文件级 ∪ 命令级（并集，本刀产出）** | **174** | **11.05%** |

样例：`ep-00b50089 seq 1087 → 恢复 @1149（same-command-success）`（文件级抓不到、命令级抓到）。

## 4 · 测试

`test/extract-recovery.test.mjs` 新增 4 条（9/9 全绿）：
- **T339 ①（tombstone）**：无文件主体、同命令再成功 ⇒ 命令级恢复（删掉 `commandRuns`/`findCommandRecovery` 则红）。
- **T339 ②**：有文件主体 ⇒ 文件级优先，不被命令级顶替。
- **T339 ③**：不同命令的成功 ⇒ 不算恢复（不凑数）。
- **T339 ④**：无 `type` 旧形态事件不触发命令级（向后兼容）。

## 5 · 诚实边界（重要）

- **这是 F3 的「测量机制」增强，不是「antipattern 已带失效条件」。**
  `falsifiableWhen` 字段在产品源码里**尚不存在**（`grep -r falsifiableWhen src/` 为空）；
  antipattern 由**棋谱边**（`edge.errorSnippet`）建，而非直接由原始事件建。
- **要让 antipattern 真正可反驳**，需把恢复抓取**接进归档/抽取层**（新字段 + 归档时回原始事件抓 + 渲染），
  这是**下一里程碑**；历史 1105 条只增不改，新机制只对新归档生效。
- 本刀先把「怎么机械抓恢复」这一步做扎实并量化 —— 这是接进产品的前提。
