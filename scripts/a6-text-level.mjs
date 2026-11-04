#!/usr/bin/env node
// A6 文字级可核 · 离线重抽（2026-11-04，audit-11 之后新增）
//
// 为什么单独一支：`audit-card-samples.mjs` 读的是**线上留样**（`card-samples.jsonl`），宿主不重启就一直是旧代码产的卡；
// 而审"改完的代码产出什么卡"必须当场重算。本档用与注入**同一条链**（walk → buildMemoryCard → runGates，
// 复用 `scripts/m5-report.mjs` 的 `runPipeline`）为当前库现造卡片，再用 `audit-card-samples.mjs` 的
// 文字级判据（at-seq / elsewhere / missing + 日期）逐条核。
//
// 判据同一份、实现同一份 ⇒ 两处读数可比：一个说"线上过去是什么"，一个说"现在的代码会产出什么"。
//
// 用法：node scripts/a6-text-level.mjs [--store <dir>] [--cards N] [--window N] [--json]
// 退出码：0 全部 at-seq 且日期一致；1 有 elsewhere/missing/日期不符；2 环境不齐。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { buildSignalTexts, runPipeline } from './m5-report.mjs';
import { auditRows, makeLogLoader } from './audit-card-samples.mjs';

const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';

export async function runA6TextLevel({ storeRoot, workspace = process.cwd(), cards = 24, window = 10, now = Date.now() } = {}) {
  const root = path.resolve(storeRoot ?? path.join(HOME, 'memory-context'));
  const store = createStore({ root });
  const episodes = new Map(store.list('episodes').map((x) => [x.record.id, x.record]));
  if (!episodes.size) return { error: 'no-store', storeRoot: root };

  const texts = buildSignalTexts(store, cards);
  const pipeline = runPipeline({ store, workspace, texts, runs: cards, now });
  const rows = pipeline.cards
    .map((item) => ({ at: now, digest: null, tokens: item.card?.tokens ?? null, scope: pipeline.scope, section: item.card?.section ?? null }))
    .filter((r) => typeof r.section === 'string' && r.section);

  const res = await auditRows({ rows, episodes, loadEvents: makeLogLoader({ home: HOME }), window, textCheck: true });
  return { storeRoot: root, scope: pipeline.scope, cardsBuilt: pipeline.cards.length, rows: rows.length, ...res };
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const json = argv.includes('--json');
  const cards = Number(opt('cards', '24'));
  const window = Number(opt('window', '10'));
  const res = await runA6TextLevel({ storeRoot: opt('store', undefined), workspace: opt('workspace', process.cwd()), cards, window });
  if (res.error) { console.error(`a6-text-level: ${res.error}（${res.storeRoot}）`); process.exit(2); }
  if (json) console.log(JSON.stringify(res, null, 2));
  else {
    const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
    console.log(`A6 文字级可核（离线重抽 · 0.118.0 之后代码）`);
    console.log(`库：${res.storeRoot}`);
    console.log(`作用域：${res.scope} · 造卡 ${res.rows} 张 · window=±${res.window}`);
    console.log(`引用 ${res.refs} 条：at-seq ${res.textAtSeq}（${pct(res.textAtSeq, res.refs)}）· elsewhere ${res.textElsewhere} · missing ${res.textMissing}`);
    console.log(`日期一致 ${res.dateOk}/${res.refs}（${pct(res.dateOk, res.refs)}）· 跨作用域 ${res.crossScopeRefs}（引用层可回溯 ${pct(res.okRefs, res.refs)}）`);
    console.log(res.exitCode === 0 ? '判据：PASS（每条引用都落在它标注的位置上）' : '判据：FAIL（有引用不在它标注的位置上）');
  }
  process.exit(res.exitCode ?? 1);
}
