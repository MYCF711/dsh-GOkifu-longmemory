// T307 · 真 ablation 骨架的单测（纯函数 + 临时文件）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listCandidates, mcnemarExact, record, score, wilson } from '../scripts/ablation-live.mjs';

const fakeStore = (claims) => ({ list: (k) => (k === 'claims' ? claims.map((r) => ({ record: r })) : []) });

test('T307 出题：只挑"有 claim 引用 + 错误原文 ≥20 字"的失败签名', () => {
  const claims = [
    { id: 'c-1', text: 'x', support: [{ episode: 'ep-aaaaaaaa', seq: 10, quote: 'Error: ENOENT: no such file or directory, open "a.log"' }] },
    { id: 'c-2', text: 'y', support: [{ episode: 'ep-bbbbbbbb', seq: 20, quote: 'short' }] },
    { id: 'c-3', text: 'z', support: [{ episode: 'ep-cccccccc', seq: 30, quote: 'all good here, nothing wrong at all' }] },
  ];
  const list = listCandidates({ store: fakeStore(claims), n: 10 });
  assert.equal(list.length, 1, `只该有 1 条候选，实际 ${JSON.stringify(list)}`);
  assert.equal(list[0].episode, 'ep-aaaaaaaa');
  assert.equal(list[0].seq, 10);
  assert.ok(list[0].taskId.startsWith('T-'));
});

test('T307 记分：B 路复发多 ⇒ 判"记忆有用"；完全一致 ⇒ 判"没起作用"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't307-'));
  const file = path.join(dir, 'r.jsonl');
  // 8 个任务：A 全不复发，B 6 个复发（McNemar 0 vs 6 ⇒ p=0.031 才显著）
  for (let i = 1; i <= 8; i += 1) {
    record({ taskId: `T${i}`, variant: 'A', recurred: false, file });
    record({ taskId: `T${i}`, variant: 'B', recurred: i <= 6, file });
  }
  const s = score({ file });
  assert.equal(s.tasks, 8);
  assert.equal(s.discordant.onlyB, 6, 'B 独有复发 6 条（4 条时 p=0.125 不显著，这是统计事实不是 bug）');
  assert.equal(s.discordant.onlyA, 0);
  assert.ok(s.mcnemarP < 0.05, `应显著，p=${s.mcnemarP}`);
  assert.match(s.verdict, /记忆有用/);
  // 全一致 ⇒ 无差别
  const file2 = path.join(dir, 'r2.jsonl');
  for (let i = 1; i <= 3; i += 1) { record({ taskId: `U${i}`, variant: 'A', recurred: true, file: file2 }); record({ taskId: `U${i}`, variant: 'B', recurred: true, file: file2 }); }
  assert.match(score({ file: file2 }).verdict, /没起作用/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T307 幂等：同 task+variant 重复记录会覆盖（不重复计数）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't307b-'));
  const file = path.join(dir, 'r.jsonl');
  record({ taskId: 'X', variant: 'A', recurred: true, file });
  record({ taskId: 'X', variant: 'A', recurred: false, file });
  const s = score({ file });
  assert.equal(s.tasks, 0, '只有 A 没有 B ⇒ 无配对');
  record({ taskId: 'X', variant: 'B', recurred: false, file });
  const s2 = score({ file });
  assert.equal(s2.tasks, 1);
  assert.equal(s2.discordant.onlyA, 0, '覆盖后两侧都是不复发 ⇒ 无 discordant');
  assert.equal(s2.discordant.onlyB, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T307 统计：Wilson 与 McNemar 已知值', () => {
  assert.ok(Math.abs(wilson(0, 10).lower) < 1e-9, '0/10 下界 0');
  assert.ok(wilson(10, 10).upper > 0.99, '10/10 上界接近 1');
  assert.equal(mcnemarExact(0, 0), 1, '没有 discordant 对 ⇒ p=1');
  assert.ok(mcnemarExact(0, 5) < 0.07 && mcnemarExact(0, 6) < 0.04, '0 vs 6 才过 0.05');
});
