# audit-12 · 独立审计（对象 0.162.0，2026-11-05）

> 审计员：precision-auditor（独立复核，**不采信** Lead/teammate 的结论，全部数字自己复算）
> 时点：`[本] 2026-11-05 09:40 +08:00`
> 上一份独立审计：audit-11（对象 0.117.0，2026-11-04 08:00）。此后 0.118.0 → 0.162.0 共 45 个版本未经独立复核。
> 只读：未改源码 / 测试 / 文档 / 配置 / 记忆库；未跑全量 `node --test`；未重启 DSH。

## 0 · 一句话结论

**0.162.0 可以继续当开发基线，但还**不能**算"可交付"**：闸 4 的合并豁免是**自证的**（数据里一个 `mergedInto` 字符串就能把真重复从安全闸下拿走），且真库已有 **29 条**已真 stale 的 claim 仍未标 stale；合流侧的两处静默（成员缺失时整行消失、不计 omitted）还没进任何验收。

**最严重的一条**：`mergedInto` 自证豁免 —— 两条同文 claim 只要写同一个 `mergedInto` 字符串，闸 4 就不再报重复，哪怕被指的节点不存在、或存在但根本不是合并节点。

**如果只能修一条**：修 `src/rooms/gates.mjs` 的 `mergeRelationOf` —— 要求被指向的节点**存在 + 是合并节点 + `members` 同时含这两条**，否则照报 `gate4/unsuperseded-duplicate`（缺失则记 `unverified`）。

## 1 · 对象一致性（先证明审的就是线上那份）

```
$ node -e 'console.log(require("./package.json").version)'
0.162.0
$ node -e 'console.log(require("<DSH_HOME>/profiles/desktop/node_modules/dsh-gokifu-longmemory/package.json").version)'
0.162.0

$ for f in gates walk inject persist topic; do sha256sum src/rooms/$f.mjs …inst/src/rooms/$f.mjs; done
gates   work=2fe74290345939be inst=2fe74290345939be SAME
walk    work=86a9c95bf34f1326 inst=86a9c95bf34f1326 SAME
inject  work=424693ad9e77c34f inst=424693ad9e77c34f SAME
persist work=25a4bab0522c910e inst=25a4bab0522c910e SAME
topic   work=c37d94fc846a2d83 inst=c37d94fc846a2d83 SAME
package.json work=afc29e598a29d274 inst=afc29e598a29d274 SAME
```

`src/rooms/*.mjs` 全 19 个文件与 `src/*.mjs` 顶层文件逐一比对：**0 处不同**。审计对象 = 线上已安装副本，一致。

数据（只读）：

```
real   claims=1340  mergeNodes=0   mergedInto=0
shadow claims=1379  mergeNodes=39  mergedInto=0
```
（影库 = `tmp/shadow-all2`，合流写出的影子库；**真库当前 0 个合并节点**）

## 2 · 闸 3 探针（0.146.0：`expect:'exists'|'missing'` + version 读不到⇒未核验）

### 判定：**有条件通过**

**方向位本身是对的**（构造实验，临时目录 `tmp/t197/`）：

```
$ node -e '…probeValidity fixtures…'
1) expect=missing + 文件确实不存在:      ok:true
2) expect=missing + 文件已出现（应 stale）: ok:false  reason=file-appeared
3) expect=missing + 路径是**目录**:        ok:true   exists:false        ← 洞 1
4) expect=exists  + 文件不存在:            ok:false  reason=file-missing
5) expect=exists  + mtime 不符:            ok:false  reason=file-mtime-changed
6) 无 expect + preconditions[file-exists] ⇒ 推断 missing（与 claim.mjs 的 ENOENT 约定一致）
```

⇒ **"文件真的出现了"会被判 stale，不会放过去**（第 2 条）；`version` 读不到走 `unverified`，闸 3 已按 T158b 不判红（`else if (check.unverified === true)` 分支）。

**真库复算**（140 条带 validity 的 claim）：

```
$ node -e 'runValidityCheck({records:{claims}, dshHome:"<DSH_HOME>"})'
summary: {"total":140,"ok":53,"failed":29,"unverified":58,"byType":{"version":68,"file":72}}
reasons: version-file-unreadable(unverified) 53 · file/ok 52 · version/version-mismatch 9
         · file/file-appeared 20 · version-package-not-found(unverified) 5 · version/ok 1
file-appeared: 20    states: {"observed":20}
version-mismatch: 9  states: {"observed":9}
```

