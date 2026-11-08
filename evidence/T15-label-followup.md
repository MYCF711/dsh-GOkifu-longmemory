# T15 · T13 跟进：标注定点修（#4/#14）+ polarity 快照标注 + T2 回归去快照依赖

> 日期：2026-11-08 · 任务：t7（队长派单，源自 `evidence/T13-label-review.md` 的三条发现）
> 可写面：`evidence/label-set.json`、`test/abstain.test.mjs`、本文件。**没有改** `src/**`、`scripts/**`、`package.json`、`CHANGELOG.md`、`MAINTENANCE.md`、版本号、台账。
> 基线：HEAD `2a1042f`（main，0.8.50）· `evidence/label-set.json` 改前 sha256 `bbe36dd6f7bd429899620d81f7fc67ff7eebb17cadf8dabb74babc4fff79567e`（= T1 blob `55ec9ef`）· 改后 `d277536b3ef7815895ca299016a69dfcbd091c900abf44ca8f381ac03033fc3a`。

## 0 · 验收（逐条对）

| 验收项 | 要求 | 实测 | 结论 |
|---|---|---|---|
| ① `node --test test/abstain.test.mjs` 全绿 | 必须绿 | **32 pass / 0 fail / 0 skipped**（含改名后的 T2 回归用例） | ✅ |
| ② 135 条里除 #4/#14 外**逐字节不变** | diff 证明 | **133/133 条 `JSON.stringify` 逐条相同**；#4 只改 `verdict+stratum+why`、#14 只改 `stratum`；顶层只 `stats`/`polarityBaseline`/`polarityReport` 变 + `polaritySnapshot` 新增（§4①） | ✅ |
| ③ 三条各一段写进本文件 | ① ② ③ | §1 / §2 / §3 | ✅ |

## 1 · ① 定点修标注（只动两条 + 由它们派生的统计）

### 1.1 两条改了什么

| pair | 字段 | 改前 | 改后 | 依据（来自 T13 §4.1） |
|---|---|---|---|---|
| **#4** | `verdict` | `relevant` | **`irrelevant`** | claim 不在信号里（LCS 仅 3 字「问题，」、`overlap=0`）；claim 出自 `ep-2ddf0a19`（magpie 本地翻译引擎，同局有「显存: 194 MiB」），信号出自 `ep-1f6c629b`（浏览器/webview 内存），且跨 scope（`w:e:/…` × `w:d:/…`）⇒ 只共享「内存/显存」泛词、指向另一对象 |
| **#4** | `stratum` | `same` | **`hard`** | `bigramRaw=3 ≥ 2` 且人工判 `irrelevant` ⇒ 正好符合 `hard`（难负例）定义 |
| **#4** | `why` | 原 T1 理由（「同一议题…同域」） | 原句**原样保留** + 追加「T13 复核改判：…原判 relevant 不成立」 | 只增不改：保留 T1 原判依据，改判理由接在后面，不删旧记录 |
| **#14** | `stratum` | `same` | **`rel`** | claim 出自**同一局**（`ep-d62a520c`）、同一对象（图片/看图链路）⇒ `verdict=relevant` **成立且不动**；只是 claim 不是信号那句（LCS 3 字），层应为 `rel` |

其余 **133 条逐字节不变**（`itemId`/`claimId`/`signalText`/`claimText`/`claimKind`/`claimScope`/`bigramRaw`/`overlap`/`polarity`/`why` 全字段）。

### 1.2 派生统计（`stats`，全部由 `pairs` 重算，不是手写）

| 字段 | 改前 | 改后 | 为什么变 |
|---|---|---|---|
| `byVerdict.relevant` | 58 | **57** | #4 relevant→irrelevant |
| `byVerdict.irrelevant` | 63 | **64** | 同上 |
| `byStratum.same` | 19 | **17** | #4、#14 各移出 1 条 |
| `byStratum.rel` | 24 | **25** | #14 进来 |
| `byStratum.hard` | 49 | **50** | #4 进来 |
| `irrelevantRatio` | 0.4667 | **0.4741** | 64/135 |
| `hardNegatives` | 49 | **50** | `hard` 层且 `bigramRaw≥2` 且 `irrelevant`（=「误判清单」长度） |
| `decidableRelevant` | 32 | **31** | #4 不再是 relevant |
| `mechanicalDecidableIrrelevant` / `decidableIrrelevant` | 12 | **13** | #4 的 `polarity`（快照）仍是 `same` ⇒ 计入「机械可判但人工判 irrelevant」 |
| `semanticDecidabilityOnNonStratified` | 0.1287 | **0.1456** | 非 `same`/`dir` 层 15/103（#4、#14 都进了非分层区） |
| `decidabilityOnRelevant` | 0.5517 | **0.5439** | 31/57 |
| `n` · `decidable` · `decidability` · `randomNegatives` · `maxBigramAmongHardNeg` · `hardNegBigramMin` | — | **不变** | `decidable=45`、`decidability=0.3333` 是**快照口径**（§2），与标签改动无关 |

