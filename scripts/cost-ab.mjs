#!/usr/bin/env node
// T337 · cost 同分次序的 A/B 对照 —— 主判据是否因「镜像线上传 costIndex」而改变？
//
// 背景（T335 隐患）：0.2.75 的「主判据不再掉」是因为 cost 从未接线（costIndex 没传 ⇒ cost 恒 null），
// 那是**假的不掉**。T336 把 sidecar 填出 110 条非零 cost 后，必须**真接线再测**，才能区分
// 「真的不损害」与「没接线所以不掉」。本脚本就是那把尺。
//
// 契约：
//   · 只读（store.list + 读冻结考卷 + 读 sidecar）；不写库、不改 claim、零模型调用。
//   · 同一批冻结考卷（`evidence/a2b-holdout.json` 的 results，114 题）、同一份库、同一份代码，
//     唯一变量 = 传不传 costIndex（镜像 `src/plugin.mjs` 的 decidePreStep）。
//   · 输出：主判据 strictRate 的 A/B + 逐题 hitStrict 翻转清单（变好/变坏/净）。
//
// 用法：node scripts/cost-ab.mjs [--exam evidence/a2b-holdout.json] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { replayFrozen, defaultHome } from './a2b-holdout.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const opt = (argv, n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

function main(argv = process.argv.slice(2)) {
  const home = defaultHome();
  const storeRoot = path.join(home, 'memory-context');
  const store = createStore({ root: storeRoot });
  const examPath = path.resolve(REPO_ROOT, opt(argv, 'exam', 'evidence/a2b-holdout.json'));
  const exam = JSON.parse(fs.readFileSync(examPath, 'utf8'));

  // 镜像 plugin.mjs：从 sidecar 读 costIndex（缺失 ⇒ null ⇒ 不过滤）
  let costIndex = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(storeRoot, 'corpus', 'antipattern-cost.json'), 'utf8'));
    if (raw?.costs && typeof raw.costs === 'object') costIndex = new Map(Object.entries(raw.costs));
  } catch { costIndex = null; }
  const nz = costIndex ? [...costIndex.values()].filter((v) => v > 0).length : 0;

  const a = replayFrozen({ store, exam, costIndex: null });   // 旧行为（不传）
  const b = replayFrozen({ store, exam, costIndex });          // 镜像线上（传）

  const aMap = new Map(a.rows.map((r) => [r.itemId, r.hitStrict]));
  const flips = [];
  for (const r of b.rows) {
    const av = aMap.get(r.itemId);
    if (av !== r.hitStrict) flips.push({ id: r.itemId, kind: r.kind, from: av, to: r.hitStrict });
  }
  const improved = flips.filter((f) => f.to).length;
  const regressed = flips.filter((f) => !f.to).length;

  const out = {
    costIndexSize: costIndex ? costIndex.size : 0,
    costIndexNonZero: nz,
    n: a.n,
    a: { strictHits: a.strictHits, strictRate: a.strictRate, hashMismatch: a.hashMismatch.length },
    b: { strictHits: b.strictHits, strictRate: b.strictRate, hashMismatch: b.hashMismatch.length },
    deltaPp: (b.strictRate != null && a.strictRate != null) ? (b.strictRate - a.strictRate) * 100 : null,
    flips: { improved, regressed, net: improved - regressed, list: flips },
  };
  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return 0; }

  const pct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(2) + '%');
  console.log(`costIndex: ${out.costIndexSize} 条（非零 ${nz}）· 考卷 ${a.n} 题（冻结重放）`);
  console.log('');
  console.log('主判据（严格命中）：');
  console.log(`  A 不传 costIndex : ${a.strictHits}/${a.n} = ${pct(a.strictRate)}`);
  console.log(`  B 传 costIndex   : ${b.strictHits}/${b.n} = ${pct(b.strictRate)}  （镜像线上）`);
  console.log(`  Δ = ${out.deltaPp == null ? 'n/a' : out.deltaPp.toFixed(2) + 'pp'} · hashMismatch A=${a.hashMismatch.length} B=${b.hashMismatch.length}`);
  console.log('');
  console.log(`逐题翻转：变好 ${improved} · 变坏 ${regressed} · 净 ${improved - regressed}`);
  for (const f of flips.slice(0, 20)) console.log(`  ${f.to ? '↑' : '↓'} ${f.id} (${f.kind}) ${f.from}→${f.to}`);
  return 0;
}

try { process.exitCode = main(); } catch (error) { console.error(`cost-ab 失败：${String(error?.message ?? error)}`); process.exitCode = 2; }
