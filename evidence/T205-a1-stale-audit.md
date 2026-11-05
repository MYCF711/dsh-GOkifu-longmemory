# T205 · A1 逐条归因（3 条 stale，2026-11-05）

> `[本] 2026/11/5 10:34:46 +08:00` · **只读**：不写库、不改任何 claim；未跑全量测试、未重启 DSH。
> 脚本 `scripts/a1-stale-audit.mjs`（复刻 `scripts/eval.mjs` · `runH1` 主循环）· 单测 `test/a1-stale-audit.test.mjs`
> scope：`w:d:/DeepSeek Harness/default-workspace/长期记忆系统` · HEAD `0.167.0`

## 0 · 一句话结论

**这 3 条不是"闸 3 的漏洞"，而是 A1 的分子口径错 + 探针的版本候选面缺一条**：
3 条**机械上全是 `probe-unverified`**（探针读不到包），继续按根因拆是 —— **1 条真 stale**（`c-175d29e9`：`magpie-chatbox-ai` 0.1.0 → 磁盘 0.1.3，探针**没有**去 `<workspace>/<name>/package.json` 找）+ **2 条根本不是 stale**（`c-7868399c` 引用的包名不存在；`c-ece24ff2` 磁盘上就是 0.3.9）。
⇒ **口径修正后 A1 = 1/99 = 1.01%**；**探针候选面修正后**，那 1 条会被闸 3 拦下 ⇒ **0%**。

## 1 · 复算（与 metrics-guard 的 A1 对拍）

```
$ node scripts/a1-stale-audit.mjs
A1 归因（只读）· scope=w:d:/DeepSeek Harness/default-workspace/长期记忆系统
信号 176（话题 36 + validity 定向 140）· 渲染行 344 · 闸后注入 99 条
A1 = 3/99 = 3.03% · 分类 {"probe-gap":82,"legit":14,"probe-unverified":3} · 其中 stale {"probe-unverified":3}

对拍 runH1：postGateInjected=99 · postGateStale=3 · 复刻 99/3 ⇒ 一致
```

**时点说明**：\`[本] 10:29\` 首次复算是 \`2.91%（3/103）\`；\`[本] 10:36\` 在 HEAD \`0.167.0\` 复算是 \`3.03%（3/99）\`；\`[本] 10:41\` 再跑又回到 \`2.91%（3/103）\`。**分母在 99–103 之间漂移**，原因是另一个 agent 正在改 \`src/rooms/inject.mjs\`（工作树带未提交改动，卡片选取行数随之变化）；**分子恒为同 3 条**，每个时点都与 \`runH1\` 逐位对拍一致（\`consistent: true\`）。下文表格用的是 10:36 的 99 条快照。

四类分布（99 条）：

| 分类 | 条数 | 含义 |
|---|---|---|
| `probe-gap` | 82 | 该 claim 没有 validity（type=none）⇒ 探针根本不跑 |
| `legit` | 14 | 探针核过（ok:true）⇒ 不是 stale |
| `probe-unverified` | 3 | 探针读不到（ok:false + unverified）⇒ 闸 3 放行，但 A1 分子把它算成 stale |
| `probe-wrong` | 0 | 探针判失效却仍到达模型（本机 0 条） |

## 2 · 3 条 stale 的逐条归因

### `c-175d29e9` · version · `magpie-chatbox-ai@0.1.0` · 分类 `probe-unverified`

- 卡片 scope：`w:d:/DeepSeek Harness/反代`
- 探针结论：`ok=false` · `reason=version-file-unreadable` · `unverified=true`
- 闸 3 判定：`unverified`（gatesOk=true）
- 为什么漏过：探针读不到（version-file-unreadable）⇒ 闸 3 记 unverified、不判红；但 A1 的 staleRows 谓词是 `ok === false`，把 unverified 也算进分子

### `c-7868399c` · version · `magpie-alysis-auth@0.1.0` · 分类 `probe-unverified`

- 卡片 scope：`w:d:/DeepSeek Harness/反代/AIysis code`
- 探针结论：`ok=false` · `reason=version-package-not-found` · `unverified=true`
- 闸 3 判定：`unverified`（gatesOk=true）
- 为什么漏过：探针读不到（version-package-not-found）⇒ 闸 3 记 unverified、不判红；但 A1 的 staleRows 谓词是 `ok === false`，把 unverified 也算进分子

### `c-ece24ff2` · version · `magpie-plugin-scaffold@0.3.9` · 分类 `probe-unverified`

- 卡片 scope：`w:d:/DeepSeek Harness/反代/work buddy`
- 探针结论：`ok=false` · `reason=version-file-unreadable` · `unverified=true`
- 闸 3 判定：`unverified`（gatesOk=true）
- 为什么漏过：探针读不到（version-file-unreadable）⇒ 闸 3 记 unverified、不判红；但 A1 的 staleRows 谓词是 `ok === false`，把 unverified 也算进分子

### 2.1 按根因再拆（机械证据）

| claimId | 声明 | 磁盘实际 | 判断 |
|---|---|---|---|
| `c-175d29e9` | `magpie-chatbox-ai@0.1.0`（scope `w:d:/DeepSeek Harness/反代`） | `反代/magpie-chatbox-ai/package.json` → name=`magpie-chatbox-ai` **version=0.1.3** | **真 stale**（0.1.0 → 0.1.3）；探针没这个候选 ⇒ 读不到 ⇒ 放行 |
| `c-7868399c` | `magpie-alysis-auth@0.1.0`（scope `…/反代/AIysis code`） | 该 workspace 的 `package.json` name=`magpie-alysis-code` **version=0.1.15**；全盘没有叫 `magpie-alysis-auth` 的包 | **不是 stale**：声明的包名不存在（validity 值本身无效） |
| `c-ece24ff2` | `magpie-plugin-scaffold@0.3.9`（scope `…/反代/work buddy`） | `反代/work buddy/references/magpie-plugin-scaffold/package.json` **version=0.3.9**（name 字段是 `unnamed-plugin`） | **不是 stale**：磁盘就是 0.3.9，与声明一致 |

探针候选面证据（逐条打出它试过的文件，`c-175d29e9`）：

```
workspace = d:DeepSeek Harness反代
探针结论  = false version-file-unreadable (unverified)
试过的候选文件：
  - <ws>
