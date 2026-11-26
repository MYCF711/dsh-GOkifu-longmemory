// 单一常量表守卫（task-9 / P0-4）
//
// 本文件钉住两件事，缺一个就红：
//   ① **同一个常量对象**：`scripts/metrics-guard.mjs` 与 `scripts/ledger-check.mjs` 读到的 A4 门槛
//      必须是 `src/rooms/limits.mjs` 的同一份（`===`，不是"数值碰巧相等"）。事故背景：两处各写一份 50，
//      D7 只改一半 ⇒ 0.8.160 / 0.8.161 连续两次发版被同一个门槛拦下。
//   ② **值一个都没动**：搬家只允许改位置，不允许顺手调值（快照式断言，逐项写死迁移前的数）。
//
// 另外两条结构性守卫：
//   ③ 消费方源码里不许再出现"数值字面量定义"（`A4_GATE_MS = 50` 这类），只允许引用常量；
//   ④ `limits.mjs` 自身零 import / 零 fs —— 这样 R11 walk 的"没有 fs 句柄就写不了盘"仍然成立。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as limits from '../src/rooms/limits.mjs';
import * as metricsGuard from '../scripts/metrics-guard.mjs';
import * as ledgerCheck from '../scripts/ledger-check.mjs';
import * as inject from '../src/rooms/inject.mjs';
import * as walk from '../src/rooms/walk.mjs';
import * as link from '../src/rooms/link.mjs';
import { gateCodesFromGates, gateClaimIdsFromGates } from '../src/plugin.mjs';

const sourceOf = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const LIMITS_SOURCE = sourceOf('src/rooms/limits.mjs');
const METRICS_SOURCE = sourceOf('scripts/metrics-guard.mjs');
const LEDGER_SOURCE = sourceOf('scripts/ledger-check.mjs');

// ---------------------------------------------------------------------------
// ① 同一常量对象（事故本体）
// ---------------------------------------------------------------------------

test('P0-4: metrics-guard 与 ledger-check 的 A4 门槛是**同一个** limits 常量对象', () => {
  // 两边重导出的必须是**同一引用**（不是各自 new 一个等值对象）
  assert.equal(metricsGuard.LIMITS, limits.LIMITS, 'metrics-guard 必须重导出 limits.LIMITS 本体');
  assert.equal(ledgerCheck.LIMITS, limits.LIMITS, 'ledger-check 必须重导出 limits.LIMITS 本体');
  // 冻结：谁都不能在运行时把它改掉（改值只能改 limits.mjs 并走测试）
  assert.equal(Object.isFrozen(limits.LIMITS), true);
});

test('P0-4: 从两条路径读到的 A4 p50 门槛 === limits.A4_P50_MAX_MS === 50', () => {
  const fromGuard = metricsGuard.LIMITS.a4P50MaxMs;
  const fromLedger = ledgerCheck.A4_GATE_MS;
  assert.equal(fromGuard, fromLedger, 'metrics-guard 与 ledger-check 读到不同的 A4 门槛 ⇒ 又出现两份拷贝了');
  assert.equal(fromGuard, limits.A4_P50_MAX_MS);
  assert.equal(fromGuard, 50, 'A4 门槛必须还是 50ms（这次只搬家，不许调值）');
  // 量级容差同样只允许一份
  assert.equal(ledgerCheck.A4_REL_SLACK, limits.A4_REL_SLACK);
  assert.equal(ledgerCheck.A4_ABS_SLACK_MS, limits.A4_ABS_SLACK_MS);
  // 判据函数默认参数必须落到同一个数（T225 的量级判据：limit = max(实测×2, 实测+20ms)）
  // 14ms < 门槛 ⇒ 不走相对基线分支，结果与环境（有没有 evidence/a4-baseline.json）无关，可稳定断言。
  const within = ledgerCheck.a4MagnitudeOk(21.5, 14);
  assert.equal(within.ok, true, '量级内应放行');
  assert.equal(within.limit, 34, `limit 必须 = max(14×${limits.A4_REL_SLACK}, 14+${limits.A4_ABS_SLACK_MS})`);
  assert.equal(ledgerCheck.a4MagnitudeOk(100, 14).ok, false, '台账落后到量级不同 ⇒ 仍要红');
  // 默认 gateMs 不传也必须来自共享常量：把常量改大/改小只可能在 limits.mjs 里发生
  assert.equal(ledgerCheck.a4MagnitudeOk(60, 14).limit, 34, '不传 gateMs 时也要按共享容差算');
});

// ---------------------------------------------------------------------------
// ② 快照：值一个都没改
// ---------------------------------------------------------------------------

