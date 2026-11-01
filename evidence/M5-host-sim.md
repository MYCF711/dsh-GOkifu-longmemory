# M5 · 宿主仿真：A3（可靠性）与端到端注入

`[本] 2026-11-02 05:12 +08:00` · 语料 `tmp/memory-context`（92 局 / 780 主题 / 125 claim）· 工作树
**这是仿真，不是线上**：用真实 `src/plugin.mjs` + 真实 store，跑 N 个"新会话首轮"的 `agent/pre-step` 决策；假 session 的 `append` 一旦被调用就抛错（证明不写会话事件）。**未安装、未重启、未写 <DSH_HOME>。**

## 结果（40 会话 × 2 轮；另有 20 会话带 100ms 间隔）

| 指标 | 值 |
|---|---|
| attempts | 40 / 40 |
| injected | 16（40%） |
| empty（沉默） | 24（60%） |
| **failed** | **0** |
| **injectFailureRate** | **0.00%** |
| warn | 0 |
| **session.append 调用** | **0**（断言：一旦调用就抛错） |
| 延迟 p50 | 2.9–4.0 ms |
| 延迟 p95 | **40.2–47.4 ms**（≤50ms） |
| 延迟 max | 56.8–113.5 ms（偶发 GC） |
| 注入 tokens p50 | **300**（预算 500） |

## 关键修复（0.9.0）

宿主仿真第一次跑出 p95 62–115ms，定位为**闸 3 真核验每次都走 fs/git**（每条 validity 一次 `git cat-file`/读 `package.json`）。加 `PROBE_CACHE`（按 `validity key + workspace + 60s 桶`）后 p95 降到 **40–47ms**。

## 判定

- **A3 从 `not-live` 升级为 `simulated`**：仿真里 0 失败、0 会话写入、0 warn；但**仍不是线上**，不能当生产可靠性证据。
- 注入率 40%（16/40），沉默 60%：与"沉默是默认"一致；该工作区语料少（11 条 claim）是主因。
- 延迟 p95 40–47ms 在门槛内；max 的 GC 尖峰仍存在，单独一次不影响会话。

## 复现

```bash
node scripts/host-sim.mjs --store tmp/memory-context --workspace . --runs 40
node scripts/host-sim.mjs --store tmp/memory-context --workspace . --runs 20 --gap-ms 100
```
