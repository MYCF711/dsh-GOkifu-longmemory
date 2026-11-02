import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registrationHit } from '../scripts/install-doctor.mjs';

function fixture(files) {
  const home = mkdtempSync(path.join(tmpdir(), 'kifu-doctor-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(home, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return home;
}

test('install-doctor: 未注册 ⇒ hits 为空', () => {
  const home = fixture({ 'profiles/desktop/cordis.patch.yml': 'plugins: []\n' });
  try {
    const reg = registrationHit(home);
    assert.deepEqual(reg.hits, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install-doctor: 注册但 disabled:true 会被单独计数', () => {
  const yml = 'services:\n  - id: kifu-longmemory\n    name: dsh-gokifu-longmemory\n    disabled: true\n  - id: other\n    name: something-else\n';
  const home = fixture({ 'profiles/desktop/cordis.patch.yml': yml });
  try {
    const reg = registrationHit(home);
    assert.ok(reg.hits.length >= 1);
    assert.equal(reg.disabled, 1, '只有带 disabled:true 的那条算禁用');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install-doctor: 跳过 memory-context/sessions 等大目录', () => {
  const home = fixture({
    'memory-context/claims/c-1.json': '{"text":"dsh-gokifu-longmemory"}',
    'sessions/x/session.json': '{"name":"dsh-gokifu-longmemory"}',
    'profiles/desktop/cordis.patch.yml': 'name: dsh-gokifu-longmemory\n',
  });
  try {
    const reg = registrationHit(home);
    assert.equal(reg.hits.length, 1, '只应命中 profiles 配置');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
