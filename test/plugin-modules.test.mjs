// 重构 C 期（M1 组合根单一化）的结构墓碑：把「拆完之后的形状」钉住，谁把它改回去就红。
//
// 钉四件事：
//   ① **依赖图无环**：`plugin → hooks → lifecycle → cache`，下层谁也不许 import 上层（尤其不许 import 组合根）。
//      拆分的目的是让"改哪层读哪层"成立；一旦有人为了图快在 cache.mjs 里 import 一下 plugin.mjs，
//      依赖图重新变成一团，这次拆分就白做了。
//   ② **三个新模块真的在**：删掉 `src/hooks.mjs` / `src/lifecycle.mjs` / `src/cache.mjs` 任一 ⇒ 本文件红
//      （tombstone：import 本身就炸，不需要额外的断言）。
//   ③ **出口垫片逐项相等**：`src/plugin.mjs` 的 named 导出面与拆分前**逐字相同**（63 项，冻结清单）。
//      宿主、脚本与别的测试只认这一层 —— 少一项就是"上游静默少读"。
//   ④ **组合根行数预算**：plugin.mjs ≤ 600 行（超了说明又把业务搬回入口了）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as plugin from '../src/plugin.mjs';
// ② tombstone：下面三条 import 少任何一个模块都会整片红。
import * as hooks from '../src/hooks.mjs';
import * as lifecycle from '../src/lifecycle.mjs';
import * as cache from '../src/cache.mjs';

const sourceOf = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const IMPORT_RE = /^\s*import\b[\s\S]*?from\s+'([^']+)';/gm;

