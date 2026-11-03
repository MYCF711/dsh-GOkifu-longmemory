#!/usr/bin/env node
// 注入卡片抽查（M4，2026-11-04）：读 <store>/card-samples.jsonl，逐条核对
// 卡片里每个 (ep, seq) 是否真的存在于该局的可回溯范围内（A6 的线上抽查）。
// 只读，不写库。用法：node scripts/audit-card-samples.mjs [--store <dir>] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/rooms/persist.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const storeRoot = path.resolve(opt('store', path.join(HOME, 'memory-context')));
const file = path.join(storeRoot, 'card-samples.jsonl');
if (!fs.existsSync(file)) { console.error(`没有抽样文件：${file}`); process.exit(2); }

const store = createStore({ root: storeRoot });
const episodes = new Map(store.list('episodes').map((x) => [x.record.id, x.record]));
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const PROV = /\((ep-[0-9a-f]{8}),\s*([^,]+),\s*seq\s*(\d+)\)/g;
const verdicts = [];
for (const row of rows) {
  const section = String(row.section ?? '');
  const refs = [...section.matchAll(PROV)].map((m) => ({ episode: m[1], date: m[2].trim(), seq: Number(m[3]) }));
  const checked = refs.map((r) => {
    const ep = episodes.get(r.episode);
    const inRange = ep ? r.seq >= (ep.closure?.seqFrom ?? 0) && r.seq <= (ep.closure?.seqTo ?? 0) : false;
    const sameScope = ep ? ep.scopeKey === row.scope : false;
    return { ...r, exists: Boolean(ep), inRange, sameScope };
  });
  verdicts.push({
    at: row.at, digest: row.digest, tokens: row.tokens, scope: row.scope,
    refs: refs.length,
    ok: checked.filter((c) => c.exists && c.inRange).length,
    sameScope: checked.filter((c) => c.sameScope).length,
    bad: checked.filter((c) => !c.exists || !c.inRange).slice(0, 3),
  });
}
const totalRefs = verdicts.reduce((n, v) => n + v.refs, 0);
const okRefs = verdicts.reduce((n, v) => n + v.ok, 0);
const sameScopeRefs = verdicts.reduce((n, v) => n + v.sameScope, 0);
const out = {
  samples: verdicts.length,
  refs: totalRefs,
  okRefs,
  traceableRate: totalRefs ? okRefs / totalRefs : null,
  sameScopeRefs,
  crossScopeRefs: totalRefs - sameScopeRefs,
  details: verdicts,
};
if (argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`样本 ${out.samples} 张 · 引用 ${out.refs} 条 · 可回溯 ${out.okRefs}（${(out.traceableRate * 100).toFixed(1)}%）· 同作用域 ${out.sameScopeRefs} · 跨作用域 ${out.crossScopeRefs}`);
  for (const v of verdicts) console.log(`- ${new Date(v.at).toLocaleString()} ${String(v.scope).slice(-24)} tokens=${v.tokens} refs=${v.refs} ok=${v.ok}`);
}
process.exit(out.traceableRate === 1 ? 0 : 1);
