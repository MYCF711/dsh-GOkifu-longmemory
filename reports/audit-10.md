# audit-10 · 第四轮终验（只核 audit-09 的两条）

- 审计时间：2026-11-04 03:10–03:22（Asia/Shanghai）
- 仓库：`D:\DeepSeek Harness\default-workspace\长期记忆系统`（只读；仅写本文件）
- 口径锚点：`HEAD = 78b048b「R00 docs: 调研 31 GraphRAG + audit-09 修复（0.110.0）(#186)」`（2026-11-04 02:57:29 +0800），`package.json = 0.110.0`，`v0.110.0` 指向同一提交（`git rev-list -n1 v0.110.0` = `78b048b9…`）。
- **工作树在审计期间被并发会话推到 0.111.0**：03:10 开始审计时 `git status --porcelain` 为空、`package.json = 0.110.0`；**03:15:17** `CHANGELOG.md` / `MAINTENANCE.md` / `package.json` / `src/plugin.mjs` / `计划表.md` 被改（版本 → 0.111.0，新增 `evidence/M7-live-pipeline-reaches-gates.md`）。本报告**一律以 HEAD（= v0.110.0）的 blob 为准**（关键文本用 `git show HEAD:<file>` 复核），并在 §2.3 记录这次漂移对结论的影响。
- 写入：仅本文件。`tmp/` 下留了三个审计中间产物（`verhist.txt` / `cl-head.md` / `mt-head.md`，均未进 git）。

## 结论

**不通过**（窄口径：**只有一处文案**）。

- **第一条：关闭。** 「已发布」行不再声称"全部有 annotated tag"，并如实列出 6 个历史缺口；这 6 个经 `git tag -l 'v*'`、`git ls-remote --tags origin`、`gh release list` 三路独立核对**全部属实**，且在声明区间 0.15.0–0.110.0 内**恰为全部缺口**。
- **第二条：NUL 已清（关闭）、"0.108 段表述更正"的更正内容不实（未关闭）。**
  - `CHANGELOG.md` 的裸 NUL 确实清零（HEAD blob 97,771 字节 / 0 个 NUL；`read` 与 `grep` 恢复可读）。`git diff --stat HEAD~1` 仍显示 `Bin`，但那是**被比较的一侧**（`HEAD~1` = v0.109.0）还带 1 个 NUL，不是当前文件的属性。
  - 但 0.110.0 把**已发布版本（0.108.0）的段落第二次改写**，改写后的句子「`MAINTENANCE.md` 的「已发布」行**未在本版改动**」与 `git show v0.108.0:CHANGELOG.md` 的事实**相反**：v0.108.0 那一版**确实改了**「已发布」行（条目 94 → 123，止点由 0.77.3 延到 0.108.0）。v0.108.0 原文「已发布列表补全 0.78 → 0.108」是**真话**，不是"误称"；真正不实的是 0.109.0 那次改写塞进去的"改为指针"。

| # | 复核项 | 判定 |
|---|---|---|
| 1 | 「已发布」行不再声称"全部有 annotated tag" + 如实列出历史缺口（6 个版本无 tag） | **关闭**（附 1 条低残留：0.14.0 也缺 tag，行内未提） |
| 2a | `CHANGELOG.md` 裸 NUL 已清 / 不再被判为二进制 | **关闭** |
| 2b | 0.110 段关于"0.108 段表述更正"的说法与 `git show v0.108.0:CHANGELOG.md` 一致 | **未关闭**（更正后的内容与事实相反） |

## 一、第一条 · 关闭

### 1.1 现在这行长什么样（HEAD / v0.110.0，`MAINTENANCE.md` 第 31 行）

```
| 已发布 | **0.15.0 → 0.110.0 的 CHANGELOG 段齐全**；tag/Release 现状以 `git tag -l 'v*' --sort=v:refname` 与 `gh release list` 为准。**已知历史缺口（不回填）**：0.77.3 / 0.78.0 / 0.86.0 / 0.88.0 / 0.97.0 / 0.107.0 有 CHANGELOG 段但无 annotated tag（audit-09 实测；本行不再声称"全部有 tag"）。 |
```

audit-09 点名的假声明（v0.109.0 的「0.15.0 → 0.108.0 **全部有 annotated tag** + GitHub Release」）**在 v0.110.0 已不存在**。实测：