**洞 1（小）**：`expect='missing'` 时只认 `st.isFile()`；路径上出现的是**目录/其他非普通文件**时按"仍不存在"判 ok — 严格说路径已存在，属"真 stale 被放过"的窄口。

**洞 2（更重要，口径不一致）**：注入热路径用的 workspace 与审计脚本不同。
- `src/plugin.mjs` · `probeCardValidity`：`probeValidity(record, { workspace: fallbackWorkspace, now })` —— 传的是**当前会话 cwd**；
- `runValidityCheck`（`scripts/gates-check.mjs` 等）：`workspaceOf(record, workspace)` —— 传的是**claim 自己的 scopeKey**。

同一条 claim 在两个口径下的复算：

```
带 validity: 140 | 结论不同: 53 | ok/不ok 翻转: 0
例：c-0080133b（value=0.2.1-go.23，scope=…/DSH-GO）
  own-scope: ok:false unverified:true reason=version-file-unreadable
  会话 cwd:  ok:false               reason=version-mismatch  path=<repo>/package.json
```

⇒ 53 条 `version` claim 在"会话 cwd 有 package.json"时会被判 `version-mismatch`（**闸 3 红**），而在 gates-check 口径下只是"未核验"（不红）。方向是**过严**（误拦注入），反向（cwd 的版本正好等于 claim 声明 ⇒ 真 stale 放行）理论存在、本次 0 例。

**洞 3（数据）**：真库 **20 条 file-appeared + 9 条 version-mismatch = 29 条已真 stale**，`state` 全为 `observed`（未标 stale）⇒ 渲染它们的卡会被闸 3 拦（行为正确，但需要一次 stale 标记的数据修复）。

## 3 · 闸 4 认合并节点（0.148.0 / 0.154.0 / 0.160.0）

### 判定：**有条件通过（合流写库前必须修）**

`isMergeRelated`（合并节点 ↔ 成员、两节点成员交集）工作正常；问题在 **`mergedInto` 反指针是自证的**：

```
$ node -e '…runGates fixtures（两条同文 claim，无 supersedes）…'
基线（两条真重复、无 merge 关系）⇒ gate4 错误: 1
两条都写 mergedInto=c-ghost999（节点不存在）⇒ gate4 错误: 0 | checks.merged.unresolved: 1
两条都指向一个**存在但无 merge 字段的无关 claim** ⇒ gate4 错误: 0 | unresolved: 0
```

`mergeRelationOf` 只比较两个字符串是否相同：`am && am === bm` ⇒ `related:true`，**从不验证**被指向的节点存在、是不是合并节点、`members` 里有没有这两条。`unresolved` 只进 `checks.merged.unresolved` 计数，**不是错误**。

当前暴露面：真库 0 条、影库 0/96 成员带 `mergedInto`（consolidate 尚未写反指针）⇒ **功能未被数据触达**；但它是安全闸的信任边界，一旦合流开始写这个字段（或写错），真重复会被静默放行。

## 4 · walk 删除同组成员展开（0.162.0 / T193）

### 判定：**通过（1/39 组有 1 行差异，已定位）**

`expandMergeMembers` 已无引用（grep 0 处），当前路径是 `pickMergeMember`（合并节点 → 1 个成员）。

全量复算（39 个合并组，逐组建卡比较源库/影库渲染出的 claimId 集合；T193 当时只抽了 3 组）：

```
{ "merges": 39, "same": 38, "srcMore": 1, "shadowMore": 0, "diffSameCount": 0,
  "mergeNodeRendered": 0, "noMemberFallback": 0,
  "details": [ { "group": "c-64b0943b", "src": 5, "shadow": 4, "hitsSrc": 5, "hitsShadow": 5 } ] }
```

唯一差异组 `c-64b0943b`：源 5 行 / 影 4 行；缺的两条 `c-f94ecb92`、`c-91858997` **都不是本组成员**，是 5 行预算下的竞争替换（影库多 39 个合并节点 ⇒ 候选池变化），不是折叠导致。**0 组建卡时把合并节点自己渲染成行**（规则 1 生效），**0 组触发成员回退**。