> 任务书只点名 `irrelevantRatio` / `hardNegatives` / 误判清单三处；上表把**所有由这两条派生**的字段一起对齐 —— 否则 `decidableRelevant=32` 会和 `pairs` 自相矛盾（实际 31）。每一项都用 §4③ 的脚本复算，0 处不符。
> 同源派生文字也顺手对齐：`polarityBaseline.note` 的「hard 层含 **12** 条机械可判但内容无关」→「**13** 条（#4 改判后）」。

## 2 · ② polarity 快照标注（不再假装「可用于决策」）

**事实**（T13 §6-C 已实测，本轮复核未变）：

| 比对 | 结果 |
|---|---|
| 文件里的 `polarity` × T1 判据树 `git show 55ec9ef:src/rooms/abstain.mjs` 的 `detectPolarity` | **135/135 逐条一致**（`same 25 / opposite 20 / unclear 90`） |
| 文件里的 `polarity` × HEAD 的 `detectPolarity` | **27/135 不一致**（HEAD：`same 24 / opposite 2 / unclear 109` ⇒ 可判率 **19.26%** < 30% 下限） |

**处置**：

1. **新增** `polaritySnapshot`（插在 `polarityReport` 与 `pairs` 之间，键序见 §4①）：

```json
"polaritySnapshot": {
 "commit": "55ec9ef",
 "module": "src/rooms/abstain.mjs@T1",
 "note": "polarity / polarityCounts / polarityReport 是 T1 旧判据（commit 55ec9ef 的 detectPolarity）的快照，与当时逐条一致；stats.decidable*/decidability* 亦按该快照口径计算。任何消费者要当前判据，请用 src/rooms/abstain.mjs 的 polarityScorecard(pairs) 现场重算。",
 "headRecount": { "same": 24, "opposite": 2, "unclear": 109, "decidable": 26, "decidability": 0.1926, "usableForDecision": false }
}
```

2. **改** `polarityReport` 的两处：
   - `usableForDecision`：`true` → **`false`**；
   - `text`：`反向记忆率 14.8%（20/135）· 可判率 33.3%（45/135）· 可用于决策`
     → `反向记忆率 14.8%（20/135）· 可判率 33.3%（45/135）· 以上为 T1 旧判据（55ec9ef）快照；按 HEAD 判据重算可判率 19.3%（26/135）< 30% 下限 ⇒ 不可用于决策`。
3. **不动** `polarity` / `polarityCounts`（25/20/90）/ `polarityReport` 的计数字段 —— 快照必须保持**可复算**（任何人用 `55ec9ef` 的 `detectPolarity` 都能验回来，§4④）。
4. **下游消费者不受影响**：`scripts/m5-report.mjs` 与 `src/rooms/abstain.mjs` 的 `polarityScorecard` 都是**现场重算**（`detect` 默认 `detectPolarity`），不读文件里的 `polarity`；只有 `test/abstain.test.mjs` 原先读过它，已在 §3 改掉。

## 3 · ③ T2 回归假红：改成固定 pairId 清单

### 3.1 先纠正任务书里的一处事实（否则证据会写错）

任务书写「①改完后该过滤式取到 0 条」。**实测不是**：

```bash
$ node --input-type=module -e '…'   # 全文见 §4②
旧过滤式（当前文件、快照 polarity）: 13  4,64,65,66,67,68,69,76,77,78,80,81,82
旧过滤式（polarity 按 HEAD 刷新）: 0 ⇒ 旧断言 >=12: FAIL(假红)
```

- 只改 `verdict` 时：`verdict==='irrelevant' && polarity!=='unclear'` 取到 **13 条**（原 12 条 + `#4`，因为 `#4` 的快照 `polarity` 仍是 `same`），旧断言 `>= 12` **仍然通过**。
- **真正会红的是下一步**：把 `polarity` 按 HEAD 重算（这正是「快照 vs HEAD 差 27 条」会诱导的维护动作）⇒ 过滤式 **0 条** ⇒ `assert.ok(0 >= 12)` 红，而且红的是「清单来源被换掉」，不是行为回归。

⇒ 旧写法是**定时炸弹**，不是「已经红」。固定清单把这条依赖彻底拆掉，两种情况都不会假红。

### 3.2 改法（`test/abstain.test.mjs`，只动这一条用例）

