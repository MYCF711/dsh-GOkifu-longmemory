# T38 · 扩坑类分类器（洞见层覆盖率 5.26% → 60.53%）

> 日期：2026-11-08 · 改动：`src/rooms/claim.mjs`（扩类 + 开关）、`src/rooms/inject.mjs`（洞见层显式开扩类）、`test/claim.test.mjs`
> 前置：`evidence/T37-recovery-insight.md`（洞见层只加注恢复事实的坑类；当时闭集 8 类，覆盖率 5.26%）

## 0 · 一句话结论

按**真库实际分布**把坑类从 8 类扩到 **19 类**（新增 11 类，全部有机械判据、全部给出真库命中数），洞见层覆盖率 **5.26% → 60.53%**（114 条有恢复事实的 claim 里 69 条能标出坑类）。**扩类默认关闭**：只给洞见层标注用（`{extended:true}`），claim 合并/类级章节仍只认原 8 类「环境/协议」类 —— R09 的「ENOENT 保留具体原文」、D2 的「语法错误保留具体原文」两条契约**逐字未动**。

## 1 · 扩类前（真库 1560 条 antipattern）

| 类 | 命中 |
|---|---|
| 未归类 | **1532（98.21%）** |
| module-missing | 9 |
| policy-human-turn | 5 |
| fs-read-before-write | 4 |
| web-search-empty | 4 |
| sandbox-limit | 3 |
| tool-unavailable | 2 |
| timeout | 1 |

## 2 · 新 11 类（机械判据 + 真库命中数）

| 类 | 判据（正则） | 真库命中 |
|---|---|---|
| `agent-not-found` | `active teammate … not found` / `task space not found` | **154** |
| `file-not-found` | `ENOENT` / `FileNotFoundError` / `no such file or directory` | **124** |
| `syntax-error` | `SyntaxError` / `syntax error`（含 bash `-c`） | **120** |
| `type-error` | `TypeError` | **41** |
| `search-io-error` | `grep/glob search failed … io error` / `io error for operation` | **39** |
| `python-exception` | `AttributeError` / `KeyError` / `UnicodeEncodeError` / `IndexError` / `ValueError` | **29** |
| `network` | `failed to connect` / `unable to access` / `could not resolve host` / 非公网 IP / `ECONNREFUSED` / `ENOTFOUND` / `socket hang up` | **18** |
| `git-not-repo` | `not a git repository` | **14** |
| `regex-error` | `regex parse error` / `PatternError` / `unterminated character set` / `invalid regular expression` | **11** |
| `arg-out-of-range` | `out of range for "` / `offset N is out of range` | **9** |
| `path-not-directory` | `not a directory` | **8** |

新增合计命中 **567** 条。类名/判据/命中数的单一来源是 `claim.mjs` 的 `ERROR_CLASSES_EXTENDED` 与 `ERROR_CLASS_NAMES`（19 类，T38 ④ 断言无重名）。

## 3 · 扩类后分布（真库）

| 读数 | 扩类前 | 扩类后 |
|---|---|---|
| 未归类 | 1532（98.21%） | **965（61.86%）** |
| 已归类 | 28 | **595** |
| 洞见层覆盖率（有恢复事实的 claim 能标坑类） | 6 / 114 = **5.26%** | **69 / 114 = 60.53%** |

洞见层按类：`syntax-error` 48 · `arg-out-of-range` 9 · `fs-read-before-write` 4 · `file-not-found` 3 · `python-exception` 2 · `module-missing` 1 · `regex-error` 1 · `sandbox-limit` 1（另有 3 条来自文本 `class:` 前缀）。

## 4 · 关键设计：扩类**默认关闭**（只服务洞见层）

扩类一旦进入 `classifyErrorClass` 的默认路径，会同时改变：
- `errorKeyOf`（claim 合并键）⇒ R09 的「ENOENT 保留具体原文」契约被破坏；
- `ensureClassClaims`（类级章节）⇒ 归档产物变化；
- 插件的 `errorClassKeyOf`（信号实体）⇒ walk 匹配面变化。

所以 `classifyErrorClass(text, { extended = false })` **默认走原 8 类**；只有 T37 的 `recoveryInsightClass` 显式 `{extended:true}`。这样：

- **洞见层**（卡上标注）看到 19 类；
- **合并/晋升/信号**（claim 生命周期）**逐字不变**（R09/D2 全绿，归档重放不受影响）；
- 关掉扩类（默认）⇒ 与原 8 类**逐字节一致**（tombstone）。

## 5 · 测试（`test/claim.test.mjs` T38 ①–④）

| # | 断言 |
|---|---|
| T38 ① | 11 个新类各有一条真库样本命中（19 个 case） |
| T38 ② | 旧 8 类优先（扩类不抢 `module-missing` / `fs-read-before-write` / `permission-denied` / `sandbox-limit` 的命中） |
| T38 ③ | tombstone：默认（不开扩类）⇒ 新类样本返回 `null`、旧类照旧；`errorKeyOf` 合并路径不参与扩类 |
| T38 ④ | 名单单一来源：`ERROR_CLASS_NAMES` 19 条、无重名、含新旧类；无关文本仍 `null` |

## 6 · 验收

- 全量：`node --test "test/*.test.mjs"` —— **1190 tests / 1184 pass / 0 fail / 6 skipped**（exit 0）。
- `node scripts/check.mjs` PASS。
- 真库分布与洞见覆盖率：`node tmp/t38-dist.mjs`、`node tmp/t37-stats.mjs`。

## 7 · 复现

```bash
node --test --test-name-pattern "T38" test/claim.test.mjs
node tmp/t38-dist.mjs      # 扩类前后分布（未归类 98.21% → 61.86%）
node tmp/t37-stats.mjs     # 洞见层覆盖率（5.26% → 60.53%）
node --test "test/*.test.mjs"
node scripts/check.mjs
```

**关键数（复核请对这四个）**：
- 扩类：8 → **19 类**（新增 11 类，每类有机械判据 + 真库命中数，合计 567 条）；
- 未归类：**98.21% → 61.86%**；
- 洞见层覆盖率：**5.26% → 60.53%**（69/114）；
- tombstone：默认关闭 ⇒ 与原 8 类**逐字节一致**；合并路径（`errorKeyOf`/`ensureClassClaims`/插件 `errorClassKeyOf`）**完全不变**。

## 8 · 限制 / 风险

1. **剩余 61.86% 仍未归类**：最大宗是 `total 40 drwxr-xr-x …`（20 条，`ls -l` 的**正常输出**，不是错误——不该归类）、PowerShell 的 `+ CategoryInfo : ParserError`（8 条，可作下一类 `powershell-parse`）、`ok cmd /c … string literal not terminated`（7 条）等。**没有为凑覆盖率把它们硬塞进类里**（不是错误 / 语义不清）。
2. **正则启发式**：`file-not-found` 会同时命中 `cp: cannot stat … no such file` 与编程语言异常；`syntax-error` 同时命中 JS `SyntaxError` 与 bash 语法错——**类内是同一类"坑"，不是同一根因**（卡上写的就是"这类坑"）。
3. **只影响标注**：扩类不改 claim 合并/晋升/可见性/闸门；`class:` 前缀仍只由原 8 类产生。
4. **未来若要扩类进合并**：必须同时改 R09/D2 的契约测试并另行论证（合并 = 丢具体原文，是**有损**的）。
5. **测试耦合**：T38 ① 用真库样本做 case，若将来这些文本不再出现在库里不影响（case 是字面量），但**判据改动**必须同步更新本测试与 `evidence` 里的命中数。