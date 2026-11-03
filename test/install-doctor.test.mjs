import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registrationHit, doctor } from '../scripts/install-doctor.mjs';

const mk = (patch, pkg = {}) => {
  const home = mkdtempSync(path.join(tmpdir(), 'kifu-doc-'));
  const dir = path.join(home, 'profiles', 'desktop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'cordis.patch.yml'), patch);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return home;
};

test('doctor: 只有 disabled 块 ⇒ 未启用（不准报已注册）', () => {
  const home = mk(`- id: kifu
  name: dsh-gokifu-longmemory
  disabled: true
- id: dsh-gokifu-longmemory
  name: dsh-gokifu-longmemory
  disabled: true
`);
  const r = registrationHit(home);
  assert.equal(r.enabled, 0);
  assert.equal(r.disabled, 2);
  rmSync(home, { recursive: true, force: true });
});

test('doctor: 注释里提到包名不算命中（防假阳性）', () => {
  const home = mk(`- id: theme
  name: "@x/ui-theme"
  config:
    preference: dark

# === 临时禁用：dsh-gokifu-longmemory ===
- id: kifu
  name: dsh-gokifu-longmemory
  disabled: true
`);
  const r = registrationHit(home);
  assert.equal(r.enabled, 0, '注释不能被算成启用块');
  assert.equal(r.disabled, 1);
  rmSync(home, { recursive: true, force: true });
});

test('doctor: package.json 依赖/bundles 有包名 ⇒ 启用', () => {
  const home = mk('', { dependencies: { 'dsh-gokifu-longmemory': 'link:/x' } });
  const r = registrationHit(home);
  assert.equal(r.enabled, 1);
  rmSync(home, { recursive: true, force: true });
});

test('doctor: 没有注册 ⇒ enabled=0 且 hits 为空', () => {
  const home = mk('- id: theme\n  name: "@x/ui-theme"\n');
  const r = registrationHit(home);
  assert.equal(r.enabled, 0);
  assert.deepEqual(r.hits, []);
  rmSync(home, { recursive: true, force: true });
});
