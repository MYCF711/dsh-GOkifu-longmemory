# 工具面注册的负面结论（2026-11-04 22:00）

## 事实

重启后凭据文件出现了，但内容是**否定**的：

```json
{ "at": 1793800560236, "names": [], "count": 0, "host": "dsh", "via": "none", "ctxHasRegister": false }
```

- `ctxHasRegister: false` —— 插件拿到的 `ctx` **没有** `ctx.tools.register`；
- `via: "none"` —— 连 `ctx.inject(['tools'], …)` 那条路也没走通（`ctx.inject` 同样不可用）；
- `names: []` —— 五个 `kifu_*` 工具**一个都没注册进宿主**。

也就是说：`src/tools.mjs` 的实现与单测都是对的（直接调用工具体可用、测试全绿），
但**宿主没把工具服务交给这个插件**，所以它们不会出现在工具面里。

## 为什么会这样（宿主侧的线索）

DSH 的实现里，插件要拿到工具服务需要**在模块上声明依赖**：

```
export const inject = ['tools']   // 宿主文档原文的写法
export const Config = …
```

我们只在 `apply()` 里**运行时**去摸 `ctx.tools` / `ctx.inject`，没有在模块上声明 `inject`，
于是 `ctx` 是一个不含该服务的受限上下文（宿主里有专门的报错提到 "sandbox ctx does not expose …；
Available: ctx.tools.register / ctx.on / ctx.provide / the timer helpers **after injecting timer**,
and any service you declared in inject"）。

## 为什么没直接加上 `export const inject = ['tools']`

Cordis 的 `inject` 数组是**必需依赖**语义：服务不存在时插件**不会加载**（不是降级）。
本插件的首要职责是自动注入记忆（A3 已经在线上跑着）；一旦 `tools` 服务在这个宿主里不可用，
加这行就等于**把记忆注入整个停掉**。这个代价不可接受，所以没有盲改。

## 可用的能力没受影响（重要）

PTC / `run_code` 里**现在就能用**的是 SDK 这一层，不需要任何注册：

```js
import { createMemorySdk } from '<repo>/src/sdk.mjs';
const sdk = createMemorySdk({ scope: 'w:d:/…' });
sdk.recentFailures({ limit: 20 });
```

它是纯进程内调用（只读 sidecar），已实测能返回真实数据。

## 下一步（两选一，都不动现在能用的东西）

1. **独立小插件**：把工具注册拆成 `src/tools-plugin.mjs`，由它单独声明 `export const inject = ['tools']`。
   服务不存在时**只有它**不加载，记忆插件照常跑。代价：要在 profile 里加一条条目（改配置要重启）。
2. **验证 `optional` 形态**：若宿主支持 `export const inject = { optional: ['tools'] }`，可加在主插件上，
   服务缺失时插件照常加载、工具自动缺席。需要先确认宿主确实支持该形态（本机实现里没搜到确证）。

倾向 1：风险被隔离在"工具插件没加载"这一格，最坏结果等于今天。
