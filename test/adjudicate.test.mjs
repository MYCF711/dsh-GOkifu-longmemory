// R10 adjudicate 的 tombstone test：删掉 src/rooms/adjudicate.mjs ⇒ 本文件整片红。
//
// 覆盖（契约 §4.7、方案 §5.4 / §5.1 / §6.3 闸 2b）：
//   - 机械聚合：agreement = 多数 ÷ 有效票；平票 / 全 insufficient / 低于阈值 ⇒ hold-disputed
//   - 反例多数 ⇒ invalidate；支持多数 ⇒ promote；都不看"模型觉得"
//   - 闸 2b：共享 contextId（或退回 sessionId）的票只算一票，其余标 `vote/shared-context` 排除
//   - 脏票被拒：重复成员、非法 verdict、support/oppose 没证据
//   - 结构化：reason ≤200 字、证据必须 {episode, seq, quote}
//   - 可回放：同输入同 id/decision/agreement；篡改一票 ⇒ replay 报 diff
//   - L4 人纠错 = 最高优先级（decision=correct），没有人的票就退回 hold-disputed
//   - 不调用模型、不读盘：纯函数，同输入同输出

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADJUDICATION_SCHEMA,
  ADJUDICATION_VERSION,
  DECISIONS,
  DEFAULT_THRESHOLD,
  LEVELS,
  MAX_REASON,
  MIN_MEMBERS,
  VERDICTS,
  AdjudicateError,
  adjudicate,
  aggregateVotes,
  contextKeyOf,
  independenceCheck,
  normalizeEvidence,
  replayAdjudication,
  validateAdjudication,
} from '../src/rooms/adjudicate.mjs';

const ev = (episode = 'ep-aaaaaaa1', seq = 10, quote = 'Error: x') => [{ episode, seq, quote }];
const vote = (member, verdict, extra = {}) => ({ member, verdict, evidence: ev(), ...extra });

// ---------------------------------------------------------------------------
// 常量与契约形态
// ---------------------------------------------------------------------------

test('R10: 契约常量（票型/裁决/层/阈值/上限）', () => {
  assert.deepEqual([...VERDICTS], ['support', 'oppose', 'insufficient']);
  assert.deepEqual([...DECISIONS], ['promote', 'hold-disputed', 'invalidate', 'correct']);
  assert.deepEqual([...LEVELS], ['L2-multi-member', 'L4-human-correction']);
  assert.equal(DEFAULT_THRESHOLD, 0.6);
  assert.equal(MAX_REASON, 200);
  assert.equal(MIN_MEMBERS, 2);
  assert.equal(ADJUDICATION_VERSION, 1);
  assert.equal(ADJUDICATION_SCHEMA, 'dsh-gokifu-longmemory/adjudication@1');
});

test('R10: 支持多数 ⇒ promote；agreement = 多数 ÷ 有效票；dissent 收反对票', () => {
  const rec = adjudicate({
    target: 'c-aaaa0001',
    votes: [vote('m-a', 'support'), vote('m-b', 'support'), vote('m-c', 'oppose')],
    now: 1000,
  });
  assert.equal(rec.decision, 'promote');
  assert.equal(rec.n, 3);
  assert.equal(rec.agreement, 0.667);
  assert.deepEqual(rec.counts, { support: 2, oppose: 1, insufficient: 0, valid: 3, decisive: 3 });
  assert.deepEqual(rec.dissent.map((v) => v.member), ['m-c']);
  assert.equal(rec.level, 'L2-multi-member');
  assert.equal(rec.at, 1000);
  assert.match(rec.id, /^ad-[0-9a-f]{8}$/);
  assert.deepEqual(rec.errors, []);
});

test('R10: 反对多数 ⇒ invalidate（反例优先，不看"原文怎么写"）', () => {
  const rec = adjudicate({
    target: 'c-aaaa0002',
    votes: [vote('m-a', 'oppose'), vote('m-b', 'oppose'), vote('m-c', 'support')],
  });
  assert.equal(rec.decision, 'invalidate');
  assert.deepEqual(rec.dissent.map((v) => v.member), ['m-c']);
});

