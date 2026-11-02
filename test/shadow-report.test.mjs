import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const card = (section) => ({
  indexLine: 'MEMORY: /index.md（scope=w:d:/x, 2 局）',
  section,
  claims: section ? [{ claimId: 'c-1', text: 'x', occurredAt: 1 }] : [],
  tokens: section ? 120 : 16,
  shadow: true,
});

test('shadow-report：读影子台账，区分"本来会注入"与沉默，给 token 分位', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifuin-shadow-'));
  try {
    const file = path.join(dir, 'shadow.jsonl');
    const rows = [
      { version: 1, mode: 'shadow', injected: false, at: 1, signal: { kind: 'root-message', terms: ['棋院'] }, card: card('<memory-ledger>\n- [antipattern] x (ep-aaaaaaa1, 2026-10-22, seq 30)\n</memory-ledger>') },
      { version: 1, mode: 'shadow', injected: false, at: 2, signal: { kind: 'root-message', terms: ['随便'] }, card: card(null) },
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/shadow-report.mjs'), '--dir', dir], { cwd: ROOT, encoding: 'utf8' });
    const report = JSON.parse(out);
    assert.equal(report.records, 2);
    assert.equal(report.wouldInject, 1);
    assert.equal(report.silent, 1);
    assert.equal(report.silentRate, 0.5);
    assert.equal(report.tokens.n, 1);
    assert.equal(report.tokensAll.n, 2);
    assert.equal(report.silentIndexOnlyTokens, 16);
    assert.equal(report.claimsPerCard, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shadow-report：台账不存在时退出码 2（不伪造 0）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kifuin-shadow-empty-'));
  try {
    let code = 0;
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/shadow-report.mjs'), '--dir', dir], { cwd: ROOT, stdio: 'pipe' });
    } catch (error) {
      code = error.status;
    }
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
