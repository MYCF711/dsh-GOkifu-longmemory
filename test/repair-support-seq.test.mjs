// T238 · support[].seq 存量修复（tombstone：删掉 `scripts/repair-support-seq.mjs` ⇒ 本文件红）
//
// 覆盖：
//   ① 唯一命中 ⇒ repair（from → to，带事件类型与距离）
//   ② 多命中 ⇒ ambiguous（**不修**）
//   ③ 找不到 ⇒ unrepaired（**不修**）
//   ④ 幂等：apply 两次，第二次 0 变更
//   ⑤ 只改 seq：quote / text / state / 其它字段一个字节不动，且追加 provenanceRepair

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createStore } from '../src/rooms/persist.mjs';
import { locateQuoteSeq, buildEventIndex, planRepairs, applyPlan } from '../scripts/repair-support-seq.mjs';

const T0 = 1_700_000_000_000;
let tmp;
test.before(() => { tmp = mkdtempSync(path.join(tmpdir(), 'kifu-t238-')); });
test.after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

/** 造事件：seq → 文本 + 类型。 */
const ev = (seq, text, type = 'tool/result') => ({ seq, type, data: { content: [{ type: 'text', text }] } });

const INDEX = buildEventIndex([
  ev(10, '思考：这里不该是 3670', 'assistant'),
  ev(14, 'fatal: unable to access github.com/MYCF711/dsh-ui', 'tool/result'),
  ev(20, '重复片段 重复片段', 'tool/result'),
  ev(21, '重复片段 重复片段', 'assistant'), // 同一段出现在两处 ⇒ ambiguous
]);

test('T238 ①: 唯一命中 ⇒ repair，带 from/to/事件类型/距离', () => {
  const r = locateQuoteSeq({ quote: 'fatal: unable to access github.com/MYCF711/dsh-ui', seq: 10, eventIndex: INDEX });
  assert.equal(r.status, 'repair');
  assert.equal(r.from, 10);
  assert.equal(r.to, 14);
  assert.equal(r.eventType, 'tool/result');
  assert.equal(r.distance, 4);
  assert.deepEqual(r.candidates, [14]);
});

test('T238: seq 已正确 ⇒ ok（不动）', () => {
  const r = locateQuoteSeq({ quote: 'fatal: unable to access github.com', seq: 14, eventIndex: INDEX });
  assert.equal(r.status, 'ok');
  assert.equal(r.to, 14);
  assert.equal(r.distance, 0);
});

test('T238 ②: 多命中 ⇒ ambiguous，**不修**（to 为 null）', () => {
  const r = locateQuoteSeq({ quote: '重复片段 重复片段', seq: 10, eventIndex: INDEX });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.to, null);
  assert.deepEqual(r.candidates, [20, 21]);
});

test('T238 ③: 找不到 ⇒ unrepaired，**不修**', () => {
  const r = locateQuoteSeq({ quote: '这段原文库里根本没有', seq: 10, eventIndex: INDEX });
  assert.equal(r.status, 'unrepaired');
  assert.equal(r.to, null);
  assert.deepEqual(r.candidates, []);
});

const claim = (id, seq, quote) => ({
  id,
  kind: 'antipattern',
  text: '这条 claim 的正文不该被改',
  scopeKey: 'u:demo',
  state: 'observed',
  support: [{ episode: 'ep-0001', seq, quote, occurredAt: T0 }],
  counter: [],
  validity: { type: 'none', value: null },
  preconditions: [],
  occurredAt: T0,
  recordedAt: T0,
  counters: { support: 1, counter: 0 },
});

const EPISODES = [{ id: 'ep-0001', closure: { logPath: 'x' } }];

test('T238 ④⑤: apply 只改 seq + 追加 provenanceRepair；连跑两次第二次 0 变更', () => {
  const root = path.join(mkdtempSync(path.join(tmp, 'store-')), 'store');
  const store = createStore({ root });
  store.ensureDirs();
  store.putMany('claims', [
    claim('c-repair', 10, 'fatal: unable to access github.com/MYCF711/dsh-ui'),
    claim('c-ok', 14, 'fatal: unable to access github.com'),
    claim('c-ambig', 10, '重复片段 重复片段'),
    claim('c-missing', 10, '这段原文库里根本没有'),
  ], { at: T0 });
  store.writeManifest(T0);

  const loadEvents = () => INDEX.size; // 占位，不用
  const plan = planRepairs({
    claims: store.list('claims').map((e) => e.record),
    episodes: EPISODES,
    loadEvents: () => [ev(10, '思考：这里不该是 3670', 'assistant'), ev(14, 'fatal: unable to access github.com/MYCF711/dsh-ui', 'tool/result'), ev(20, '重复片段 重复片段', 'tool/result'), ev(21, '重复片段 重复片段', 'assistant')],
  });
  assert.equal(plan.repair.length, 1, '只有 c-repair 可修');
  assert.equal(plan.ambiguous.length, 1);
  assert.equal(plan.unrepaired.length, 1);
  assert.equal(plan.ok, 1);

  const first = applyPlan({ store, plan, apply: true, at: T0 + 1000 });
  assert.equal(first.changed, 1);
  assert.equal(first.fixes, 1);

  const after = store.list('claims').map((e) => e.record).find((c) => c.id === 'c-repair');
  assert.equal(after.support[0].seq, 14, 'seq 必须改成 14');
  assert.equal(after.support[0].quote, 'fatal: unable to access github.com/MYCF711/dsh-ui', 'quote 一个字节不许动');
  assert.equal(after.text, '这条 claim 的正文不该被改', '正文不许动');
  assert.equal(after.state, 'observed', 'state 不许动');
  assert.ok(Array.isArray(after.provenanceRepair) && after.provenanceRepair.length === 1, '必须追加 provenanceRepair');
  assert.equal(after.provenanceRepair[0].fixes[0].from, 10);
  assert.equal(after.provenanceRepair[0].fixes[0].to, 14);

  // 幂等：再算一次计划 ⇒ 没有任何可修
  const plan2 = planRepairs({
    claims: store.list('claims').map((e) => e.record),
    episodes: EPISODES,
    loadEvents: () => [ev(10, '思考：这里不该是 3670', 'assistant'), ev(14, 'fatal: unable to access github.com/MYCF711/dsh-ui', 'tool/result'), ev(20, '重复片段 重复片段', 'tool/result'), ev(21, '重复片段 重复片段', 'assistant')],
  });
  assert.equal(plan2.repair.length, 0, '第二次不该再有可修项');
  const second = applyPlan({ store, plan: plan2, apply: true, at: T0 + 2000 });
  assert.equal(second.changed, 0);
});