```
git show v0.109.0:MAINTENANCE.md | grep -c '全部有'   → 1   （就是那句完整性强断言）
git show HEAD:MAINTENANCE.md     | grep -n '全部有'   → 31   （同串字符，但只出现在自我否定的从句里：
                                                             「本行不再声称"全部有 tag"」）
```

即：字面串还在，但它的角色从"声称"变成了"声明不再这么声称"，没有任何完整性强断言残留。判定：改到位。

### 1.2 "有段无 tag"独立核对

命令与结果：

| 命令 | 结果 |
|---|---|
| `git tag -l 'v*' \| wc -l` | **128** |
| `git for-each-ref refs/tags --format='%(objecttype)' \| sort \| uniq -c` | **128 个 `tag`（全部 annotated，无一 lightweight）** |
| `gh release list --limit 200 \| wc -l` | **128** |
| tag 集合 vs Release 集合 `comm` 双向差 | **两侧为空**（128 = 128，一一对应；无"有 tag 无 Release"，也无"有 Release 无 tag"） |
| `git ls-remote --tags origin \| grep -c refs/tags/v` | 256（= 128 个 tag 对象 + 128 个 `^{}` 剥离行，自洽） |
| `git ls-remote --tags origin refs/tags/v<X>` 对 7 个可疑版本 | **全部为 0 条**（远端同样没有，不是本地缺 fetch） |

把 HEAD 的 `CHANGELOG.md` 段落集合（`^## x.y.z`，共 **135** 段，0.110.0 → 0.1.0，无重复）与 128 个 tag 对账：

- **有段无 tag（全历史，7 个）**：`0.14.0`、`0.77.3`、`0.78.0`、`0.86.0`、`0.88.0`、`0.97.0`、`0.107.0`
- **区间 0.15.0–0.110.0 内（6 个）**：`0.77.3`、`0.78.0`、`0.86.0`、`0.88.0`、`0.97.0`、`0.107.0`
- **有 tag 无段**：**0 个**

⇒ 「已发布」行写的那 6 个版本，**在与该行自述区间（0.15.0 → 0.110.0）相同的口径下，恰好是全部缺口，一个不多一个不少**。"有段无 tag"这个说法**准确**。

补强（第三路证据，不依赖 CHANGELOG 与 tag 自证）：扫 `package.json` 全部历史版本号（131 个），在 0.15.0–0.110.0 区间内**没有任何一个 package.json 版本缺 CHANGELOG 段**（⇒ "段齐全"这半句也成立），其中仅 `0.78.0`、`0.86.0` 缺 tag——`0.77.3` / `0.88.0` / `0.97.0` / `0.107.0` 从未作为 `package.json` 版本存在过（只在 CHANGELOG 里成段），这与"内容随相邻版本发布"的历史事实一致，不构成新问题。

### 1.3 低残留：缺口清单少一个 `0.14.0`

`0.14.0` **有 CHANGELOG 段、无 annotated tag、无 GitHub Release**（本地、远端都没有；GitHub Release 在 v0.13.0 与 v0.15.0 之间直接跳过）。核查：

- `sed -n '/^## 0.14.0/,/^## 0.13.0/p' CHANGELOG.md`：成段存在（2026-11-02，`scripts/shadow-report.mjs`）。
- `git log -S'## 0.14.0' -- CHANGELOG.md`：该段随 `0e8dc96「零配置：装完即用（0.15.0）(#24)」` 进入仓库。
- `git log -S'"version": "0.14.0"' -- package.json`：**空**（0.14.0 从未作为 package.json 版本发布过）。
- `gh release list --limit 200 | grep -E 'v0\.1[0-9]\.'`：`v0.13.0` 之后直接是 `v0.15.0`。

判定：**不算本条失败**——该行自述的范围起点就是 0.15.0，`0.14.0` 落在区间外，清单在区间内完整准确。但缺口清单那句没有写"（0.15.0 起）"，读者会把它当全历史清单，按全历史读就**少 1 个**。建议二选一：把 0.14.0 补进清单并注明"0.14.0 在 0.15.0 之前"，或在"**已知历史缺口**"后加"（0.15.0 起）"。

另：`0.1.1` 曾是 `package.json` 版本，但**既无 tag 也无 CHANGELOG 段**，不符合"有段无 tag"的口径，不计入。

## 二、第二条 · NUL 关闭，但"更正"本身不实

### 2.1 裸 NUL：已清

```
python -c "print(open('CHANGELOG.md','rb').read().count(b'\x00'))"      → 0
git cat-file blob HEAD:CHANGELOG.md   → 97,771 字节 / NUL = 0
git cat-file blob v0.109.0:CHANGELOG.md → 98,239 字节 / NUL = 1   ← 回归就出在这一版
```

