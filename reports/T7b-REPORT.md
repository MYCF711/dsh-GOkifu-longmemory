# T7b 报告 —— R12 inject（影子模式）+ R13 gates 起步

> 任务板 `task-7` · 负责人 card-smith · `[本] 2026-11-02`（工作树未提交）
> 契约来源：`docs/数据契约.md` §7.3、`方案.md` §7.2/§7.3/§6.3、`docs/记忆的职责边界.md` §2/§4/§5、`AGENTS.md` §11 R12/R13
> 实测证据：`evidence/T7b-shadow.md`（真实语料影子跑）

## 0 · 一句话

**做到了**：命中才展开、无命中只有一行事实；每条注入行都带绝对日期 + `(ep-…, seq N)` 出处；超预算先缩文本再丢条目、省略永远可发现；影子模式只追加 `evidence/shadow/shadow.jsonl`（`injected:false`）且**写 `$DSH_HOME` 会被硬拒**；R13 四道闸跑在本机真实语料上 **20/20 零假红**。

## 1 · 交付物

| 文件 | 性质 | 说明 |
|---|---|---|
| `src/rooms/inject.mjs` | 新增 | R12：`buildMemoryCard` / `signalFromText` / `degradedWalk` / `writeShadow` / `readShadow` / `assertSafeShadowDir` / `estimateTokens` / `formatCardDate` / `PROVENANCE_LINE_RE` / `IMPERATIVE_PATTERNS` / `runInject` |
| `src/rooms/gates.mjs` | 新增 | R13：`runGates` / `auditImperatives` / `auditGovernance` / `ACTIVE_GATES` / `PENDING_GATES` / `GATE_DOCS` |
| `test/inject.test.mjs` | 新增 | 23 条（含与 R11 walk 的真实组合测试，walk 不在则自动 skip） |
| `test/gates.test.mjs` | 新增 | 26 条 |
| `scripts/cli.mjs` | 改（3 行注释 + 1 行用法） | 只补文档，未改行为 |
| `src/rooms/cli.mjs` | 改（**纯追加**） | `inject` 分支 + `--signal/--shadow-dir/--kind` 解析 + USAGE 行。`stats/dump/walk/verify/rebuild/index` 一行未动（`test/cli.test.mjs` 全绿即证据） |
| `package.json` | 改（追加 2 个 exports） | `./inject`、`./gates`（与其它房间一致） |
| `.gitignore` | 改（追加 1 行） | `evidence/shadow/`（影子记录是运行产物，不该进 git） |
| `evidence/T7b-shadow.md` | 新增 | 真实语料实测数字（可复现命令 + 口径） |
| `reports/T7b-REPORT.md` | 新增 | 本文件 |
| `MAINTENANCE.md` | 改 | 状态与下一步 |

## 2 · 契约落点（逐条对照）

### R12 `buildMemoryCard({ signal, walkResult, store, scope, now })`

| 契约 | 实现 | 测试 |
|---|---|---|
| `indexLine` 恒一行、只陈述事实 | `MEMORY: <index 路径>（scope=…, N 局, 未列出≠不存在）`，路径渲染成正斜杠 | 「无命中 ⇒ 只有 indexLine」 |
| 无命中 = 零注入 | `section:null`、`claims:[]`、`omissions:null`，只花首轮 ~35 tokens | 同上 + 闸 6b `zero-hit-injection` |
| 命中才展开 | `section` 仅当命中且至少渲染出 1 条 | 「命中却一条都渲染不出来 ⇒ 仍然零展开」 |
| 每行 `[state] 文本 (ep-…, YYYY-MM-DD, seq N)` | `PROVENANCE_LINE_RE` 单源定义，R12 产、R13 核同一份 | 每行正则 + 日期=occurredAt(UTC) |
| ≤5 条 / ≤500 tokens | `ENTRY_LIMIT=5`、`BUDGET_TOKENS=500`（口径 = indexLine+section，保守） | 「≤5 条、≤500 tokens」 |
| 失败教训在前 / 约束偏好次之 / 定式候选最后 | `RANK`：antipattern 0 → failure 0.5 → preference/rule 1 → constraint 1.5 → fact/pointer 2 → pattern 3；同档按 occurredAt 新→旧 | 「排序 = …」 |
| 超预算先降表示、不丢来源与日期 | 阶梯：160 字 → 60 字 → 去 markers 行 → 丢尾部条目（每条都带计数省略行） | 「先降表示（160→60），再降条数」 |
| 省略可发现 | `omitted: N items（…）— see index.md（未列出 ≠ 不存在）` | 「超条数上限 ⇒ 显式省略」 |
| **shadow 只记录不注入** | `writeShadow({dir, card, signal, at})` 只追加 JSONL（`mode:"shadow"`、`injected:false`）；`assertSafeShadowDir` 拒绝 `$DSH_HOME` 内任何路径 | 「只追加到指定目录」「写 $DSH_HOME 直接被拒」 |
| 无源不入 | 缺 `occurredAt` **或** 缺 `seq` 的条目直接丢，只计数进省略 | 「无源不入」+ 「预算小到放不下空壳」 |
| 不教模型「何时查」 | 卡片里没有祈使句、没有「下一步」；只给路径与事实 | 「卡片只陈述事实」+ R13 边界闸 |

