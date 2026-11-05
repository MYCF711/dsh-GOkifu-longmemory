# T203 · 真 stale 对账（audit-12 的 29 vs T201 的 0）

> `[本] 2026-11-05 10:10:02 +08:00` · **只读**：不写库、不改任何 claim；未跑全量测试、未重启 DSH。
> 对象：真库 `<DSH_HOME>/memory-context`（claims **1379**，含 39 个合并节点）· 脚本 `scripts/stale-reconcile.mjs` · 单测 `test/stale-reconcile.test.mjs`

## 0 · 裁决（一句话）

**当前库的真 stale 是 29 条；audit-12 正确，T201 的 0 是 `scripts/apply-store-changes.mjs` · `findStaleTargets` 的字段名缺陷**：它用 `verdict.ok !== false` 过滤，而 `classifyClaim` 返回的是 `{action, reason, detail, why}`（**没有 `ok` 字段**）⇒ 每条都被 `continue` 跳过 ⇒ targets 恒为 0。

## 1 · 三种口径的读数（同一份真库、同一时点）

```
A （audit-12 · runValidityCheck 逐条 scopeKey）：29 条 {"version-mismatch":9,"file-appeared":20}
B0（T201 现状 · findStaleTargets）：        0 条（扫描 1379 · 已标 0 · 判不了 0）
B1（T201 意图 · classifyClaim.action==="mark"）：29 条 {"version-mismatch":9,"file-appeared":20} · 跳过 {"no-validity":1239,"unverified":58,"fresh":53}
```

差集：

```
A vs B0：只在 A 29 · 只在 B0 0 · 都在 0
A vs B1：只在 A 0 · 只在 B1 0 · 都在 29
```

**A 与 B1 完全相同（29/29 同集合）** ⇒ 两个口径本身没有分歧；分歧只在"T201 实际跑的那段代码"和"它自己的契约"之间。

## 2 · 29 条逐条（口径 A 的真 stale）

| claimId | 结论 | validity | 为什么 B0 没有 |
|---|---|---|---|
| `c-072e17c0` | version/version-mismatch | `0.3.73` | t201-ok-field |
| `c-0a7e7ac0` | version/version-mismatch | `dsh-gokifu-compact@1.16.0` | t201-ok-field |
| `c-2caa6d03` | file/file-appeared | `c:/Users/<user>/AppData/Local/Temp/pr-resp.json` | t201-ok-field |
| `c-37938a7f` | file/file-appeared | `c:/Users/<user>/AppData/Local/Temp/models.json` | t201-ok-field |
| `c-383b2271` | file/file-appeared | `c:/Users/<user>/AppData/Local/Temp/probe_dupe.py` | t201-ok-field |
| `c-3d4243e0` | version/version-mismatch | `dsh-session-superagent@0.8.11` | t201-ok-field |
| `c-4225b416` | version/version-mismatch | `dsh-session-superagent@0.8.12` | t201-ok-field |
| `c-5ccb0794` | file/file-appeared | `d:/主工作区/tmp/qq-bot-research/_cfg_check2.json` | t201-ok-field |
| `c-5d48ff82` | file/file-appeared | `c:/Users/<user>/AppData/Local/Temp/entry-0175.md` | t201-ok-field |
| `c-64a3be12` | file/file-appeared | `c:/Users/<user>/.config/magpie/plugin-updates.json` | t201-ok-field |
| `c-7171c15e` | file/file-appeared | `d:/DeepSeek Harness/default-workspace/dsh-ui/scripts/doc-links.py` | t201-ok-field |
| `c-72298d0b` | file/file-appeared | `c:/Users/<user>/AppData/Local/Temp/ps.json` | t201-ok-field |
| `c-76a0ea07` | file/file-appeared | `c:/Users/<user>/AppData/Local/Temp/dshd-tools-compact.json` | t201-ok-field |
| `c-81f0893e` | file/file-appeared | `c:/Users/<user>/AppData/Local/Temp/lingxi-score.json` | t201-ok-field |
| `c-82e1bf1f` | file/file-appeared | `c:/Users/<user>/AppData/Local/Temp/wb-head.bin` | t201-ok-field |
| `c-8a22fe45` | file/file-appeared | `d:/主工作区/repos/dsh-GOkifu-compact/evidence/持续优化-总览-2026-11-02.md` | t201-ok-field |
| `c-953203e2` | file/file-appeared | `c:/Users/<user>/AppData/Local/Temp/who.json` | t201-ok-field |
| `c-96e12366` | version/version-mismatch | `dsh-gokifu-compact@1.17.1` | t201-ok-field |
| `c-a74a2e16` | version/version-mismatch | `dsh-session-superagent@0.9.167` | t201-ok-field |
| `c-ac8cd9cc` | file/file-appeared | `c:/Users/<user>/AppData/Local/Temp/dsh-022-meta.json` | t201-ok-field |
| `c-bb8fe6f9` | version/version-mismatch | `dsh-session-superagent@0.8.14` | t201-ok-field |
| `c-bb990458` | version/version-mismatch | `dsh-gokifu-compact@1.17.2` | t201-ok-field |
| `c-bded74c5` | file/file-appeared | `c:/Users/<user>/AppData/Local/Temp/wps_usage.jsonl` | t201-ok-field |
| `c-c238fc3b` | file/file-appeared | `c:/Users/<user>/AppData/Local/Temp/dom.html` | t201-ok-field |
| `c-c2d6aa4a` | file/file-appeared | `c:/Users/<user>/AppData/Local/Temp/or.json` | t201-ok-field |
| `c-c4e308bf` | file/file-appeared | `d:/DeepSeek Harness/反代/work buddy/magpie-workbuddy/package.json` | t201-ok-field |
| `c-cb186bfd` | file/file-appeared | `c:/Users/<user>/AppData/Local/Temp/icn/shot2.png` | t201-ok-field |
| `c-cc5b8f0a` | version/version-mismatch | `dsh-gokifu-compact@1.17.3` | t201-ok-field |
| `c-d65a25b1` | file/file-appeared | `e:/Documents/deepseek-harness/default-workspace/prompt-opt/sysprompt-pack-2026-11-05-redacted/05-memory-context/README.md` | t201-ok-field |

