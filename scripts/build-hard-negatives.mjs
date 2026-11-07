// scripts/build-hard-negatives.mjs —— 从标注集里整理"难负例"（只读标注集，写一个新文件）。
import fs from 'node:fs';

const j = JSON.parse(fs.readFileSync('evidence/label-set.json', 'utf8'));

const confirmed = [
  {
    pairId: 5,
    bigramRaw: 2,
    note: '信号=看token额度；claim=Error: glob search failed。**有词重合(bigramRaw=2)但内容无关** —— 判据误判为相关，是典型难负例。',
  },
];

const candidates = j.pairs
  .filter((p) => (p.bigramRaw || 0) >= 2)
  .map((p) => ({ pairId: p.pairId, bigramRaw: p.bigramRaw, overlap: p.overlap, status: '待标注' }));

const out = {
  note: '难负例 = **有表面重合（bigramRaw≥2）但内容无关**的对（DPR 的 BM25 negatives）。**不是**"来自别的 scope"的随机负例（那些太容易，判据不会犯错）。',
  confirmed,
  candidatesCount: candidates.length,
  candidates: candidates.slice(0, 50),
  method: '从这些 bigramRaw≥2 的候选里，**人工判"不相关"**的，就是难负例 —— 它们骗过了判据。',
};

fs.writeFileSync('evidence/label-hard-negatives.json', JSON.stringify(out, null, 1));
console.log('已确认难负例:', confirmed.length, '（pair 5）');
console.log('待标注候选（bigramRaw≥2）:', candidates.length);