1. 用例名：`T2 回归：…+ 12 条「必须退回 unclear」` → **`T2 回归：…固定样本上 8 条「不得判 opposite」+ 13 条「必须退回 unclear」`**。
2. 删掉过滤式 `set.pairs.filter((p) => p.verdict === 'irrelevant' && p.polarity !== 'unclear')`，改成**固定 13 个 pairId**：
   `const MUST_BE_UNCLEAR_PAIR_IDS = [4, 64, 65, 66, 67, 68, 69, 76, 77, 78, 80, 81, 82];`
   （= T1 快照的 12 条误判 + T13 改判的 `#4`）；每条先断言存在、再断言 `verdict === 'irrelevant'`，最后断言 HEAD 判据 `detectPolarity === 'unclear'`；另断言清单长度 = 13。
3. 追加 **②' 快照 pin（3 条断言）**：`set.polaritySnapshot.commit === '55ec9ef'`、`module === 'src/rooms/abstain.mjs@T1'`、`polarityReport.usableForDecision === false` —— 防止有人把快照悄悄刷成 HEAD 值、又把「不可用于决策」改回去。
4. ①（8 条 `dir`/`polarityHuman==='same'` 不得判 `opposite`）、③（真反向至少保留 2 条）**一字不动**。

## 4 · 验证（可复现，全部实测）

```bash
# ① 135 条逐字节证明（HEAD 基线 vs 工作树）
git show HEAD:evidence/label-set.json > /tmp/label-set.head.json
node -e '
const fs=require("fs");
const before=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const after=JSON.parse(fs.readFileSync("evidence/label-set.json","utf8"));
let identical=0; const changed=[];
for(let i=0;i<before.pairs.length;i++){
  if(JSON.stringify(before.pairs[i])===JSON.stringify(after.pairs[i])) identical++;
  else changed.push([before.pairs[i].pairId,Object.keys(before.pairs[i]).filter(k=>JSON.stringify(before.pairs[i][k])!==JSON.stringify(after.pairs[i][k])).join("+")]);
}
for(const k of Object.keys(after)){ if(!Object.hasOwn(before,k)) console.log("added:",k); else if(JSON.stringify(before[k])!==JSON.stringify(after[k])) console.log("changed:",k); }
console.log("pairs:",before.pairs.length,"->",after.pairs.length,"| byte-identical:",identical,"| changed:",JSON.stringify(changed));
' "$(cygpath -w /tmp/label-set.head.json)"
# 实测输出：
#   changed: stats / polarityBaseline / polarityReport
#   added: polaritySnapshot
#   changed: pairs
#   pairs: 135 -> 135 | byte-identical: 133 | changed: [[4,"verdict+stratum+why"],[14,"stratum"]]

# ② 旧过滤式 vs 固定清单（§3.1）
node --input-type=module -e '
import fs from "node:fs";
import { detectPolarity } from "./src/rooms/abstain.mjs";
const set = JSON.parse(fs.readFileSync("evidence/label-set.json","utf8"));
const old = set.pairs.filter(p => p.verdict === "irrelevant" && p.polarity !== "unclear");
const oldRefreshed = set.pairs.map(p => ({...p, polarity: detectPolarity(p.signalText, p.claimText)})).filter(p => p.verdict === "irrelevant" && p.polarity !== "unclear");
console.log("旧过滤式（当前文件、快照 polarity）:", old.length, old.map(p => p.pairId).join(","));
console.log("旧过滤式（polarity 按 HEAD 刷新）:", oldRefreshed.length, "⇒ 旧断言 >=12:", oldRefreshed.length >= 12 ? "PASS" : "FAIL(假红)");
'

# ③ `stats` 全部由 pairs 重算一致
node -e '
const fs=require("fs"); const j=JSON.parse(fs.readFileSync("evidence/label-set.json","utf8")); const P=j.pairs, r4=x=>Math.round(x*10000)/10000;
const cnt=f=>P.filter(f).length;
const byV={}, byS={}; for(const p of P){byV[p.verdict]=(byV[p.verdict]||0)+1; byS[p.stratum]=(byS[p.stratum]||0)+1;}
const dec=cnt(p=>p.polarity==="same"||p.polarity==="opposite"), dRel=cnt(p=>p.verdict==="relevant"&&p.polarity!=="unclear"), dIrr=cnt(p=>p.verdict==="irrelevant"&&p.polarity!=="unclear");
const ns=P.filter(p=>p.stratum!=="same"&&p.stratum!=="dir");
const hard=P.filter(p=>p.stratum==="hard").map(p=>p.bigramRaw);
const exp={byVerdict:byV,byStratum:byS,irrelevantRatio:r4(byV.irrelevant/P.length),hardNegatives:cnt(p=>p.stratum==="hard"&&p.bigramRaw>=2&&p.verdict==="irrelevant"),randomNegatives:cnt(p=>p.stratum==="random"&&p.verdict==="irrelevant"),decidable:dec,decidability:r4(dec/P.length),decidableRelevant:dRel,mechanicalDecidableIrrelevant:dIrr,semanticDecidabilityOnNonStratified:r4(ns.filter(p=>p.polarity!=="unclear").length/ns.length),decidabilityOnRelevant:r4(dRel/byV.relevant),decidableIrrelevant:dIrr,maxBigramAmongHardNeg:Math.max(...hard),hardNegBigramMin:Math.min(...hard)};
const flat=o=>(o&&typeof o==="object")?JSON.stringify(Object.keys(o).sort().map(k=>[k,o[k]])):JSON.stringify(o);
const bad=Object.keys(exp).filter(k=>flat(exp[k])!==flat(j.stats[k]));
console.log("stats vs recomputed:", bad.length?JSON.stringify(bad):"全部一致（0 处不符）");
'
# 实测输出：stats vs recomputed: 全部一致（0 处不符）

# ④ 快照仍可复算（T1 树逐条一致 / HEAD 差 27）
git show 55ec9ef:src/rooms/abstain.mjs > /tmp/abstain-t1.mjs
node --input-type=module -e '
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const old = await import(pathToFileURL(process.argv[1]).href);
const { detectPolarity: now } = await import("./src/rooms/abstain.mjs");
const P = JSON.parse(fs.readFileSync("./evidence/label-set.json","utf8")).pairs;
console.log("vs T1-tree diff:", P.filter(p=>old.detectPolarity(p.signalText,p.claimText)!==p.polarity).length,
            "| vs HEAD diff:", P.filter(p=>now(p.signalText,p.claimText)!==p.polarity).length);
' "$(cygpath -w /tmp/abstain-t1.mjs)"
# 实测输出：vs T1-tree diff: 0 | vs HEAD diff: 27

# ⑤ 验收测试
node --test test/abstain.test.mjs
# 实测：tests 32 · pass 32 · fail 0 · skipped 0
# ✔ T2 回归：`evidence/label-set.json` 固定样本上 8 条「不得判 opposite」+ 13 条「必须退回 unclear」

# ⑥ 仓库自检（未被本次数据改动破坏）
node scripts/check.mjs   # 实测：check: PASS

# ⑦ 官方测试命令（`package.json` 的 test 脚本，全仓 1117 条）
node --test "test/*.test.mjs"
# 实测：tests 1117 · pass 1111 · fail 0 · skipped 6 · exit 0
```

