#!/usr/bin/env node
// T313 · 指标上线门（知识库 70 的 G1–G5 落地；只读）
//
// 为什么：知识库 70 写了"一个数字可不可信"的四条判据（V1 口径完整 / V2 负向对照 / V3 换实现复算 /
// V4 分桶报 worst-bucket）和上线门 G1–G5，但它只是文档 ⇒ 不接进流程 = 没装（知识库 51 / 63 同样的教训）。
//
// 本工具对**每个已登记的指标**逐门检查，缺任何一道 ⇒ 只能「观察」，不许进「验收面」。
// 只读：不写库、不跑归档、不改任何指标实现。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 指标登记表（**唯一真相**：谁想进验收面，就先在这里把五道门的证据补齐）。
 * 空字符串 / null ⇒ 该门缺失。
 */
export const METRICS = Object.freeze([
  {
    id: 'a2bStrict',
    title: 'A2b 严格命中率',
    spec: { numerator: 'holdout 中严格命中的条数', denominator: 'holdout 总数 n', asOf: '每次 metrics-guard 运行时刻', tree: '工作树' },
    negativeControl: 'metrics-guard 里 `--strict` 的反例样本（自比同一批时命中率 100% ⇒ 判据无效）',
    recompute: '', // 没有第二实现复算
    buckets: '',   // 只报 overall
    tombstoneTest: 'test/metrics-guard.test.mjs',
  },
  {
    id: 'mergeRate',
    title: '子代理失败归并率',
    spec: { numerator: '已归并 + 待归并的子局数', denominator: '带失败的子局数（delegationDepth>0 且 failures>0）', asOf: 'subagent-merge --report 运行时刻', tree: '工作树（真库）' },
    negativeControl: 'T296 ②：mergeRate 0.50 ⇒ 必须红',
    recompute: '',
    buckets: 'orphanFailures / crossScopeSkipped 单列（恒等式 分母 = 归并 + orphan + crossScope）',
    tombstoneTest: 'test/patrol.test.mjs',
  },
  {
    id: 'semanticSI',
    title: '语义不变量（SI-1/2/4/5/6）',
    spec: { numerator: '通过的引用条数', denominator: '可判定引用总数', asOf: 'semantic-check 运行时刻', tree: '工作树（真库）' },
    negativeControl: 'T262 ⑤ / T272 ② / T277 ①：改坏必红',
    recompute: '',
    buckets: '按 SI-1/2/4/5/6 分桶计数 + SI-6 偏移分布（众数 delta / 占比）',
    tombstoneTest: 'test/semantic-check.test.mjs',
  },
  {
    id: 'a6AtSeq',
    title: 'A6 文字层 at-seq 率',
    spec: { numerator: 'at-seq 命中条数', denominator: 'refs 总数', asOf: 'audit-card-samples 运行时刻', tree: '工作树（真库）' },
    negativeControl: '',
    recompute: '',
    buckets: 'at-seq / offset / notFound / unreadable 四桶 + 日期一致率',
    tombstoneTest: 'test/audit-card-samples.test.mjs',
  },
]);

const GATES = ['G1', 'G2', 'G3', 'G4', 'G5'];

function specComplete(spec) {
  if (!spec || typeof spec !== 'object') return false;
  return ['numerator', 'denominator', 'asOf', 'tree'].every((k) => typeof spec[k] === 'string' && spec[k].trim() !== '');
}

/**
 * 单指标过门（纯函数；文件存在性由 `fileExists` 注入 ⇒ 可单测）。
 * @returns {{id, gates:Record<string,'pass'|'fail'|'unverified'>, passed:number, missing:string[], verdict:'accept'|'observe'}}
 */
export function evaluateMetric(metric, { fileExists = (p) => fs.existsSync(path.join(REPO, p)) } = {}) {
  const gates = {};
  // G1 口径完整（缺一即红）
  gates.G1 = specComplete(metric?.spec) ? 'pass' : 'fail';
  // G2 负向对照
  gates.G2 = typeof metric?.negativeControl === 'string' && metric.negativeControl.trim() ? 'pass' : 'fail';
  // G3 换实现复算 —— 没有就「未验证」（不判绿也不判红）
  gates.G3 = typeof metric?.recompute === 'string' && metric.recompute.trim() ? 'pass' : 'unverified';
  // G4 分桶（只报 overall ⇒ 红）
  gates.G4 = typeof metric?.buckets === 'string' && metric.buckets.trim() ? 'pass' : 'fail';
  // G5 tombstone 用例
  const t = typeof metric?.tombstoneTest === 'string' ? metric.tombstoneTest.trim() : '';
  gates.G5 = t && fileExists(t) ? 'pass' : 'fail';

  const missing = GATES.filter((g) => gates[g] !== 'pass');
  const passed = GATES.filter((g) => gates[g] === 'pass').length;
  return { id: metric?.id ?? '?', gates, passed, missing, verdict: passed === GATES.length ? 'accept' : 'observe' };
}

export function auditMetrics(metrics = METRICS, opts = {}) {
  return metrics.map((m) => ({ title: m.title, ...evaluateMetric(m, opts) }));
}

export function formatReport(rows) {
  const lines = ['# 指标上线门（G1 口径 · G2 负向对照 · G3 复算 · G4 分桶 · G5 tombstone）', ''];
  lines.push('| 指标 | 过门 | 判定 | 缺哪道 |');
  lines.push('|---|---|---|---|');
  for (const r of rows) {
    const verdict = r.verdict === 'accept' ? '可进验收面' : '**只能观察**';
    const miss = r.missing.length ? r.missing.map((g) => `${g}${r.gates[g] === 'unverified' ? '(未验证)' : ''}`).join('、') : '—';
    lines.push(`| ${r.title ?? r.id} | ${r.passed}/5 | ${verdict} | ${miss} |`);
  }
  const accept = rows.filter((r) => r.verdict === 'accept').length;
  const freq = {};
  for (const r of rows) for (const g of r.missing) freq[g] = (freq[g] ?? 0) + 1;
  const worst = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
  lines.push('', `结论：${accept}/${rows.length} 个指标可进验收面；最普遍的缺口是 ${worst ? `${worst[0]}（${worst[1]} 个指标缺）` : '无'}`);
  return lines.join('\n');
}

export function runCli(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) return { code: 0, stdout: 'node scripts/metric-gate.mjs [--json]' };
  const rows = auditMetrics();
  if (argv.includes('--json')) return { code: rows.some((r) => r.verdict !== 'accept') ? 1 : 0, stdout: JSON.stringify(rows, null, 2) };
  return { code: rows.some((r) => r.verdict !== 'accept') ? 1 : 0, stdout: formatReport(rows) };
}

export function main(argv = process.argv.slice(2)) {
  const res = runCli(argv);
  process.stdout.write(`${res.stdout}\n`);
  return res.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
