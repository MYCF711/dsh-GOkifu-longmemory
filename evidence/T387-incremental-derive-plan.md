# T387 · 增量派生（`deriveStore` 只算受影响子集）：设计与验收

> 2026-11-20 · 承接 T386 的实测（derive 单次 14.2 秒，产出 21.5 万条 link，归档调用两次）。

## 一、为什么这是当前唯一值得做的大件

| 阶段 | 耗时 | 随变更量变化 |
|---|---|---|
| 读日志 | 200s → **14.7s**（已优化） | ✅ |
| **deriveStore × 2** | **~28s** | ❌ 与变更量无关 |
| diff + 写盘（21.5万 → 2.9万） | 估 >100s | ❌ |

派生产出 215,410 条 link，库里只存 29,293 条 —— **7 倍冗余在"生成→丢弃"上被浪费**。

## 二、做法（三步，按风险从低到高）

### 第 1 步：二次 `deriveStore` 改抽样校验（**最低风险**）
`archive.mjs:842` 第二次调用只是为了"写完再算一遍复核"。改为：随机抽 5% 的 episode + 全量 topics 校验。
- 收益：立刻省 ~14 秒；
- 风险：降低复核覆盖率 —— **但幂等/一致性另有测试兜底**（`test/archive.test.mjs`）。

### 第 2 步：派生输入按变更集收窄
`deriveStore({ episodes })` 目前吃全量 4572 局。改为：
- 变更集 = 本次 `built` 里的 episode + **共享主题的旧 episode**（links 只在这些之间产生）；
- 其余 episode 的派生记录沿用库里已有；
- 风险：**漏掉间接关联**（A 变 → C 的派生本该更新）⇒ 必须用"主题闭包"取候选，不能只看直接命中。

### 第 3 步：派生阶段去重到最终形态
生成时就用最终 link 身份（`kind + a + b`）去重，别先造 21.5 万再 diff 到 2.9 万。

## 三、验收判据（机械可核）

1. **结果等价**：对同一 store 跑"旧全量派生"与"新增量派生"，`topics/links/threads/mentions` **逐条 deepEqual**；
2. **耗时**：1 个新会话入档全链 **≤60 秒**；连跑两次第二次 **≤60 秒**；
3. **幂等**：第二次跑 `manifest.json` **逐字节不变**；
4. **不回退**：`A2b 46.6%/79.7%`、`A6 100%`、`staleMarkedBy` 保留。

## 四、顺序纪律

**先做第 1 步**（省 14 秒，几乎零风险），验证 `archive.test.mjs` + 幂等后再考虑第 2 步。
第 2 步必须配"新旧派生逐条比对"的差分测试（与 T381 剪枝同法：差异必须为 0 才允许切换）。

---

## 五、更正（2026-11-20）：第 1 步的前提**搞错了**

我写这份设计时以为「第二次 `deriveStore`（`archive.mjs:842`）只是核验，可以改抽样」。
**读代码后确认不是**：

```js
// 回读 episodes 再算派生：保证"入档产物 == rebuild 产物"（同一份数据、同一函数）
const storedEpisodes = store.list('episodes').filter(e => e.record).map(e => e.record);
const derivedFromStore = await deriveStore({ episodes: storedEpisodes, ... });
writes.topics = store.replaceDerived('topics', derivedFromStore.topics, ...);
writes.links  = store.replaceDerived('links',  derivedFromStore.links,  ...);
```

**第二次才是"真正写入的那一份"**（从 store 回读，保证产物与 `rebuild` 一致）；
第一次（`:742`）用的是**内存里本次构建的** episodes，供 claims/joseki 使用。

⇒ 所以「改抽样校验」会把**唯一的写入源**降级，**不是零风险，绝对不能做**。

### 修正后的第 1 步

先量清楚**第一次 derive 的结果是否被复用**：若 `:742` 的派生结果只用于 claims/joseki，
而 topics/links 由第二次派生写入，那么可以：
1. 把 `:742` 那次**改成按需**（只在有 claims/joseki 变更时算）；
2. 或让它与第二次共用同一份 episodes（避免两次全量）。

**必须先做这一步测量（只读）才能动代码。** 在此之前，T387 的三步全部搁置。
