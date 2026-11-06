// T311/T311b · 抽取时机械抓"恢复条件"（F3）
//   T311b 修两处：① 失败必须**行级定位**（整段 blob 里含 Error 字样不算）
//                 ② 恢复必须**同主体 + exit 0**（"后来别的事成功了"不算）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRecovery, findRecovery, failureLineOf, failureOf, eventText, toolNameOf, subjectOf, RECOVERY_KINDS,
} from '../scripts/extract-recovery.mjs';

const ev = (seq, text) => ({ seq, time: 1793540000000 + seq, data: { message: { content: [{ type: 'text', text }] } } });
const FILE = '/d/ws/src/app.mjs';

test('T311 ① 错误后有**同主体**成功命令 ⇒ 抓到恢复条件（带 seq + 引文）', () => {
  const events = [
    ev(10, `bash(command=node ${FILE})`),
    ev(11, `Error: Cannot find module "${FILE}"`),
    ev(12, `node ${FILE}\n[exit code: 0]`),
  ];
  const out = extractRecovery({ events });
  assert.equal(out.length, 1);
  assert.equal(out[0].seq, 11);
  assert.equal(out[0].state, 'verified');
  assert.equal(out[0].falsifiableWhen.seq, 12);
  assert.ok(out[0].falsifiableWhen.quote.includes('exit code: 0'));
  assert.equal(out[0].falsifiableWhen.kind, 'same-subject-exit-0');
});

test('T311 ② 错误后没有恢复证据 ⇒ unverified（不许为了覆盖率编）', () => {
  const out = extractRecovery({ events: [ev(10, `Error: Cannot find module "${FILE}"`), ev(11, 'bash(command=ls)')] });
  assert.equal(out[0].state, 'unverified');
  assert.equal(out[0].falsifiableWhen, null);
});

test('T311b ③ 整段 blob 里含 Error 字样但该行不是失败 ⇒ **不算失败**（tombstone：系统提示词必须被排除）', () => {
  const prompt = 'You are an AI agent powered by DeepSeek Harness.\n'
    + 'When a tool returns Error, retry once.\n'
    + 'The word error may appear anywhere in prose.';
  assert.equal(failureLineOf(prompt), null, '行中间出现 Error/error 不算失败');
  assert.equal(extractRecovery({ events: [ev(5, prompt)] }).length, 0, '整条事件不许被当成失败');

  // 正例：行首 Error: 才算
  assert.equal(failureLineOf('Error: boom').line, 'Error: boom');
  assert.equal(failureLineOf('TypeError: x is not a function').reason, 'error-line');
  assert.equal(failureLineOf('[exit code: 1]').reason, 'exit:1');
  assert.equal(failureLineOf('[exit code: 0]'), null, 'exit 0 不是失败');
});

test('T311b ④ 后续有别的命令成功（不同文件）⇒ **不算恢复**', () => {
  const events = [
    ev(10, `Error: Cannot find module "${FILE}"`),
    ev(11, 'node /d/ws/src/other.mjs\n[exit code: 0]'),  // 别的文件成功了
  ];
  assert.equal(findRecovery(events, 0, { subject: FILE }), null, '不同主体不算恢复');
  assert.equal(extractRecovery({ events })[0].state, 'unverified');

  // 没有主体 ⇒ 一律 unverified（不许"任意 exit 0"凑数）
  const noSubject = [ev(10, 'Error: boom'), ev(11, 'bash(command=ls)\n[exit code: 0]')];
  assert.equal(extractRecovery({ events: noSubject })[0].state, 'unverified');
});

test('T311b ⑤ 只认后续事件 + 引文非空 + 主体可从错误行取到', () => {
  const events = [ev(9, `node ${FILE}\n[exit code: 0]`), ev(10, `Error: Cannot find module "${FILE}"`)];
  assert.equal(findRecovery(events, 1, { subject: FILE }), null, '恢复证据必须在失败**之后**');
  assert.equal(subjectOf(`Error: Cannot find module "${FILE}"`), FILE);
  const f = failureOf(ev(10, `Error: Cannot find module "${FILE}"`));
  assert.equal(f.seq, 10);
  assert.ok(f.quote.length > 0 && f.quote.length <= 200, '引文非空且 ≤200');
  assert.equal(toolNameOf('bash(command=ls)'), 'bash');
  assert.ok(eventText(ev(1, 'x')).includes('x'));
  assert.deepEqual([...RECOVERY_KINDS], ['same-subject-exit-0']);
});

// ─── T339 · 命令主体恢复（F3 第二条腿）───
// 带 type 的真实事件形态：tool/call（callId+name+arguments）与 tool/result（message.toolCallId 回指）。
const call = (seq, callId, name, args) => ({ type: 'tool/call', seq, time: 1793540000000 + seq, data: { callId, name, arguments: JSON.stringify(args) } });
const result = (seq, callId, text) => ({ type: 'tool/result', seq, time: 1793540000000 + seq, data: { message: { toolCallId: callId, content: [{ type: 'text', text }] } } });

test('T339 ① 无文件主体的失败，同一命令再次执行成功 ⇒ 命令级恢复（tombstone）', () => {
  const events = [
    call(10, 'c1', 'bash', { command: 'node scripts/check.mjs' }),
    result(11, 'c1', 'Error: unknown job bash-abc'),   // 无文件路径主体 ⇒ 文件级 null
    call(12, 'c2', 'bash', { command: 'node scripts/check.mjs' }),
    result(13, 'c2', 'all green\n[exit code: 0]'),      // 同命令成功
  ];
  const out = extractRecovery({ events });
  assert.equal(out.length, 1);
  assert.equal(out[0].state, 'verified');
  assert.equal(out[0].falsifiableWhen.kind, 'same-command-success');
  assert.equal(out[0].falsifiableWhen.seq, 13);
});

test('T339 ② 有文件主体 ⇒ 文件级优先，不被命令级顶替', () => {
  const events = [
    call(10, 'c1', 'bash', { command: 'node app.mjs' }),
    result(11, 'c1', `Error: Cannot find module "${FILE}"`),  // 有文件主体
    result(12, 'c1', `fixed ${FILE}\n[exit code: 0]`),          // 文件级恢复
  ];
  const out = extractRecovery({ events });
  assert.equal(out[0].falsifiableWhen.kind, 'same-subject-exit-0');
});

test('T339 ③ 不同命令的成功 ⇒ 不算恢复（不凑数）', () => {
  const events = [
    call(10, 'c1', 'bash', { command: 'node a.mjs' }),
    result(11, 'c1', 'Error: boom'),
    call(12, 'c2', 'bash', { command: 'node b.mjs' }),   // 不同命令
    result(13, 'c2', '[exit code: 0]'),
  ];
  const out = extractRecovery({ events });
  assert.equal(out[0].state, 'unverified');
  assert.equal(out[0].falsifiableWhen, null);
});

test('T339 ④ 无 type 的旧形态事件不触发命令级（向后兼容）', () => {
  // ev() 无 type ⇒ commandRuns 跳过 ⇒ 文件级照常，命令级不介入
  const events = [ev(10, 'Error: boom'), ev(11, '[exit code: 0]')];
  const out = extractRecovery({ events });
  assert.equal(out[0].state, 'unverified');  // 无主体、无 type ⇒ 不恢复
});
