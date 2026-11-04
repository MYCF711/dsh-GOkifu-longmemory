// R00 tooling：tag 审计（0.118.0）—— 事故：v0.116.0 指到 PR 前的分支提交，那里 package.json 已是 0.117.0。
// 闸的判据是「tag 名 == 该提交里的 version」，只认机械事实，不看提交信息。
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTags } from '../scripts/tag-audit.mjs';

test('tag-audit: 版本一致即通过（含软警不影响结论）', () => {
  const res = auditTags([
    { tag: 'v0.117.0', commit: 'a'.repeat(40), version: '0.117.0', onMain: true },
    { tag: 'v0.9.0', commit: 'b'.repeat(40), version: '0.9.0', onMain: false },
  ]);
  assert.deepEqual(res.bad, []);
  assert.equal(res.checked, 2);
  assert.equal(res.warn.length, 1, '不在 main 上只告警');
});

test('tag-audit: tag 名与内容版本不符 ⇒ 硬红（0.116.0 的真实形态）', () => {
  const res = auditTags([
    { tag: 'v0.116.0', commit: 'c'.repeat(40), version: '0.117.0', onMain: false },
  ]);
  assert.equal(res.bad.length, 1);
  assert.match(res.bad[0], /v0\.116\.0/);
  assert.match(res.bad[0], /0\.117\.0/);
  assert.match(res.bad[0], /与 tag 名不符/);
});

test('tag-audit: 取不到 version ⇒ 硬红（fail-closed，不当成一致）', () => {
  const res = auditTags([{ tag: 'v1.0.0', commit: 'd'.repeat(40), version: null, onMain: true }]);
  assert.equal(res.bad.length, 1);
  assert.match(res.bad[0], /取不到/);
});

test('tag-audit: 非 v 前缀 tag 按去掉前缀后的字面比', () => {
  const ok = auditTags([{ tag: '0.117.0', commit: 'e'.repeat(40), version: '0.117.0', onMain: true }]);
  assert.deepEqual(ok.bad, []);
  const bad = auditTags([{ tag: 'v0.1.0', commit: 'f'.repeat(40), version: '0.1.1', onMain: true }]);
  assert.equal(bad.bad.length, 1);
});

test('tag-audit: 空集合不红', () => {
  const res = auditTags([]);
  assert.deepEqual(res, { checked: 0, bad: [], warn: [] });
});
