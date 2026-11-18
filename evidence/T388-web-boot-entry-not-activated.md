# T388 · 根因：`ctx.inject(...)` 留下 PENDING 子插件 ⇒ DSH **web boot 整树起不来**

> 2026-11-18 · 用户报「你的插件让我的 dsh 报错」。下面是**宿主自己的崩溃日志**，不是猜的。

## 一、报错原文（`%APPDATA%/@deepseek-ai/dsh-desktop/logs/crash-2026-11-09T19-46-33-220Z-web-boot.log`）

```
phase: startup
app: @deepseek-ai/dsh-desktop 0.2.2-rc.1

--- error ---
Error: web boot: 1 entry did not activate
dsh-gokifu-longmemory: failed
    at .../app.asar/lib/main.js:20648:15
```

同一时刻的插件操作记录里，我们的条目是 `reason: "bundle" · target: "dsh-gokifu-longmemory" · stage: "enable" · version: "0.8.127" · application: "applied"`。

**含义**：宿主在 web 启动阶段统计「没激活的 entry」，**一个就足以让整个 Web GUI 起不来**。
我们的条目就是那一个。

## 二、根因（我们代码里的一行写法）

`src/plugin.mjs` 的 `apply` 里有：

```js
ctx.inject(['tools'],     (host) => { … 注册 kifu_* 工具 … });
ctx.inject(['webServer'], (host) => { … 注册设置页接口 … });
```

Cordis 的 `ctx.inject(deps, cb)` **等价于派生一个等待这些服务的子插件**：

```js
inject(inject, callback) { return this.plugin({ inject, apply: callback, name: callback.name }); }
```

服务不来 ⇒ 子插件永远停在 **PENDING** ⇒ 宿主判它「did not activate」⇒ web boot 直接失败。

- 在 `cli.js` 宿主里（PTC / 设置页服务齐全）看不出问题；
- 到了 **web 侧**（没有 `webServer`，或没有 `tools`）就必然踩中；
- 凭据文件里 `via: "inject"` 就是这条路径留下的指纹。

**我把「注册不上工具」升级成了「启动失败」——后者代价大得多，这是设计错误。**

## 三、修复

| 位置 | 旧 | 新 |
|---|---|---|
| `src/plugin.mjs` tools | `ctx.inject(['tools'], cb)` | 服务此刻在就直接注册；不在就 `via='none'`，**不派生子插件** |
| `src/plugin.mjs` webServer | `ctx.inject(['webServer'], cb)` | `typeof ctx.webServer.register === 'function'` 才注册，否则整段跳过 |
| `src/tools-plugin.mjs`（T375 引入） | 读不到就去 `ctx.inject` 等 | 同样删掉等待路径，如实记 `tools-plugin-none` |

## 四、验证

```
node --test test/t375-tools-deferred.test.mjs → 3/3
  ② 改为钉新契约：**没有 tools 服务时 injectCalls 必须是 0**（不能再留 waiting entry）
node --test "test/*.test.mjs" → 1299 条 / 1293 通过 / 0 失败 / 6 跳过
```

真机 Cordis（rc.2）里直接加载，两种情况都必须 ACTIVE 且**不产生等待子插件**：

```
有 tools+webServer      → state=ACTIVE
无 tools / 无 webServer → state=ACTIVE      ← 修复前靠 ctx.inject 等，服务不来就 PENDING
```

## 五、边界

- 这次修的是**启动期**的失败类；`kifu_*` 工具在读不到 `ctx.tools` 时仍然注册不上（如实记 `via: none`）——
  但**不会再把 DSH 拖到起不来**。
- 崩溃日志里其余几条（`Web authentication failed`、`host exited 134`、模型列表 401）与本插件无关，已在报告里分开列出。
