# T42 · 重启验证一键脚本 `scripts/post-restart-verify.mjs`

> 2026-11-08 · 把 `docs/重启验证清单.md` 变成**一条命令跑完、每项给 PASS/FAIL/NO-SAMPLE + 证据**的机械脚本。
> 目的：重启后不再靠人手抄清单——机器判，判不了就说 NO-SAMPLE，**不许硬算过**。

## 1 · 用法与退出码

```bash
node scripts/post-restart-verify.mjs            # 人类可读（每项 status + 一行证据）
node scripts/post-restart-verify.mjs --json     # 机器可读（items[] + summary）
node scripts/post-restart-verify.mjs --store <dir>        # 非默认记忆库
node scripts/post-restart-verify.mjs --timeout-ms 600000  # 子命令超时
```

| 退出码 | 含义 |
|---|---|
| `0` | 没有 FAIL（全 PASS，或 PASS + NO-SAMPLE） |
| `1` | 至少一项 FAIL |
| `2` | **全部** NO-SAMPLE（什么都判不了） |

> ⑥⑦ 是静态判据（读源码 / 跑 metrics-guard），永远判得出 PASS/FAIL ⇒ 实际跑几乎总落在 `0/1`；
> `2` 的分支由 `summarize()` 单测钉住（`test/post-restart-verify.test.mjs` 的「全 NO-SAMPLE=2」）。

## 2 · 七项判据（全部机械）

| # | 项 | 数据源 | 门槛 | 样本不足时 |
|---|---|---|---|---|
| ① | 新代码已加载 | `instance-status.mjs` 输出 + `package.json`/`CHANGELOG.md` 的 mtime + 当前宿主 pid 首条心跳 | 包版本 ≥ 本仓版本 **且** 软链 OK **且** 首心跳晚于发版时点 | 没有心跳 ⇒ NO-SAMPLE |
| ② | T12：abstain 不再全塌 cross-scope | `<store>/live-stats.jsonl`，当前 pid 的 `action=abstain` 行 | 出现**任何**非 `cross-scope` 的 reason | 没有 abstain 行 ⇒ NO-SAMPLE |
| ③ | T10：signalPreview 完整度 | `<store>/card-samples.jsonl`，当前 pid 最近 30 条 | `signalPreview` 长度 >160 的比例 **> 30%** | <5 条 ⇒ NO-SAMPLE |
| ④ | T25：重复注入减少 | 当前 pid 的 `action=inject` 行，按 `(scope,digest)` 分组 | 重复率 **< T24 基线 36.23%**（471/1300） | <20 条 ⇒ NO-SAMPLE |
| ⑤ | T28/T31：恢复事实尾注 | `cli.mjs inject --shadow --signal "推进任务表"` 的卡文本 | 出现 ` · 恢复` 尾注 | 没命中恢复事实 ⇒ NO-SAMPLE（「无恢复事实命中」） |
| ⑥ | T16/T18/T20：三个 cap = 64MB | `src/plugin.mjs` 的 `CARD_SAMPLE/LIVE_STATS/MESSAGE_CORPUS_CAP_BYTES` | 三个都等于 `64*1024*1024` | 常量缺失也算 FAIL |
| ⑦ | T27：A1 三轴 | `metrics-guard.mjs` 输出 | 含 `A1 三轴` | 脚本跑不起来 ⇒ FAIL |

设计说明（为什么这么判，而不是更宽松）：

- **① 不能只看版本号**：插件是软链直读源码，`instance-status` 的「包版本」永远是新版本——真正决定「在跑哪份代码」的是**宿主进程的启动时间**。所以必须同时要求「当前 pid 首心跳 > 最新发版时点」（发版时点 = `package.json` / `CHANGELOG.md` 的 mtime 取最大）。
- **②③④ 都按「当前宿主 pid」切账**：live-stats/card-samples 是跨进程追加的，旧 pid 的行是旧代码的账，混进来会把修复后的指标稀释成假绿/假红。
- **④ 是 scope 级代理口径**：`live-stats` 行里**没有 session id**（T24 的会话级口径要解会话日志），所以这条只能测「同 scope 同 digest 的重复注入率」是否低于 T24 的 scope 级基线。T25 修的是会话级重复，跨会话的重复本来合法（T24 §二：36.23% 的主体是「同 scope 多会话各拿一次」）——所以这条是**上界检查**，不是 T25 的完整验收。
- **⑤ 匹配 ` · 恢复` 而不是 ` · 恢复：`**：T37 会在「恢复」后插 `（class:…）` 洞见标签（` · 恢复（class:race）：后于 …`），写死冒号会假阴性。
- **⑥ 只认 `64 * 1024 * 1024` 或纯字节数**，拒绝 `64 * 1000 * 1000` 这类近似写法。

## 3 · 本次实测（线上仍是旧代码 —— 脚本如实报 FAIL/NO-SAMPLE）

运行：`node scripts/post-restart-verify.mjs`（2026-11-08 23:1x，宿主 pid 25256，跑的还是 06:53 启动的旧进程）

