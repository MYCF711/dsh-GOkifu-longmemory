# T35 · file-exists 适用条件失效 ⇒ 不注入（负迁移机械消除）

> 日期：2026-11-08 · 改动：`src/rooms/inject.mjs`、`test/inject.test.mjs`
> 依据：`docs/合流-契约.md`（preconditions 是适用范围的一部分）、`gates.expectedExistenceOf`（T158/T159 的 file `expect` 方向）

## 0 · 一句话结论

注入前对 `preconditions` 里的 **`file-exists`** 类做**机械核验**：适用条件已不成立 ⇒ 该 claim **不注入**（不是降级成指针行——指针行仍在说"这里有信息量"）。核验是**方向感知**的（见 §1 的关键发现），真的库 **110 条** file-exists claim 里**当前失效 34 条**（路径已出现），其余 76 条仍成立（不误杀）。

## 1 · 关键发现：`file-exists` 在本仓是**反向**语义（T158/T159）

真库里 `file-exists` 类 precondition **全部 110 条**都是 `validity.expect === 'missing'`（ENOENT 派生的 fact）：

```json
{ "validity": { "type": "file", "value": "c:/Users/ADMINI~1/AppData/Local/Temp/pr-resp.json", "expect": "missing" },
  "preconditions": [{ "check": "file-exists", "value": "c:/Users/…/pr-resp.json",
                      "why": "该条记录的是证据时刻「此路径不存在」；该路径出现即不再成立（方案 §5.3）" }] }
```

也就是说：**「文件不存在」才是它成立的时候**；路径**出现**才让它失效（`gates.expectedExistenceOf` 的 `missing` 分支，`mark-stale.mjs` 同口径）。

⇒ 如果按任务书字面（"文件不存在 ⇒ 不注入"）实现，会**恰好反掉**：把 76 条**仍然正确**的记忆丢掉（负迁移的另一种形态），却保留 34 条已经失效的。所以本刀按**仓库既有语义**实现：

| `expect` | 何时失效（不注入） |
|---|---|
| `missing`（ENOENT 派生，本库 **110/110**） | 路径**出现** |
| `exists`（普通文件 fact；缺省） | 文件**消失** |
| 旧记录无 `expect` | 按 gates 规则：`validity.value === precondition.value` ⇒ `missing`，否则 `exists` |

## 2 · 实现（`src/rooms/inject.mjs`）

```js
export function fileExistsPreconditionOk(claim, options = {}) { … }   // 纯函数，方向感知
```

- `entryFromClaim` 在 `invalidated` 之后、选 support 之前调用：`if (claim && !fileExistsPreconditionOk(claim, options)) return null;` ⇒ 整行不出现。
- **只认 `file-exists`**：`scope` / `cmd` / `tool` / `step-range` 一概不动（scope 是 A5 的职责；其它由各自闸管）。
- `value` 取不到（空/非字符串）⇒ **无法核验 ⇒ 放行**（不拿缺字段当失效理由）。
- 相对路径按 `options.preconditionBaseDir`（默认 `process.cwd()`）；绝对路径原样。
- **成本**：`fs.existsSync` + 进程内按绝对路径缓存（上限 512 条整体清空）⇒ 热路径每 claim 最多一次 stat，同文件只查一次。

**顺带修掉的真 bug**：`pickClaimBase` 对"hit 自带 claim 对象"的**投影**原来只带 `id/kind/state/text/occurredAt/support`，**丢掉 `preconditions` 与 `validity`** —— 这条旁路上 preconditions 永远为空 ⇒ T35 核验（以及 T298 的 `preconditionOk` 回调）会被静默绕过（等于永不失效）。已把两个字段补进投影（T35 ⑤ 钉住）。

## 3 · 统计（真库，`tmp/t35-stats.mjs`，只读）

| 读数 | 值 |
|---|---|
| claim 总数 | 2277（**全部**带 `preconditions` 字段） |
| 带 `file-exists` 类的 claim | **110** |
| 其中 `expect: missing` | **110**（100%） |
| 当前**仍成立**（路径仍不存在） | **76**（不误杀） |
| 当前**已失效**（路径已出现 ⇒ T35 不注入） | **34** |

