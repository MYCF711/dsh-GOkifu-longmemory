// kifu-loader：把棋院插件换个包名挂进 profile。
//
// 起因（2026-11-03）：cordis.patch.yml 里有两块历史遗留的 `disabled: true`（`dsh-gokifu-longmemory`），
// 那两块会让同名包被禁用；**改包名**不需要动热重载开关，重启即生效。
//
// 2026-11-06（T283）修复：原来这里是
//     export * from '../../src/plugin.mjs';
// 这种**相对导入**只在"仓库内"成立；包一旦被实体化到独立 home 的 `node_modules` / profile 目录，
// `../../src/plugin.mjs` 就指向不存在的路径，**加载即炸**（实测：
// `ERR_MODULE_NOT_FOUND: Cannot find module '<USER_HOME>\AppData\Local\src\plugin.mjs'`）。
//
// 现在：**本文件自包含**（不 import 任何相对路径），核心插件在 `apply()` 里**惰性解析**：
//   ① 环境变量 `KIFU_CORE_PATH`（独立 home / 调试）
//   ② 包名 `dsh-gokifu-longmemory/plugin`（安装成依赖时走 `exports` 的 `./plugin`）
//   ③ 包名 `dsh-gokifu-longmemory`
//   ④ 仓库内相对路径 `../../src/plugin.mjs`
// 解析不到时**抛明确错误**，而不是在模块加载期炸掉整棵插件树。
//
// 宿主（Cordis）只需要 `name` / `inject` / `apply`；其余导出请直接从 `dsh-gokifu-longmemory` 取。

export const name = 'dsh-gokifu-longmemory-tools';

/** 宿主工具服务。缺了它本插件不加载（主插件照常跑）。 */
export const inject = ['tools'];

/** 核心插件的候选来源（按优先级）。 */
export function coreCandidates() {
  const out = [];
  const fromEnv = typeof process.env.KIFU_CORE_PATH === 'string' ? process.env.KIFU_CORE_PATH.trim() : '';
  if (fromEnv) out.push(fromEnv);
  out.push('dsh-gokifu-longmemory/plugin');
  out.push('dsh-gokifu-longmemory');
  out.push('../../src/plugin.mjs');
  return out;
}

/** 惰性解析核心插件模块；全部候选都失败时抛带候选清单的错误。 */
export async function loadCore() {
  const tried = [];
  for (const spec of coreCandidates()) {
    try {
      const mod = await import(spec);
      if (mod && typeof mod.apply === 'function') return { mod, spec };
      tried.push(`${spec}（模块存在但没有 apply）`);
    } catch (error) {
      tried.push(`${spec}（${String(error?.code ?? error?.message ?? error).split('\n')[0]}）`);
    }
  }
  throw new Error(`kifu-loader: 解析不到核心插件（试过 ${tried.join(' · ')}）；请安装 dsh-gokifu-longmemory 或设置 KIFU_CORE_PATH`);
}

/**
 * Cordis 4.1 入口：把 `tools` 服务交给核心插件，并原样转发其 effect/disposer。
 * 诊断信息不走 apply 返回值；普通对象会被 Cordis 拒绝，函数型清理能力必须保留。
 */
export async function apply(ctx, config = {}) {
  const { mod } = await loadCore();
  return mod.apply(ctx, config);
}

export default { name, inject, apply };
