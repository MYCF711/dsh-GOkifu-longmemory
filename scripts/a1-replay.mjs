import fs from 'node:fs';
const p = 'D:/DeepSeek Harness/home/memory-context/live-stats.jsonl';
const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
const rows = [];
for (const l of lines) { try { const r = JSON.parse(l); if (r.kind === 'pre-step' && r.action === 'inject') rows.push(r); } catch { /* skip */ } }
rows.sort((a, b) => a.at - b.at);
// 口径：同 scope + 同 digest，30 分钟内再次注入 ⇒ 判为"浪费重注"（与 A1.redundant 的 necessary 口径区分）
const WINDOW = 30 * 60 * 1000;
const last = new Map();
let waste = 0, fresh = 0;
let wasteTokens = 0, totalTokens = 0;
for (const r of rows) {
  const key = `${r.scope}|${r.digest}`;
  const tk = Number(r.tokens || 0);
  totalTokens += tk;
  const prev = last.get(key);
  if (prev !== undefined && r.at - prev <= WINDOW) { waste += 1; wasteTokens += tk; }
  else fresh += 1;
  last.set(key, r.at);
}
console.log(JSON.stringify({
  注入总数: rows.length,
  新鲜: fresh,
  浪费重注: waste,
  浪费率: +(waste / rows.length).toFixed(4),
  浪费tokens: wasteTokens,
  总tokens: totalTokens,
  时间窗: '30 分钟内同 scope 同 digest 再注',
  口径: '回放口径（历史 live-stats），非线上实时实测',
}, null, 1));
