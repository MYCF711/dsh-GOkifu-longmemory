// T323 · A1 门：只有"真失败"才进 antipattern（知识库 73）
import test from 'node:test';
import assert from 'node:assert/strict';
import { a1Gate } from '../scripts/antipattern-a1-gate.mjs';

test('T323 ① 行首 `Error:` ⇒ 进', () => {
  const g = a1Gate('Error: Cannot find module "yaml"');
  assert.equal(g.pass, true);
  assert.equal(g.reason, 'error-line');
  assert.equal(a1Gate('TypeError: x is not a function').pass, true);
  assert.equal(a1Gate('AssertionError: expected 1 to equal 2').pass, true);
});

test('T323 ② 方案标题 / 命令输出噪声 ⇒ **不进**（tombstone）', () => {
  for (const t of [
    '=== 方案 1：端口检查命令 ===',
    '=== 当前 IME ===',
    '方案 1：先查端口，再改配置。',
    'Updated todo list: 4 pending, 1 in progress, 0 completed.',
  ]) {
    const g = a1Gate(t);
    assert.equal(g.pass, false, `${t} 不许进 antipattern`);
    assert.equal(g.reason, 'no-failure-line');
  }
});

test('T323 ③ 独占一行的非零退出码 ⇒ 进；exit 0 ⇒ 不进', () => {
  assert.equal(a1Gate('[exit code: 1]').pass, true);
  assert.equal(a1Gate('[exit code: 1]').reason, 'exit:1');
  assert.equal(a1Gate('[exit code: 0]').pass, false, 'exit 0 不是失败');
});

test('T323 ④ 合并文本（`class:xxx · Error: …`）按段判；行中间的 Error 不算', () => {
  assert.equal(a1Gate('class:fs-read-before-write · Error: cannot modify "/a/b.mjs"').pass, true);
  assert.equal(a1Gate('When a tool returns Error, retry once.').pass, false, '行中间的 Error 不算失败');
  assert.equal(a1Gate('').pass, false, '空文本不进');
  assert.equal(a1Gate(null).pass, false);
});