工具侧复验（audit-09 说被废掉的两个入口；两者都作用于**工作树文件**，03:15 后工作树是 0.111.0 版，NUL 同样为 0）：

- `read` 工具直接读 `CHANGELOG.md`：**成功**（返回 1,699 行，不再报 `binary file`）。HEAD 版本为 1,689 行（工作树多一版 0.111.0 段）。
- `grep` 工具搜 `^## 0\.1(09|10|11)\.0`：**3 命中**（不再回 `Binary file matches`）。
- `git grep -c audit-09 HEAD -- CHANGELOG.md` → 3（git 侧也按文本处理）。
- 其它关键文本文件 NUL 均为 0：`MAINTENANCE.md` / `README.md` / `AGENTS.md` / `计划表.md` / `scripts/preflight-bundle.mjs`。

### 2.2 `git diff --stat HEAD~1` 仍显示 `Bin` —— 是历史侧的字节，不是当前文件

```
git diff --stat  HEAD~1 HEAD -- CHANGELOG.md  →  CHANGELOG.md | Bin 98239 -> 97771 bytes
git diff --numstat HEAD~1 HEAD -- CHANGELOG.md →  -    -    CHANGELOG.md
git diff --stat  c862efd HEAD -- CHANGELOG.md →  CHANGELOG.md | 30 +++++++++++++++++++++++++++++-
git diff --numstat c862efd HEAD -- CHANGELOG.md →  29   1   CHANGELOG.md
```

判读：git 的二进制判定是**逐对比较**——`HEAD~1`（v0.109.0）那一侧含 NUL，所以 `HEAD~1..HEAD` 这一对被标 `Bin`，行数统计退化成 `-  -`；换成不含 NUL 的基准（`c862efd` = v0.108.0）立刻回到文本统计（29 增 / 1 删）。**当前 HEAD 的 `CHANGELOG.md` 不再是二进制**，`Bin` 只是那次回归留下的历史对照面。

**注意（环境）**：`git diff --stat HEAD~1`（不带第二个 rev，比的是**工作树**）在本次审计中读到的是 `98239 -> 98291`，因为工作树在 03:15:17 被并发会话改成了 0.111.0。这条命令的读数会随工作树漂移，核二进制属性时应固定比较两个 rev。

### 2.3 0.110 段对"0.108 段表述更正"的说法：与事实**不一致**

0.110 段（`git show HEAD:CHANGELOG.md`，第 15–18 行）原文：

```
### audit-09 修复（终验不通过 → 逐条关闭）
- **R1 关闭**：… CHANGELOG 0.108 段里"已改为指针"的不实表述更正为"本版未改，指针是 0.109.0 做的"。
```

而 HEAD 的 0.108 段第 3 条 bullet（`git show HEAD:CHANGELOG.md` 第 38 行）现在写的是：

```
- **`MAINTENANCE.md` 的「已发布」行未在本版改动**（audit-09 更正：改为指针是 0.109.0 做的；本版的表述曾误称已改，特此更正）。
```

三份文本对照（这是本条的全部依据）：

| 来源 | 「已发布」行相关文字 |
|---|---|
| `git show v0.108.0:CHANGELOG.md`（该版原文） | 「**`MAINTENANCE.md` 已发布列表补全 0.78 → 0.108**（此前止于 0.77.3）。」 |
| `gh release view v0.108.0 --json body`（**已发布、不可变的 Release 正文**） | 同上，原句仍在（第 6 行） |
| `git show v0.109.0:CHANGELOG.md`（0.109.0 改写后） | 「「已发布」行**改为指针**…audit-08 证明手抄列表必然漏/重…」 |
| `git show HEAD:CHANGELOG.md`（0.110.0 再次改写） | 「「已发布」行**未在本版改动**（…改为指针是 0.109.0 做的…）」 |

事实核对（全部可复现）：

1. **v0.108.0 原文是真话，不是"误称"。** 取 0.108.0 那一提交 `c862efd` 与它父提交 `0c0bfb7`（0.106.0）的 `MAINTENANCE.md` 第 31 行，按 `→` 切条目：
   - `0c0bfb7`（0.106.0）：**94** 条，末条止于「0.77.3 归档幂等实测（补课 ≠ 失真）」；
   - `c862efd`（0.108.0）：**123** 条，末条「…0.107.0 N10 线上验证 → 0.108.0 audit-07 修复」。
   ⇒ 「已发布」行**在 0.108.0 这一版确实被改动**（补全 0.78→0.108），v0.108.0 段原文「补全 0.78 → 0.108（此前止于 0.77.3）」与实测**逐字吻合**。
