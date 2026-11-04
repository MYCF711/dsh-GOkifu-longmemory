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
  const names = registerMemoryTools(ctx, { createSdk, warn });
  // 凭据：无论成没成都写（`names: []` 就是"宿主没给工具面"的证据）。
  if (storeRoot && fs.existsSync(storeRoot)) {
    recordToolRegistration(storeRoot, names, {
      host: 'dsh',
      via: names.length ? 'tools-plugin' : 'tools-plugin-none',
      ctxHasRegister: typeof ctx?.tools?.register === 'function',
    });
  }
  return { name, registered: names.length };
}

export default { name, inject, apply };