const EXPECTED_LIMITS = Object.freeze({
  // A 轴门槛
  a1Max: 0.05,
  a1OppositeMax: 0.05,
  a1RedundantWasteMax: 0.01,
  a5Max: 0,
  a6Min: 1,
  a4P50MaxMs: 50,
  a4RelSlack: 2,
  a4AbsSlackMs: 20,
  // 注入预算
  entryLimit: 5,
  budgetTokens: 500,
  indexLineBudget: 60,
  textClip: 160,
  tightClip: 60,
  pointerSupportLimit: 1,
  // 检索
  walkMaxDepth: 2,
  walkDefaultLimit: 5,
  walkDefaultBudgetTokens: 500,
  walkMaxTopics: 8,
  walkMaxHops: 40,
  // 相关边
  maxLinksPerEpisode: 16,
  // 可观测性
  digestGateCodesLimit: 5,
});

test('P0-4: 常量表快照 —— 键与值逐项等于迁移前的实测值（只搬家，不许调值）', () => {
  assert.deepEqual(Object.keys(limits.LIMITS).sort(), Object.keys(EXPECTED_LIMITS).sort(), '键集合变了：新增/删除常量必须同时改快照');
  for (const [key, want] of Object.entries(EXPECTED_LIMITS)) {
    assert.equal(limits.LIMITS[key], want, `LIMITS.${key} 变了（期望 ${want}）—— 这次任务是"只搬家"，改值必须另开一刀并说明`);
  }
  // 标量导出与表内键必须一致（免得"表里一个值、导出另一个值"这种新坑）
  assert.equal(limits.A4_P50_MAX_MS, limits.LIMITS.a4P50MaxMs);
  assert.equal(limits.ENTRY_LIMIT, limits.LIMITS.entryLimit);
  assert.equal(limits.BUDGET_TOKENS, limits.LIMITS.budgetTokens);
  assert.equal(limits.WALK_MAX_DEPTH, limits.LIMITS.walkMaxDepth);
  assert.equal(limits.MAX_LINKS_PER_EPISODE, limits.LIMITS.maxLinksPerEpisode);
  assert.equal(limits.DIGEST_GATE_CODES_LIMIT, limits.LIMITS.digestGateCodesLimit);
});

test('P0-4: 四个消费方读到的是同一份值（注入 / 检索 / 连带 / 心跳摘要）', () => {
  // R12 inject：导出面不变，值来自 limits
  assert.equal(inject.ENTRY_LIMIT, 5);
  assert.equal(inject.BUDGET_TOKENS, 500);
  assert.equal(inject.ENTRY_LIMIT, limits.ENTRY_LIMIT);
  assert.equal(inject.BUDGET_TOKENS, limits.BUDGET_TOKENS);
  assert.equal(inject.INDEX_LINE_BUDGET, limits.INDEX_LINE_BUDGET);
  assert.equal(inject.TEXT_CLIP, limits.TEXT_CLIP);
  assert.equal(inject.TIGHT_CLIP, limits.TIGHT_CLIP);
  assert.equal(inject.POINTER_SUPPORT_LIMIT, limits.POINTER_SUPPORT_LIMIT);
  // R11 walk：深度/条数/预算（walk 的默认值 = 注入侧同一契约）
  assert.deepEqual(walk.WALK_DEFAULTS, { depth: 2, limit: 5, budgetTokens: 500, maxTopics: 8, maxHops: 40 });
  assert.equal(walk.MAX_DEPTH, limits.WALK_MAX_DEPTH);
  assert.equal(walk.WALK_DEFAULTS.limit, limits.WALK_DEFAULT_LIMIT);
  assert.equal(walk.WALK_DEFAULTS.budgetTokens, limits.WALK_DEFAULT_BUDGET_TOKENS);
  // R05 link：每局边数上限
  assert.equal(link.DEFAULT_LINK_OPTIONS.maxLinksPerEpisode, 16);
  assert.equal(link.DEFAULT_LINK_OPTIONS.maxLinksPerEpisode, limits.MAX_LINKS_PER_EPISODE);
  // 插件心跳摘要：两个函数默认参数 + warn 行原本各写一份 5
  const gates = { errors: Array.from({ length: 9 }, (_, i) => ({ code: `E${i}`, detail: { ids: [`c-${i}`] } })) };
  assert.equal(gateCodesFromGates(gates).length, limits.DIGEST_GATE_CODES_LIMIT);
  assert.equal(gateClaimIdsFromGates(gates).length, limits.DIGEST_GATE_CODES_LIMIT);
});

// ---------------------------------------------------------------------------
// ③ 消费方源码里不许再有"数值字面量定义"
// ---------------------------------------------------------------------------

