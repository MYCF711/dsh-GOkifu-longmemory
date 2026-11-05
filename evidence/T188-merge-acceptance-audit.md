# T188 · 合流四条验收口径的独立复核（2026-11-05）

> `[本] 2026-11-05 08:25 +08:00` · **只读**：未改 `scripts/merge-acceptance.mjs` / `src/**` / 记忆库；临时库全部建在 `tmp/t188/`（不进 git）；未跑全量测试、未重启 DSH。
> 对象：`scripts/merge-acceptance.mjs`（T173→T178→T181→T185）在 `tmp/shadow-all2`（1379 claims / 39 合并节点）上的四条口径。
> 真源库：`<DSH_HOME>/memory-context`（只读对照）。

## 0 · 一句话结论

**最严重的漏洞：② 在"成员记录消失"时会静默变成"0 组被检查 = 通过"。**
`groupsChecked` 只在找到成员时才 +1，找不到就 `continue`；而"成员记录仍留在库里（只增不改）"正是合流契约的核心不变量 —— 四条口径里**没有一条**检查它。删掉全部成员后：② `mergeRecords=39 / groupsChecked=0 / errors=0 / pass=true`，④c 变成"证据不足"，整套验收仍然不会报"成员丢了"。

## 1 · ① 同文重复行：会不会因为抽样太少而恒真？

**代码事实**（`runAcceptance` + `sampleClaims` + `countDuplicateRows`）：
- 抽样池是**影库** claim（`sampleClaims(shadowClaims, sample)`），按 id 排序等距取 `sample` 条；
- 每张卡分别在源/影两侧渲染，数"同一张卡里 ≥2 个不同 claimId 但正文相同"的多余行；
- 判据只有一条：`dup.notWorse = shadowDup <= srcDup` ⇒ **两侧都是 0 时恒真**。

**实测 1：同一套库，只改抽样条数**
```
$ for n in 1 5 10 40; do node scripts/merge-acceptance.mjs --store tmp/shadow-all2 --sample $n --json; done
sample=1 · ①源0/影0 notWorse=true · ④可折=4 省行=4 · ok=true
sample=5 · ①源1/影1 notWorse=true · ④可折=4 省行=4 · ok=true
sample=10 · ①源1/影1 notWorse=true · ④可折=4 省行=4 · ok=true
sample=40 · ①源1/影1 notWorse=true · ④可折=4 省行=4 · ok=true
```

**实测 2：把源库做成"没有重复"（`tmp/t188/src-clean`：删掉 131 个同文组里多余的 150 条），用同一条数据跑两次**
```
$ node scripts/merge-acceptance.mjs --store tmp/shadow-all2 --source tmp/t188/src-clean --sample 10 --json
ok: false
① 源 0 影 1 notWorse false reduction null

$ node scripts/merge-acceptance.mjs --store tmp/shadow-all2 --source tmp/t188/src-clean --sample 1 --json
sample: 1 ① 源 0 影 0 notWorse true cards 1
ok: false （① 通过）
```
**同一条数据、同一份代码：`--sample 10` 抓到了，`--sample 1` 放过了。** ① 不是数学恒真，是**抽样决定的**。

**实测 3：这个形状到底多稀有**（扫 120 张影库卡，走的是 ① 自己的 `buildCard` + `countDuplicateRows`）
```
$ node -e '…sampleClaims(shadowClaims,120) → buildCard → countDuplicateRows…'
{ "claims": 1379, "sampled": 120, "built": 120, "cardsWithDup": 2, "dupRows": 2, "withMergeAndMember": 0,
  "samples": [ { "claim": "c-981f0df5", "dups": 1 }, { "claim": "c-c9c82cf0", "dups": 1 } ] }
```
- 120 张卡里只有 **2 张**含同文重复行；**0 张**同时渲染"合并节点 + 它的成员"（也就是合流本该消除、也是 ① 唯一真正要防的那个形状）。
- 总覆盖率：`10 / 1379 = 0.73%`。在这个覆盖率下，① 的读数几乎恒为 `0 vs 0` 或 `1 vs 1`。

**要它有意义，样本该这么定**：
1. 分母不是"随机 10 条 claim"，而是**全部同文组**（本机 131 组 / 262 条）——逐组在源/影两侧各渲染一次，比较"该组在本卡里多出几行"；
2. 再加一层**库级配对**：对每个规范化正文，比较源/影里不同 claimId 的个数（不依赖卡片，成本 O(claims)）；
3. 判据从"影 ≤ 源（合计）"改成**逐组** `shadow_dup(text) ≤ source_dup(text)`，任何一组反增即红 —— 合计口径会被"一组 +1、另一组 -1"抵消。

## 2 · ④a/④b 是行数口径 —— 行数不变但信息量变了能不能通过？

