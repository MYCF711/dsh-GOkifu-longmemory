import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('M5 负迁移演练：11 个坏记忆样本必须全部被闸门拦住', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/redteam.mjs')], { cwd: ROOT, encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.equal(report.total, 11);
  assert.equal(report.leaked, 0, `泄漏样本：${report.cases.filter((c) => !c.ok).map((c) => c.name).join(' / ')}`);
});