失效样例（路径现在真的存在，这条 fact 的"当时不存在"已不成立）：

| claim | 路径 | expect |
|---|---|---|
| `c-13d0c05b` | `c:/Users/Administrator/.config/magpie/plugins/node_modules/magpie-opc-auth` | missing |
| `c-1bc49c56` | `c:/Users/ADMINI~1/AppData/Local/Temp/bd2.html` | missing |
| `c-2caa6d03` | `c:/Users/ADMINI~1/AppData/Local/Temp/pr-resp.json` | missing |
| `c-32870086` | `d:/` | missing |

**本刀消除的负迁移量 = 34 / 2277 = 1.49%**（这 34 条记忆的适用条件已不成立，继续注入就是拿过期事实当现状）。

## 4 · tombstone

- 路径**仍不存在**（`expect:missing`）或**存在**（`expect:exists`）⇒ 卡片与本改动前**逐字节一致**（T35 ① 用同一 claim 的"有/无 precondition"两版对照）。
- 失效时该 claim **整行不出现**（不是指针行，T35 ②）。
- `scope` / `cmd` 类 preconditions **不受影响**（T35 ③）。
- 无法核验（`value` 空/缺失）**放行**（T35 ④）。
- 方向：`missing` 档"路径出现才失效"、`exists` 档"文件消失才失效"、旧记录按 gates 规则（T35 ⑤）。

## 5 · 测试（`test/inject.test.mjs` T35 ①–⑤）

| # | 断言 |
|---|---|
| T35 ① | 文件存在（`expect:exists` 缺省）⇒ 有无 precondition 的卡片**逐字节相同**（tombstone） |
| T35 ② | 文件不存在（`expect:exists`）⇒ **整行不出现**；文件存在时照常渲染 |
| T35 ③ | 只认 file-exists：`scope` / `cmd` 类 precondition 照常注入 |
| T35 ④ | 无法核验（`value` 缺失/空/空白）⇒ 放行（不误杀） |
| T35 ⑤ | 方向感知：`expect:missing` ⇒ 路径仍不存在时**照常渲染**、路径出现时**不注入**；旧记录（无 `expect`、`validity.value` 同值）按 missing 判 |

## 6 · 验收

- 全量：`node --test "test/*.test.mjs"` —— **1181 tests / 1175 pass / 0 fail / 6 skipped**（exit 0）。
- `node scripts/check.mjs` PASS。
- 真库统计：110 条 file-exists claim，失效 **34** 条（不误杀 76 条）。

## 7 · 复现

```bash
node --test --test-name-pattern "T35" test/inject.test.mjs
node tmp/t35-stats.mjs        # 真库 file-exists 失效统计（方向感知）
node --test "test/*.test.mjs"
node scripts/check.mjs
```

**关键数（复核请对这四个）**：
- 真库 file-exists claim **110** 条（**全部** `expect:missing`）；
- 当前失效 **34** 条（路径已出现 ⇒ 不注入），仍成立 **76** 条（不误杀）；
- 本刀消除的负迁移量 **34 / 2277 = 1.49%**；
- tombstone：条件成立时卡片逐字节不变（T35 ①②③④⑤）。

## 8 · 限制 / 风险

1. **只做 file-exists**：`cmd` / `tool` / `step-range` 类 precondition 仍未核（需要执行命令/工具，不在注入热路径上做）；`scope` 归 A5。
2. **方向依赖 `validity.expect`**：若将来有 writer 只写 `preconditions` 不写 `validity`，按 gates 的旧记录规则（`validity.value` 同值 ⇒ missing）判——与 `mark-stale`/`probeValidity` 一致，不会各判一套。
3. **缓存**：进程内按绝对路径缓存，文件在**同一进程生命周期内**被创建/删除不会立刻反映（下次进程即可见）。热路径上这是可接受折中（否则每 claim 每次 stat）。
4. **`d:/` 这种根路径**也算"存在"：这是机械判据的边界（`existsSync('d:/')` 为真）；它确实说明"该路径存在"，判失效是对的，但样例会有点滑稽——已在 §3 列出。
5. 本刀只做"不注入"，**不写** stale 标记、不改 claim 数据（原件永不删；`validityOk` 仍由 gates 的 probe 管）。