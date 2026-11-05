#!/usr/bin/env node
// T251 · 假阳性处置（dry-run 优先）：把"测试通过汇总"误建的 claim 标成失效。
//
// 背景：`[antipattern] ℹ tests 69 ℹ pass 69 ℹ fail 0` 这类条目**不是失败**，是真 bug 的产物
// （抽取时 `errorSnippet` 抓到了 grep 出来的绿字）。抽取侧已在 `src/rooms/extract.mjs` 修掉
// （`isTestPassSummary` + `dropped.falsePositive`），这里只负责**存量数据**。
//
// 数据纪律（AGENTS.md §2.3 只增不改）：
//   · **不删、不改写**原有字段；
//   · 只加三个键：`state: "invalidated"`、`invalidatedReason: "false-positive:test-pass-summary"`、`supersededBy: null`；
//   · 真库**只读**：默认 dry-run；`--apply` 只允许打在 `tmp/` 下的副本（传 `--store <copy>`，且路径必须含 tmp）。
//
// 用法：
//   node scripts/mark-false-positive.mjs                      # dry-run（真库只读）
//   node scripts/mark-false-positive.mjs --json               # 机器可读
//   node scripts/mark-false-positive.mjs --apply --store tmp/memory-context-copy   # 只许打副本
//
// 退出码：0 诊断完成；2 环境不齐（没有 store）；1 参数被拒（--apply 指到真库）。

import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/rooms/persist.mjs';
import { isTestPassSummary } from '../src/rooms/extract.mjs';

const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const REASON = 'false-positive:test-pass-summary';

function opt(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

/**
 * 找出"测试通过汇总"误建的 claim。
 * @param {Array<object>} claims
 * @returns {{hits:Array, scanned:number, skipped:Array}}
 */
export function findFalsePositives(claims) {
  const hits = [];
  const skipped = [];
  for (const claim of Array.isArray(claims) ? claims : []) {
    if (!claim || typeof claim !== 'object') continue;
    const text = String(claim.text ?? '').trim();
    if (!isTestPassSummary(text)) continue;
    if (claim.state === 'invalidated') {
      skipped.push({ id: claim.id, why: 'already-invalidated' });
      continue;
    }
    hits.push({
      id: claim.id ?? null,
      kind: claim.kind ?? null,
      state: claim.state ?? null,
      text: text.slice(0, 120),
      support: Array.isArray(claim.support) ? claim.support.map((s) => `${s?.episode ?? '?'}#${s?.seq ?? '?'}`) : [],
    });
  }
  return { hits, scanned: Array.isArray(claims) ? claims.length : 0, skipped };
}

/** 真库路径（拒绝 --apply 打上来）。 */
export function isRealStore(storeRoot, home = HOME) {
  const real = path.resolve(home, 'memory-context');
  const target = path.resolve(storeRoot);
  const same = target.toLowerCase() === real.toLowerCase();
  const underTmp = target.split(path.sep).some((seg) => seg.toLowerCase() === 'tmp');
  return { same, underTmp };
}

function main(argv) {
  const storeRoot = path.resolve(opt(argv, 'store', path.join(HOME, 'memory-context')));
  const apply = argv.includes('--apply');
  const json = argv.includes('--json');
  if (!fs.existsSync(storeRoot)) {
    console.error(`没有 store：${storeRoot}`);
    return 2;
  }
  const { same, underTmp } = isRealStore(storeRoot);
  if (apply && (same || !underTmp)) {
    console.error(`拒绝 --apply：${storeRoot} 不是 tmp 副本（真库只读；请先复制到 tmp/ 再打）`);
    return 1;
  }

  const store = createStore({ root: storeRoot });
  const entries = store.list('claims');
  const claims = entries.map((x) => x?.record).filter(Boolean);
  const { hits, scanned, skipped } = findFalsePositives(claims);

  if (json) {
    console.log(JSON.stringify({ storeRoot, apply, scanned, hits, skipped, reason: REASON }, null, 2));
  } else {
    console.log(`假阳性（测试通过汇总）诊断 · store=${storeRoot}${apply ? ' · APPLY' : ' · dry-run'}`);
    console.log(`扫描 claim ${scanned} 条 · 命中 ${hits.length} 条 · 已失效跳过 ${skipped.length} 条`);
    for (const [i, hit] of hits.entries()) {
      console.log(`${String(i + 1).padStart(2)}. ${hit.id} · ${hit.kind}/${hit.state} · ${JSON.stringify(hit.text.slice(0, 60))} · ${hit.support.join(' ')}`);
    }
    if (!hits.length) console.log('（0 条 —— 存量已清理干净）');
  }

  if (apply) {
    for (const entry of entries) {
      const rec = entry?.record;
      if (!hits.some((h) => h.id === rec?.id)) continue;
      // 只增不改：三个键，原有字段一个不动
      store.put('claims', { ...rec, state: 'invalidated', invalidatedReason: REASON, supersededBy: null }, { at: Date.now() });
    }
    console.log(`apply：已标记 ${hits.length} 条（state=invalidated · reason=${REASON} · supersededBy=null）`);
  } else {
    console.log('（dry-run：没有写任何文件。真库处置等口令；--apply 只许打在 tmp/ 副本上）');
  }
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')) : false;
if (invoked || process.argv[1]?.endsWith('mark-false-positive.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
