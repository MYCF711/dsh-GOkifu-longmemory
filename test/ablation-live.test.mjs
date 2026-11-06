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

// ─── T352 · 出题必须取**因果**那次 tool/call，不是"最近的前一个" ───
test('T352 ① seq 指向 assistant 消息时，用 toolCallId 关联到因果调用（不是最近的前一个）', () => {
  const events = [
    call(10, 'old', 'bash', { command: 'echo unrelated' }),          // 与失败无关的旧调用
    { type: 'assistant/message', seq: 11, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'the check failed' }] } } },
    call(13, 'c9', 'bash', { command: 'node scripts/check.mjs' }),   // 因果调用
    result(14, 'c9', 'Error: boom'),                                 // 真失败在它后面
  ];
  const p = actionPromptAt(events, 11);
  assert.ok(p && p.includes('node scripts/check.mjs'), `要取因果调用，实际：${p}`);
  assert.ok(!String(p).includes('unrelated'), `不许退化成最近的前一个：${p}`);
});

test('T352 ② 只有 job_id 的工具（job_output）也要能出题', () => {
  const events = [
    call(20, 'j1', 'job_output', { job_id: 'bash-abc123', wait: true }),
    result(21, 'j1', 'Error: unknown job bash-abc123'),
  ];
  const p = actionPromptAt(events, 21);
  assert.ok(p && p.includes('bash-abc123'), `空参数的题没用，实际：${p}`);
});

// ─── T353 · 判定必须把「方向」与「显著性」分开说 ───
test('T353 ① 方向对但未显著 ⇒ 说"未达显著"，不许说"方向相反"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abl-t353-'));
  const file = path.join(dir, 'r.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ taskId: 'X', variant: 'B', recurred: true }),
    JSON.stringify({ taskId: 'X', variant: 'A', recurred: false }),
  ].join('\n') + '\n');
  const s = score({ file });
  assert.equal(s.discordant.onlyA, 0);
  assert.equal(s.discordant.onlyB, 1);
  assert.ok(!/方向相反/.test(s.verdict), `未显著不许说方向相反，实际：${s.verdict}`);
  assert.ok(/未达显著/.test(s.verdict), `应说明未达显著，实际：${s.verdict}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T353 ② 两臂都没复发 ⇒ 明说"题可能不复现失败"，不许当成记忆没用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abl-t353b-'));
  const file = path.join(dir, 'r.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ taskId: 'Y', variant: 'B', recurred: false }),
    JSON.stringify({ taskId: 'Y', variant: 'A', recurred: false }),
  ].join('\n') + '\n');
  const s = score({ file });
  assert.ok(/无差别/.test(s.verdict), s.verdict);
  assert.ok(/不复现失败/.test(s.verdict), `要提示"题不复现失败"这个可能，实际：${s.verdict}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

