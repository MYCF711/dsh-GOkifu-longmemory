// T330 · cost（T3 付过代价）：只认机械痕迹；判不出 ⇒ cost: 0（不是"没代价"）
import test from 'node:test';
import assert from 'node:assert/strict';
import { costOf } from '../scripts/antipattern-cost.mjs';

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