test('R10: 平票 ⇒ hold-disputed，两边证据都列（"沉默即断言"）', () => {
  const rec = adjudicate({ target: 'c-aaaa0003', votes: [vote('m-a', 'support'), vote('m-b', 'oppose')] });
  assert.equal(rec.decision, 'hold-disputed');
  assert.equal(rec.agreement, 0.5);
  assert.equal(rec.dissent.length, 2, 'disputed 时 dissent = 全部有效票（两边都列）');
});

test('R10: 一致度低于阈值 ⇒ hold-disputed（3 票里 1 支持 1 反对 1 判不了）', () => {
  const rec = adjudicate({
    target: 'c-aaaa0004',
    votes: [vote('m-a', 'support'), vote('m-b', 'oppose'), vote('m-c', 'insufficient', { evidence: [] })],
  });
  assert.equal(rec.agreement, 0.333);
  assert.equal(rec.decision, 'hold-disputed');
});

test('R10: 阈值可调 —— 0.9 时 2/3 支持也判不了', () => {
  const votes = [vote('m-a', 'support'), vote('m-b', 'support'), vote('m-c', 'oppose')];
  assert.equal(adjudicate({ target: 'c-aaaa0005', votes }).decision, 'promote');
  assert.equal(adjudicate({ target: 'c-aaaa0005', votes, threshold: 0.9 }).decision, 'hold-disputed');
});

test('R10: 全部 insufficient ⇒ hold-disputed（没有一方主张，不硬判）', () => {
  const rec = adjudicate({
    target: 'c-aaaa0006',
    votes: [vote('m-a', 'insufficient', { evidence: [] }), vote('m-b', 'insufficient', { evidence: [] })],
  });
  assert.equal(rec.decision, 'hold-disputed');
  assert.equal(rec.agreement, 0);
  assert.deepEqual(rec.errors, []);
});

test('R10: 没有有效票 ⇒ hold-disputed + 记一条 degraded 错', () => {
  const rec = adjudicate({ target: 'c-aaaa0007', votes: [] });
  assert.equal(rec.decision, 'hold-disputed');
  assert.equal(rec.n, 0);
  assert.ok(rec.errors.some((e) => e.code === 'adjudication/no-valid-votes'));
});

// ---------------------------------------------------------------------------
// 闸 2b：独立性
// ---------------------------------------------------------------------------

test('R10 闸2b: 共享 contextId 的票只算一票，其余标 vote/shared-context 排除', () => {
  const rec = adjudicate({
    target: 'c-bbbb0001',
    votes: [
      vote('m-a', 'support', { contextId: 'ctx-1' }),
      vote('m-b', 'support', { contextId: 'ctx-1' }),
      vote('m-c', 'support', { contextId: 'ctx-2' }),
    ],
  });
  assert.equal(rec.n, 2, '同一 context 只说一遍');
  assert.equal(rec.agreement, 1);
  assert.deepEqual(rec.excluded.map((v) => [v.member, v.excludedReason]), [['m-b', 'vote/shared-context']]);
  assert.ok(rec.errors.some((e) => e.code === 'vote/shared-context' && e.severity === 'excluded'));
});

test('R10 闸2b: 没有 contextId 时按 sessionId 判共享上下文', () => {
  const rec = adjudicate({
    target: 'c-bbbb0002',
    votes: [
      vote('m-a', 'support', { sessionId: 'session-x' }),
      vote('m-b', 'support', { sessionId: 'session-x' }),
      vote('m-c', 'oppose', { sessionId: 'session-y' }),
    ],
  });
  assert.equal(rec.n, 2);
  assert.equal(rec.decision, 'hold-disputed', '少掉一张票后 1:1 平票');
  assert.equal(rec.excluded[0].excludedReason, 'vote/shared-context');
  assert.deepEqual(rec.excluded[0].sessionId, 'session-x', '共享上下文的原始 sessionId 留档');
});

test('R10 闸2b: independenceCheck 直接给出冲突（给 R13 用）', () => {
  const ok = independenceCheck([vote('m-a', 'support', { contextId: 'c1' }), vote('m-b', 'support', { contextId: 'c2' })]);
  assert.equal(ok.ok, true);
  const bad = independenceCheck([vote('m-a', 'support', { contextId: 'c1' }), vote('m-b', 'support', { contextId: 'c1' })]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.shared[0].members, ['m-a', 'm-b']);
  assert.deepEqual(bad.shared[0].indexes, [0, 1]);
  assert.equal(contextKeyOf({ member: 'm-a' }), 'm-a', '没有 contextId 时退回 member');
  assert.equal(contextKeyOf({ contextId: 'c', member: 'm-a' }), 'c');
  assert.equal(contextKeyOf({ sessionId: 's', member: 'm-a' }), 's');
});