### R13 `runGates({ card, walkResult })`

| 闸 | 判据 | 失败码 |
|---|---|---|
| **0 时间戳前置** | 每条 claim 有 `occurredAt`；`source.episode` + `source.seq` 齐备；渲染行能被 provenance 正则解析；行里的日期 = `occurredAt` 的 UTC 绝对日期；行里的 ep/seq 与 `source` 一致；section 行数 = claims 数；无游离行 | `gate0/missing-occurred-at`、`gate0/missing-{episode,seq,provenance}`、`gate0/line-not-provenanced`、`gate0/date-mismatch`、`gate0/{episode,seq}-mismatch`、`gate0/section-line-count`、`gate0/stray-section-line` |
| **6 预算与省略** | tokens 有数且与实测一致；≤500；≤5 条；provenance 覆盖率 = 1；有省略就必须出现 `omitted: <n>` 且指向 `index.md` | `gate6/{missing-tokens,token-mismatch,budget-exceeded,over-limit,provenance-coverage,omission-hidden,omission-no-pointer}` |
| **6b 相关闸** | 不命中却展开 ⇒ 失败；每个 hit 的 `why` 非空；请求深度与 hit 深度 ≤2；hit 必须有 episode | `gate6b/{zero-hit-injection,claims-without-hits,missing-why,depth-exceeded,hit-depth-exceeded,hit-without-episode}` |
| **边界闸** | `你应该|请|下一步|建议|务必|记得|不要忘记|可以试试` 逐个扫描 indexLine + section + 未渲染的 claim 文本；另扫 `permission: allow|ask|deny`、`approval:`、`sandbox_permissions` | `boundary/imperative`、`boundary/tool-governance` |

任一失败 ⇒ `ok:false`，`errors:[{gate, code, detail}]`；`checks` 给出行数/条数/token/命中数/扫描串数。**只判不改**（有纯函数测试）。

`PENDING_GATES = ['1','2','2b','3','4','5','7']` 显式登记为未启用 —— 避免「以为已经覆盖」的静默遗漏（M4 落）。

## 3 · 测试

```
$ node --test test/inject.test.mjs test/gates.test.mjs
ℹ tests 49   ℹ pass 49   ℹ fail 0

$ node --test            # 全仓（含 T1–T7a 全部房间）
ℹ tests 216  ℹ pass 216  ℹ fail 0

$ node scripts/check.mjs
check: PASS
```

基线 150 条不红（现在 216 = 150 + T7a 17 + T7b 49）。`test/cli.test.mjs` 里 `stats/dump/walk/index` 的既有断言全部未改、全绿。

## 4 · 实测（真实语料，影子模式）

详见 `evidence/T7b-shadow.md`。摘要（语料 = 92 棋谱 / 780 主题 / 125 claim）：

| 指标 | 值 |
|---|---|
| 闸门通过 | **20 / 20** 条信号零假红 |
| 零注入 | 1 / 20（主题 `127.0.0.1`：walk 命中主题但产不出 hit） |
| token（indexLine + section） | min 35 / 中位 253 / p90 275 / **max 292**（预算 500，最坏占 58%） |
| 首轮那一行 | 35 tokens（中位） |
| 渲染行 | 42 条 claim 行 + 51 条指针行 |
| shadow | 20 行 JSONL，全部 `injected:false` |
| 耗时 | 3.6–4.7 s / 20 条 ≈ 180–235 ms/条（两次跑；walk + card + gates + 一次追加写） |

**成本透明**：M2 时代注入 0 tokens；M3 影子模式**仍然注入 0**（只落盘）。若日后开闸，预算上限 = 首轮 35 tokens、命中 ≤292（实测最坏），低于方案规定的 500。

## 5 · 设计决定（带理由与可逆性）

