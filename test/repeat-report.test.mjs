import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { summarize } from '../scripts/repeat-report.mjs';
import { writeRepeatTelemetry } from '../src/plugin.mjs';

test('D5 遥测：写入影子目录的 repeat-hint.jsonl，只放机械量', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kifu-tele-'));
  try {
    writeRepeatTelemetry({
      config: { shadowDir: dir },
      trigger: { cls: 'fs-read-before-write', count: 2 },
      card: { tokens: 120 },
      digest: 'abc123',
      at: 1793616000000,
    });
    const lines = readFileSync(path.join(dir, 'repeat-hint.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.kind, 'repeat-hint');
    assert.equal(row.cls, 'fs-read-before-write');
    assert.equal(row.count, 2);
    assert.equal(row.tokens, 120);
    assert.equal(row.digest, 'abc123');
    assert.equal(row.at, 1793616000000);
    // 不含路径/会话语义
    assert.doesNotMatch(lines[0], /[A-Za-z]:\|\/d\/|session-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D5 报表：按类聚合、去重 digest 计会话数、token 均值', () => {
  const out = summarize([
    JSON.stringify({ kind: 'repeat-hint', cls: 'a', tokens: 100, digest: 'd1', at: 1 }),
    JSON.stringify({ kind: 'repeat-hint', cls: 'a', tokens: 200, digest: 'd2', at: 2 }),
    JSON.stringify({ kind: 'repeat-hint', cls: 'b', tokens: 300, digest: 'd2', at: 3 }),
    'not json',
    JSON.stringify({ kind: 'shadow' }),
  ]);
  assert.equal(out.total, 3);
  assert.equal(out.sessions, 2);
  assert.deepEqual(out.byClass, [['a', 2], ['b', 1]]);
  assert.equal(out.tokensAvg, 200);
});
