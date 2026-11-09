# T377 · rc1 验收探针收编进仓库，并在**当前宿主**上跑通

> 2026-11-10 · 起于 T186 的 C 类发现：「`AGENTS.md` §2.2.1 写着 `longmemory-rc1-probe.mjs`，主线里却没有它」。

## 一、为什么这条一直在 tmp 里

原探针把三个路径**写死**成升级任务当时的现场：

```js
const asar     = 'D:/DeepSeek Harness/Desktop-0.2.2-rc.1/resources/app.asar';
const worktree = '.../tmp/dsh-latest-upgrade/worktrees/longmemory';
const home     = '.../tmp/dsh-latest-upgrade/longmemory-probe-home';
assert.equal(runtimeVersion, '0.2.2-rc.1');   // 宿主一升级就整条报废
assert.equal(cordisVersion, '4.1.0');
```

`tmp/` 不进 git ⇒ 换个目录、换个宿主版本，这条验收能力就没了。

## 二、改法（`scripts/rc1-probe.mjs`）

| 原来 | 现在 |
|---|---|
| 写死 asar / worktree / home | `--asar`（默认读 `DSH_ASAR`）/ `--repo`（默认**本仓**）/ `--home`（默认系统临时目录） |
| 断言 `=== '0.2.2-rc.1'` | 断言 `startsWith('0.2.2-rc.')`；要钉死版本用 `--expect-version 0.2.2-rc.1` |
| 用 `new URL(...).pathname` 推仓库根 | `fileURLToPath(import.meta.url)`（原来的写法在中文路径上会**双重百分号编码**，直接 `ERR_MODULE_NOT_FOUND`） |

**必须用宿主的 node 跑**（asar 是 Electron 的虚拟文件系统，普通 `node` 读不了 `app.asar/dsh/package.json`）：

```bash
ELECTRON_RUN_AS_NODE=1 "D:/DeepSeek Harness/Desktop-0.2.2-rc.1/DeepSeek Harness.exe" scripts/rc1-probe.mjs
```

## 三、在当前宿主上的实测（exit 0）

```
LONGMEMORY_RC1_PROBE_PASS
{"runtimeVersion":"0.2.2-rc.1","cordisVersion":"4.1.0",
 "startupError":null,
 "stateBeforeDispose":2,"stateAfterDispose":4,
 "coreEffectType":"function",
 "disposersBefore":5,"disposersAfter":0,
 "autoBuildCancelCalls":0,"autoBuildPostDisposeCalls":0,
 "autoBuildSharedCalls":1,"autoBuildSharedFinished":1,
 "disposePromiseShared":true,
 "autoBuildDisposersAfter":[0,0,0],
 "cleanShutdown":true}
```

逐条对上 `AGENTS.md` §2.2.1 的验收口径：

| §2.2.1 要求 | 实测 |
|---|---|
| `startupError=null` | ✅ null |
| 核心 effect = function | ✅ `coreEffectType: "function"` |
| disabled disposers **5 → 0** | ✅ `5 → 0` |
| `autoBuildSharedCalls=1` / `Finished=1` | ✅ 1 / 1 |
| `autoBuildCancelCalls=0` | ✅ 0 |
| `autoBuildPostDisposeCalls=0` | ✅ 0 |
| 严格同 Promise | ✅ `disposePromiseShared: true` |
| 全部探针 disposers = 0 | ✅ `autoBuildDisposersAfter: [0,0,0]` |
| `cleanShutdown=true` | ✅（**只限探针 fibers**，不冒充完整 Desktop 验收） |

## 四、边界（照旧）

- `cleanShutdown=true` **只限探针 fibers**；真实 archive/pack/install、完整 Desktop/GUI/HMR/长跑仍需单独验收。
- 探针**不是**端到端注入测试：它验的是 rc1 生命周期契约（effect / disposer / 共享 build / 取消时机）。

## 五、附带结论

T186 的 C 类里另一条 `fix/profile-verify` 也当场核完：主线 `scripts/kifu-profile-stage.mjs` 已 **421 行**
（含 T217 的真 YAML 校验与 T219 的 fail-closed），分支版只有 376 行 ⇒ **该分支已被主线取代**，可删。
