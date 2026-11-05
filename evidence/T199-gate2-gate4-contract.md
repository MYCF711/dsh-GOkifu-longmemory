# T199 · 闸 2 成员解析 + 闸 4 合并契约（audit-12 剩余两条"同族静默放行"）

> 对象：`0.162.0+`（工作树）· 只改 `src/rooms/gates.mjs` + `test/gates.test.mjs`（+ 可重放补丁 `tmp/t199-redo.cjs`）
> 来源：`reports/audit-12.md` 第 3 节 + T198 自查清单
> 纪律：**只加严，不放宽**；不改任何既有 gate 名与文案。

## 1 · A · 闸 2：成员取不到 ⇒ 不许静默放行

### 改前（漏洞）

```js
if (mergedCap.resolved === 0) {
  // 成员都取不到 ⇒ 判不了：按记录自身 state 放行，并如实记 merged-unverified（不假装核过）。
  checks.merged.unverified += 1;
  continue;                     // ← 静默放行
}
```

合并节点的 state 上限 = **成员证据的并集**；成员一条都解析不到时"允许态"是**空集**。
拿空集放行，等于把"没有证据"读成"证据支持"——缺证据 ≠ 无问题（`AGENTS.md` §2.4 同源）。

### 改后

```js
checks.merged.unverified += 1;
checks.mergedUnverified += 1;
if (strict) {
  push('2', 'gate2/merged-members-unresolved', { index, claimId, members, reason: 'members-unresolved' });
} else {
  unverified('2', 'gate2/merged-members-unresolved', 1, '合并节点的成员记录一条都解析不到（缺证据 ≠ 无问题）');
}
// 两条路径都**不 continue** ⇒ 继续落到常规 support-state 判据（不许因此跳过更严的检查）
```

| 模式 | 行为 | 可见性 |
|---|---|---|
| `strict: true` | **FAIL**（`errors[]` 里有 `gate2/merged-members-unresolved`，带 `members` 列表） | 退出码非 0 |
| `strict: false` | 不制造假红，但 `checks.mergedUnverified` 计数 + `checks.unverified[]` 里有同名条目 | 报告可见 |

## 2 · B · 闸 4：新增 `gate4/merge-contract-invalid`

一条 claim 带 `merge` 字段时，**必须能自证它是怎么合出来的**（数据自相矛盾 ⇒ 报错，不是 unverified）：

| # | 判据 | 问题码 |
|---|---|---|
| ① | `merge.representative.claimId` ∈ `merge.members` | `representative-not-member` |
| ② | `representative` 能解析到，且**同 scopeKey** | `representative-unresolved` / `representative-scope-mismatch` |
| ③ | `members` 非空且**全部可解析** | `members-empty` / `member-unresolved:<id>` |
| — | `representative.claimId` 缺失 | `representative-missing` |

`detail = { index, claimId, issues: [...] }`，一个合并节点只报一条（issues 里列全部问题）。

## 3 · `checks` 字段变化

```
+ checks.mergedUnverified          // 合并节点"成员解析不到"的次数（非 strict 下也可见）
  checks.merged.unverified        // 既有：同样的计数（保留兼容）
  checks.merged.{unverifiedRefs, unverifiedRefReasons}   // T198 起
```

## 4 · 测试（原样）

```
$ node --test "test/gates.test.mjs"
ℹ tests 75
ℹ suites 0
ℹ pass 75
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 180.276
```

新增 5 条：`T199 ①`（strict ⇒ 闸 2 FAIL）、`T199 ②`（非 strict ⇒ `mergedUnverified` + 报告可见）、`T199 ③`（representative ∉ members）、`T199 ④`（representative 解析不到）、`T199 ⑤`（契约完整 ⇒ 不报，守卫）。

### 失败分支真红（隔离副本 `tmp/t199-old/`，未动共享源码）

副本 = `git show HEAD:src/rooms/gates.mjs`（改前）+ 同一份测试：

```
✖ T199 ①: 合并节点成员取不到 + strict ⇒ 闸 2 FAIL（gate2/merged-members-unresolved）
✖ T199 ②: 成员取不到 + 非 strict ⇒ checks.mergedUnverified 计数且报告可见，且仍走常规判据
✖ T199 ③: representative.claimId ∉ members ⇒ gate4/merge-contract-invalid
✖ T199 ④: representative 解析不到 ⇒ gate4/merge-contract-invalid
ℹ tests 75
ℹ pass 71
ℹ fail 4
```

## 5 · 真库复算（只读）

```
$ T199_STORE=tmp/t170-shadow node tmp/t199-recompute.mjs
{
 "claims": 1379,
 "mergeNodes": 39,
 "strict": { "gate2_merged_members_unresolved": 0, "gate4_merge_contract_invalid": 0 },
 "details": []
}
```

**39 个合并节点：闸 2 与闸 4 的新判据都是 0 错** —— 现有合流产物契约完整（representative 都在 members 里、都可解析、同 scope），没有"悬空成员"。
（生产库 `$DSH_HOME/memory-context` 本身 **0 个合并节点**；39 个在影库 `tmp/t170-shadow`。）

## 6 · 那 29 条真 stale 现在怎么算

`file-appeared 20 + version-mismatch 9 = 29` 条，`state` 全是 `observed`：

- **它们现在仍然只是在 `checks` 里计数**（`runValidityCheck` 的 `summary.failed` / `failures[]`），**不会**因为这次 T199 变红 —— 这是**对的**：
  闸 3 的判据是"**被渲染的**断言必须 validity 通过"。这 29 条只有真的进到卡上才会红（那时是 `gate3/stale-not-marked`），
  而要不要让它们进卡，是 walk/R12 的**可达性**问题，不是闸的职责。
- **该由谁变红**：数据侧把它们标成 `state: "stale"`（R09 的降级路径），之后即使被渲染也只出指针行（闸 3 放行）。
  在那之前，闸 3 会在**真的渲染到它们时**拦住整张卡 —— 这是正确的 fail-closed。
- 结论：**29 条不是闸的漏洞，是数据待修**；闸只负责"渲染时必须带证据"，不负责"没渲染时也要红"。

## 7 · 复现

```bash
node tmp/t199-redo.cjs --check     # 幂等自检（已应用则跳过）
node tmp/t199-redo.cjs             # 重放（anchor 不匹配会抛错）
node --test "test/gates.test.mjs"  # 75 条
T199_STORE=tmp/t170-shadow node tmp/t199-recompute.mjs
```
