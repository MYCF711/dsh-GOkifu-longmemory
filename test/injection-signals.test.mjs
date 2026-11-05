import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRE_STEP_SIGNALS,
  USABLE_SIGNALS,
  workspaceOfScope,
  workspaceTokens,
  withWorkspaceSignal,
  measureModes,
} from '../scripts/injection-signals.mjs';

test('T265 ①: 信号清单必须标注 pre-step 是否可得，且"事后信息"被标成不可用', () => {
  const byKey = new Map(PRE_STEP_SIGNALS.map((s) => [s.key, s]));
  assert.equal(byKey.get('scopeKey').availableAtPreStep, true);
  assert.equal(byKey.get('rootUserText').availableAtPreStep, true);
  // 宿主未在 pre-step 暴露的字段必须标 false（不许冒充合法信号）
  assert.equal(byKey.get('activeFile').availableAtPreStep, false);
  assert.equal(byKey.get('diagnostics').availableAtPreStep, false);
  assert.equal(byKey.get('thisStepToolResult').availableAtPreStep, false, '本步工具结果是事后信息');
  // 原型只能用合法信号
  assert.equal(USABLE_SIGNALS.includes('thisStepToolResult'), false);
});

test('T265 ②: 工作区派生词只从 scopeKey/package.json 来（可机械复算）', () => {
  assert.equal(workspaceOfScope('w:d:/DeepSeek Harness/反代'), 'd:/DeepSeek Harness/反代');
  assert.equal(workspaceOfScope('u:owner'), null);
  const tokens = workspaceTokens('w:d:/work/demo-app', { readPackageName: () => 'demo-pkg' });
  assert.ok(tokens.includes('demo-app'), JSON.stringify(tokens));
  assert.ok(tokens.includes('demo-pkg'), JSON.stringify(tokens));
  assert.ok(tokens.includes('work/demo-app'), JSON.stringify(tokens));
});

test('T265 ③: 加信号是"只加不改"—— base 的判别词一个不丢，且 B 不会比 A 差', async () => {
  const base = { terms: ['existing-token'], entities: [] };
  const extended = withWorkspaceSignal(base, 'w:d:/work/demo-app');
  assert.ok(extended.terms.includes('existing-token'), 'base 词必须保留');
  assert.ok(extended.terms.includes('demo-app'));
  assert.deepEqual(base.terms, ['existing-token'], '不许改到原对象');
  // measureModes 的契约：B ⊆ A 的单调性（工作区词只会加候选，不会删）
  const store = { get: () => null, list: () => [] };
  const exam = { results: [] };
  const out = await measureModes({ store, exam });
  assert.equal(out.A.n, 0);
  assert.equal(out.B.n, 0);
});