ode_modulesmagpie-chatbox-aipackage.json
  - <ws>package.json
  - <DSH_HOME>profiles*
ode_modulesmagpie-chatbox-aipackage.json
  - <DSH_HOME>profiles*workspacepackage.json
⇒ 真实仓库在 <ws>magpie-chatbox-aipackage.json —— **不在候选面里**
```

## 3 · 口径错在哪（为什么"unverified 进分子"是错的）

`scripts/eval.mjs` · `runH1`：

```js
const staleRows = rows.filter((c) => {
  const res = validityByKey[...] ?? null;
  return Boolean(res && res.ok === false);        // ← 把 unverified 也算成 stale
});
```

而闸 3 与 `scripts/mark-stale.mjs` 的口径都是 `ok === false && unverified !== true` 才算"真失效"（`REAL_STALE_REASONS = ['file-appeared','version-mismatch']）。
同一个库里"什么算 stale"出现两套定义 ⇒ A1 的分子把"核不了"记成"已失效"，**高估了负迁移**。

## 4 · 修法（最小改法，只描述；本刀不改代码）

| # | 文件 · 符号 | 改法 | 效果 |
|---|---|---|---|
| **F1** | `scripts/eval.mjs` · `runH1` 的 `staleRows` 谓词 | `res.ok === false` → `res.ok === false && res.unverified !== true`（与闸 3 / mark-stale 同口径） | A1 **3/99 → 1/99 = 1.01%**（`c-7868399c`/`c-ece24ff2` 移出分子） |
| **F2** | `src/rooms/gates.mjs` · `probeValidity` 的 `version` 分支候选面 | 在 `<workspace>/node_modules/<name>/package.json` 之外**加** `<workspace>/<name>/package.json`（兄弟仓库布局） | `c-175d29e9` 判成 `version-mismatch`（真 stale）⇒ 该卡被闸 3 拦（`gate3/stale-not-marked`）⇒ 闸后分子 0 ⇒ **A1 = 0%** |
| F3（数据） | T201 执行包 | 先给 `c-175d29e9` 打 `state:'stale'`（`--expect` 从 29 改 30），再跑 F2；否则 F2 落地后该卡会被拦、注入数下降 | 语义正确：真 stale 只给指针 |

**为什么不许在分子里把 "stale 的 claim 直接删掉"**：那会让 A1 失去消费者（覆盖率永远 0）。F1 不是"做手脚"，是把"核不了"从"已失效"里拆出来 —— 依据是闸 3 与 mark-stale 的既有口径（两处都明确 `unverified ≠ stale`）。

## 5 · 99 条全表（逐条）