> **别用裸 `node --test`**：它会把 `tmp/t227-before-test.mjs`（gitignored 的 2026-11-05 遗留快照文件）也当测试跑，报 2 条与本改动无关的 red（R11 merge 节点断言）。本改动**没有碰** `tmp/`，那两条 red 在本次改动前就存在；官方脚本限定 `test/*.test.mjs`，全绿。

## 5 · 未动面 / 工作树说明

| 路径 | 本任务是否改 | 说明 |
|---|---|---|
| `evidence/label-set.json` | ✅ 改（可写面） | #4/#14 + 派生 stats + 快照标注 |
| `test/abstain.test.mjs` | ✅ 改（可写面） | 只动「T2 回归」这一条用例 |
| `evidence/T15-label-followup.md` | ✅ 新建（可写面） | 本文件 |
| `src/**` / `scripts/**` / `package.json` / `CHANGELOG.md` / `MAINTENANCE.md` / 版本号 | ❌ 未改 | 任务禁止 |
| `docs/任务书.md`（M）、`install-superagent.cmd`（未跟踪） | ❌ 未改 | 开工前就已在工作树里（前序产物） |
| `src/plugin.mjs`（M） | ❌ 未改 | **本次任务期间**由并行任务改动；本任务全程未写该文件（可核：本任务只写过上表三处） |

## 6 · 备注 / 已知遗留

1. **`polarity` 快照会继续漂移**：它锁的是 `55ec9ef` 的判据；以后 `src/rooms/abstain.mjs` 再改（T12 已改过一次），差集只会变大。`polaritySnapshot.note` 已写清「要当前判据请现场重算」，但**没有任何机制**阻止快照过期 —— 若将来要更严，可让 `m5-report` 或 CI 在 `polarity` ≠ 现场重算时**告警**（本轮不做，避免扩大改动面）。
2. **T1 文档未同步**：`evidence/T1-label-expansion.md` §三「`same` 19 条 / 机械可判 19（100%）」与 §五「12 条误判」仍是改前口径（T13 §7-F2 提过）。本任务可写面不含该文件，**未改**；如需同步，属另一次取证。
3. **`#4` 的 `why` 是追加而非覆盖**：保留 T1 原判依据 + T13 改判理由，读者能同时看到两轮结论（只增不改）。
4. **固定清单的语义**：它锁的是「这 13 条在 HEAD 判据下必须退回 `unclear`」，**不是**「这 13 条永远是全部误判」。新增误判不会被这条用例发现 —— 但也不会再因为快照刷新而**假红**；要发现新误判，应加新用例而不是改旧清单。