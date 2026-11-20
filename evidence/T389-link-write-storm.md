# T389 · 归档跑不完的真正机制：**派生 21.5 万条 link，逐条写文件**

> 2026-11-20 · 由 T386/T388 的计时与代码阅读交叉得出。

## 一、机制（读 `persist.mjs` 的 `replaceDerived`）

```js
function replaceDerived(kind, records, opts) {
  const written = putMany(kind, list, { at });     // ← 逐条写（原子替换 + journal）
  for (const id of ids(kind)) {                    // ← 再扫全目录删多余的
    if (wanted.has(id)) continue;
    fs.unlinkSync(...);
  }
}
```

归档对 `links` 调用它时，`list.length` = **215,410**（T386 实测），而库里现存 **29,293**。
⇒ 每次归档都要**多写 ~186,000 个文件**，每个都走「读旧内容 → 算 sha256 → 原子写 → 追 journal」。

**这就是 >900 秒的来源**，与读日志、与 `deriveStore` 的 CPU 都不同：是**文件数爆炸**。

## 二、为什么库里有 29,293 而派生要 215,410

两种可能（本轮未定论，需下一轮验证）：
1. **历史归档从未写完**：每次跑到超时被杀，落盘的只是一部分 ⇒ 库里 2.9 万是"没写完的残留"；
2. **派生本身膨胀**：`topics` 派生到 26,238 个（库里存 13,212）⇒ 主题×局 的组合自然翻倍。

无论哪种，**结论一致**：当前 `links` 的"一条记录一个文件"存储方式，在这个量级下不可用。

## 三、候选修法（下一轮按此顺序验证）

| 方案 | 说明 | 风险 |
|---|---|---|
| **① 减少派生量** | 生成期就去重到最终形态（同 `kind+a+b` 只留一条），或对低权重边设阈值 | 阈值可能影响 A2b ⇒ 需差分验证 |
| **② links 改聚合存储** | 一个 topic 的边写一个文件（或分片），`replaceDerived` 只写分片 | 改动 R15 契约，影响面大 |
| **③ 只写变化的边** | 现有 `putMany` 已算 sha256，但对 21.5 万条每条都要 `readFileSync` 旧值 ⇒ 改成先按 id 批量 stat/读取 | 收益有限 |

**建议先做 ①**：它是"少生成"，不改存储契约，且可用 A2b 做回归护栏。

## 四、验收判据（不变）

1. 1 个新会话入档全链 **≤60 秒**；
2. 连跑两次，第二次 **≤60 秒**且 `manifest.json` **逐字节不变**；
3. `archive.test` 全绿、`staleMarkedBy` 不丢、**A2b 46.6%/79.7% 不变**。

## 五、这条与 A4/D7 无关

纯正向（不改判据），且是**当前唯一能让归档真正跑完的路径**。

---

## 六、更正（2026-11-20 复测）：派生 link 是 **40,919**，不是 215,410

复测（同一 store、同一函数）：

```
derivedLinks 40919 · derivedUniqueIds 40919 · storedLinks 29293 · overlapStored 26008
kinds = { shared-topic: 13777, same-error: 19879, same-file: 7263 }
```

⇒ 每次归档实际新增约 **14,911** 条、删除约 **3,285** 条。
**之前那个 215,410 是一次异常读数**（很可能是归档正写到一半时的中间态，或含 subagent 未归并的口径）。
本节之前的"21.5 万"说法以此处为准。

## 七、40,919 条边也解释不了 >1200 秒 —— 说明还有别的重活

本轮实测：`timeout 1200 node scripts/archive.mjs --incremental --json` **仍然超时（exit 124）**，
连分阶段计时都来不及打出结果。

候选（下一轮逐一排除，**先量再改**）：
1. `store.verify()`：收官时对所有 kind 做 checksum 校验 —— 文件数 ≈ 29k(links)+13k(topics)+4.5k(episodes)+5k(claims)，**逐文件读+算 sha256**；
2. `putMany`：对每条记录先 `readFileSync` 旧值比对 sha256（40k 次读）；
3. `ids(kind)` + `unlink` 扫描；
4. `stabilizeExisting` 对大数组的深比较。

**下一步做法**：改用 `console.error` 在每阶段结束**立即输出**（而不是等 JSON 汇总），
这样即使进程被 `timeout` 杀掉，也能看到"卡在哪一阶段"。
