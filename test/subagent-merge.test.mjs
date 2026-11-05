// T293 · 子代理失败归并：口径（什么算真失败）+ 幂等 + 不跨 scope
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailureText, planMerge, mergeKey } from '../scripts/subagent-merge.mjs';

test('T293 口径①：todo/进度消息**不算**失败', () => {
  for (const t of [
    'Updated todo list: 4 pending, 1 in progress, 0 completed.',
    'pending',
    'in progress',
    'completed',
  ]) {
    assert.equal(classifyFailureText(t).failure, false, t);
  }
});

test('T293 口径②：真 `Error:` / 异常名 / 非零退出码**算**失败', () => {
  assert.equal(classifyFailureText('Error: Cannot find module "yaml"').failure, true);
  assert.equal(classifyFailureText('error: failed to push some refs').failure, true);
  assert.equal(classifyFailureText('TypeError: x is not a function').failure, true);
  assert.equal(classifyFailureText('[exit code: 1]').failure, true);
  assert.equal(classifyFailureText('[exit code: 0]').failure, false, 'exit 0 不是失败');
  assert.equal(classifyFailureText('', { isError: true }).failure, true, 'isError 优先');
});

test('T293 幂等：重放两次同结果（按 subEpisode+seq 去重）', () => {
  const episodes = [
    { id: 'ep-parent', sessionId: 's-parent', delegationDepth: 0, scopeKey: 'w:/a', signals: { failures: 0 } },
    { id: 'ep-child1', sessionId: 's-c1', parentSessionId: 's-parent', delegationDepth: 1, scopeKey: 'w:/a', signals: { failures: 2 } },
    { id: 'ep-child2', sessionId: 's-c2', parentSessionId: 's-parent', delegationDepth: 1, scopeKey: 'w:/a', signals: { failures: 1 } },
  ];
  const p1 = planMerge({ episodes, claims: [] });
  assert.equal(p1.toMerge.length, 2);
  assert.equal(p1.newSupports, 2);
  const claims = p1.toMerge.map((m) => ({ id: `c-${m.child}`, support: [{ provenanceRepair: { kind: 'subagent-merge', from: m.child, seq: 0 } }] }));
  const p2 = planMerge({ episodes, claims });
  assert.equal(p2.toMerge.length, 0, '第二次 0 变更');
  assert.equal(p2.alreadyMerged, 2);
  assert.equal(mergeKey('ep-x', 3), 'ep-x#3');
});

test('T293 不跨 scope：父子 scopeKey 不同 ⇒ 不归并（A5 仍 0）', () => {
  const episodes = [
    { id: 'ep-parent', sessionId: 's-parent', delegationDepth: 0, scopeKey: 'w:/a', signals: { failures: 0 } },
    { id: 'ep-child', sessionId: 's-c', parentSessionId: 's-parent', delegationDepth: 1, scopeKey: 'w:/b', signals: { failures: 3 } },
  ];
  const p = planMerge({ episodes, claims: [] });
  assert.deepEqual(p.toMerge, [], '跨 scope 不许归并');
  assert.equal(p.childrenWithFailures, 1);
  assert.equal(p.alreadyMerged, 0);
});