```
FAIL      新代码已加载（instance-status + 宿主启动时间）
          包版本 0.8.76 ≥ 0.8.76；软链 OK；宿主首心跳 2026-11-07T22:53:09.765Z 早于 发版 2026-11-08T13:43:28.026Z ⇒ 仍是旧进程（需要重启宿主）
FAIL      T12：abstain 的 reason 不再全塌 cross-scope
          n=73 · reason cross-scope=73 ⇒ 仍全塌 cross-scope（T12 未生效）
FAIL      T10：card-samples 的 signalPreview 完整度
          最近 30 条：>160 字符 0 条（0.0%，门槛 >30%）· 中位长度 160 ⇒ 仍以 160 字截断为主（T10 未生效）
FAIL      T25：同 scope 同 digest 重复注入（对照 T24 基线）
          n=282 · 不同 (scope,digest)=157 · 多余注入=125 · 重复率 44.3% vs T24 基线 36.2% ⇒ 未低于基线（oncePerSession 可能仍未生效）
NO-SAMPLE T28/T31：卡上出现「 · 恢复」尾注
          本次信号没有命中带恢复事实的 claim（卡上没有 · 恢复 尾注 —— 没样本，不能判过）
PASS      T16/T18/T20：三个 sidecar 上限常量 = 64MB
          CARD_SAMPLE_CAP_BYTES=64MB · LIVE_STATS_CAP_BYTES=64MB · MESSAGE_CORPUS_CAP_BYTES=64MB ⇒ 三个都是 64MB
PASS      T27：metrics-guard 输出含「A1 三轴」
          命中：A1 三轴 · A1.stale=0.0% A1.opposite=0.0%（可判率 20.9%，n=993，未通电·不参与 exit code（0 次触发 ≠ 无反向记忆））（guard exit=1，与本项无关）

汇总：2/7 项通过 · FAIL=4 · NO-SAMPLE=1 ⇒ exit 1
```

**这组数字本身就是「不硬算过」的证据**：
- ② 没有把「73 条全是 cross-scope」说成通过；
- ③ 没有把「0/30 条 >160」说成通过；
- ④ 没有把 44.3%（高于基线）说成通过；
- ⑤ 没有把「没命中恢复事实」说成通过，而是 NO-SAMPLE 并写明为什么；
- ① 没有因为「包版本 0.8.76 = 当前版本、软链 OK」就判过——宿主启动时间早于发版时点，直判 FAIL。

另一次紧接的 `--json` 运行落盘在 `tmp/t42-verify-now.json`：`{"pass":2,"fail":4,"noSample":1,"total":7,"exitCode":1,"text":"2/7 项通过"}`
（逐项 `status/evidence` 与人读版一致；`n=283` 这类数字随宿主持续写入小幅变动，判据不变）。

**空库冒烟**（`runChecks({store:'tmp/t42-empty-store'})`，故意把子命令超时压到 4s）：5 项 NO-SAMPLE、⑥ PASS、⑦ 因超时 FAIL、`exit 1` ——
没有抛异常、也没有任何一项因为「没数据」被算成 PASS；⑦ 超时被如实记 FAIL（`exit=127`），不是补绿。

## 4 · 重启后应如何转 PASS（逐项机制）

| # | 重启后为什么应转 PASS |
|---|---|
| ① | 新宿主 pid 的首条心跳 ≥ 重启时刻 > 发版时点 ⇒ `宿主首心跳 晚于 发版`，包版本/软链本来就 OK |
| ② | T12 修掉了 `crossScopeWalk` 恒真 ⇒ abstain 的 reason 出现 `no-relevant-claim` / `low-confidence` 等 |
| ③ | T10 的完整信号上线 ⇒ 新卡样本 `signalPreview` 中位 ~1.1KB，>160 的比例 ~70%（T10 实测），远超 30% |
| ④ | T25 的 `session.id` 判据上线 ⇒ 同会话重复被拦，scope 级重复率应低于 36.2%（T25 预估 −20%~−29%） |
| ⑤ | 若卡上命中带恢复事实的 claim ⇒ 出现 ` · 恢复`；仍没命中就继续 NO-SAMPLE（**不许**为了转绿去挑信号） |
| ⑥ | 代码常量已就位（现在就是 PASS），重启不影响 |
| ⑦ | 现在就是 PASS；重启后 `A1.redundant` 通电判定可能变化，但「A1 三轴」这行一定在 |

## 5 · 自测

```bash
node --test test/post-restart-verify.test.mjs     # 12/12 pass
```

覆盖：版本比较（`0.8.9 < 0.8.76` 的字符串陷阱）、instance-status 解析、① 的三种失败形态（旧进程/版本低/软链错/无心跳）、
②③④ 的 NO-SAMPLE 边界与 FAIL 形态、⑤ 的 `（class:…）` 变体、⑥ 的缺失/32MB、⑦ 缺行、汇总的 0/1/2 映射、
当前 pid 选取（按 `at` 取最新、忽略仿真行），以及一条**接线断言**：本仓 `src/plugin.mjs` 现在真的三个 cap 都是 64MB（脚本判据不是空转）。

## 6 · 已知边界（如实写）

1. **④ 不是 T25 的完整验收**：live-stats 没有 session id，只能测 scope 级重复率（上界检查）；T25 的会话级验收仍需 T24 的会话日志口径（`tmp/t24-*.json` + `scripts/t24-session-dup.mjs`）。
2. **① 用 mtime 当「发版时点」**：git checkout / 分支切换会刷新 mtime，可能把「已重启」误判成「旧进程」（保守方向，不会假绿）。若被误判，重启一次即可消解。
3. **⑤ 每次运行会追加一行 `evidence/shadow/shadow.jsonl`**（`inject --shadow` 的设计写盘面，清单要求跑这条命令）；该目录已 gitignore。
4. **⑦ 是重命令**（本次约 58s，全脚本约 63s）；`metrics-guard` 自身的 exit code 与本项无关（它判六轴门槛），本项只检查「A1 三轴」这行在不在。
5. 读数随宿主持续写入而小幅变动（`n=282` / `n=73` 这类数字每次跑会变），判据不变。
