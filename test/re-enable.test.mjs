import test from 'node:test';
import assert from 'node:assert/strict';
import { stripDisableBlock, validatePatch } from '../scripts/re-enable.mjs';

const PATCH = `- id: other
  name: "@x/theme"
  config:
    a: 1

# === 临时禁用：dsh-gokifu-longmemory ===
- id: kifu
  name: dsh-gokifu-longmemory
  disabled: true
- id: dsh-gokifu-longmemory
  name: dsh-gokifu-longmemory
  disabled: true
- id: keep
  name: "@x/others"
`;

test('stripDisableBlock: 只摘本插件块与注释，别的块原样保留', () => {
  const r = stripDisableBlock(PATCH);
  assert.equal(r.removedEntries, 2);
  assert.equal(r.removedComments, 1);
  assert.ok(!r.text.includes('dsh-gokifu-longmemory'));
  assert.ok(r.text.includes('@x/theme'));
  assert.ok(r.text.includes('@x/others'));
});

test('stripDisableBlock: 没有本插件时原样返回', () => {
  const text = '- id: a\n  name: "@x/a"\n';
  const r = stripDisableBlock(text);
  assert.equal(r.removed, 0);
  assert.equal(r.text, text);
});

test('validatePatch: 块数按"仅条目"计（注释不算块）', () => {
  const r = stripDisableBlock(PATCH);
  const errs = validatePatch(PATCH, r.text, r.removedEntries);
  assert.deepEqual(errs, [], errs.join('；'));
});

test('validatePatch: 块数不对要报（防误删别人的条目）', () => {
  const r = stripDisableBlock(PATCH);
  const wrong = validatePatch(PATCH, r.text, 5);
  assert.ok(wrong.some((e) => e.includes('块数不对')));
});
