import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { summarize } from '../scripts/repeat-report.mjs';
import { writeRepeatTelemetry, apply } from '../src/plugin.mjs';

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

// 2026-11-02：影子模式下 D5 也记遥测（本来会补卡），便于开注入前观察
test('D5 影子遥测：shadow:true 且不改变 messages', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { apply } = await import('../src/plugin.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'kifu-shadow-tele-'));
  const { ctx, hooks } = makeCtxForShadow();
  apply(ctx, {
    shadow: true, enabled: false, storeRoot: dir, shadowDir: dir,
    repeatHint: true, repeatHintAfter: 2, repeatHintMax: 1,
  });
  const session = { id: 's-shadow' };
  const step = (texts) => hooks['agent/pre-step'](
    { agent: { session }, messages: texts.map((t) => ({ role: 'user', content: [{ type: 'text', text: t }] })) },
    async () => ({ kind: 'enter', messages: [{ role: 'assistant', content: [] }] }),
  );
  await step(['a', 'Error: cannot edit "x": file has not been read']);
  const second = await step(['a', 'Error: cannot edit "x": file has not been read', 'b', 'Error: cannot modify "y": file has not been read']);
  assert.equal(second.messages.length, 1, '影子模式不得改变 messages');
  const file = path.join(dir, 'repeat-hint.jsonl');
  assert.ok(existsSync(file), '影子模式也要写 D5 遥测');
  const row = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]);
  assert.equal(row.shadow, true);
  assert.equal(row.cls, 'fs-read-before-write');
});

function makeCtxForShadow() {
  const hooks = {};
  const ctx = {
    on(event, handler) { (hooks[event] ??= []).push(handler); },
    inject() {},
    logger: { warn() {}, info() {}, error() {} },
  };
  return { ctx, hooks: new Proxy({}, { get: (_t, prop) => (hooks[prop] && hooks[prop][0]) || undefined }) };
}