1. **预算口径 = indexLine + section**（而不是只算 section）。理由：一个可核的数比两个数好审计，且天然更保守。代价：命中展开实际只能用 ~465。可逆：改 `tokens` 一行。
2. **降表示阶梯 160 → 60 → 去 markers → 丢尾部**。理由：方案 §7.2 纪律 3「超了先降表示，不丢来源与日期」。可逆：`CLIP_STEPS` 与循环。
3. **claim 与 hit 的锚定规则收紧**：只有 (a) walk 直接给 `claim` id、(b) 该局 claims 里存在与该 hit **同一 seq** 的 support 时，才把 claim 原文写进卡；否则退化成指针行。理由：随手抓一条该局别的 claim 就是 F8「顺藤摸错枝」。可逆：`pickClaim` 一处。
4. **`singleLine` 与 `clipLine` 分离**：条目保存 `rawText`，渲染时才按当前阶梯截断——否则"先截到 160 再想降到 60"是死路（截断不可逆）。可逆：`buildEntry` 一处。
5. **闸门正则与行格式单源**：`IMPERATIVE_PATTERNS` / `PROVENANCE_LINE_RE` / `INDEX_LINE_RE` 都定义在 R12，R13 import ——注入端与审计端不可能漂移。
6. **边界闸只扫模型可见串**（indexLine + section + 未进 section 的 claim 文本），不扫 quote/证据原文。理由：边界 §5 的判据是「模型可见字符串字面量」；证据原文是用户逐字原话，不是注入内容。
7. **不新增依赖、不调用模型、不写 `<DSH_HOME>`**：R12/R13 只用 `node:fs`/`node:path`/`node:url`；唯一写盘面是 shadow 追加，且有 `$DSH_HOME` 硬守卫。

## 6 · 风险与未做的事

| # | 风险/缺口 | 归属 | 建议 |
|---|---|---|---|
| 1 | **精度未经评审**：泛工具主题（`echo`/`grep`/`git`）会带出 5 条棋谱，卡片里有 3 条 claim；"够不够相关"本轮无法判定 | R11 相关性 + M4 闸 6b 弱边策略 | 用影子记录做精度抽样（人/独立成员判"这条该不该注入"），先算 precision 再谈开闸 |
| 2 | **指针行是"局级"粒度**：`occurredAt`=`startedAt`、`seq`=`closure.seqFrom`，不是某次具体失败的时点 | R11 若不产出 claim/mention 级 hit 就一直存在 | 影子记录已保留全部字段，事件级 hit 一旦有，卡片自动升级 |
| 3 | **闸 1/2/2b/3/4/5/7 未启用**（作用域、证据门槛、裁决独立性、有效性+适用条件、只增不改、来源纪律、事后降级） | M4 | `PENDING_GATES` 已显式登记，`GATE_DOCS` 有每道闸的一句话判据 |
| 4 | **`gate6/token-mismatch` 要求 `card.tokens` 与实测完全相等**：外部手工拼卡时容易假红 | R13 | 若将来有别的卡生产者，改成容差（±2）并在 `GATE_DOCS` 注明 |
| 5 | **`check.mjs` 的「房间齐」清单还没加 `walk/inject/gates`** | 发布方（Lead） | 加 3 行即让 `--strict-rooms` 对 M3 有意义；不在本任务写作用域，未动 |
| 6 | **版本没升**：`package.json` 仍 `0.3.0`，`CHANGELOG.md` 未加段 | 发布方（Lead） | 按 §10 准则：分支 → PR → 必需检查 → 合并 → 0.4.0 + CHANGELOG |
| 7 | **未接宿主**：`agent/pre-step` 注入点、shutdown/turn-stopping 钩子都没做 | M3 后续（另一刀） | 本任务是影子模式；真注入选择必须单独一刀 + 单独闸门证据 |

## 7 · 给接手者的最短路径

```bash
# 跑本房间的验收
node --test test/inject.test.mjs test/gates.test.mjs

# 看一张真实卡（不写盘）
node scripts/cli.mjs inject --signal "yaml 装不上" --root tmp --store tmp/memory-context

# 落一条影子记录（默认写 <repo>/evidence/shadow/，可用 --shadow-dir 改）
node scripts/cli.mjs inject --shadow --signal "yaml 装不上" --root tmp --store tmp/memory-context

# 判闸门是否放行（脚本退出码：0 = 全绿，1 = 有闸失败）
node scripts/cli.mjs inject --shadow --signal "…" --root tmp --store tmp/memory-context --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.ok, r.gates.errors)})'
```
