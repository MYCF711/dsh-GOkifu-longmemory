// T330 · cost（T3 付过代价）：只认机械痕迹；判不出 ⇒ cost: 0（不是"没代价"）
import test from 'node:test';
import assert from 'node:assert/strict';
import { costOf, anchorFailureIndex } from '../scripts/antipattern-cost.mjs';

const ev = (seq, text) => ({ seq, time: 1793540000000 + seq, data: { message: { content: [{ type: 'text', text }] } } });

test('T330 ① 同一命令连续失败 ≥2 次 ⇒ retry（付过代价）', () => {
  const events = [
    ev(10, 'Error: Cannot find module "/d/ws/src/app.mjs"'),
    ev(11, 'Error: Cannot find module "/d/ws/src/app.mjs"'),
    ev(12, 'ok done'),
  ];
  const r = costOf({ events, index: 0 });
  assert.ok(r.kinds.includes('retry'), JSON.stringify(r));
  assert.ok(r.cost >= 1, 'cost 必须 > 0');
});

test('T330 ② 失败后对同一文件有修改 ⇒ rework（返工）', () => {
  const events = [
    ev(10, 'Error: cannot modify "/d/ws/src/app.mjs"'),
    ev(11, 'write(file_path=/d/ws/src/app.mjs)'),
  ];
  const r = costOf({ events, index: 0 });
  assert.ok(r.kinds.includes('rework'), JSON.stringify(r));
});

test('T330 ③ 判不出 ⇒ cost: 0（没测到，不是没代价）', () => {
  const events = [ev(10, 'Error: unknown job'), ev(11, 'ok'), ev(12, 'ok'), ev(13, 'ok'), ev(14, 'ok'), ev(15, 'ok')];
  const r = costOf({ events, index: 0 });
  assert.equal(r.cost, 0);
  assert.deepEqual(r.kinds, []);
});

test('T330 ④ 失败后 ≤3 条事件就结束 ⇒ interruption；无事件 ⇒ cost 0 不抛', () => {
  const events = [ev(10, 'Error: boom'), ev(11, 'ok')];
  assert.ok(costOf({ events, index: 0 }).kinds.includes('interruption'));
  assert.equal(costOf({ events: [], index: -1 }).cost, 0);
  assert.equal(costOf({}).cost, 0);
});

// ─── T336 · 重锚定：support 锚在「提到失败的 assistant 消息」，真失败在紧邻 tool/result ───

test('T336 ① support 锚在 assistant 消息，真 Error 在 +2 且有同主体重试 ⇒ 重锚后算出 retry（tombstone）', () => {
  const events = [
    ev(10, 'assistant\ntool-call\nbash {"command":"node /d/ws/src/app.mjs"}'), // support.seq 锚这里，无 Error 行
    ev(11, 'some reasoning about the failure'),
    ev(12, 'Error: Cannot find module "/d/ws/src/app.mjs"'),  // 真失败（+2，tool/result）
    ev(13, 'Error: Cannot find module "/d/ws/src/app.mjs"'),  // 同主体重试
    ev(14, 'ok done'),
    ev(15, 'ok'),
    ev(16, 'ok'),
  ];
  // 重锚定本身：index 0 → 2
  assert.equal(anchorFailureIndex(events, 0), 2);
  // 不重锚 ⇒ subject=null ⇒ retry 跳过 ⇒ cost 0；重锚 ⇒ 算出 retry
  const r = costOf({ events, index: 0 });
  assert.ok(r.kinds.includes('retry'), `重锚后必须算出 retry，实际 ${JSON.stringify(r)}`);
  assert.ok(r.cost >= 1, '重锚后 cost 必须 > 0');
});

test('T336 ② 真失败在窗口外（+5 > ±3）⇒ 不重锚，cost 仍 0（不编）', () => {
  const events = [
    ev(10, 'assistant tool-call'),          // support，无 Error 行
    ev(11, 'ok'), ev(12, 'ok'), ev(13, 'ok'), ev(14, 'ok'),
    ev(15, 'Error: Cannot find module "/d/ws/src/app.mjs"'),  // +5 窗口外
    ev(16, 'Error: Cannot find module "/d/ws/src/app.mjs"'),
  ];
  assert.equal(anchorFailureIndex(events, 0), 0, '窗口外不重锚');
  assert.equal(costOf({ events, index: 0 }).cost, 0);
});

test('T336 ③ 两侧等距都有失败行 ⇒ 并列取靠后（Error 在 assistant 之后）', () => {
  const events = [
    ev(10, 'Error: before "/d/ws/src/a.mjs"'),  // index 0（-1）
    ev(11, 'assistant mentions a failure'),      // support index 1，无 Error 行
    ev(12, 'Error: after "/d/ws/src/b.mjs"'),    // index 2（+1）
  ];
  assert.equal(anchorFailureIndex(events, 1), 2, '等距取靠后');
});

test('T336 ④ support 本身含失败行 ⇒ 不重锚（保持原 index）', () => {
  const events = [ev(10, 'Error: boom "/d/ws/src/a.mjs"'), ev(11, 'Error: other "/d/ws/src/b.mjs"')];
  assert.equal(anchorFailureIndex(events, 0), 0);
});
