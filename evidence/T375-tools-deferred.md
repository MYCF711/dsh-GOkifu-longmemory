# T375 · 工具面两条注册路径：能直连就直连，读不到就 `ctx.inject` 延迟注册

> 2026-11-10 · 起于重启后的一条凭据：`ctxHasRegister: false · count: 0`。

## 一、现象

```
home/memory-context/tools-registered.json（01:55，当前宿主 pid 23364 = Desktop-0.2.2-rc.1）
  via: tools-plugin-none · ctxHasRegister: false · count: 0 · names: []

home-0.2.2-rc.1/memory-context/tools-registered.json（21:35，更早一次启动）
  via: direct · ctxHasRegister: true · count: 6（六个 kifu_* 全在）
```

两个 home 的 `profiles/desktop/cordis.patch.yml` **都挂了 `kifu-tools`**（各 2 处匹配）⇒ 配置不是差异点。

⇒ **`apply` 执行那一刻 `ctx.tools.register` 是否存在，不能假设。**

## 二、宿主的官方写法

同一份宿主的 `@deepseek-ai/dsh-agent-tool-presentation`：

```js
const inject = ["tools"];
function apply(ctx, config) {
  if (config.mode === "native") { ctx.tools.presentAs("native"); return; }
  ctx.inject(["ptcRuntime"], (runtimeCtx) => { runtimeCtx.tools.presentAs(config.mode); });
}
```

对**声明了 `inject` 的服务**直接用；对**可能还没就绪**的服务走 `ctx.inject(deps, cb)` **延迟获取**。

## 三、改法（老路优先，失败才退）

```
① ctx.tools.register 是函数  → 直接注册（**与改动前逐字节一致**：凭据 via 仍是 tools-plugin）
② 不是函数，但宿主给了 ctx.inject → 登记 ['tools'] 回调；服务就绪时再注册，凭据 via: tools-plugin-deferred
③ 两者都没有 → 如实记一条 names:[] 的凭据（不抛、不装成功）
```

两条路径都**不会让已经能用的宿主变差**：能直连就绝不走延迟。

## 四、验收

```
node --test test/t375-tools-deferred.test.mjs → 3/3
  ✔ ① 老路优先：ctx.tools.register 在就直接注册，凭据 via=tools-plugin（口径不变）
  ✔ ② 读不到但给了 ctx.inject ⇒ 真的登记了 ['tools'] 回调；回调拿到工具面后 **7 个工具全注册**
       且凭据写成 via=tools-plugin-deferred / ctxHasRegister=true
  ✔ ③ 两者都没有 ⇒ registered 0、凭据 via=tools-plugin-none、不抛
node --test test/tools-plugin.test.mjs test/tools.test.mjs → 12/12（老契约不动）
node --test "test/*.test.mjs" → 1297 条 / 1291 pass / 0 fail / 6 skip
node scripts/check.mjs        → PASS
```

## 五、诚实边界

- 这条**只有在宿主重启后才会生效**——本会话里 `kifu_*` 仍然不可用。
- 我**没法在重启前验证**它在当前宿主上一定成功；能保证的是：**②这条路走不通时仍然是 ③（如实记 0）**，
  不会比现在更差。
- 验证口径（下次重启后）：

  ```bash
  cat "$DSH_HOME/memory-context/tools-registered.json"
  # 期望：count: 7 · via: tools-plugin 或 tools-plugin-deferred · ctxHasRegister: true
  ```
