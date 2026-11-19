#!/usr/bin/env node
// T383：A4 的**相对基线**工具（D7 选项③的地基，不改任何判据）。
//
// 为什么需要它：语料每天都在长（现在 13212 主题 / 29293 links / 5396 claims），
// 绝对阈值 50ms 抓到的往往是"数据变多"，而不是"代码变慢"。
// 真正要防的是：**同一语料规模下，比上次更慢**。
//
// 用法：
//   node scripts/a4-baseline.mjs --write     # 采样 3 批 × 9 次，写入 evidence/a4-baseline.json
//   node scripts/a4-baseline.mjs             # 与基线比较（同时打印语料指纹，语料变了要说明）
//
// 判读：语料指纹一致时，median 上升 >20% 才值得当成回归；语料变了就不做绝对比较，只看趋势。
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const OUT = path.join(REPO, 'evidence/a4-baseline.json');

const { createStore } = await import('../src/rooms/persist.mjs');
const { runPipeline } = await import('./m5-report.mjs');

const root = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'memory-context') : path.join(REPO, 'tmp/memory-context');
const workspace = 'D:/DeepSeek Harness/default-workspace/长期记忆系统';
const texts = ['扫描隐私 头部 没找到', '上下文压缩 阈值', 'AssertionError 失败', '缓存 失效 判据'];

function corpusFingerprint(storeRoot) {
  const counts = {};
  for (const kind of ['episodes', 'links', 'claims', 'topics']) {
    try { counts[kind] = fs.readdirSync(path.join(storeRoot, kind)).filter((n) => n.endsWith('.json')).length; } catch { counts[kind] = null; }
  }
  return counts;
}

const store = createStore({ root, bundle: true });
const fp = corpusFingerprint(root);
const samples = [];
for (let batch = 0; batch < 3; batch += 1) {
  const r = runPipeline({ store, workspace, texts, runs: 9, now: Date.now() });
  const t = (r.times ?? []).slice().sort((a, b) => a - b);
  samples.push({ median: +t[Math.floor(t.length / 2)].toFixed(2), min: +t[0].toFixed(2), max: +t[t.length - 1].toFixed(2) });
}
const medians = samples.map((s) => s.median).sort((a, b) => a - b);
const summary = {
  at: new Date().toISOString(),
  corpus: fp,
  samples,
  medianOfMedians: +medians[Math.floor(medians.length / 2)].toFixed(2),
};

if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n');
  console.log(`baseline 已写：medianOfMedians=${summary.medianOfMedians}ms · 语料 ${JSON.stringify(fp)}`);
} else {
  let base = null;
  try { base = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* 没有基线 */ }
  console.log(`本次：medianOfMedians=${summary.medianOfMedians}ms · 语料 ${JSON.stringify(fp)}`);
  if (!base) {
    console.log('没有基线（先跑 --write）');
  } else {
    const sameCorpus = JSON.stringify(base.corpus) === JSON.stringify(fp);
    const delta = ((summary.medianOfMedians - base.medianOfMedians) / base.medianOfMedians) * 100;
    console.log(`基线：${base.medianOfMedians}ms（${base.at}）· 语料 ${sameCorpus ? '**一致**' : '已变化（不做绝对比较）'}`);
    console.log(`变化：${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%（判据：语料一致时 >+20% 才算回归）`);
  }
}
