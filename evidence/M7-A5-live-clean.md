# M7 · A5 线上复核：补闸后跨作用域引用归 0（2026-11-04）

> 目的：0.117.0 修掉 `entryFromClaim` 的跨作用域取源后，验收那条**线上**判据 —— `audit-card-samples` 的 `crossScopeRefs` 必须归 0。
> 方式：主人重启 DSH → 新宿主进程加载 0.117.0 → 真实会话继续产生注入 → 抽查留样卡片逐条比对。

## 1 · 重启与版本确认

| 事实 | 值 | 依据 |
|---|---|---|
| 旧宿主进程 | pid 36056，末行 07:37:34 | `live-stats.jsonl` 按 pid 切分 |
| 新宿主进程 | pid 38972，首行 **07:44:05** | 同上（第 11674 行） |
| 重启后心跳 | 到 07:50:57 已 22 条 pre-step，其中 `action=inject` **8** 条 | 同上 |
| 重启后注入作用域 | DSH-GO 6 · GOkifu上下文压缩 1 · 长期记忆系统 1 | 同上 |
| 加载版本 | profile `node_modules/dsh-gokifu-longmemory` = **0.117.0** | `package.json` |

0.116.0 才引入的 `sampleCards`（默认 true）在重启后继续写 `<storeRoot>/card-samples.jsonl`，
且 0.117.0 才有的补闸行为在下面被观测到 —— 两者共同证明宿主确实加载了新版本，不是旧进程残留。

## 2 · 抽查结果（`node scripts/audit-card-samples.mjs`）

全量 22 张卡 / 98 条引用：

| 指标 | 值 |
|---|---|
| 可回溯（ep 存在且 seq 落在闭包内） | **98 / 98 = 100%** |
| 同作用域引用 | 96 |
| 跨作用域引用 | **2** |
| 其中**重启后**（≥ 07:44:05）样本 | 8 张 / 34 条引用 / 跨作用域 **0** |

那 2 条跨作用域引用全部来自**补闸前**的卡：

- `2026-11-04 06:57:35` · scope `…/default-workspace/DSH-GO` · `ep-1cf2b33f@783`
- `2026-11-04 07:37:34` · 同上，同一条引用（同一个 digest 反复命中）

两条都是同一个 `ep-1cf2b33f` —— 与 `evidence/M7-A5-live-leak.md` 定位的根因完全一致（`u:owner` 类级 claim 的 support 跨工作区，取 support[0] 时把别项目的失败原文渲染进本项目的卡）。
补闸之后（07:44 起）再没出现过一条跨作用域引用，且期间仍持续有注入（8 次），说明不是"因为不再注入所以不越界"。

## 3 · 判据

| 六轴 | 判据 | 读数 | 结论 |
|---|---|---|---|
| A5 跨作用域 | `crossScopeRefs = 0` | 补闸后线上 0 / 补闸前 2 | **通过（线上）** |
| A6 可回溯 | 引用 100% 可核 | 98/98 | 通过（线上） |
| A3 线上 | 宿主真实注入且失败 0 | 累计 `inject=62`、失败字段 0 条 | 通过 |

## 4 · 复现命令

```bash
node scripts/live-stats.mjs            # 按 pid / 动作看宿主心跳
node scripts/audit-card-samples.mjs    # 卡片引用可回溯性 + 跨作用域计数
```

按 pid 切分（定位任意一次重启的边界）：

```bash
node -e "const fs=require('fs');const rows=fs.readFileSync('D:/DeepSeek Harness/home/memory-context/live-stats.jsonl','utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));const m=new Map();for(const r of rows){const e=m.get(r.pid)||{n:0,f:r.at,l:r.at,inj:0};e.n++;e.l=r.at;if(r.action==='inject')e.inj++;m.set(r.pid,e)}for(const [k,v] of [...m].sort((a,b)=>a[1].f-b[1].f))console.log(k,new Date(v.f).toLocaleString(),'→',new Date(v.l).toLocaleTimeString(),'n='+v.n,'inject='+v.inj)"
```

## 5 · 口径与限制

- 只统计 `src=index.js`（宿主）；`src:sim-inject.mjs` 的仿真行不计入。
- 样本是"注入成功才留样"，所以 `crossScopeRefs=0` 只覆盖**成功渲染**的卡；被闸挡掉的命中不产生留样（那部分由 A2b 离线指标覆盖）。
- 抽样窗口只有重启后 6 分钟（8 张），不能外推为长期分布；下一轮巡检继续累计。