| claimId | 探针 | 信号来源 | validity | 探针结论 | 闸3 | 分类 |
|---|---|---|---|---|---|---|
| `c-00eb81f4` | file | validity | `/_lead/community-workbuddy-index.mjs` | ok | ok | legit |
| `c-13d0c05b` | file | validity | `c:/Users/<user>/.config/magpie/plugins/n` | ok | ok | legit |
| `c-14ae511a` | file | validity | `c:/tmp/wb-official.png` | ok | ok | legit |
| `c-32870086` | file | validity | `d:/` | ok | ok | legit |
| `c-386a8833` | file | validity | `/msg-open.txt` | ok | ok | legit |
| `c-4f0231b1` | file | validity | `d:/DeepSeek Harness/反代/work buddy/magpie` | ok | ok | legit |
| `c-66ddf00e` | file | validity | `/cmd5.png` | ok | ok | legit |
| `c-7ece9589` | file | validity | `d:/tmp/baizhi.svg` | ok | ok | legit |
| `c-a7868cf8` | file | validity | `d:/tmp/m3.json` | ok | ok | legit |
| `c-ace52463` | file | validity | `/../../docs/reasoning-ui.md` | ok | ok | legit |
| `c-ae78f4d6` | file | validity | `d:/tmp/old-static.mjs` | ok | ok | legit |
| `c-af6be177` | file | validity | `c:/Users/<user>/.config/magpie/plugins/n` | ok | ok | legit |
| `c-b3ead453` | file | validity | `c:/Users/<user>/.config/magpie/request-a` | ok | ok | legit |
| `c-c43a84e8` | file | validity | `/tool/bash/*.go` | ok | ok | legit |
| `c-01b1ecf1` | none | validity | `` | ok | ok | probe-gap |
| `c-024b2bda` | none | validity | `` | ok | ok | probe-gap |
| `c-03b8df2a` | none | validity | `` | ok | ok | probe-gap |
| `c-03d6ac4c` | none | topic | `` | ok | ok | probe-gap |
| `c-073cd471` | none | validity | `` | ok | ok | probe-gap |
| `c-089494f1` | none | topic | `` | ok | ok | probe-gap |
| `c-091e6917` | none | topic | `` | ok | ok | probe-gap |
| `c-0b2317fb` | none | validity | `` | ok | ok | probe-gap |
| `c-0b31b85f` | none | validity | `` | ok | ok | probe-gap |
| `c-0c4982e7` | none | validity | `` | ok | ok | probe-gap |
| `c-0df8c23e` | none | validity | `` | ok | ok | probe-gap |
| `c-1193cf93` | none | validity | `` | ok | ok | probe-gap |
| `c-119c3ace` | none | topic | `` | ok | ok | probe-gap |
| `c-1293d2a5` | none | validity | `` | ok | ok | probe-gap |
| `c-143f2809` | none | validity | `` | ok | ok | probe-gap |
| `c-14b678e5` | none | validity | `` | ok | ok | probe-gap |
| `c-1851fd0d` | none | validity | `` | ok | ok | probe-gap |
| `c-19758ad6` | none | topic | `` | ok | ok | probe-gap |
| `c-1af130ae` | none | validity | `` | ok | ok | probe-gap |
| `c-1d3ebf26` | none | validity | `` | ok | ok | probe-gap |
| `c-232f6a04` | none | validity | `` | ok | ok | probe-gap |
| `c-23d4c5ca` | none | validity | `` | ok | ok | probe-gap |
| `c-2a0b7d29` | none | topic | `` | ok | ok | probe-gap |
| `c-2a2171be` | none | validity | `` | ok | ok | probe-gap |
| `c-2a5385b9` | none | topic | `` | ok | ok | probe-gap |
| `c-2d4fdcf7` | none | topic | `` | ok | ok | probe-gap |
| `c-2e17ebe4` | none | validity | `` | ok | ok | probe-gap |
| `c-349cbc34` | none | topic | `` | ok | ok | probe-gap |
| `c-34a72797` | none | validity | `` | ok | ok | probe-gap |
| `c-34b6b750` | none | validity | `` | ok | ok | probe-gap |
| `c-359288d1` | none | validity | `` | ok | ok | probe-gap |
| `c-3bc0d581` | none | validity | `` | ok | ok | probe-gap |
| `c-3d5fbe36` | none | topic | `` | ok | ok | probe-gap |
| `c-3e050c61` | none | topic | `` | ok | ok | probe-gap |
| `c-3f963ee7` | none | validity | `` | ok | ok | probe-gap |
| `c-40e2e1fb` | none | validity | `` | ok | ok | probe-gap |
| `c-4531a6d0` | none | validity | `` | ok | ok | probe-gap |
| `c-47979cda` | none | validity | `` | ok | ok | probe-gap |
| `c-4b857c69` | none | topic | `` | ok | ok | probe-gap |
| `c-4e686f1f` | none | topic | `` | ok | ok | probe-gap |
| `c-5175f1dc` | none | topic | `` | ok | ok | probe-gap |
| `c-53e30566` | none | topic | `` | ok | ok | probe-gap |
| `c-58105daf` | none | validity | `` | ok | ok | probe-gap |
| `c-5928a6a4` | none | validity | `` | ok | ok | probe-gap |
| `c-5959fc7e` | none | topic | `` | ok | ok | probe-gap |
| `c-5d7c9265` | none | topic | `` | ok | ok | probe-gap |
| `c-64b0943b` | none | validity | `` | ok | ok | probe-gap |
| `c-6b91f6e8` | none | validity | `` | ok | ok | probe-gap |
| `c-6ee1ff3f` | none | validity | `` | ok | ok | probe-gap |
| `c-72c3aae1` | none | validity | `` | ok | ok | probe-gap |
| `c-7302e7a9` | none | topic | `` | ok | ok | probe-gap |
| `c-7af9250b` | none | validity | `` | ok | ok | probe-gap |
| `c-7c3ddd2d` | none | validity | `` | ok | ok | probe-gap |
| `c-867eb782` | none | validity | `` | ok | ok | probe-gap |
| `c-87a93382` | none | validity | `` | ok | ok | probe-gap |
| `c-88283969` | none | validity | `` | ok | ok | probe-gap |
| `c-8b051dc6` | none | validity | `` | ok | ok | probe-gap |
| `c-8fedd82f` | none | validity | `` | ok | ok | probe-gap |
| `c-94f5de29` | none | topic | `` | ok | ok | probe-gap |
| `c-96a3b8f0` | none | topic | `` | ok | ok | probe-gap |
| `c-99ba9e6b` | none | validity | `` | ok | ok | probe-gap |
| `c-9de6864b` | none | validity | `` | ok | ok | probe-gap |
| `c-a2e28f86` | none | validity | `` | ok | ok | probe-gap |
| `c-b4755a88` | none | topic | `` | ok | ok | probe-gap |
| `c-b4d7bfb1` | none | validity | `` | ok | ok | probe-gap |
| `c-bc34b983` | none | validity | `` | ok | ok | probe-gap |
| `c-bcf4f97a` | none | validity | `` | ok | ok | probe-gap |
| `c-c1397505` | none | validity | `` | ok | ok | probe-gap |
| `c-ca38de53` | none | validity | `` | ok | ok | probe-gap |
| `c-ccf34a4b` | none | validity | `` | ok | ok | probe-gap |
| `c-cd0d08dc` | none | validity | `` | ok | ok | probe-gap |
| `c-d010a5aa` | none | topic | `` | ok | ok | probe-gap |
| `c-d296e620` | none | topic | `` | ok | ok | probe-gap |
| `c-db692ecd` | none | validity | `` | ok | ok | probe-gap |
| `c-e2f76d9d` | none | topic | `` | ok | ok | probe-gap |
| `c-e3f037e5` | none | validity | `` | ok | ok | probe-gap |
| `c-e7cd03db` | none | validity | `` | ok | ok | probe-gap |
| `c-e9ced83a` | none | validity | `` | ok | ok | probe-gap |
| `c-ed0ced41` | none | topic | `` | ok | ok | probe-gap |
| `c-f303f08d` | none | validity | `` | ok | ok | probe-gap |
| `c-fbe74d18` | none | topic | `` | ok | ok | probe-gap |
| `c-ff3db873` | none | validity | `` | ok | ok | probe-gap |
| `c-175d29e9` | version | validity | `magpie-chatbox-ai@0.1.0` | version-file-unreadable | unverified | probe-unverified |
| `c-7868399c` | version | validity | `magpie-alysis-auth@0.1.0` | version-package-not-found | unverified | probe-unverified |
| `c-ece24ff2` | version | validity | `magpie-plugin-scaffold@0.3.9` | version-file-unreadable | unverified | probe-unverified |

## 6 · 复现

```bash
node scripts/a1-stale-audit.mjs            # 人读：分类 + 3 条 stale 明细 + 与 runH1 对拍
node scripts/a1-stale-audit.mjs --json     # 机器读（全字段）
node --test "test/a1-stale-audit.test.mjs" # 纯函数单测（四类分类/话术/映射/汇总）
```
