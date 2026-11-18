// 棋院 · 工具面**独立插件**（PTC / run_code）。
//
// 为什么要单独一个插件文件：
//   主插件 `src/plugin.mjs` 的首要职责是自动注入记忆，它在线上跑着。宿主只把 `tools` 服务交给
//   **在模块上声明了 `inject` 的插件**（见 `evidence/M8-tools-registration-negative.md` 的实测：
//   主插件运行时摸 `ctx.tools` 拿到的是 `undefined`）。
//   而 Cordis 的 `inject` 是**必需依赖**语义 —— 服务不存在时插件不加载。
//   所以把它拆出来：服务缺失时**只有这个插件不加载**，记忆注入完全不受影响。
//
// 它做什么：把 `kifu_*` 五个**只读**工具注册进宿主（能力全部来自 `src/sdk.mjs`）。
// 它不做什么：不写记忆、不改注入、不碰压缩与系统提示词。
import { registerMemoryTools, recordToolRegistration } from './tools.mjs';
import { createMemorySdk } from './sdk.mjs';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-gokifu-longmemory-tools';

/** 宿主工具服务。缺了它本插件不加载（主插件照常跑）。 */
export const inject = ['tools'];

export function storeRootOf() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : '';
  return home ? path.resolve(home, 'memory-context') : null;
}

export function apply(ctx, config = {}) {
  const storeRoot = storeRootOf();
  const dshHome = storeRoot ? path.dirname(storeRoot) : null;
  const warn = (c, line) => {
    try { c?.logger?.warn?.(`dsh-gokifu-longmemory-tools: ${line}`); } catch { /* 日志失败不影响注册 */ }
  };
  const createSdk = (opts) => createMemorySdk({ ...opts, dshHome: opts?.dshHome || dshHome || null });

  const record = (names, scope, { via } = {}) => {
    if (!storeRoot || !fs.existsSync(storeRoot)) return;
    recordToolRegistration(storeRoot, names, {
      host: 'dsh',
      via: via ?? (names.length ? 'tools-plugin' : 'tools-plugin-none'),
      ctxHasRegister: typeof scope?.tools?.register === 'function',
    });
  };

  // T375（2026-11-10）：**两条注册路径**。
  //
  // 真事：重启到 `Desktop-0.2.2-rc.1`（pid 23364）后，凭据写成
  //   `via: tools-plugin-none · ctxHasRegister: false · count: 0`
  // 而同一天更早一次启动（另一个 home）写的是 `count: 6 · ctxHasRegister: true`。
  // 说明「apply 那一刻 ctx.tools 是否已就绪」与宿主/加载顺序有关，不能假设它一定在。
  //
  // 宿主自己的官方插件（`@deepseek-ai/dsh-agent-tool-presentation`）用的是**延迟获取**：
  //   `ctx.inject(['tools'], (runtimeCtx) => runtimeCtx.tools… )`
  // 所以这里先走老路（直接读，行为与之前逐字节一致）；读不到再登记一次 `inject`，
  // 等服务就绪时再注册。**两条路径都不会让已经能用的宿主变差**（能直接读就绝不走延迟）。
  const directNames = typeof ctx?.tools?.register === 'function'
    ? registerMemoryTools(ctx, { createSdk, warn })
    : null;
  if (directNames) {
    record(directNames, ctx);
    return { name, registered: directNames.length, via: 'tools-plugin' };
  }

  // T388（2026-11-18）：**不再用 `ctx.inject(['tools'], …)` 等一个可能永远不来的服务**。
  //
  // 同一个事故：`web boot: 1 entry did not activate / dsh-gokifu-longmemory: failed`。
  // `ctx.inject(deps, cb)` 会派生一个等待该服务的子插件；服务不来它就永远 PENDING，
  // 宿主在 web 启动时按「未激活 entry」处理 ⇒ 整个 Web GUI 起不来。
  // T375 原本想靠这条修「读不到 ctx.tools」，但它把「注册不上」升级成了「启动失败」——代价大得多。
  // 现在：服务此刻在就已经在上面直接注册过；不在就如实记 none，绝不留等待中的子插件。
  const servicePresent = Boolean(ctx && typeof ctx === 'object' && ctx.tools !== undefined);
  if (servicePresent) warn(ctx, 'tools 服务存在但没有 register（宿主接口变了）');

  // 最后：如实记一条"没拿到工具面"的凭据（`names: []` 本身就是证据）
  record([], ctx);
  return { name, registered: 0 };
}

export default { name, inject, apply };
