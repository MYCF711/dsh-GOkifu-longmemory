# T25 · 修 `oncePerSession` 失效：WeakSet（对象身份）→ `Set<session.id>`

> 2026-11-08 · 依据 T24 实测（`evidence/T24-redundant-injection.md` §五）：长期记忆系统同会话重复注入 **69/69 全在同一 pid**，
> 同一张卡同会话内投 **9 次、跨 6 小时**。根因：`src/plugin.mjs` 用 `new WeakSet()` 按 **session 对象身份**判会话，
> 宿主每个 pre-step 可能给一个**新对象** ⇒ 永远判「没注入过」。
> 改动：`src/plugin.mjs`（`sessionIdOf` + `injectedIds: Set` / `injectedObjects: WeakSet` 兜底）、`test/plugin.test.mjs`（T25 ①–⑤）。

## 1 · ① 先确认：`session.id` 是稳定标识（不是新发明的）

| 证据（源码符号） | 说明 |
|---|---|
| `resolveSessionScope` → `sessionLogScope(sid, home)` | 用 `session?.id` 到 `<DSH_HOME>/sessions/<group>/<sid>/session.v4.jsonl.zstd` 找会话日志 header —— **目录名就是 session.id**，同一会话的日志只有一份 |
| `LAST_SCOPE = new Map()` / `lastResolvedScope(sessionId)` | `decidePreStep` 里 `LAST_SCOPE.set(session.id, resolved)`，外层心跳再 `lastResolvedScope(session?.id)` 读 —— 已按 id 跨步骤缓存 |
| `repeatStateFor(map, session, …)` | D5 的「同类失败计数」也是 `typeof session?.id === 'string' ? session.id : …` —— 同一把 id |
| T24 的会话日志口径 | 943 个会话 / 1319 次注入全部按 `session.id` 归组（日志本身就是按 session id 分目录） |

⇒ 结论：**`session.id` 稳定、且是仓库里已经在用的唯一会话键**；`payload.agent.session` / `payload.session` 的**对象身份**不稳定（T24 的 69/69 同 pid 重复即反证）。

**③ 复用同一个 id 键**：新增 `export function sessionIdOf(session)` 作为**唯一入口**（非空字符串才认，否则 `null`），
`LAST_SCOPE`、`injectedIds`、`repeatStateFor` 三处都用同一把 `session.id` —— 不引入第二个会话标识、不做字符串归一化（避免 id 变形）。
无 id 时才退回 `WeakSet<session 对象>`（旧行为兜底，绝不炸）。

## 2 · ② 修复

```js
// apply() 里：
const injectedIds = new Set();         // session.id ⇒ 已注入（主判据）
const injectedObjects = new WeakSet(); // 无 id 的 session 对象 ⇒ 旧行为兜底
const sessionId = sessionIdOf(session);     // 每个 pre-step 现取（宿主可能给新对象）
const sessionObject = session && typeof session === 'object' ? session : null;

// 已注入判定（oncePerSession）
if (sessionId ? injectedIds.has(sessionId)
              : (sessionObject ? injectedObjects.has(sessionObject) : false)) return decision;

// 真注入成功 / 影子记录写成：
if (sessionId) injectedIds.add(sessionId);
else if (sessionObject) injectedObjects.add(sessionObject);
```

- dispose 时 `injectedIds.clear()`（与 `repeatStates.clear()` 同处）。
- **⑤ 向后兼容**：`oncePerSession: false` 时判定整段不执行 ⇒ 行为与修复前完全一致（T25 ④ 断言同 id 每步都注入）。

## 3 · 修复前后对照（用 T24 的 `634616f8` 会话日志重放）

数据源：T24 落盘的 `tmp/t24-*.json`（会话日志逐帧解出的注入事件：`session.id` + digest + at）与
`<DSH_HOME>/memory-context/live-stats.jsonl`（按 `digest + at±2s` 回配 `pid`，取 `src=index.js` 的 inject 行）。
修复前的行为 = **每次 pre-step 都注入**（WeakSet 对象身份失效，T24 实测 69/69 同 pid）；修复后 = **每个 (session.id, pid) 至多 1 次**。