// ---------------------------------------------------------------------------
// 脏票
// ---------------------------------------------------------------------------

test('R10: 重复成员 / 非法 verdict / 无证据的主张都被排除（不静默计入）', () => {
  const rec = adjudicate({
    target: 'c-cccc0001',
    votes: [
      vote('m-a', 'support'),
      vote('m-a', 'support'),
      vote('m-b', 'maybe'),
      vote('m-c', 'support', { evidence: [{ episode: 'ep-1', seq: 1 }] }), // 缺 quote ⇒ 等于没证据
      vote('m-d', 'insufficient', { evidence: [] }),
    ],
  });
  const reasons = rec.excluded.map((v) => v.excludedReason).sort();
  assert.deepEqual(reasons, ['vote/duplicate-member', 'vote/invalid-verdict', 'vote/no-evidence']);
  assert.equal(rec.n, 2, 'm-a 与 m-d 计入');
});

test('R10: 证据半好半坏 ⇒ 好票留下并记 warning（不静默丢）', () => {
  const rec = adjudicate({
    target: 'c-cccc0003',
    votes: [vote('m-a', 'support', { evidence: [{ episode: 'ep-1', seq: 2, quote: 'q' }, { episode: 'ep-2', seq: null, quote: 'q' }] })],
  });
  assert.equal(rec.n, 1);
  assert.equal(rec.votes[0].evidence.length, 1, '只留结构完整的那一条证据');
  assert.ok(rec.errors.some((e) => e.code === 'vote/evidence-weak' && e.severity === 'warning'));
});

test('R10: 证据必须 {episode, seq, quote} 三条齐（normalizeEvidence 直接可测）', () => {
  const ok = normalizeEvidence([{ episode: 'ep-1', seq: 3, quote: 'q' }]);
  assert.equal(ok.valid.length, 1);
  assert.deepEqual(ok.problems, []);
  const bad = normalizeEvidence([{ episode: '', seq: 'x', quote: '  ' }, null]);
  assert.equal(bad.valid.length, 0);
  assert.equal(bad.problems.length, 2);
  assert.deepEqual(bad.problems[0].missing, ['episode', 'seq', 'quote']);
});

test('R10: reason 截到 200 字并记 warning（不静默）', () => {
  const long = '很长的理由'.repeat(100);
  const rec = adjudicate({ target: 'c-cccc0002', votes: [vote('m-a', 'support', { reason: long })] });
  assert.ok([...rec.votes[0].reason].length <= MAX_REASON);
  assert.ok(rec.votes[0].reason.endsWith('…'));
  assert.ok(rec.errors.some((e) => e.code === 'vote/reason-truncated'));
});

test('R10: 非法输入直接抛 AdjudicateError（不返回半个记录）', () => {
  assert.throws(() => adjudicate({ target: '', votes: [] }), (e) => e instanceof AdjudicateError && e.code === 'adjudicate/missing-target');
  assert.throws(() => adjudicate({ target: 'c-1', votes: 'nope' }), (e) => e.code === 'adjudicate/invalid-votes');
  assert.throws(() => adjudicate({ target: 'c-1', votes: [], threshold: 1.5 }), (e) => e.code === 'adjudicate/invalid-threshold');
  assert.throws(() => adjudicate({ target: 'c-1', votes: [], level: 'L9' }), (e) => e.code === 'adjudicate/invalid-level');
});

// ---------------------------------------------------------------------------
// L4 人纠错
// ---------------------------------------------------------------------------

test('R10 L4: 人纠错 = 最高优先级 ⇒ decision=correct，agreement=1', () => {
  const rec = adjudicate({
    target: 'c-dddd0001',
    level: 'L4-human-correction',
    votes: [
      vote('m-a', 'support'),
      vote('m-b', 'support'),
      vote('human:owner', 'oppose', { human: true, evidence: ev('ep-1', 9, '这条错了') }),
    ],
  });
  assert.equal(rec.decision, 'correct');
  assert.equal(rec.agreement, 1);
  assert.deepEqual(rec.dissent.map((v) => v.member), ['m-a', 'm-b'], '原有支持票变成异见，原文保留');
});