## 5 · `inject.collapseMergeNodes`（0.160.0 定稿）

### 判定：**有条件通过（静默丢弃路径存在）**

正常影库：39 组全部 `mergeNodeRendered=0`、`noMemberFallback=0` ⇒ "合并节点只在替代 ≥2 成员时成行"成立，1 成员命中时保持 1→1。

**但"0 成员可渲染"时会整行消失且不计数**（成员全删的对照副本 `tmp/t188/shadow-nomembers`）：

```
$ node -e '…walk+card on shadow-nomembers, signal=合并节点正文…'
dropped: {"…": "mergeNodeNoMember":39, "stale":87, …}
影卡行: 3 ["c-5175f1dc","c-f303f08d","c-2a2171be"]  含合并节点: false
omitted: null
```

机制：walk 一个成员都解析不出来 ⇒ 回退到合并节点本身（`dropped.mergeNodeNoMember += 1`）⇒ R12 `collapseMergeNodes` 规则 1 把合并节点行**撤掉** ⇒ 这一行没有任何替代、也不进 `omitted` 摘要。**内容去哪了：哪也没去，消失了，卡上看不出。**

当前可达性：39 个节点里"全部成员都过不了守卫" = **0**（scope 不同 0 · invalidated/validityOk=false 0 · 无 (ep,seq,quote) 0 · 无 occurredAt 0）⇒ 现网/现影库**未触达**；触发条件是成员被删（违反"只增不改"）或全部成员 stale/invalidated —— 后者是正常运行中会发生的。

## 6 · 未解决项清单

| # | 项 | 严重度 | 现状 | 建议 |
|---|---|---|---|---|
| 1 | `mergeRelationOf` 的 `mergedInto` 自证豁免（不验证目标节点存在/是合并节点/含双方） | **高**（安全闸可被数据关闭） | 未触达（0 条带指针） | 合流写库前修：验证三点，失败照报重复 |
| 2 | 成员全部不可解析时，合并节点的行被静默丢弃、不进 `omitted` | 中 | 未触达（0/39） | `collapseMergeNodes` 回退成"保留合并节点行"或计入 `dropped.mergeNodeNoMember` 的 omitted |
| 3 | 探针 workspace 口径不一致（plugin 用会话 cwd / gates-check 用自身 scope），53 条 claim 结论不同 | 中 | 已存在 | `probeCardValidity` 改 `workspaceOf(record, fallbackWorkspace)`，一行 |
| 4 | `expect='missing'` 只认普通文件，路径变目录仍判 ok | 低 | 边角 | 判据改成"路径是否存在"（`stat` 非 ENOENT 即算存在） |
| 5 | 真库 29 条已真 stale（20 file-appeared + 9 version-mismatch）仍 `state=observed` | 中（会造成注入被拦） | 已存在 | 数据修复：按"只增不改"打 stale + 指针 |

## 7 · 复算命令（全部只读，可直接跑）

