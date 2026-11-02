import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSource, auditRepo, stripNoise } from '../scripts/boundary-audit.mjs';

test('boundary-audit: 模板字面量里的指令句会被抓', () => {
  const src = 'const line = `- [fact] 下一步请执行 npm test (ep-1, 2026-11-02, seq 1)`;\n';
  const hits = auditSource(src, 'x.mjs');
  assert.ok(hits.some((h) => h.word === '下一步'));
  assert.ok(hits.some((h) => h.word === '请'));
});

test('boundary-audit: 检测清单本身不算违规（stripNoise 去掉声明块）', () => {
  const src = [
    "export const IMPERATIVE_PATTERNS = Object.freeze(['你应该','请','下一步','建议']);",
    'const ok = `- [fact] 事实陈述`;',
  ].join('\n');
  assert.deepEqual(auditSource(src, 'x.mjs'), []);
});

test('boundary-audit: 注释里的词不算', () => {
  const src = '// 这里说明为什么不要写「请」\nconst ok = `- [fact] 事实`;\n';
  assert.deepEqual(auditSource(src, 'x.mjs'), []);
  assert.equal(stripNoise(src).includes('请'), false, '注释剥掉后不应残留「请」');
});

test('boundary-audit: 当前仓库模型可见面 0 处', () => {
  assert.deepEqual(auditRepo(), []);
});