2. **「未在本版改动」为假。** 上一条直接证否；改后的句子把该版自己**做过的**改动说成没做过，并删掉了那句真话。
3. **「改为指针是 0.109.0 做的」这半句成立**：`git show v0.108.0:MAINTENANCE.md` 第 31 行仍是手抄流水，指针句最早出现在 `v0.109.0`（`c9ba8d8`）。
4. **因此不实的是 0.109.0 那次插入的"改为指针"，不是 0.108.0 的原文。** 0.110.0 的更正把锅扣错了版本：它修掉了"改为指针"，却顺手否掉了 v0.108.0 的真改动。
5. **同一版本现在有两份互相矛盾的公开文本**：仓库里的 `CHANGELOG.md` 说 0.108.0 没改，而 GitHub 上 v0.108.0 的 Release 正文（`release.mjs` 当时从该段抽出）说改了。0.110.0 的 Release 正文也带着同一句不实表述（`gh release view v0.110.0` 已复核）。
6. 这是**对已发布版本段落的第二次改写**（0.109.0 改一次、0.110.0 再改一次）。audit-09 残留 C 的建议是"不要覆盖已发布版本的记述，或加一行『（0.109.0 复核更正）』"，本次仍走覆盖路线，且覆盖后更不实。

改法（一行字）：把 0.108 段那句改成

```
- **`MAINTENANCE.md` 的「已发布」行在本版补全到 0.108.0（未改为指针；改为指针是 0.109.0 做的）**；0.109.0 曾把本版误记成"改为指针"，audit-09 复核更正。
```

（或按 audit-09 残留 C：留原文 + 追加一行更正说明。）

## 三、残留

**A（中，本报告判不通过的**唯一**原因）· 已发布版本段被第二次改写，改后与事实相反。**
见 §2.3。位置：HEAD `CHANGELOG.md` 第 38 行（0.108.0 段第 3 条 bullet）。影响面：`release.mjs` 的 release notes 从这些段落抽取，所以不实表述会**继续随新 Release 扩散**；且同一版本的 GitHub Release 正文与仓库 CHANGELOG 已经不一致。

**B（低）· 缺口清单少 `0.14.0`，或该句缺下限说明。**
见 §1.3。区间内口径准确，不算本条失败。

**C（低，与 A 同源）· "更正"的写法仍是覆盖式。**
audit-09 残留 C 建议的"保留原文 + 追加更正行"未被采纳；已发布版本的记述被连续两版覆盖，每次都只留下最新一版的说法，读者无法从文件本身判断哪句是当时的、哪句是后补的。

**D（环境，非缺陷）· 审计期间工作树被并发推到 0.111.0。**
03:15:17 起工作树为 0.111.0（`package.json`、`CHANGELOG.md`、`MAINTENANCE.md`、`src/plugin.mjs`、`计划表.md`、新增 `evidence/M7-live-pipeline-reaches-gates.md`，未提交）。本报告结论锚定 HEAD = v0.110.0。抽查工作树 0.111.0 的两个关键点：`MAINTENANCE.md` 第 31 行**除区间末端 `0.110.0` → `0.111.0` 外一字未改**（缺口清单与"不再声称全部有 tag"保持原样），`CHANGELOG.md` NUL 仍为 0。**⇒ 若以 0.111.0 交付，本条判定（§1 关闭、§2.3 不通过）逐字适用。** 另：`node scripts/check.mjs` 在 0.111.0 工作树上退出 0。

## 四、跑了什么（可复现清单）

