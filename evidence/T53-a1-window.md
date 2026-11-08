# T53 · A1.redundant 的窗口要跟着「当前在跑的那份代码」走（否则修好了也照样红满 24 小时）

> 2026-11-09 · `scripts/m5-report.mjs` 的 `measureA1Redundant` / 新增 `currentRunStartAt`

## 一、要解决的问题

T49 修完"同一张卡每轮重投"之后，`A1.redundant` 并**不会**立刻变绿——它的窗口下限 `fixAt` 是一个
**写死的常量**（`A1_REDUNDANT_FIX_AT = 1794115537000` = 2026-11-08T05:25:37Z，上一次修判据的时点）。

于是：新代码上线后，窗口里仍然混着**旧代码**注入的那批 ⇒ 哪怕修好了，也要等满 24 小时、
旧数据滚出窗口才会绿。中间这段时间，读数是"红"，但那个红**不代表当前代码**。
这违反本仓的口径纪律：**跨时点不可比、跨代码版本更不可比**。

## 二、改成什么

```js
export function currentRunStartAt(storeRoot) { /* 最后一条 src=index.js 心跳的 pid → 它的首条心跳 */ }

const declaredWindowStart = Math.max(declaredFixAt, now - A1_REDUNDANT_WINDOW_MS);
const fixAt       = Math.max(declaredFixAt, runStartAt ?? 0);
const windowStart = Math.max(fixAt, now - A1_REDUNDANT_WINDOW_MS);   // ← 判据窗口
```

- 宿主一重启，pid 换新，`currentRunStartAt` 自动推进 ⇒ **不用人工改常量**，也不会忘记改。
- 扫描用 `min(判据窗口, 参考窗口)` 起，保证两个窗口都扫得到。

**换口径不藏读数**：同一批扫描结果按旧窗口（跨代码版本）再算一遍，放进 `detail.reference`，
只报不判、不参与 exit code。

## 三、当场读数（2026-11-09 07:33，宿主 pid 8040 仍在跑旧代码）

```
node -e '…measureA1Redundant({dataRoot, runStartAt: currentRunStartAt(storeRoot)})…'

判据窗口 2026-11-08T17:52:55.455Z（= 当前宿主首心跳）
  注入 33 · waste 0.00% · powered false          ← 未通电：样本不足，不参与 exit code
参考窗口 2026-11-08T05:25:37.000Z（跨代码版本，旧的写死常量）
  注入 309 · waste 9.81% · necessary 7.64% · powered true   ← 原来那个红的来源，仍然看得见
```

也就是：**旧的那个 9.81%（≈之前的 10.53%，窗口随 now 滑动）没有被抹掉**，它现在挂在"参考"下；
"判据"这一栏说的才是"当前这份代码的表现"，并且诚实地标成**未通电**而不是绿。

`node scripts/metrics-guard.mjs` 现在的输出：

```
A1.redundant=浪费 0.0% · 必要重注 0.0%（会话级同卡再投；n=33，未通电·不参与 exit code（窗口样本不足））
```

## 四、验收

```
node --test test/t53-a1-window.test.mjs → 6/6
  ✔ ① currentRunStartAt = **最后一条**心跳那个 pid 的首条心跳（既不是全库最早，也不是最早那个 pid）
  ✔ ② 不是宿主写的行（src 非 index.js）不参与判定
  ✔ ③ 没有 live-stats ⇒ null（不编造一个 start）
  ✔ ④ 判据窗口用 runStartAt 下限（旧代码那批注入不计入分母）
  ✔ ⑤ 常量比 runStartAt 晚时取常量（不因为重启就把判据修复时点吞掉）
  ✔ ⑥ 换口径不藏读数：reference 按旧窗口再算一遍，只报不判

node --test "test/*.test.mjs"  → 1235 条 / 1229 pass / 0 fail / 6 skip
node scripts/check.mjs         → PASS
```

## 五、边界与代价（说清，别当免费）

- **重启后一段时间内会是"未通电"**（要达到 100 次注入 / 20000 token 的门槛），期间不判红也不判绿。
  这是本仓一贯纪律（"样本不足就 NO-SAMPLE，不许硬算过"），不是这条轴特有的。
- **频繁重启会把窗口一直压得很短** ⇒ 这条轴长期停留在"未通电"。它的代价是"看得见但判不了"，
  比"判得出来但判的是旧代码"更诚实。
- **它不替 T49 证明修复有效**。修复是否有效，重启后看判据窗口里的 `waste` 与
  `node scripts/t49-replay.mjs` 的真库回放（5.51%–8.82% 会被拦）两条一起看。
- 参考值只用于"别把旧读数藏起来"，**不能**拿它跟判据值比较（口径不同：跨版本 vs 单版本）。