/** 某个文件里所有相对 import 的目标（只取 `./x.mjs` 形态）。 */
function relativeImports(rel) {
  const src = sourceOf(rel);
  const out = new Set();
  for (const m of src.matchAll(IMPORT_RE)) out.add(m[1]);
  // 动态 import（`const { x } = await import('./rooms/inject.mjs')`）也算依赖
  for (const m of src.matchAll(/await import\('([^']+)'\)/g)) out.add(m[1]);
  return out;
}

// ---------------------------------------------------------------------------
// ① 依赖图无环（单向：plugin → hooks → lifecycle → cache）
// ---------------------------------------------------------------------------

test('C-M1 ①: 依赖方向单向 —— cache 是叶子，谁也不许 import 上层', () => {
  const cacheImports = relativeImports('src/cache.mjs');
  for (const forbidden of ['./hooks.mjs', './lifecycle.mjs', './plugin.mjs']) {
    assert.equal(cacheImports.has(forbidden), false, `cache.mjs 不许 import ${forbidden}（会成环）`);
  }
  const lifecycleImports = relativeImports('src/lifecycle.mjs');
  for (const forbidden of ['./hooks.mjs', './plugin.mjs']) {
    assert.equal(lifecycleImports.has(forbidden), false, `lifecycle.mjs 不许 import ${forbidden}（会成环）`);
  }
  const hooksImports = relativeImports('src/hooks.mjs');
  assert.equal(hooksImports.has('./plugin.mjs'), false, 'hooks.mjs 不许 import 组合根（环；组合根把 telemetry 注入进来）');
  // 反向：组合根必须真的把四层接起来（少了就不是组合根了）
  const pluginImports = relativeImports('src/plugin.mjs');
  for (const required of ['./hooks.mjs', './lifecycle.mjs', './cache.mjs']) {
    assert.equal(pluginImports.has(required), true, `plugin.mjs 必须 import ${required}（组合根）`);
  }
});

test('C-M1 ①: 依赖图是 DAG —— 四层之间不存在双向 import', () => {
  const files = ['src/plugin.mjs', 'src/hooks.mjs', 'src/lifecycle.mjs', 'src/cache.mjs'];
  const edges = new Map(files.map((f) => [f, [...relativeImports(f)]]));
  const nameOf = (dep) => (dep.startsWith('./') ? `src/${dep.slice(2)}` : null);
  for (const [from, deps] of edges) {
    for (const dep of deps) {
      const to = nameOf(dep);
      if (!to || !edges.has(to)) continue;
      const back = (edges.get(to) ?? []).filter((d) => nameOf(d) === from);
      assert.equal(back.length, 0, `${from} → ${to} 存在回边 ${to} → ${from}（成环）`);
    }
  }
});

// ---------------------------------------------------------------------------
// ② 三个新模块的接缝（删模块 ⇒ import 就炸）
// ---------------------------------------------------------------------------

test('C-M1 ②: hooks.mjs 交出事件绑定接口（createPreStepHandler / createTurnStoppingHandler）', () => {
  assert.equal(typeof hooks.createPreStepHandler, 'function');
  assert.equal(typeof hooks.createTurnStoppingHandler, 'function');
  // 钩子名只有一份（组合根从这里转出去）
  assert.equal(hooks.HOOK, plugin.HOOK);
  assert.equal(hooks.name, plugin.name);
});

test('C-M1 ②: lifecycle.mjs 交出运行时与 dispose 语义（createPluginRuntime / scheduleAutoBuild / 配置工厂）', () => {
  assert.equal(typeof lifecycle.createPluginRuntime, 'function');
  assert.equal(typeof lifecycle.scheduleAutoBuild, 'function');
  assert.equal(typeof lifecycle.createConfigApi, 'function', '配置逻辑以工厂交出（默认值表由组合根注入）');
  // 配置逻辑与默认值表**同一份**：工厂用入口传来的表，组合根导出的 sanitizeConfig 认那张表
  assert.equal(plugin.resolveConfig({}).enabled, plugin.DEFAULT_CONFIG.enabled);
  assert.equal(plugin.resolveConfig({}).pointerTier, plugin.DEFAULT_CONFIG.pointerTier);
});

test('C-M1 ②: 默认值表逐字留在组合根（m5 A3 用源扫描读它 —— 判据不许松）', () => {
  const src = sourceOf('src/plugin.mjs');
  assert.match(src, /export const DEFAULT_CONFIG = Object\.freeze\(\{/, 'DEFAULT_CONFIG 必须定义在 src/plugin.mjs（m5-report 的 readPluginFacts 源扫描）');
  assert.ok(src.includes('enabled: true'), '零配置默认开启（2026-11-02 裁定）必须写在表里');
  assert.ok(src.includes('shadow: false'), '影子模式默认关必须写在表里');
  // 逻辑不在入口（否则入口又会重新变胖）：sanitizeConfig 的实现只在 lifecycle.mjs
  assert.equal(/function sanitizeConfig\(/.test(src), false, 'sanitizeConfig 的实现应留在 lifecycle.mjs 的配置工厂里');
});

test('C-M1 ②: cache.mjs 交出缓存面（walk cache / bundle 读取 / 探针缓存），且常量只有一份', () => {
  assert.equal(typeof cache.walkCacheFor, 'function');
  assert.equal(typeof cache.openReadStore, 'function');
  assert.equal(typeof cache.walkCacheEntries, 'function');
  assert.equal(cache.WALK_CACHE_IDLE_MS, plugin.WALK_CACHE_IDLE_MS, 'WALK_CACHE_IDLE_MS 必须是同一份值');
  assert.equal(cache.SESSION_MAP_MAX, plugin.SESSION_MAP_MAX);
});

// ---------------------------------------------------------------------------
// ③ 出口垫片：原导出面逐项相等（冻结清单 = 拆分前实测的 63 项）
// ---------------------------------------------------------------------------

const NAMED_SURFACE = Object.freeze([
  'CARD_SAMPLE_CAP_BYTES', 'CARD_SAMPLE_SIGNAL_LIMIT', 'CARD_SOURCE_FORM', 'CARD_SOURCE_KIND',
  'CONFIG_ROUTE', 'Config', 'DEFAULT_CONFIG', 'HOOK', 'LIVE_STATS_CAP_BYTES', 'LLM_PACKAGE',
  'MESSAGE_CORPUS_CAP_BYTES', 'MESSAGE_CORPUS_PATH', 'MESSAGE_ENTITY_PATTERNS', 'MESSAGE_TEXT_LIMIT',
  'PLUGIN_VERSION', 'SESSION_MAP_MAX', 'USER_CONFIG_FILE', 'WALK_CACHE_IDLE_MS', 'WARMUP_MAX_EPISODES',
  'WARMUP_MAX_LINKS', 'appendCardSample', 'appendLiveStats', 'appendMessageCorpus', 'apply',
  'cardAlreadyInContext', 'cardSampleSignal', 'cardText', 'classifyAbstainReason', 'collectRepeatTrigger',
  'digestOf', 'enforceStoreRoot', 'gateClaimIdsFromGates', 'gateCodesFromGates', 'gateIdsFromGates',
  'handleConfigRoute', 'insertAfterClaimed', 'lastResolvedScope', 'lastUserText', 'makeUserMessageFallback',
  'messageCorpusPath', 'messageCorpusRow', 'messageEntities', 'messageText', 'name', 'probeCacheSize',
  'probeCardValidity', 'readUserConfig', 'redactForCorpus', 'resolveConfig', 'resolveSessionScope',
  'sanitizeConfig', 'sessionIdOf', 'sessionLogScope', 'sessionScopeIndex', 'signalFromMessages',
  'storeStatsOf', 'traceCardSampleCap', 'traceLiveStatsCap', 'traceMessageCorpusCap', 'walkCacheEntries',
  'walkCacheSize', 'writeRepeatTelemetry', 'writeUserConfig',
]);

test('C-M1 ③: named 导出面与拆分前逐项相等（63 项，不多不少）', () => {
  const actual = Object.keys(plugin).filter((k) => k !== 'default').sort();
  assert.deepEqual(actual, [...NAMED_SURFACE].sort(), '导出面变了 ⇒ 宿主/脚本/别的测试会静默少读');
});

test('C-M1 ③: default 导出面逐项相等（宿主用的就是这一份，26 项）', () => {
  const expected = [
    'CARD_SAMPLE_CAP_BYTES', 'CARD_SAMPLE_SIGNAL_LIMIT', 'CARD_SOURCE_FORM', 'CARD_SOURCE_KIND',
    'DEFAULT_CONFIG', 'HOOK', 'LIVE_STATS_CAP_BYTES', 'LLM_PACKAGE', 'MESSAGE_CORPUS_CAP_BYTES',
    'PLUGIN_VERSION', 'appendCardSample', 'appendLiveStats', 'appendMessageCorpus', 'apply',
    'cardSampleSignal', 'cardText', 'digestOf', 'insertAfterClaimed', 'lastUserText', 'messageText',
    'name', 'sanitizeConfig', 'sessionIdOf', 'traceCardSampleCap', 'traceLiveStatsCap',
    'traceMessageCorpusCap',
  ];
  assert.deepEqual(Object.keys(plugin.default).sort(), [...expected].sort(), 'default 导出面变了');
  assert.equal(typeof plugin.default.apply, 'function');
});

// ---------------------------------------------------------------------------
// ④ 组合根行数预算
// ---------------------------------------------------------------------------

test('C-M1 ④: plugin.mjs 仍是组合根 —— 行数 ≤ 600（超了说明业务又搬回入口了）', () => {
  const lines = sourceOf('src/plugin.mjs').split('\n').length - 1; // 末尾换行不计数
  assert.ok(lines <= 600, `plugin.mjs 现在 ${lines} 行（预算 600）`);
  // 三个新模块必须真的承担了重量（不是把空壳挪出去）
  assert.ok(sourceOf('src/hooks.mjs').split('\n').length > 300, 'hooks.mjs 太薄：事件绑定与决策流水线应当在这里');
  assert.ok(sourceOf('src/lifecycle.mjs').split('\n').length > 300, 'lifecycle.mjs 太薄：运行时/dispose/autoBuild 应当在这里');
  assert.ok(sourceOf('src/cache.mjs').split('\n').length > 100, 'cache.mjs 太薄：缓存与读取面应当在这里');
});