**代码事实**：`saved = sourceRows - shadowRows`；④b 的判据只有 `sourceRows >= 1 && shadowRows === 0`。

**构造实验**（用脚本自带的 `measure` 注入缝，不碰真库）：
```
C1 源2→影2（正文 34 字 → 3 字）⇒ ④a true ④b true saved 0
C2 源3→影1 ⇒ ④a true ④b true losses 0 saved 2
C3 源3(成员2行)→影1(只剩合并节点) ⇒ ④a true ④b true 可折 1 省行 1 ratio 1 verdict 证据不足
C4 成员被删净（源也只有合并节点）⇒ 可折 0 省行 0 verdict 证据不足
```
C1 就是"行数不变、内容从 34 字缩成 3 字"——**两条都过**。

**真库里也已经发生**（39 个合并组逐组比较渲染出的 claimId 集合）：
```
组=39 · 渲染集合完全相同=25 · 集合不同=14（行数相同但内容不同=5 · 影库更多行=0 · 影库更少行=9）
```
其中 5 组是"行数一样、换了一条 claim"，例如：
```
c-3011f83f: 源 [c-349cbc34] → 影 [c-3011f83f]
c-415e7002: 源 [c-14b678e5] → 影 [c-415e7002]
```
（这两例是**预期内**的：成员行被合并节点代表行替换。但它们证明"行数相等"完全不能区分"折叠成功"和"换掉了别的东西"。）

## 3 · ④b「源库 ≥1 行 ⇒ 影库 ≥1 行」的漏网面

**真库计数**（39 个合并组，判据：`0 < shadowRows < sourceRows`）：
```
组数: 39
源>影>0（④b 漏网）: 14
    c-1f1ce0f6 成员=2 成员行1/0 源3→影2 省1
    c-2009f707 成员=3 成员行2/0 源16→影14 省2
    c-24b33a42 成员=2 成员行0/0 源2→影1 省1
    c-4d20318a 成员=3 成员行1/0 源17→影13 省4
    c-64b0943b 成员=5 成员行3/0 源13→影7 省6
    c-7873ccaf 成员=2 成员行2/0 源8→影7 省1
    c-867eb782 成员=2 成员行0/0 源15→影11 省4
    c-94108d88 成员=2 成员行1/0 源19→影14 省5
    c-abe785ae 成员=2 成员行1/0 源8→影3 省5
    c-c9c82cf0 成员=2 成员行1/0 源7→影5 省2
源≥1 ⇒ 影=0（④b 真正抓的）: 0
省行组: 14 / 全部 39
```
**漏网面 = 14/39 = 35.9%**，而 ④b 抓到的（影库 0 行）是 **0 组**。

再往下一层：这些少掉的行，到底"代表"到合并节点里了吗？
```
合并组: 39 | 有行消失的组: 14 | 消失行合计: 16 | 被合并节点代表覆盖: 3 | 真丢: 13
```
⇒ **16 行消失里，13 行在影库那张卡上没有任何合并节点的 members 能代表它** —— 不是"折叠换代表"，是真的没渲染出来。④b 全部放行。

## 4 · ④c 的"可折组"定义会不会奖励错误实现？

**会。** 两个方向：

- **卡片层面**（C3）：源卡 3 行（其中 2 行是本组成员），影卡只剩合并节点 1 行 ⇒ ④a/④b 全过，`foldable=1 · savedPositive=1 · ratio=1` —— 把成员行全砍掉反而被算成"100% 省行"。
- **库层面**（把 96 条成员记录从影库副本里删掉，`tmp/t188/shadow-nomembers`，源库用原影库）：
```
ok: false
① 源 0 影 0 notWorse true
② mergeRecords 39 groupsChecked 0 errors 0 pass true      ← 成员全没了，闸 4 反而"通过"
③ 0
④ 组 39 foldable 0 savedPositive 0 ratio null a false b true verdict 证据不足
```
`groupsChecked=0` 是**静默的**：`mergePick` 里 `if (!member) continue;` 既不计数也不报错，`pass = gate4Errors === 0` 于是恒真。`foldable=0` 则让 ④c 从"分母"变成"无定义"（证据不足），同样不红。

## 5 · Wilson 判据：`下界 ≥ 0.5 且可折 ≥ 10` 是松还是紧？