29 条全部是同一类原因 `t201-ok-field`（不是数据问题、不是 workspace 推错）。

## 3 · 根因（可复核的代码事实）

`scripts/apply-store-changes.mjs` · `findStaleTargets`：

```js
verdict = classify(record, { probe, workspace: deps.workspace ?? process.cwd(), dshHome: … });
if (!verdict || verdict.ok !== false) continue;          // ← 这里
if (!REAL_STALE_REASONS.includes(verdict.reason)) { unjudgeable += 1; continue; }
```

`scripts/mark-stale.mjs` · `classifyClaim` 的返回形状：

```js
return { action: 'mark', reason, detail };   // 或 { action:'skip', reason, … } —— 从来没有 ok
```

⇒ `verdict.ok` 恒为 `undefined`，`verdict.ok !== false` 恒为 `true` ⇒ **每一条都在第一道 if 被跳过**，`targets` 恒空、`unjudgeable` 也恒 0（所以报告里"判不了 0"看起来一切正常）。

**为什么测试没抓到**：`test/apply-store-changes.test.mjs` 把 `findStaleTargets` 整个用 `fakeFindStale` 桩掉了（`deps.findStaleTargets`），而 `classifyClaim` 的契约由 `test/stale-marking.test.mjs` 单独测 —— **两段各自绿，中间的接缝没人测**。本次新增的 `test/stale-reconcile.test.mjs` 里有一条专门的回归守卫（`classifyDiffGuard`）盯这个形状。

## 4 · T201 的假设为什么不对

T201 的结论写的是「这 29 条依赖 stale-pass 的副本 dataRoot 语义；按 `scopeKey` 推每个 claim 自己的 workspace 复算仍是 0」。复算结果：

- A 与 B1 **都**用 `workspaceOf(record, workspace)` 逐条推 workspace（口径完全一样），两边都是 **29**；
- 差别只在于 A 走 `runValidityCheck`、B1 走 `classifyClaim`，而今天 T201 实际跑的是 B0（有缺陷的那段）——**不是 dataRoot/workspace 的语义差异**。
- `posix-ambiguous` 本轮 **0 条**（29 条的路径全是 `c:/`、`d:/`、`e:/` 开头，没有 `/tmp/x` 方言）。
- `unverified` 58 条两边都不标（一致）；`fresh` 53 条（一致）。

## 5 · audit-12 那一段要怎么改

原文（`reports/audit-12.md` §2 末尾「洞 3（数据）」那一段）：

> **洞 3（数据）**：真库 **20 条 file-appeared + 9 条 version-mismatch = 29 条已真 stale**，`state` 全为 `observed`（未标 stale）⇒ 渲染它们的卡会被闸 3 拦（行为正确，但需要一次 stale 标记的数据修复）。

**数字不用改**（复算仍是 29）。建议在该段后补一句口径与时点：

> （T203 复核：2026-11-05 用 `scripts/stale-reconcile.mjs` 三口径并列复算 —— A=29 · T201 现状 B0=0 · T201 意图 B1=29，A 与 B1 同集合；T201 的 0 来自 `findStaleTargets` 用 `verdict.ok !== false` 过滤 `classifyClaim` 的 `{action}` 返回值（字段名缺陷），不是 dataRoot/workspace 语义差异。另：真库已由 1340 增至 1379 条并含 39 个合并节点，见 `evidence/T203-stale-reconcile.md`。）

**如果只动一处：改 audit-12 的数字反而是错的** —— 该修的是 `findStaleTargets` 那一行。

## 6 · 复现

```bash
node scripts/stale-reconcile.mjs            # 人读：A / B0 / B1 + 差集 + 逐条原因
node scripts/stale-reconcile.mjs --json     # 机器读
node --test "test/stale-reconcile.test.mjs" # 6 条纯函数单测（含 ok/action 回归守卫）
```

**最小修法（只描述）**：`scripts/apply-store-changes.mjs` · `findStaleTargets` 把
`if (!verdict || verdict.ok !== false) continue;` 改成 `if (!verdict || verdict.action !== 'mark') continue;`，
并给 `test/apply-store-changes.test.mjs` 加一条**不桩 findStaleTargets** 的端到端（用 `classifyClaim` + 假探针）。
