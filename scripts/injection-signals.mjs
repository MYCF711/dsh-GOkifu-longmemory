#!/usr/bin/env node
// T265 · 信号面侦查 + 原型（只读）
//
// A · 盘点"注入时刻（agent/pre-step）可得"的信号源：每项标出**在 pre-step 是否真的存在**（带代码位置）。
// B · 原型：把「当前工作区派生词」加进信号（只加已证实 pre-step 可得的），用 a2b 考卷的合法口径量收益。
//
// 用法：
//   node scripts/injection-signals.mjs                 # 打印信号清单
//   node scripts/injection-signals.mjs --measure       # 再跑 A/B 两路严格命中对照（慢）
//   node scripts/injection-signals.mjs --measure --json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { buildMemoryCard, signalFromText } from '../src/rooms/inject.mjs';
import { walkFromSignals, createWalkCache } from '../src/rooms/walk.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/**
 * A · 信号源清单。
 *
 * `availableAtPreStep` 只写**核实过**的：
 *   · `hook`  —— `src/plugin.mjs` 的 `agent/pre-step` 回调参数里能直接拿到；
 *   · `ctx`   —— 通过 `ctx`/session 查询能拿到（同一时刻已存在）；
 *   · `fs`    —— pre-step 时读磁盘（工作区文件）就能拿到，不依赖"事后"信息。
 * 反例（**不能用**）：`hooks.payload` 里没有 assistant 回复；工具结果属于"本步内"，pre-step 时尚未发生。
 */
export const PRE_STEP_SIGNALS = Object.freeze([
  { key: 'scopeKey', availableAtPreStep: true, source: 'hook', where: 'src/plugin.mjs · HOOK = agent/pre-step', note: '当前会话工作区键（w:<path> / u:<user>）' },
  { key: 'sessionId', availableAtPreStep: true, source: 'hook', where: 'src/plugin.mjs · pre-step payload.sessionId', note: '当前会话 id（可关联"上一局"）' },
  { key: 'rootUserText', availableAtPreStep: true, source: 'hook', where: 'src/plugin.mjs · buildSignal 的根用户消息', note: '现状：只用根用户原话（T264 证明仅 20.18% 含实体）' },
  { key: 'recentMessages', availableAtPreStep: true, source: 'ctx', where: 'session 的历史消息（pre-step 时已存在）', note: '能拿到最近 N 条 user/assistant 文本 ⇒ 可抽文件路径与报错' },
  { key: 'workspacePackageName', availableAtPreStep: true, source: 'fs', where: '<workspace>/package.json 的 name', note: '注入时刻读磁盘即可，非事后信息' },
  { key: 'workspaceRepoName', availableAtPreStep: true, source: 'fs', where: '<workspace>/.git/config 的 remote url', note: '同上' },
  { key: 'recentFilesMtime', availableAtPreStep: true, source: 'fs', where: '<workspace> 下最近修改的文件名', note: '同上（注意成本：只扫 1 层）' },
  { key: 'activeFile', availableAtPreStep: false, source: 'host', where: '宿主未在 pre-step payload 暴露', note: '没有这个字段 ⇒ 不能用' },
  { key: 'diagnostics', availableAtPreStep: false, source: 'host', where: '宿主未在 pre-step payload 暴露', note: '不能用' },
  { key: 'thisStepToolResult', availableAtPreStep: false, source: 'host', where: '本步的工具结果在 pre-step 时尚未发生', note: '事后信息 ⇒ 禁止' },
]);

/** pre-step 合法可得的那些（原型只能用这些）。 */
export const USABLE_SIGNALS = Object.freeze(PRE_STEP_SIGNALS.filter((s) => s.availableAtPreStep).map((s) => s.key));

/** 从 scopeKey（w:<path>）解出工作区路径。 */
export function workspaceOfScope(scopeKey) {
  const s = String(scopeKey ?? '');
  if (!s.startsWith('w:')) return null;
  const raw = s.slice(2).trim();
  if (!raw) return null;
  // scopeKey 是"小写盘符 + 正斜杠"（R00 口径）；这里只做路径重建，不改大小写语义
  return raw;
}

/**
 * B · 工作区派生词（**只用 pre-step 可得的信号**：scopeKey 路径 + 可选的 package.json name）。
 * 产出：项目名、仓库名、路径末段 —— 都是"确定性词"，不猜语义。
 */
