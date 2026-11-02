import test from 'node:test';
import assert from 'node:assert/strict';
import { stripDisableBlock } from '../scripts/re-enable.mjs';

const NAME = 'dsh-gokifu-longmemory';

test('re-enable: 精准删掉禁用条目，保留其它条目与注释', () => {
  const yml = [
    'services:',
    '  - id: keep-me',
    '    name: other-plugin',
    '    config:',
    '      a: 1',
    '# === 临时禁用：dsh-gokifu-longmemory（cap: 卡死 web boot）===',
    '  - id: kifu-longmemory',
    `    name: ${NAME}`,
    '    disabled: true',
    '  - id: dsh-gokifu-longmemory',
    `    name: ${NAME}`,
    '    disabled: true',
    '  - id: after',
    '    name: tail-plugin',
  ].join('\n');
  const out = stripDisableBlock(yml, NAME);
  assert.equal(out.removed, 3, '注释 1 + 条目 2');
  assert.match(out.text, /id: keep-me/);
  assert.match(out.text, /id: after/, '后续条目必须保留');
  assert.doesNotMatch(out.text, /disabled: true/);
  assert.doesNotMatch(out.text, /临时禁用/);
});

test('re-enable: 没有禁用块时幂等（不改内容）', () => {
  const yml = 'services:\n  - id: a\n    name: keep\n';
  const out = stripDisableBlock(yml, NAME);
  assert.equal(out.removed, 0);
  assert.equal(out.text, yml);
});

test('re-enable: 已启用（无 disabled）的条目保留并计数', () => {
  const yml = `services:\n  - id: x\n    name: ${NAME}\n`;
  const out = stripDisableBlock(yml, NAME);
  assert.equal(out.removed, 0);
  assert.equal(out.disabledLeft, 1);
  assert.match(out.text, new RegExp(NAME));
});
