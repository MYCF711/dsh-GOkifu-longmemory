// scripts/abstain-effect.mjs —— **只读**：测"精化后的 abstain"在真实考卷上的效果与疑似误杀率。
import fs from 'node:fs';
import { hasReliableHandle } from '../src/rooms/abstain.mjs';

const j = JSON.parse(fs.readFileSync('evidence/a2b-holdout.json', 'utf8'));

let reliable = 0;
let wouldAbstain = 0;
let abstainButRelated = 0;
const examples = [];

for (const x of j.results) {
  if (!hasReliableHandle(x.signal)) continue;
  reliable += 1;
  // 卡上是否有"与信号内容相关"的行（与考卷 contentRelated 同口径）
  const hasRelated = (x.rows || []).some((r) => (r.bigramRaw || 0) >= 2 || (r.overlap || 0) >= 1);
  if (!hasRelated) {
    wouldAbstain += 1;
    // 该局**有** claim（expectedClaimIds > 0）却被判为"不相关" ⇒ **疑似误杀**
    if (x.expectedClaimIds > 0) {
      abstainButRelated += 1;
      examples.push({ id: x.itemId, expect: x.expectedClaimIds, signal: String(x.signal || '').slice(0, 60) });
    }
  }
}

console.log(`判据可靠的题：${reliable} / ${j.results.length}`);
console.log(`会被 abstain 拒掉的：${wouldAbstain}（卡上无 bigramRaw≥2 / overlap≥1 的行）`);
console.log(`**其中"该局有 claim 却被拒"（疑似误杀）：${abstainButRelated}**`);
console.log(`疑似误杀率（在可靠输入上）：${((100 * abstainButRelated) / Math.max(1, wouldAbstain)).toFixed(1)}%`);
console.log('样例：', JSON.stringify(examples.slice(0, 3), null, 1));