| 口径 | 修复前 | 修复后（估算） | 变化 |
|---|---|---|---|
| **`634616f8` 单会话** | **35 次**（19 张不同卡，跨 44h） | **≈4 次**（该会话跨 4 个宿主进程：pid 4532 / 10096 / 12068 / 19252，每进程 1 次） | **−88.6%** |
| `634616f8` 的**同一张卡** `08840121f2c29be4` | **9 次**（06:21→12:44，**全部 pid 10096**） | **1 次**（同进程同会话） | **9 → 1** |
| **长期记忆系统 scope**（20 会话） | 200 次 / 29,144 tokens | ≈55 次 / 11,877 tokens | **−72.5% 次数 / −59.2% token** |
| **全库 11 个 scope 合计**（943 会话） | **1,319 次 / 262,386 tokens** | **943–1,054 次 / 194,473–223,182 tokens** | **−20.1%～−28.5% 次数 / −14.9%～−25.9% token** |

> 口径说明：①「修复后」的下界 = 每个 session 至多 1 次（943）；上界 = 按 (session, pid) 至多 1 次（1,054，59 条
> live-stats 配不到 pid 的按独占进程计 —— 主要是 D5 补卡，T24 §1.3 已说明它不写 live-stats）。真实值落在区间内。
> ② 修复后同一会话在**宿主重启后**会重新获得 1 次注入（内存态，设计如此）；上界已按 pid 还原这部分。
> ③ 这不改变"卡是否相关"的判定，只改变"同一个会话投几次" —— 语义即配置字面：`oncePerSession = 每会话只注入一次（首轮）`。

## 4 · ④ Tombstone

| 测试 | 断言 |
|---|---|
| T25 ① | 同一 `session.id`、**两个不同 session 对象** ⇒ 只注入一次（旧 WeakSet 实现这里会注入两次） |
| T25 ② | 不同 `session.id` ⇒ 各自注入一次（不是全局一刀切） |
| T25 ③ | 无 id 不炸：同一对象第二次不注入（旧行为兜底）、不同对象视为不同会话；**`payload.session` 直接是字符串也不许炸**（WeakSet 只收对象，已加类型守卫） |
| T25 ④ | `oncePerSession: false` ⇒ 同一 id 每步都注入（向后兼容） |
| T25 ⑤ | `sessionIdOf` 只认非空字符串 id，其它一律 null |

**实证**：把判定临时改回 `injectedObjects.has(session)`（对象身份）⇒ **T25 ① 红**（4 pass / 1 fail）；
复原后 sha256 一致（`fa3d7aafac00ceef213c3cf6e47c40e147b7356289c7c1389e80996130ecdf7f`），T25 全绿。

## 5 · 验证

```bash
node --test test/plugin.test.mjs                                # 75/75 pass
node --test --test-name-pattern "T25|oncePerSession|每会话只注入一次" test/plugin.test.mjs  # 6/6
node scripts/check.mjs                                          # PASS
node scripts/boundary-audit.mjs                                 # PASS 0 处
```

- 兼容性回归：全量 `test/plugin.test.mjs` 75/75（含旧 R16「同一会话第二次不再注入」「oncePerSession:false」两条）。
- 唯一需要同步的旧测试：`makeSession` 增加可选 id；「换一个会话」改为**换 id**（只换对象不再算新会话 —— 这正是本修复的语义）；
  T16 ③ 的两步改用不同 id（同 id 第二步会被 oncePerSession 拦住）。

## 6 · 风险 / 注意

1. `injectedIds` 是**进程内** Set，宿主重启后清空 ⇒ 每个会话在每次宿主生命周期里最多注入一次（与旧设计一致，不跨进程持久化）。这也是 T24「同 pid 69/69」能解释的部分。
2. Set 会随会话数增长（每 session id ~36 字符；1 万个会话 ≈ 0.7MB 量级），长期运行可接受；如需上限可将来按 LRU 裁剪。
3. D5 `repeatHint` **不受 oncePerSession 限制**（原设计：它是"同类失败反复"的补卡，有自己的 `repeatHintMax`）——本次不动，T24 已把它单列。
