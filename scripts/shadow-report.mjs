#!/usr/bin/env node
// 影子台账复盘：把 evidence/shadow/shadow.jsonl 读成一份可核对的统计（零模型、只读）。
// 用途：安装后跑 1–2 天，回答"本来会注入多少、多长、哪些信号被命中"。
import { readShadow } from '../src/rooms/inject.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const dir = opt('dir', 'evidence/shadow');
const read = readShadow({ dir });
if (read.missing) {
  console.error(`影子台账不存在：${read.path}（先按 docs/安装指南.md 开 shadow 并跑一天）`);
  process.exit(2);
}
const records = read.records;
const withSection = records.filter((r) => r?.card && typeof r.card.section === 'string' && r.card.section.trim() !== '');
const tokens = withSection.map((r) => (Number.isFinite(r.card.tokens) ? r.card.tokens : 0)).sort((a, b) => a - b);
const p = (q) => (tokens.length ? tokens[Math.min(tokens.length - 1, Math.floor(q * tokens.length))] : null);
const seeds = new Map();
for (const r of records) {
  const sig = r?.signal ?? {};
  const text = String(sig.text ?? (Array.isArray(sig.terms) ? sig.terms.join(' ') : '')).slice(0, 40);
  if (!text) continue;
  seeds.set(text, (seeds.get(text) ?? 0) + 1);
}
const allTokens = records.map((r) => (Number.isFinite(r?.card?.tokens) ? r.card.tokens : 0)).sort((a, b) => a - b);
const silentTokens = records.filter((r) => !(typeof r?.card?.section === 'string' && r.card.section.trim() !== '')).map((r) => (Number.isFinite(r?.card?.tokens) ? r.card.tokens : 0));
const report = {
  dir: read.path,
  records: records.length,
  parsed: read.parsed,
  badLines: read.badLines ?? 0,
  wouldInject: withSection.length,
  silent: records.length - withSection.length,
  silentRate: records.length ? Number(((records.length - withSection.length) / records.length).toFixed(4)) : null,
  tokens: { n: tokens.length, p50: p(0.5), p90: p(0.9), max: tokens[tokens.length - 1] ?? null },
  tokensAll: { n: allTokens.length, p50: allTokens[Math.floor(allTokens.length * 0.5)] ?? null, max: allTokens[allTokens.length - 1] ?? null },
  silentIndexOnlyTokens: silentTokens.length ? silentTokens[0] : null,
  topSignals: [...seeds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  claimsPerCard: withSection.length
    ? withSection.reduce((n, r) => n + (Array.isArray(r.card.claims) ? r.card.claims.length : 0), 0) / withSection.length
    : null,
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = 0;
