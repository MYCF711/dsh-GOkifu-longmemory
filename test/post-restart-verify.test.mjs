// T42 · `scripts/post-restart-verify.mjs` 的判据单测（全部纯函数；不碰线上数据）
//
// 口径优先级：机械可核 > 好看。样本不足一律 NO-SAMPLE，不允许被算成 PASS。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  compareVersions,
  parseInstanceStatus,
  judgeNewCode,
  judgeAbstainReasons,
  judgeSignalPreview,
  judgeDuplicateInjections,
  judgeRecoveryTail,
  judgeCapConstants,
  judgeA1ThreeAxes,
  summarize,
  pickCurrentPid,
  T24_SCOPE_DUP_BASELINE,
  EXPECTED_CAP_BYTES,
} from '../scripts/post-restart-verify.mjs';

const P = 'PASS';
const F = 'FAIL';
const N = 'NO-SAMPLE';

test('T42 ①: compareVersions 按数字段比较（不按字符串）', () => {
  assert.equal(compareVersions('0.8.76', '0.8.65'), 1);
  assert.equal(compareVersions('0.8.65', '0.8.65'), 0);
  assert.equal(compareVersions('0.8.9', '0.8.76'), -1, '按字符串比较会遇到 0.8.9 > 0.8.76 的假象');
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.9', '0.9.0'), 0);
  assert.equal(compareVersions('', '0.1.0'), -1);
});

test('T42 ①: parseInstanceStatus 读出包版本/软链状态', () => {
  const text = [
    'OK    工作区        D:\\ws\\kifu',
    'OK    包版本        dsh-gokifu-longmemory@0.8.76',
    'FAIL  软链         → D:\\other（不是本工作区）',
  ].join('\n');
  const out = parseInstanceStatus(text);
  assert.equal(out.version, '0.8.76');
  assert.equal(out.versionOk, true);
  assert.equal(out.linkOk, false);
});

test('T42 ①: 新代码已加载 = 版本到位 + 软链 OK + 宿主首心跳晚于发版时点（否则 FAIL）', () => {
  const inst = 'OK    包版本        x@0.8.76\nOK    软链         → 本工作区';
  const fresh = judgeNewCode({ instanceText: inst, localVersion: '0.8.76', hostFirstAt: 2000, releaseAt: 1000 });
  assert.equal(fresh.status, P);
  const stale = judgeNewCode({ instanceText: inst, localVersion: '0.8.76', hostFirstAt: 1000, releaseAt: 2000 });
  assert.equal(stale.status, F, '宿主启动早于发版 ⇒ 跑的还是旧进程');
  assert.match(stale.evidence, /仍是旧进程/);
  const lower = judgeNewCode({ instanceText: 'OK    包版本        x@0.8.65\nOK    软链         → 本工作区', localVersion: '0.8.76', hostFirstAt: 2000, releaseAt: 1000 });
  assert.equal(lower.status, F);
  const noLink = judgeNewCode({ instanceText: 'OK    包版本        x@0.8.76\nFAIL  软链         → 别处', localVersion: '0.8.76', hostFirstAt: 2000, releaseAt: 1000 });
  assert.equal(noLink.status, F);
  const noBeat = judgeNewCode({ instanceText: inst, localVersion: '0.8.76', hostFirstAt: null, releaseAt: 1000 });
  assert.equal(noBeat.status, N, '没有心跳就不能判「在跑新代码」');
});

test('T42 ②: T12 —— abstain 全塌 cross-scope 才 FAIL；没样本 NO-SAMPLE', () => {
  assert.equal(judgeAbstainReasons([]).status, N);
  const all = judgeAbstainReasons([{ reason: 'cross-scope' }, { reason: 'cross-scope' }]);
  assert.equal(all.status, F);
  assert.match(all.evidence, /cross-scope=2/);
  const mixed = judgeAbstainReasons([{ reason: 'cross-scope' }, { reason: 'no-relevant-claim' }]);
  assert.equal(mixed.status, P);
  assert.match(mixed.evidence, /no-relevant-claim=1/);
});

test('T42 ③: T10 —— 最近 30 条卡样本 >160 的比例 >30% 才 PASS', () => {
  assert.equal(judgeSignalPreview([]).status, N);
  assert.equal(judgeSignalPreview([{ signalPreview: 'x'.repeat(200) }, { signalPreview: 'y'.repeat(10) }]).status, N, '<5 条不判');
  const stuck = Array.from({ length: 30 }, () => ({ signalPreview: 'a'.repeat(160) }));
  assert.equal(judgeSignalPreview(stuck).status, F, '旧代码全是 160');
  const fixed = Array.from({ length: 30 }, (_, i) => ({ signalPreview: 'b'.repeat(i < 12 ? 500 : 100) }));
  const out = judgeSignalPreview(fixed);
  assert.equal(out.status, P);
  assert.match(out.evidence, /12 条（40\.0%/);
  // 缺字段按 0 处理，不许当成"有信号"
  const missing = Array.from({ length: 30 }, () => ({}));
  assert.equal(judgeSignalPreview(missing).status, F);
});

