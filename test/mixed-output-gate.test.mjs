// T325 · 混合输出判据：R2 段内最终结论 + X3 依赖链（缺则 observed，不许编）
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalConclusion, dependencyChainOf, gateClaim } from '../scripts/mixed-output-gate.mjs';

test('T325 ① `ok verify … rebuild: FAIL` ⇒ 判失败（看最终结论）', () => {
  assert.equal(finalConclusion('ok verify: OK\nrebuild: FAIL'), 'failure');
  // 但 A1 门只认 `Error:` / 非零退出码 —— `rebuild: FAIL` 本身不是失败原文 ⇒ 仍被挡（不冒充真失败）
  assert.equal(gateClaim('ok verify: OK\nrebuild: FAIL').state, 'rejected');
  // 混有真错误行 ⇒ 按最终结论判为失败
  assert.notEqual(gateClaim('ok verify: OK\nError: rebuild failed').state, 'rejected');
});

test('T325 ② `rebuild: FAIL … ok verify` ⇒ FAIL 不因顺序抵消', () => {
  assert.equal(finalConclusion('rebuild: FAIL\nok verify: OK'), 'success', '最后一条是成功');
  assert.equal(finalConclusion('rebuild: FAIL\nok verify: OK\nError: boom'), 'failure', '后续又失败 ⇒ 失败');
  assert.equal(finalConclusion('ok build\nok verify\n✖ test/foo.test.mjs'), 'failure', '上游成功不抵消下游失败');
});

test('T325 ③ 无失败主体 ⇒ observed（补不出 X3 就不进注入）', () => {
  const r = gateClaim('Error: unknown job');
  assert.equal(r.state, 'observed');
  assert.equal(r.chain, null);
  assert.equal(gateClaim('=== 方案 1：端口检查命令 ===').state, 'rejected', 'A1 门先挡掉噪声');
});

test('T325 ④ 有 X3 ⇒ reusable（文件 / 目标 / 测试名都能取）', () => {
  const a = gateClaim('Error: cannot modify "/d/ws/src/engine.mjs": file has not been read');
  assert.equal(a.state, 'reusable');
  assert.equal(a.chain.kind, 'file');
  assert.equal(a.chain.subject, '/d/ws/src/engine.mjs');
  assert.equal(dependencyChainOf("[exit code: 1]"), null, "只有退出码没有主体 ⇒ 无依赖链");
  assert.equal(dependencyChainOf('ok verify\nall good'), null, '没有失败行 ⇒ 无依赖链');
});
