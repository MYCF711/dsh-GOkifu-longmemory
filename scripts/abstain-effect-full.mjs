// scripts/abstain-effect-full.mjs —— **只读**：精化 + 跨语言修复后，abstain 在整个考卷上的效果。
import fs from 'node:fs';
import path from 'node:path';
import { hasReliableHandle, isCrossLingualFailureMatch } from '../src/rooms/abstain.mjs';

const home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
const claimsDir = path.join(home, 'memory-context', 'claims');

function claimText(id) {
  const p = path.join(claimsDir, `${id}.json`);
  if (!fs.existsSync(p)) return '';
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).text || ''; } catch { return ''; }
}

const j = JSON.parse(fs.readFileSync('evidence/a2b-holdout.json', 'utf8'));

let reliable = 0;
const rejected = [];

for (const x of j.results) {
  if (!hasReliableHandle(x.signal)) continue;
  reliable += 1;
  const rows = x.rows || [];
  // 卡上是否有"与信号相关"的行：词重合 ≥2 / 硬实体 ≥1 / **跨语言失败匹配**
  const hasRelated = rows.some((r) => (r.bigramRaw || 0) >= 2 || (r.overlap || 0) >= 1)
    || rows.some((r) => isCrossLingualFailureMatch(x.signal, claimText(r.claimId)));
  if (!hasRelated) {
    rejected.push({
      id: x.itemId,
      expect: x.expectedClaimIds,
      signal: String(x.signal || '').slice(0, 60),
      claimTexts: rows.slice(0, 2).map((r) => claimText(r.claimId).slice(0, 80)),
    });
  }
}

console.log(`判据可靠的题：${reliable} / ${j.results.length}`);
console.log(`精化 + 跨语言修复后，会被 abstain 拒掉的：${rejected.length}`);
console.log('');
for (const r of rejected) {
  console.log(`--- ${r.id}（期望 ${r.expect} 条）`);
  console.log(`    信号：${r.signal}`);
  for (const t of r.claimTexts) console.log(`    卡上：${t}`);
}