test('T42 ④: T25 —— 重复率必须低于 T24 基线；样本 <20 条 NO-SAMPLE', () => {
  assert.equal(judgeDuplicateInjections([]).status, N);
  const make = (n, unique) => Array.from({ length: n }, (_, i) => ({ scope: 's', digest: `d${i % unique}` }));
  assert.equal(judgeDuplicateInjections(make(10, 5)).status, N, '少于 20 条不判');
  const low = judgeDuplicateInjections(make(40, 30)); // 多余 10 ⇒ 25%
  assert.equal(low.status, P);
  assert.match(low.evidence, new RegExp(`T24 基线 ${(T24_SCOPE_DUP_BASELINE * 100).toFixed(1)}%`));
  const high = judgeDuplicateInjections(make(40, 15)); // 多余 25 ⇒ 62.5%
  assert.equal(high.status, F);
  // 没有 digest 的行不算（防止拿坏行凑数）
  const noDigest = [...make(40, 30).map((r) => ({ ...r, digest: '' }))];
  assert.equal(judgeDuplicateInjections(noDigest).status, N);
});

test('T42 ⑤: T28/T31 —— 有「 · 恢复」尾注 PASS；没有则 NO-SAMPLE（不许算过）', () => {
  assert.equal(judgeRecoveryTail('- [x] body (ep-1, 2026-11-01, seq 3) · 恢复：后于 2026-11-02 同一文件写入成功（seq 382）').status, P);
  assert.equal(judgeRecoveryTail('- [x] body (ep-1, 2026-11-01, seq 3) · 恢复（class:race）：后于 2026-11-02 同一命令成功（exit 0, seq 1）').status, P, 'T37 会插（class:…），不能写死「恢复：」');
  assert.equal(judgeRecoveryTail('- [x] body (ep-1, 2026-11-01, seq 3)').status, N);
  assert.equal(judgeRecoveryTail('', { exitCode: 1, stderr: 'boom' }).status, F, '命令失败是 FAIL，不是 NO-SAMPLE');
});

test('T42 ⑥: 三个 cap 常量必须都是 64MB', () => {
  const good = [
    'export const CARD_SAMPLE_CAP_BYTES = 64 * 1024 * 1024;',
    'export const LIVE_STATS_CAP_BYTES = 64 * 1024 * 1024;',
    'export const MESSAGE_CORPUS_CAP_BYTES = 64 * 1024 * 1024;',
  ].join('\n');
  assert.equal(judgeCapConstants(good).status, P);
  const bad = good.replace('CARD_SAMPLE_CAP_BYTES = 64 * 1024 * 1024', 'CARD_SAMPLE_CAP_BYTES = 32 * 1024 * 1024');
  const out = judgeCapConstants(bad);
  assert.equal(out.status, F);
  assert.match(out.evidence, /CARD_SAMPLE_CAP_BYTES=32MB/);
  assert.equal(judgeCapConstants('').status, F, '常量缺失也是 FAIL');
});

test('T42 ⑦: metrics-guard 必须打印「A1 三轴」', () => {
  assert.equal(judgeA1ThreeAxes('  A1 三轴 · A1.stale=0.0% A1.opposite=0.0%').status, P);
  assert.equal(judgeA1ThreeAxes('A1=0 A5=0').status, F);
});

test('T42 汇总: 全 PASS=0；有 FAIL=1；全 NO-SAMPLE=2；PASS+NO-SAMPLE=0', () => {
  assert.equal(summarize([{ status: P }, { status: P }]).exitCode, 0);
  assert.equal(summarize([{ status: P }, { status: N }]).exitCode, 0);
  assert.equal(summarize([{ status: P }, { status: F }]).exitCode, 1);
  assert.equal(summarize([{ status: N }, { status: N }]).exitCode, 2);
  assert.equal(summarize([{ status: F }, { status: N }]).exitCode, 1);
  assert.equal(summarize([{ status: P }, { status: P }]).text, '2/2 项通过');
});

test('T42 当前宿主 pid：取最后一条宿主心跳；仿真/坏行不参与', () => {
  const rows = [
    { src: 'index.js', pid: 1, at: 10 },
    { src: 'sim-inject.mjs', pid: 2, at: 20 },
    { src: 'index.js', pid: 3, at: 30 },
    { src: 'index.js', pid: 4, at: 25 },
  ];
  assert.equal(pickCurrentPid(rows), 3, '按 at 取最新（不是数组最后一项）');
  assert.equal(pickCurrentPid([{ src: 'sim-inject.mjs', pid: 9, at: 1 }]), null);
  assert.equal(pickCurrentPid([]), null);
});

test('T42 接线: 本仓 src/plugin.mjs 的三个 cap 常量真的都是 64MB（脚本判据不是空转）', () => {
  const src = fs.readFileSync(path.resolve('src', 'plugin.mjs'), 'utf8');
  const out = judgeCapConstants(src);
  assert.equal(out.status, P, out.evidence);
  assert.equal(EXPECTED_CAP_BYTES, 64 * 1024 * 1024);
});
