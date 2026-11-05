# T257 · "同文多处"的机械消歧：假设验证 + dry-run

> `[本] 2026-11-05 19:20 +08:00` · 真库**只读**（`--apply` 现在被守卫拒绝，只有 `tmp/` 副本能写）。
> 产物：`scripts/repair-support-seq.mjs`、`test/repair-support-seq.test.mjs`、`tmp/t257-redo.cjs`

## 0 · 守卫（先贴代码，再跑东西）

```js
// ⚠ T257 守卫：--apply 只许落在 tmp/ 下（真库只读）
if (flags.apply) {
  const segs = path.resolve(storeRoot).split(path.sep).map((x) => x.toLowerCase());
  if (!segs.includes('tmp')) return { code: 1, stdout: `✗ 拒绝 --apply：store 必须位于 tmp/ 下（实际 ${path.resolve(storeRoot)}）—— 真库只读` };
}
```
测试 `T257 守卫` 实证：真库路径 `--apply` ⇒ **exit 1** + 拒绝文案。

## 1 · A · 假设验证：**不成立（至少不普遍）**

判据：`normalizeCardText(support.quote)` 在事件 blob 里的命中。

| 桶 | 条数 | 含义 |
|---|---|---|
| ok（seq 已正确） | 944 | 不动 |
| **可修**（唯一 tool/result 或唯一命中） | **865** | 消歧后可自动修 |
| ambiguous · multiple-tool | 678 | 多个 `tool/result` 都含 ⇒ **不修** |
| ambiguous · echo-only | 45 | 只有 `assistant/message` 等非原始出处 ⇒ **不修** |
| unrepaired | 47 | 一个都没有 ⇒ 不修 |

**关键反例（10 条逐字对照，节选 5 条）**：

```
— echo-only c-0080133b seq 11647 hits 4
     11649 job/registered   "version = \"0.2.1-go.23\"/' cmd/dshd/main.go gofmt -"
     11650 job/settled      "version = \"0.2.1-go.23\"/' cmd/dshd/main.go gofmt -"
     11860 job/registered   "version = \"0.2.1-go.23\"/version = \"0.2.1-go.24\"/' "
— echo-only c-0337722c seq 6999 hits 4
      7001 job/registered   "version = \"0.2.1-go.15\"/' cmd/dshd/main.go gofmt -"
      7002 job/settled      "version = \"0.2.1-go.15\"/' cmd/dshd/main.go gofmt -"
— multiple-tool-results:2 c-01c643fc seq 9006 hits 2
      9010 tool/result      "SyntaxError: Illegal return statement at checkSynt"
      9024 tool/result      "SyntaxError: Illegal return statement at checkSynt"
— multiple-tool-results:2 c-021f74a1 seq 500 hits 2
       507 tool/result      "OK docs/WORKER.md OK docs/cold-start.md OK docs/ex"
       541 tool/result      "OK docs/WORKER.md OK docs/cold-start.md OK docs/ex"
```

**结论**：多命中的真实来源**不是** "assistant 回显 vs tool 原始"，而是：

1. **同一份 payload 被广播两次** —— `job/registered` 与 `job/settled` 各存一份**逐字相同**的子代理结果（上面 11649/11650 两行完全一致）；
2. **同一段工具输出在多个 step 重复出现**（9010/9024、507/541）——重试或重复执行导致；
3. `assistant/message` 只在少数条目里出现，**不是主要来源**。

⇒ 按"原始出处优先"这条规则，`echo-only 45` 条里绝大多数其实**没有真正的原始出处可指**（它们只出现在 job 广播里）。

## 2 · B · dry-run（`tmp/t257-copy` 副本）

```
$ node --max-old-space-size=6144 scripts/repair-support-seq.mjs --apply --store tmp/t257-copy
扫描 claim 1516 条 · support 引用 2579 条
  ok 944 → 写入 674 条 claim · 865 处引用
  —— 头部 5 条 from → to ——
  c-008c3e04 @ ep-543cf0b2: 2033 → 2037（tool/result，距离 4）
  c-00d76725 @ ep-9becea64: 1330 → 1334（tool/result，距离 4）
  c-00eb81f4 @ ep-a9f16ff0: 401 → 408（tool/result，距离 7）
  c-0153220d @ ep-00b50089: 15470 → 15474（tool/result，距离 4）
  c-01b1ecf1 @ ep-aa52f421: 613 → 621（tool/result，距离 8）
耗时 2m13s
```

**修后（P2 同口径）**：

```
$ node --max-old-space-size=6144 scripts/repair-support-seq.mjs --apply --store tmp/t257-copy   # 第二次
  ok（seq 已正确）      1809          ← 944 + 865
  可修                 0
  ambiguous            723
  unrepaired           47
写入：0 条 claim · 0 处引用          ← **幂等**
```

- **P2 通过率**：`944/2579 = 36.6%` → `1809/2579 = 70.1%`（+33.5pt）；
- **幂等**：第二次 0 变更；
- **只增不改**：只改 `seq` + 追加 `provenanceRepair{at,from,to,reason,eventType,index}`（测试 ④⑤ 断言 quote/text/state 逐字不变）。

## 3 · 测试

```
$ node --test "test/repair-support-seq.test.mjs"
ℹ tests 9   ℹ pass 9   ℹ fail 0   ℹ duration_ms 211.13
```
新增：T257 ① 唯一 tool/result ⇒ 可修 · ② 多个 tool/result ⇒ 不修 · ③ 只有 assistant ⇒ 不修 · 守卫 ⇒ 真库 `--apply` 退 1。

## 4 · 一句话回报

**假设不成立**：多命中的主因是 **`job/registered` + `job/settled` 把同一份子代理 payload 广播两次**（逐字相同），而不是"模型回显"；按"唯一 `tool/result`"规则仍能自动修 **865 条**（P2 36.6% → 70.1%），剩下 **723 条 ambiguous + 47 条 unrepaired** 需要新规则（"成对广播去重"）或人工。

## 5 · 未决事项（上一轮遗留，必须由 Lead 拍板）

真库在 18:42 被无守卫版本写入过 **299 条 claim / 553 处 seq**（`verify` 报 299 条 checksum 错、manifest 未更新）。本轮的守卫已防止再发生，但**那 553 处仍在库里**，回滚/扶正需要你一句话。