```bash
# ① 一致性：逐文件 sha256（工作树 vs 已安装副本）
INST="$DSH_HOME/profiles/desktop/node_modules/dsh-gokifu-longmemory"
for f in src/rooms/*.mjs src/*.mjs; do a=$(sha256sum "$f"|cut -d' ' -f1); b=$(sha256sum "$INST/$f"|cut -d' ' -f1); [ "$a" = "$b" ] || echo "DIFF $f"; done; echo "（无输出=全部一致）"

# ② 闸 3 方向位（构造：文件已存在但声明 expect=missing ⇒ 必须 file-appeared）
node -e 'import("./src/rooms/gates.mjs").then(({probeValidity})=>{const p=require("path"),fs=require("fs");const W=p.resolve("tmp/t197");
fs.mkdirSync(p.join(W,"dir-not-file"),{recursive:true});fs.writeFileSync(p.join(W,"exists.txt"),"x");
const cases=[["missing+absent","never.txt","missing"],["missing+appeared","exists.txt","missing"],["missing+目录","dir-not-file","missing"],["exists+absent","never.txt","exists"]];
for (const [name,value,expect] of cases) console.log(name, JSON.stringify(probeValidity({id:"c-x",validity:{type:"file",value,expect}},{workspace:W,now:Date.now()})));})'

# ③ 闸 3 真库复算（140 条带 validity 的 claim）
node -e 'import("./src/rooms/persist.mjs").then(async({createStore})=>{const {runValidityCheck}=await import("./src/rooms/gates.mjs");
const H=process.env.DSH_HOME;const s=createStore({root:H+"/memory-context"});const claims=s.list("claims").map(e=>e.record).filter(Boolean);
const c=runValidityCheck({records:{claims,joseki:[]},dshHome:H});
console.log(JSON.stringify({total:c.summary.total,ok:c.summary.ok,failed:c.summary.failed,unverified:c.summary.unverified}));
const r={};for(const x of Object.values(c.results)){const k=x.type+"/"+(x.reason??"ok")+(x.unverified?"(unverified)":"");r[k]=(r[k]||0)+1;}console.log(JSON.stringify(r,null,1));})'

# ④ 闸 4 自证豁免（构造：两条同文 claim 写同一个不存在的 mergedInto）
node -e 'import("./src/rooms/gates.mjs").then(({runGates})=>{const SCOPE="w:d:/work/demo";
const mk=(id,o={})=>({id,kind:"fact",text:"同一句失败教训",scopeKey:SCOPE,state:"observed",support:[{episode:"ep-a",seq:1,quote:"q"}],counter:[],validity:{type:"none",value:null},preconditions:[],occurredAt:Date.UTC(2026,9,22),supersedes:null,...o});
const entry=r=>({claimId:r.id,kind:"fact",state:r.state,text:r.text,occurredAt:r.occurredAt,source:{episode:"ep-a",seq:1}});
const run=rs=>runGates({card:{indexLine:"MEMORY: x",section:null,claims:rs.map(entry),omitted:null,tokens:80,shadow:true,omittedCount:0,hitCount:rs.length,crossScope:0,crossScopeWalk:0,unknownScope:0},records:{claims:rs,joseki:[]},scope:SCOPE,validityResults:{}}).errors.filter(e=>e.gate==="4").length;
const A=mk("c-a1"),B=mk("c-b1");console.log("基线 gate4 错误:",run([A,B]));
console.log("都写 mergedInto=c-ghost999:",run([{...A,mergedInto:"c-ghost999"},{...B,mergedInto:"c-ghost999"}]));})'

# ⑤ 合流三/四项（影库 39 组：源 vs 影 claimId 集合；成员全删副本的行/omitted）
node -e 'import("./src/rooms/persist.mjs").then(async({createStore})=>{const {createWalkCache,walkFromSignals}=await import("./src/rooms/walk.mjs");const {buildMemoryCard,signalFromText}=await import("./src/rooms/inject.mjs");
const shadow=createStore({root:"tmp/shadow-all2"}),source=createStore({root:"D:/DeepSeek Harness/home/memory-context"});
const sc=createWalkCache(shadow),rc=createWalkCache(source);
const merges=shadow.list("claims").map(e=>e.record).filter(c=>c.merge&&Array.isArray(c.merge.members));
let same=0,more=0,less=0,nodeRow=0,fallback=0;
for(const m of merges){const sig=signalFromText(String(m.text));sig.scopeKey=String(m.scopeKey);
 const w1=walkFromSignals({signal:sig,store:source,scope:String(m.scopeKey),depth:2,limit:5,budgetTokens:500,cache:rc});
 const w2=walkFromSignals({signal:sig,store:shadow,scope:String(m.scopeKey),depth:2,limit:5,budgetTokens:500,cache:sc});
 if((w2.dropped?.mergeNodeNoMember??0)>0)fallback++;
 const c1=buildMemoryCard({cache:rc,signal:sig,walkResult:w1,store:source,scope:String(m.scopeKey),now:Date.now(),limit:5,budgetTokens:500});
 const c2=buildMemoryCard({cache:sc,signal:sig,walkResult:w2,store:shadow,scope:String(m.scopeKey),now:Date.now(),limit:5,budgetTokens:500});
 const a=(c1.claims??[]).map(x=>String(x.claimId??"?"));const b=(c2.claims??[]).map(x=>String(x.claimId??"?"));
 if(b.includes(m.id))nodeRow++;
 if(a.join()===b.join())same++;else if(b.length>a.length)more++;else less++;}
console.log(JSON.stringify({merges:merges.length,same,more,less,mergeNodeRendered:nodeRow,noMemberFallback:fallback}));})'
```