export function workspaceTokens(scopeKey, { readPackageName = null } = {}) {
  const ws = workspaceOfScope(scopeKey);
  if (!ws) return [];
  const parts = String(ws).split(/[\\/]+/).filter(Boolean);
  const out = [];
  const last = parts[parts.length - 1];
  if (last) out.push(last);
  if (parts.length >= 2) out.push(parts.slice(-2).join('/'));
  const pkg = typeof readPackageName === 'function' ? readPackageName(ws) : null;
  if (pkg) out.push(String(pkg));
  return [...new Set(out.filter((t) => typeof t === 'string' && t.length >= 3))];
}

/** 在 base signal 上追加工作区词（不改 base 的词，只加）。 */
export function withWorkspaceSignal(baseSignal, scopeKey, opts = {}) {
  const extra = workspaceTokens(scopeKey, opts);
  const signal = { ...baseSignal };
  signal.terms = [...(Array.isArray(baseSignal?.terms) ? baseSignal.terms : []), ...extra];
  signal.workspaceTokens = extra;
  return signal;
}

/**
 * B · 在 a2b 考卷（n=108）上量两种口径：
 *   A = 现状（只用考卷给的 signal）
 *   B = A + 工作区派生词（pre-step 可得）
 * 严格命中 = claim 文本与签名 ≥2 个判别词重合（与 runHoldout 同口径，这里复刻其判定以便加信号）。
 */
export async function measureModes({ store, exam, limit = 5, budgetTokens = 500, now = null, withWorkspace = true } = {}) {
  const cache = createWalkCache(store);
  const items = Array.isArray(exam?.results) ? exam.results : [];
  const at = Number.isFinite(now) ? now : Date.now();
  const run = (useWorkspace) => {
    let strict = 0;
    let related = 0;
    let n = 0;
    for (const item of items) {
      const base = signalFromText(String(item.signal ?? ''), { at });
      base.scopeKey = item.scopeKey ?? null;
      const signal = useWorkspace ? withWorkspaceSignal(base, item.scopeKey) : base;
      const walk = walkFromSignals({ signal, store, scope: item.scopeKey ?? null, cache, depth: 2, limit, budgetTokens });
      const card = buildMemoryCard({ signal, walkResult: walk, store, scope: item.scopeKey ?? null, now: at, limit, budgetTokens });
      n += 1;
      const text = (card?.claims ?? []).map((c) => String(c.text ?? '').toLowerCase()).join('\n');
      const tokens = String(item.signal ?? '').toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((t) => t.length >= 4 && t !== 'path');
      const overlap = tokens.filter((t) => text.includes(t)).length;
      if (overlap >= 2) strict += 1;
      if (overlap >= 1) related += 1;
    }
    return { n, strict, strictRate: n ? strict / n : null, related, relatedRate: n ? related / n : null };
  };
  const a = run(false);
  const b = withWorkspace ? run(true) : a;
  return { A: a, B: b, signals: USABLE_SIGNALS };
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--measure')) {
    for (const s of PRE_STEP_SIGNALS) {
      console.log(`${s.availableAtPreStep ? '✅' : '❌'} ${s.key} · ${s.source} · ${s.where} —— ${s.note}`);
    }
    return 0;
  }
  const home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
  const store = createStore({ root: path.join(home, 'memory-context') });
  const examPath = path.join(REPO, 'evidence', 'a2b-holdout.json');
  const exam = fs.existsSync(examPath) ? JSON.parse(fs.readFileSync(examPath, 'utf8')) : null;
  if (!exam) { console.error(`缺考卷：${examPath}`); return 2; }
  return measureModes({ store, exam }).then((out) => {
    if (argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
    else {
      const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : 'n/a');
      console.log(`A（现状） 严格 ${out.A.strict}/${out.A.n} = ${pct(out.A.strictRate)} · 宽松 ${pct(out.A.relatedRate)}`);
      console.log(`B（+工作区词）严格 ${out.B.strict}/${out.B.n} = ${pct(out.B.strictRate)} · 宽松 ${pct(out.B.relatedRate)}`);
      console.log(`差：严格 ${out.B.strict - out.A.strict} 条 · 宽松 ${out.B.related - out.A.related} 条`);
    }
    return 0;
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  Promise.resolve(main()).then((code) => { process.exitCode = code ?? 0; }).catch((e) => { console.error(String(e?.stack ?? e)); process.exitCode = 2; });
}
