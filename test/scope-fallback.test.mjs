import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionScope } from '../src/plugin.mjs';

const fakeStore = (episodes) => ({ list: (kind) => (kind === 'episodes' ? episodes.map((record) => ({ record })) : []) });
const STORE_ROOT = 'D:/DeepSeek Harness/home/memory-context';

test('scope 兜底：cwd 在 DSH_HOME 里 ⇒ 用本会话历史 episode 的 scopeKey', () => {
  const store = fakeStore([{ sessionId: 's1', scopeKey: 'w:d:/proj/a', lastEventAt: 10 }]);
  const r = resolveSessionScope({ session: { id: 's1', cwd: 'D:/DeepSeek Harness/home/profiles/desktop' }, store, storeRoot: STORE_ROOT });
  assert.equal(r.scope, 'w:d:/proj/a');
  assert.equal(r.from, 'episode-fallback');
});

test('scope 兜底：cwd 正常 ⇒ 直接用 cwd', () => {
  const store = fakeStore([]);
  const r = resolveSessionScope({ session: { id: 's2', cwd: 'D:/proj/b' }, store, storeRoot: STORE_ROOT });
  assert.equal(r.scope, 'w:d:/proj/b');
  assert.equal(r.from, 'session-cwd');
});

test('scope 兜底：cwd 在 HOME 但没有历史 episode ⇒ 保持 cwd（不乱猜）', () => {
  const store = fakeStore([]);
  const r = resolveSessionScope({ session: { id: 's3', cwd: 'D:/DeepSeek Harness/home/profiles/desktop' }, store, storeRoot: STORE_ROOT });
  assert.equal(r.from, 'session-cwd');
  assert.ok(r.scope.toLowerCase().startsWith('w:d:/deepseek harness/home/profiles/desktop'));
});

test('scope 兜底：新会话无 episode 时，读日志 header 的 cwd', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const zlib = await import('node:zlib');
  const path = (await import('node:path')).default;
  const home = mkdtempSync(path.join(tmpdir(), 'kifu-home-'));
  const sid = 'sess-test-1';
  const dir = path.join(home, 'sessions', '--D-proj--', sid);
  mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ type: 'session', version: 4, id: sid, cwd: 'D:/proj/real' }) + '\n';
  writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(header)));
  const store = fakeStore([]);
  const r = resolveSessionScope({ session: { id: sid, cwd: path.join(home, 'profiles', 'desktop') }, store, storeRoot: path.join(home, 'memory-context') });
  assert.equal(r.from, 'session-log');
  assert.equal(r.scope.toLowerCase(), 'w:d:/proj/real');
  rmSync(home, { recursive: true, force: true });
});
