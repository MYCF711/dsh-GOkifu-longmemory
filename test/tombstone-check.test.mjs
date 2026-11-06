// T300 · tombstone-check（自动化"删掉实现必红"）tombstone 测试
// 用临时目录里的**假仓库**（fake impl + fake test）验证三态与 finally 恢复，
// 不依赖真仓库、不跑真实房间测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkTombstone } from '../scripts/tombstone-check.mjs';

function fakeRepo({ implBody, testBody, withTest = true }) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kifu-t300-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  if (implBody !== null) fs.writeFileSync(path.join(repo, 'src', 'room.mjs'), implBody);
  if (withTest) fs.writeFileSync(path.join(repo, 'test', 'room.test.mjs'), testBody);
  return repo;
}

test('T300 ①: 移走实现后测试红 ⇒ 判「有效」', () => {
  const repo = fakeRepo({
    implBody: 'export const answer = () => 42;\n',
    // 测试 import 实现：实现没了 ⇒ ERR_MODULE_NOT_FOUND ⇒ 红
    testBody: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from '../src/room.mjs';\ntest('a', () => assert.equal(answer(), 42));\n",
  });
  const r = checkTombstone({ impl: 'src/room.mjs', test: 'test/room.test.mjs', repo, vault: path.join(repo, 'tmp', 'tombstone') });
  assert.equal(r.status, 'valid', JSON.stringify(r));
  assert.notEqual(r.exitCode, 0);
  assert.equal(r.restored, true);
  assert.ok(fs.existsSync(path.join(repo, 'src', 'room.mjs')), '文件必须被恢复');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('T300 ②: 移走实现后测试仍绿 ⇒ 判「无效」并报出（测试没覆盖该房间）', () => {
  const repo = fakeRepo({
    implBody: 'export const answer = () => 42;\n',
    testBody: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('只测常量', () => assert.equal(1 + 1, 2));\n",
  });
  const r = checkTombstone({ impl: 'src/room.mjs', test: 'test/room.test.mjs', repo, vault: path.join(repo, 'tmp', 'tombstone') });
  assert.equal(r.status, 'invalid');
  assert.equal(r.exitCode, 0);
  assert.equal(r.reason, 'still-green');
  assert.ok(fs.existsSync(path.join(repo, 'src', 'room.mjs')));
  fs.rmSync(repo, { recursive: true, force: true });
});

test('T300 ③: 测试跑崩/抛异常时文件仍被恢复（finally 硬要求）', () => {
  const repo = fakeRepo({
    implBody: 'export const answer = () => 42;\n',
    testBody: 'throw new Error("boom");\n',
  });
  const r = checkTombstone({ impl: 'src/room.mjs', test: 'test/room.test.mjs', repo, vault: path.join(repo, 'tmp', 'tombstone') });
  assert.equal(r.restored, true, '必须恢复');
  assert.ok(fs.existsSync(path.join(repo, 'src', 'room.mjs')), '实现文件必须回到原位');
  const content = fs.readFileSync(path.join(repo, 'src', 'room.mjs'), 'utf8');
  assert.match(content, /answer/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('T300 ③b: runner 抛异常（模拟进程被杀）也必须恢复', () => {
  const repo = fakeRepo({ implBody: 'export const x = 1;\n', testBody: '// x\n' });
  const boom = () => { throw Object.assign(new Error('killed'), { code: 'ETIMEDOUT' }); };
  const r = checkTombstone({ impl: 'src/room.mjs', test: 'test/room.test.mjs', repo, vault: path.join(repo, 'tmp', 'tombstone'), exec: boom });
  assert.equal(r.status, 'unverified');
  assert.equal(r.restored, true);
  assert.ok(fs.existsSync(path.join(repo, 'src', 'room.mjs')));
  fs.rmSync(repo, { recursive: true, force: true });
});

test('T300 ④: 测试文件不存在 ⇒ 「未验证」单列（不判绿也不判红）', () => {
  const repo = fakeRepo({ implBody: 'export const x = 1;\n', testBody: '', withTest: false });
  const r = checkTombstone({ impl: 'src/room.mjs', test: 'test/room.test.mjs', repo, vault: path.join(repo, 'tmp', 'tombstone') });
  assert.equal(r.status, 'unverified');
  assert.equal(r.reason, 'test-missing');
  assert.ok(fs.existsSync(path.join(repo, 'src', 'room.mjs')), '实现文件不该被动过');
  fs.rmSync(repo, { recursive: true, force: true });
});