test('R10 L4: 没有人的票 ⇒ 退回 hold-disputed + 记错（不冒充纠错）', () => {
  const rec = adjudicate({ target: 'c-dddd0002', level: 'L4-human-correction', votes: [vote('m-a', 'oppose')] });
  assert.equal(rec.decision, 'hold-disputed');
  assert.ok(rec.errors.some((e) => e.code === 'level/no-human-vote'));
});

// ---------------------------------------------------------------------------
// 可回放
// ---------------------------------------------------------------------------

test('R10: 同输入同输出（id/decision/agreement 稳定，at 由调用方给）', () => {
  const votes = [vote('m-a', 'support'), vote('m-b', 'support'), vote('m-c', 'oppose')];
  const a = adjudicate({ target: 'c-eeee0001', votes, now: 111 });
  const b = adjudicate({ target: 'c-eeee0001', votes, now: 222 });
  assert.equal(a.id, b.id);
  assert.equal(a.decision, b.decision);
  assert.equal(a.agreement, b.agreement);
  assert.equal(a.at, 111);
  assert.equal(b.at, 222);
  // 票序不影响结果
  const c = adjudicate({ target: 'c-eeee0001', votes: [...votes].reverse() });
  assert.equal(c.decision, a.decision);
  assert.equal(c.agreement, a.agreement);
  assert.equal(c.id, a.id, 'id 只看（成员, 票型, 上下文）的排序集合');
});

test('R10: replay 从留档的票重算 —— 原样记录 ok，篡改一票就露 diff', () => {
  const rec = adjudicate({
    target: 'c-eeee0002',
    votes: [vote('m-a', 'support', { contextId: 'c1' }), vote('m-b', 'support', { contextId: 'c2' }), vote('m-c', 'oppose', { contextId: 'c3' })],
    now: 500,
  });
  const ok = replayAdjudication(rec);
  assert.equal(ok.ok, true, JSON.stringify(ok.diffs));
  assert.equal(ok.recomputed.decision, rec.decision);

  const tampered = JSON.parse(JSON.stringify(rec));
  tampered.votes[2].verdict = 'support'; // 把反对票改成支持票
  const bad = replayAdjudication(tampered);
  assert.equal(bad.ok, false);
  assert.ok(bad.diffs.some((d) => d.startsWith('agreement')), bad.diffs.join(' | '));

  const tampered2 = JSON.parse(JSON.stringify(rec));
  tampered2.decision = 'invalidate';
  assert.equal(replayAdjudication(tampered2).ok, false);
});

test('R10: replay 对残缺记录不抛，返回 record/missing', () => {
  assert.deepEqual(replayAdjudication(null).diffs, ['record/missing']);
  assert.equal(replayAdjudication({}).ok, false);
});

// ---------------------------------------------------------------------------
// 结构校验（给 R13 闸 2b 的入口）
// ---------------------------------------------------------------------------

test('R10: validateAdjudication 逐字段核形态；共享上下文的记录被判不合规', () => {
  const good = adjudicate({ target: 'c-ffff0001', votes: [vote('m-a', 'support'), vote('m-b', 'support')] });
  assert.deepEqual(validateAdjudication(good), { ok: true, errors: [] });

  assert.equal(validateAdjudication(null).ok, false);
  const bad = {
    ...good,
    n: 99,
    agreement: 2,
    decision: 'whatever',
    votes: [vote('m-a', 'support', { contextId: 'same' }), vote('m-b', 'support', { contextId: 'same' })],
  };
  const res = validateAdjudication(bad);
  assert.equal(res.ok, false);
  const codes = res.errors.map((e) => e.code);
  assert.ok(codes.includes('adjudication/n-mismatch'));
  assert.ok(codes.includes('adjudication/invalid-agreement'));
  assert.ok(codes.includes('adjudication/invalid-decision'));
  assert.ok(codes.includes('adjudication/shared-context'));
});

test('R10: aggregateVotes 是纯函数（同输入同输出，不改入参）', () => {
  const votes = [vote('m-a', 'support'), vote('m-b', 'oppose')];
  const snapshot = JSON.stringify(votes);
  const a = aggregateVotes({ votes });
  const b = aggregateVotes({ votes });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(votes), snapshot, '不修改调用方的票');
  assert.equal(a.decision, 'hold-disputed');
});
