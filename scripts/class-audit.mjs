#!/usr/bin/env node
// R00 诊断（只读）：类级 claim 覆盖审计 —— 「若允许对历史 claim 做一次受控重算，会多出多少类级章节」
//
// 只读 store；不写盘、不改 claim。输出每个 class:* 的：
//   claims —— 现有单条 claim 数（kind=antipattern 且 errorKeyOf(text) 命中该类）
//   episodes —— 这些 claim 覆盖的去重局数
//   mergedExists —— 是否已存在该类级 claim（text 以 class:<name> 开头）
//   potential —— 若把这些合并成一条，会得到的一条类级 claim 能覆盖的局数（去重）
//
// 用法：node scripts/class-audit.mjs [--store <dir>] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { errorKeyOf } from '../src/rooms/claim.mjs';

const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--store') { flags.store = argv[i + 1]; i += 1; }
  }
  return flags;
}

export function classAudit({ storeRoot } = {}) {
  const store = createStore({ root: storeRoot });
  const claims = store.list('claims').map((r) => r.record);
  const groups = new Map();
  for (const claim of claims) {
    const key = errorKeyOf(String(claim?.text ?? ''));
    if (!String(key).startsWith('class:')) continue;
    const name = key.slice('class:'.length);
    const g = groups.get(name) ?? { name, claims: [], episodes: new Set(), mergedExists: false };
    if (String(claim.text).startsWith(`class:${name} · `)) g.mergedExists = true;
    else g.claims.push(claim.id);
    for (const s of Array.isArray(claim.support) ? claim.support : []) {
      if (s?.episode) g.episodes.add(String(s.episode));
    }
    groups.set(name, g);
  }
  const rows = [...groups.values()]
    .map((g) => ({ class: g.name, claims: g.claims.length, episodes: g.episodes.size, mergedExists: g.mergedExists, potential: g.episodes.size }))
    .sort((a, b) => b.episodes - a.episodes || a.class.localeCompare(b.class));
  return {
    storeRoot,
    totals: {
      classes: rows.length,
      merged: rows.filter((r) => r.mergedExists).length,
      missingMerged: rows.filter((r) => !r.mergedExists).length,
      claimsThatWouldFold: rows.filter((r) => !r.mergedExists).reduce((a, r) => a + r.claims, 0),
      episodesCovered: rows.filter((r) => !r.mergedExists).reduce((a, r) => a + r.episodes, 0),
    },
    rows,
  };
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const flags = parseArgs(process.argv.slice(2));
  const storeRoot = path.resolve(flags.store ?? path.join(HOME, 'memory-context'));
  if (!fs.existsSync(storeRoot)) {
    console.error(`记忆库不存在：${storeRoot}`);
    process.exit(2);
  }
  const out = classAudit({ storeRoot });
  if (flags.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`类级 claim 覆盖审计（只读）：${storeRoot}`);
    console.log(`类 ${out.totals.classes} 个 · 已有类级 claim ${out.totals.merged} · 缺 ${out.totals.missingMerged}`);
    console.log(`若做一次受控重算：可折叠单条 claim ${out.totals.claimsThatWouldFold} 条，覆盖 ${out.totals.episodesCovered} 局（去重）`);
    for (const r of out.rows.slice(0, 12)) {
      console.log(`- ${r.class} · 单条 ${r.claims} · 局 ${r.episodes} · 类级 ${r.mergedExists ? '已有' : '缺'}`);
    }
  }
}