| 命令 | 结果 |
|---|---|
| `git log -1 --format='%H %ci %s'` | `78b048b9… 2026-11-04 02:57:29 +0800 R00 docs: 调研 31 GraphRAG + audit-09 修复（0.110.0） (#186)` |
| `git rev-list -n1 v0.110.0` / `v0.108.0` | `78b048b9…` / `c862efd1…`（tag 与提交对齐） |
| `git status --porcelain` | 03:11 空 → 03:15 起 5 改 1 增（0.111.0，见残留 D） |
| `git tag -l 'v*' \| wc -l` | 128 |
| `git show v0.109.0:MAINTENANCE.md \| grep -c '全部有'` vs `git show HEAD:MAINTENANCE.md \| grep -n '全部有'` | 1（完整性强断言本体）vs 1 处，且只出现在「本行不再声称"全部有 tag"」这个否定从句里 |
| `git for-each-ref refs/tags --format='%(objecttype)' \| uniq -c` | 128 × `tag`（全部 annotated） |
| `gh release list --limit 30` / `--limit 200` | 30 行 / 128 行；与 tag 集合双向差为空 |
| `git ls-remote --tags origin \| grep -c refs/tags/v` | 256（128 tag + 128 peeled） |
| `git ls-remote --tags origin refs/tags/v{0.14.0,0.77.3,0.78.0,0.86.0,0.88.0,0.97.0,0.107.0}` | 7 个全为 0 条 |
| `^## x.y.z` 段集合 × tag 集合对账（HEAD blob，python） | 135 段；有段无 tag = 7（区间内 6）；有 tag 无段 = 0 |
| `git log -p -- package.json` 抽版本号 × 段集合对账 | 131 个历史版本；区间内无"有版本无段"；区间内无 tag 的仅 0.78.0 / 0.86.0 |
| `python -c "print(open('CHANGELOG.md','rb').read().count(b'\x00'))"` | **0** |
| `git cat-file blob HEAD:CHANGELOG.md` / `v0.109.0:…`（python 计 NUL） | 97,771 / **0** ；98,239 / **1** |
| `read` 工具 + `grep` 工具读 `CHANGELOG.md` | 成功（1,699 行 / 3 命中），不再判二进制 |
| `git diff --stat HEAD~1` / `--stat HEAD~1 HEAD` / `--stat c862efd HEAD` | `Bin 98239 -> 98291`（工作树，漂移）/ `Bin 98239 -> 97771`（旧侧带 NUL）/ `30 +++…`（文本统计） |
| `git diff --numstat HEAD~1 HEAD -- CHANGELOG.md` vs `c862efd HEAD` | `-  -` vs `29  1` |
| `git show v0.108.0:CHANGELOG.md` / `gh release view v0.108.0 --json body` | 「已发布列表补全 0.78 → 0.108（此前止于 0.77.3）」两处均有 |
| `git show v0.109.0:CHANGELOG.md` 的 0.108 段 | 「「已发布」行改为指针…」 |
| `git show HEAD:CHANGELOG.md` 的 0.108 段 / 0.110 段 | 「未在本版改动…」/「…更正为"本版未改，指针是 0.109.0 做的"」 |
| `0c0bfb7` vs `c862efd` 的 `MAINTENANCE.md:31` 按 `→` 切条目 | 94 条（止 0.77.3）→ 123 条（止 0.108.0） |
| `git show v0.108.0:MAINTENANCE.md \| sed -n 31p` | 仍是手抄流水（⇒ 指针是 0.109.0 引入） |
| `git log -S'"version": "0.14.0"' -- package.json` | 空（0.14.0 从未成为 package.json 版本） |
| `gh release list --limit 200 \| grep -E 'v0\.1[0-9]\.'` | v0.13.0 → v0.15.0，无 v0.14.0 |
| `node scripts/check.mjs` | exit 0（在 0.111.0 工作树上） |

未做：没有重跑 `node --test`（0.110.0 段自记 414/410/0/4，与 0.109.0 一致，且本轮不涉及运行时代码）；没有重跑 `ledger-check --full`（不在本次两条范围内）；没有逐个 `gh api` 拉 128 个 Release 的正文（`gh release list` 与 tag 集合已双向对齐，足够）。

## 五、是否阻塞交付

- **第一条：不阻塞（已关闭）。**
- **第二条：阻塞交付，且只需改一行字。** 运行/产品层面无影响（测试、`check`、NUL、tag/Release 全绿），但本仓"文档必须为真"是硬条款，而当前 `CHANGELOG.md` 的 0.108.0 段**把一个已发布版本做过的改动说成没做过**，并与该版本的 GitHub Release 正文直接冲突。按 §2.3 的改法改完后，本报告的两条判定即为"全部关闭"。
- 出现了一个**新的过程性问题**（残留 C）：同一已发布段落被连续两版覆盖改写。建议在 `release.mjs` 或 `check.mjs` 加一条机械断言：`CHANGELOG.md` 中**早于当前版本**的段落不得被修改（`git diff HEAD~1` 命中旧版本段即报错）——这正是这类错误的护栏，audit-09 §1.6 也提过同类护栏缺失。
