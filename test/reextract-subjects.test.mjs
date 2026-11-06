// T327 · 重跑抽取：原件有 E1 主体 ⇒ 可修；原件没有 ⇒ 永久损失（不编）
import test from 'node:test';
import assert from 'node:assert/strict';
import { reextractOne, subjectFromText, commandFromText } from '../scripts/reextract-subjects.mjs';

const ev = (seq, text) => ({ seq, time: 1793540000000 + seq, data: { message: { content: [{ type: 'text', text }] } } });

test('T327 ① 原件里有目标字段 ⇒ recoverable（E1 主体 + E3 命令）', () => {
  const events = [ev(9, 'bash(command=npm test --prefix /d/ws)'), ev(10, 'Error: Cannot find module "/d/ws/src/app.mjs"')];
  const r = reextractOne({ claimText: 'Error: unknown job', events, seq: 10 });
  assert.equal(r.state, 'recoverable');
  assert.equal(r.subject.kind, 'file');
  assert.ok(r.subject.subject.includes('/d/ws/src/app.mjs'));
  assert.ok(String(r.command ?? '').startsWith('bash('), 'E3 命令可重放');
  assert.ok(String(r.command).includes('npm test'));
});

test('T327 ② 原件里也没有主体 ⇒ permanent（不硬补）', () => {
  const events = [ev(10, 'Error: unknown job')];
  const r = reextractOne({ claimText: 'Error: unknown job', events, seq: 10 });
  assert.equal(r.state, 'permanent');
  assert.equal(r.subject, null);
});

test('T327 ③ 主体提取优先级：路径 > FAIL 目标 > 引号；命令提取不越界', () => {
  assert.equal(subjectFromText('FAIL /d/ws/a.ts').kind, 'file');
  assert.equal(subjectFromText('✖ test/foo.test.mjs').kind, 'file', '带路径的失败目标按文件算');
  assert.equal(subjectFromText('Error: cannot modify "/a/b.mjs"').kind, 'file');
  assert.equal(subjectFromText('Error: unknown job "abc"'), null, '裸 token 不算主体');
  assert.equal(subjectFromText('Error: unknown job'), null);
  assert.ok(commandFromText('bash(command=ls -la)').startsWith('bash(ls -la'));
  assert.equal(commandFromText('no tool here'), null);
});

test('T327 ④ 没有事件/没有 seq ⇒ 不抛、按原件没有处理', () => {
  const r = reextractOne({ claimText: 'Error: unknown job', events: [], seq: null });
  assert.equal(r.state, 'permanent');
  assert.equal(reextractOne({ claimText: '', events: [] }).state, 'permanent');
});