test('P0-4: metrics-guard / ledger-check 源码里不再有门槛数值字面量', () => {
  // 旧名字 + 数值字面量 = 又出现一份拷贝（这正是事故形态）
  assert.equal(/a4p50MaxMs\s*[:=]\s*\d/.test(METRICS_SOURCE), false, 'metrics-guard 里又写了 a4 门槛数值');
  assert.equal(/A4_GATE_MS\s*=\s*\d/.test(LEDGER_SOURCE), false, 'ledger-check 里又写了 A4 门槛数值（应 `= A4_P50_MAX_MS`）');
  assert.equal(/A4_ABS_SLACK_MS\s*=\s*\d/.test(LEDGER_SOURCE), false, 'ledge-check 里又写了 A4 绝对容差数值');
  // 反过来：唯一权威表里必须真的有这几个数（不许"两边都不写了"）
  assert.equal(/A4_P50_MAX_MS\s*=\s*50\b/.test(LIMITS_SOURCE), true, 'limits.mjs 必须定义 A4_P50_MAX_MS = 50');
});

test('P0-4: inject / walk / link 源码里不再有同值字面量（只引用常量）', () => {
  const injectSource = sourceOf('src/rooms/inject.mjs');
  const walkSource = sourceOf('src/rooms/walk.mjs');
  const linkSource = sourceOf('src/rooms/link.mjs');
  assert.equal(/ENTRY_LIMIT\s*=\s*5\b/.test(injectSource), false, 'inject.mjs 又自己写了 ENTRY_LIMIT = 5');
  assert.equal(/BUDGET_TOKENS\s*=\s*500\b/.test(injectSource), false, 'inject.mjs 又自己写了 BUDGET_TOKENS = 500');
  assert.equal(/MAX_DEPTH\s*=\s*2\b/.test(walkSource), false, 'walk.mjs 又自己写了 MAX_DEPTH = 2');
  assert.equal(/maxLinksPerEpisode:\s*\d/.test(linkSource), false, 'link.mjs 又自己写了每局边数上限');
  // plugin 的两处默认参数是任务里点名的重复点
  const pluginSource = sourceOf('src/plugin.mjs');
  assert.equal(/FromGates\(gates,\s*limit\s*=\s*\d/.test(pluginSource), false, 'plugin.mjs 的 gate* 函数又写了 limit = 数字');
});

// ---------------------------------------------------------------------------
// ④ limits.mjs 自身的"零 I/O"性质（walk 只读结构保证的传递依赖）
// ---------------------------------------------------------------------------

test('P0-4: limits.mjs 零 import / 零 fs / 全冻结（R11 只读保证成立）', () => {
  assert.equal(/^\s*import\b/m.test(LIMITS_SOURCE), false, 'limits.mjs 不许 import 任何模块（否则 walk 的零 I/O 结构不再成立）');
  assert.equal(/require\s*\(/.test(LIMITS_SOURCE), false, 'limits.mjs 不许 require');
  assert.equal(/node:fs|from 'fs'|readFileSync|writeFileSync|existsSync/.test(LIMITS_SOURCE), false, 'limits.mjs 不许碰文件系统');
  // walk 的唯一 import 必须指向它（与 test/walk.test.mjs 的只读结构用例互为交叉验证）
  const walkSource = sourceOf('src/rooms/walk.mjs');
  const imports = walkSource.match(/^\s*import\b/gm) ?? [];
  assert.equal(imports.length, 1, 'walk.mjs 只允许 import 一张零 I/O 常量表');
  assert.match(walkSource, /from '\.\/limits\.mjs';/, 'walk.mjs 的唯一 import 必须是 ./limits.mjs');
});

test('P0-4: 常量表里每类数值都写了上游对应值（Graphiti / LlamaIndex 至少各一处）', () => {
  // 不做逐项正则（会让注释变成考试题），只钉住"上游依据这段没被删掉"这个事实
  assert.match(LIMITS_SOURCE, /Graphiti/, 'limits.mjs 必须保留上游对应（Graphiti 集中常量）');
  assert.match(LIMITS_SOURCE, /LlamaIndex/, 'limits.mjs 必须保留上游对应（LlamaIndex token_limit）');
  assert.match(LIMITS_SOURCE, /MAX_SEARCH_DEPTH/, 'walk 深度的上游对应值（Graphiti MAX_SEARCH_DEPTH）必须写在表里');
  assert.match(LIMITS_SOURCE, /DEFAULT_TOKEN_LIMIT/, '预算的上游对应值（LlamaIndex DEFAULT_TOKEN_LIMIT）必须写在表里');
});