```
10/10 = 100.0% ⇒ Wilson 下界 72.2% · 上界 100.0% · 门槛(下界≥50% 且 n≥10) ⇒ 有证据
9/10  =  90.0% ⇒ Wilson 下界 59.6% · 上界  98.2% · ⇒ 有证据
15/20 =  75.0% ⇒ Wilson 下界 53.1% · 上界  88.8% · ⇒ 有证据
14/20 =  70.0% ⇒ Wilson 下界 48.1% · 上界  85.5% · ⇒ 证据不足
8/10  =  80.0% ⇒ Wilson 下界 49.0% · 上界  94.3% · ⇒ 证据不足
4/4   = 100.0% ⇒ Wilson 下界 51.0% · 上界 100.0% · ⇒ 证据不足（n<10）
phat=0.75 时需要 n=20 才能使下界 ≥50%（此时 15/20）
phat=1（全中）时 n=4 起下界 ≥50%
```
- **可折 10 组全中**：下界 72.2% ⇒ "有证据"。这是**合理**的（72% 的下界确实说明多半能省行）。
- **可折 20 组中 15 中**：下界 53.1% ⇒ "有证据"。**这条偏松**：它只证明"真值大概率 > 50%"，也就是**比抛硬币好**，不证明"折叠是可靠的省行手段"；而且 9/10（下界 59.6%）也过。
- 但注意：④c **不参与退出码**（`pass = a.pass && b.pass`），所以"门槛松"不会让坏的实现通过验收，只会让**结论文字**（"有证据"）过度乐观。

## 6 · 最严重漏洞 · 最小修法 · 结论会不会变

**最严重漏洞（一句话）**：② 在成员记录缺失时静默变成"0 组被检查 = 通过"，而"成员仍在库里"是合流契约的核心不变量 —— 四条口径没有一条检查它；同时 ④b 只认"影库 0 行"，真库里 14/39 组（其中 13 行内容）已经丢了却没被发现。

**最小修法（只描述，不改代码）**：
1. **② 加一条硬判据**：`unresolved = merges.filter(m => m.merge.members.every(id => !shadowClaims.some(c => c.id === id)))`；`unresolved > 0` ⇒ 该项 **FAIL**（或至少 `unverified`），并把 `groupsChecked` 与 `mergeRecords` 一起打印。顺手把 `mergePick` 的默认从 `20` 改成**全量**（39 个节点，成本可接受）。
2. **④b 换成内容身份判据**：对每组的源卡渲染行，逐行要求在影卡里"同 claimId 出现，或被某个渲染中的合并节点的 `members` 覆盖"；缺失即记 `lostRows`，`lostRows > 0` ⇒ FAIL。这样 13 行真丢会被抓到，5 组"等量换人"里的合法替换（成员→合并节点）不会误报。
3. **④a/④b 加"载荷不缩水"**：按 claimId 对齐后，比较 `text` 长度 / `support.length`，缩水超过阈值（如 50%）记 FAIL —— 用来堵 C1 那种"行数不变、引文被截短"。
4. **① 改全量配对**（第 1 节方案）：131 个同文组逐组判 `shadow_dup ≤ source_dup`，不再靠 10 张卡抽样。
5. **④c 的"可折"要求成员仍在**（`membersShadowRows ≥ 1`），否则显式记"成员缺失"而不是落到"证据不足"；阈值若要表达"可靠"，下界抬到 0.7–0.8（当前 0.5 只表达"好于随机"）。

**修完后会不会改变已有结论？**
- **④c 的"证据不足"仍然成立**：当前 `可折 4 < 10`，与修法无关（本机 39 组里只有 4 组满足"源卡本组成员行 ≥2"）。
- **④b 会从"通过"变成"不通过"**：按修法 2，14 组有行消失、13 行无人代表 ⇒ `lostRows=13 > 0` ⇒ FAIL。也就是说**当前"四项全过"的结论里，④b 这一项是靠"只认 0 行"才过的**。
- **② 会从"20 组通过"变成"39 组通过"**（真库里 96 个成员都在，修法是让它可证伪，不改变当下的读数）。
- ① 修成全量后，当前 1379 claims 的历史同文组（131 组）在影库里是否 ≤ 源库需要重测 —— 本次未测（只测了抽样口径），不能预判。

## 7 · 复现（全部只读；临时库在 tmp/t188/）

```bash
# 基线
node scripts/merge-acceptance.mjs --store tmp/shadow-all2 --sample 10 --json
# ① 抽样灵敏度（同一套库）
for n in 1 5 10 40; do node scripts/merge-acceptance.mjs --store tmp/shadow-all2 --sample $n --json; done
# ① 可红性：源库先去同文（tmp/t188/src-clean 是 tmp/shadow-all2 的副本，删掉 131 组里多余的 150 条）
node scripts/merge-acceptance.mjs --store tmp/shadow-all2 --source tmp/t188/src-clean --sample 10 --json   # ① FAIL
node scripts/merge-acceptance.mjs --store tmp/shadow-all2 --source tmp/t188/src-clean --sample 1  --json   # ① ok
# ④c/② 的静默：删掉 96 条成员记录后的副本
node scripts/merge-acceptance.mjs --store tmp/t188/shadow-nomembers --source tmp/shadow-all2 --json
```
