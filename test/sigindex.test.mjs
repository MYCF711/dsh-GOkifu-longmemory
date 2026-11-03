import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeSignatureIndex, loadSignatureIndex, lookupSignature, SIG_INDEX_VERSION } from '../src/rooms/sigindex.mjs';

test('签名索引：写入后可读，版本不符返回 null', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kifu-sig-'));
  writeSignatureIndex(root, { 'k1': [{ episode: 'ep-a', edgeId: 'e1', seq: 3, occurredAt: 10, snippet: 'x' }] });
  const idx = loadSignatureIndex(root);
  assert.equal(idx.version, SIG_INDEX_VERSION);
  assert.equal(idx.entries.k1.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test('签名索引：lookup 按时间倒序并尊重 limit', () => {
  const idx = { version: 1, entries: { k: [
    { episode: 'ep-old', occurredAt: 1 },
    { episode: 'ep-new', occurredAt: 9 },
    { episode: 'ep-mid', occurredAt: 5 },
  ] } };
  assert.deepEqual(lookupSignature(idx, 'k', { limit: 2 }).map((x) => x.episode), ['ep-new', 'ep-mid']);
  assert.deepEqual(lookupSignature(idx, 'missing'), []);
});

test('签名索引：没有索引文件时返回 null（不影响注入）', () => {
  assert.equal(loadSignatureIndex(path.join(tmpdir(), 'kifu-none-' + Date.now())), null);
});

test('签名索引：同一文件重复读取命中缓存，重写后失效', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kifu-sig2-'));
  writeSignatureIndex(root, { a: [{ episode: 'ep-1', occurredAt: 1 }] });
  const first = loadSignatureIndex(root);
  const second = loadSignatureIndex(root);
  assert.equal(first, second, '第二次应是同一个对象（缓存）');
  writeSignatureIndex(root, { a: [{ episode: 'ep-2', occurredAt: 2 }] });
  const third = loadSignatureIndex(root);
  assert.notEqual(third, first, '重写后必须失效');
  assert.equal(third.entries.a[0].episode, 'ep-2');
  rmSync(root, { recursive: true, force: true });
});
