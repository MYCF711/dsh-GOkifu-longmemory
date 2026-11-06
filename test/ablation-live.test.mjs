// T307 · 真 ablation 骨架的单测（纯函数 + 临时文件）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listCandidates, mcnemarExact, record, score, wilson, signatureOf, actionPromptAt, leaksAnswer, judgeRecurrence } from '../scripts/ablation-live.mjs';

const fakeStore = (claims) => ({ list: (k) => (k === 'claims' ? claims.map((r) => ({ record: r })) : []) });

test('T307 出题：只挑"有 claim 引用 + 错误原文 ≥20 字"的失败签名', () => {
  const claims = [
    { id: 'c-1', text: 'x', support: [{ episode: 'ep-aaaaaaaa', seq: 10, quote: 'Error: ENOENT: no such file or directory, open "a.log"' }] },
    { id: 'c-2', text: 'y', support: [{ episode: 'ep-bbbbbbbb', seq: 20, quote: 'short' }] },
    { id: 'c-3', text: 'z', support: [{ episode: 'ep-cccccccc', seq: 30, quote: 'all good here, nothing wrong at all' }] },
  ];
  // T344 起默认「无动作提示 ⇒ 不出题」；本用例只测**筛选口径**，故显式放行（放行结果不得用于判「记忆有用」）
  const list = listCandidates({ store: fakeStore(claims), n: 10, allowUnsafe: true });
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

// ─── T344 · 两个致命漏洞：考卷泄漏（漏洞 3）+ 手工判据（漏洞 2）───
const T0 = 1_700_000_000_000;
const call = (seq, callId, name, args) => ({ type: 'tool/call', seq, time: T0 + seq, data: { callId, name, arguments: JSON.stringify(args) } });
const result = (seq, callId, text) => ({ type: 'tool/result', seq, time: T0 + seq, data: { message: { toolCallId: callId, content: [{ type: 'text', text }] } } });

test('T344 ① 复发签名归一：只差路径的两条错误 ⇒ 同一签名', () => {
  const a = signatureOf('Error: Cannot find module "/d/ws/a/app.mjs"');
  const b = signatureOf('Error: Cannot find module "D:\\other\\b\\app.mjs"');
  assert.equal(a, b);
  assert.ok(a.length > 0);
});

test('T344 ② 题目提示取自动作（不是错误原文）', () => {
  const events = [call(10, 'c1', 'bash', { command: 'node scripts/check.mjs' }), result(11, 'c1', 'Error: boom')];
  const p = actionPromptAt(events, 11);
  assert.ok(p && p.includes('node scripts/check.mjs'), p);
  assert.equal(actionPromptAt([result(11, 'c1', 'Error: boom')], 11), null, '没有 tool/call ⇒ 取不到动作');
  assert.equal(actionPromptAt(events, 999), null, 'seq 不存在 ⇒ null');
});

test('T344 ③ 泄漏判据：提示里出现错误原文就算泄漏', () => {
  const err = 'Error: Cannot find module "/d/ws/src/app.mjs"';
  assert.equal(leaksAnswer(`bash node ${err}`, err), true);
  assert.equal(leaksAnswer('bash node scripts/check.mjs', err), false);
});

test('T344 ④ 出题默认无泄漏（tombstone：把 taskPrompt 改回错误原文 ⇒ 默认全被排除）', () => {
  const err = 'Error: Cannot find module "/d/ws/src/app.mjs"';
  const claim = { id: 'c-1', text: err, support: [{ episode: 'ep-aaaaaaaa', seq: 11, quote: err }] };
  const store = { list: (k) => (k === 'claims' ? [{ record: claim }] : [{ record: { id: 'ep-aaaaaaaa' } }]) };
  const safeEvents = [call(10, 'c1', 'bash', { command: 'node scripts/check.mjs' }), result(11, 'c1', err)];
  const unsafeEvents = [call(10, 'c1', 'bash', { command: `node ${err}` }), result(11, 'c1', err)];

  const safe = listCandidates({ store, n: 5, readEvents: () => safeEvents });
  assert.equal(safe.length, 1);
  assert.equal(safe[0].promptSafe, true);
  assert.ok(!leaksAnswer(safe[0].taskPrompt, safe[0].errorText), '默认输出不许泄漏');
  assert.ok(safe[0].signature.length > 0, '必须带判分签名');

  assert.equal(listCandidates({ store, n: 5, readEvents: () => unsafeEvents }).length, 0, '会泄漏的题默认不出');
  const forced = listCandidates({ store, n: 5, allowUnsafe: true, readEvents: () => unsafeEvents });
  assert.equal(forced.length, 1);
  assert.equal(forced[0].promptSafe, false, '显式放行也必须标不安全');
});

test('T344 ⑤ 机械判复发：运行里再现同一签名 ⇒ recurred=true（只差路径也算）', () => {
  const tasks = [
    { taskId: 'T-1', signature: signatureOf('Error: Cannot find module "/d/ws/src/app.mjs"') },
    { taskId: 'T-2', signature: signatureOf("Error: ENOENT: no such file or directory, open 'x.json'") },
  ];
  const rows = judgeRecurrence({ tasks, events: [result(5, 'c1', 'Error: Cannot find module "/somewhere/else/app.mjs"')] });
  assert.equal(rows.find((r) => r.taskId === 'T-1').recurred, true);
  assert.equal(rows.find((r) => r.taskId === 'T-2').recurred, false);
});

test('T344 ⑥ 机械判复发：没有失败事件 ⇒ recurred=false（不编）', () => {
  const tasks = [{ taskId: 'T-1', signature: signatureOf('Error: boom') }];
  assert.equal(judgeRecurrence({ tasks, events: [result(5, 'c1', 'all green')] })[0].recurred, false);
  assert.equal(judgeRecurrence({ tasks, events: [] })[0].recurred, false);
  assert.deepEqual(judgeRecurrence({ tasks: [], events: [] }), []);
});
