import test from 'node:test';
import assert from 'node:assert/strict';
import { cwdFromScope } from '../scripts/replay-live.mjs';

test('replay-live: scopeKey → 工作区路径（盘符还原、分隔符统一）', () => {
  assert.equal(cwdFromScope('w:d:/DeepSeek Harness/default-workspace/长期记忆系统'), 'D:/DeepSeek Harness/default-workspace/长期记忆系统');
  assert.equal(cwdFromScope('w:e:/Documents/x'), 'E:/Documents/x');
  assert.equal(cwdFromScope('u:owner'), process.cwd());
  assert.equal(cwdFromScope(null), process.cwd());
});
