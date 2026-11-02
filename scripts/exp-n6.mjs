#!/usr/bin/env node
// N6 离线对照（2026-11-03）：机械版"查询扩展"能不能提高 A2b 严格召回？
// 做法：保持其余一切不变，只把信号文本从 item.sig 改成 item.sig + 该 scope 下 df 最高的 K 个主题词。
// 判据：严格召回（specificHits/n）与覆盖（hits/n）都要涨，且 token 不显著增加；任一降 ⇒ N6 否决。
//
// 用法：node scripts/exp-n6.mjs [--top 3] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { signalFromText, buildMemoryCard, PROVENANCE_LINE_RE } from '../src/rooms/inject.mjs';
import { walkFromSignals, createWalkCache } from '../src/rooms/walk.mjs';
import { errorClassKeyOf } from '../src/rooms/topic.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
const storeRoot = path.join(HOME, 'memory-context');
const topK = (() => { const i = process.argv.indexOf('--top'); return i >= 0 ? Number(process.argv[i + 1]) : 3; })();
const json = process.argv.includes('--json');

const store = createStore({ root: storeRoot });
const cache = createWalkCache(store);
const setFile = (() => { const i = process.argv.indexOf('--set'); return i >= 0 ? process.argv[i + 1] : 'a2b-set.json'; })();
const frozen = JSON.parse(fs.readFileSync(path.join(REPO, 'evidence', setFile), 'utf8'));
const splitAt = Date.parse(frozen.createdAt ?? '2026-11-02T11:21:02.636Z');

// 机械扩展词：全库 df 最高的 K 个主题词（topic 记录本身不带 scope，做不到按 scope 取）
const shuffle = process.argv.includes('--shuffle');
const allTopics = store.list('topics')
  .map((x) => x.record)
  .filter((t) => t && typeof t.key === 'string' && t.key.length >= 3 && t.kind !== 'tool')
  .sort((a, b) => (b.df ?? 0) - (a.df ?? 0) || String(a.key).localeCompare(String(b.key)));
const pick = shuffle ? allTopics.slice().sort(() => 0.5 - Math.random()).slice(0, topK) : allTopics.slice(0, topK);
const topTopics = pick.map((t) => String(t.key));

function runOne(item, extend) {
  const scope = item.scopeKey ?? null;
  const baseText = String(item.sig);
  const ext = extend ? ` ${topTopics.join(' ')}` : '';
  const signal = signalFromText(baseText + ext, { at: splitAt });
  signal.scopeKey = scope;
  const cls = errorClassKeyOf(item.sig);
  if (cls) signal.entities.push({ kind: 'error', key: cls });
  const walk = walkFromSignals({ signal, store, scope, cache, depth: 2, limit: 5, budgetTokens: 500 });
  const card = buildMemoryCard({ signal, walkResult: walk, store, scope, limit: 5, budgetTokens: 500 });
  const prior = new Set(item.prior ?? []);
  let hit = false;
  let specific = false;
  for (const row of Array.isArray(card.claims) ? card.claims : []) {
    const id = typeof row?.claimId === 'string' ? row.claimId : null;
    if (!id) continue;
    const record = store.get('claims', id);
    const covered = Array.isArray(record?.support) ? record.support.some((x) => prior.has(String(x?.episode ?? ''))) : false;
    if (!covered) continue;
    hit = true;
    const text = String(record?.text ?? '').toLowerCase();
    const tokens = baseText.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((t) => t.length >= 4 && t !== 'path');
    if (tokens.filter((t) => text.includes(t)).length >= 2) specific = true;
  }
  for (const line of String(card?.section ?? '').split(String.fromCharCode(10))) {
    const m = PROVENANCE_LINE_RE.exec(line);
    if (m && prior.has(m[3])) { hit = true; break; }
  }
  return { hit, specific, tokens: card.tokens ?? 0, lines: (card.section ?? '').split('- [').length - 1 };
}

const rows = frozen.items.map((item) => {
  const base = runOne(item, false);
  const ext = runOne(item, true);
  return { sig: String(item.sig).slice(0, 50), base, ext };
});
const sum = (k, which) => rows.reduce((acc, r) => acc + (r[which][k] ? 1 : 0), 0);
const totalTokens = (which) => rows.reduce((acc, r) => acc + r[which].tokens, 0);
const n = rows.length;
const out = {
  topK,
  set: setFile,
  shuffle,
  n,
  base: { recall: sum('hit', 'base') / n, strict: sum('specific', 'base') / n, tokens: totalTokens('base') },
  ext: { recall: sum('hit', 'ext') / n, strict: sum('specific', 'ext') / n, tokens: totalTokens('ext') },
  changed: rows.filter((r) => r.base.specific !== r.ext.specific || r.base.hit !== r.ext.hit).length,
  changedRows: rows.filter((r) => r.base.specific !== r.ext.specific || r.base.hit !== r.ext.hit),
  topTopics,
};
out.verdict = out.ext.strict > out.base.strict && out.ext.recall >= out.base.recall && out.ext.tokens <= out.base.tokens * 1.1 ? 'keep' : 'reject';
if (json) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`N6 对照（topK=${topK}，n=${n}）`);
  console.log(`基线：覆盖 ${(out.base.recall * 100).toFixed(1)}% · 严格 ${(out.base.strict * 100).toFixed(1)}% · tokens ${out.base.tokens}`);
  console.log(`扩展：覆盖 ${(out.ext.recall * 100).toFixed(1)}% · 严格 ${(out.ext.strict * 100).toFixed(1)}% · tokens ${out.ext.tokens}`);
  console.log(`判定：${out.verdict}（变化条目 ${out.changed}）`);
}
