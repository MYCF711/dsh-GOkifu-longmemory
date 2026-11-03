// 签名索引（N9，2026-11-03）：把"某局里真实出现过的失败原文"按归一化签名索引起来，
// 让注入层能按**签名**（而不是按类别）找到对应的历史失败行。
// 数据是派生的，可随时重建：scripts/build-sigindex.mjs。
// 文件：<storeRoot>/signature-index.json  { version, builtAt, entries: { [key]: [{episode, edgeId, seq, occurredAt, snippet}] } }

import fs from 'node:fs';
import path from 'node:path';

export const SIG_INDEX_FILE = 'signature-index.json';
export const SIG_INDEX_VERSION = 1;

export function sigIndexPath(storeRoot) {
  return path.join(storeRoot, SIG_INDEX_FILE);
}

export function loadSignatureIndex(storeRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(sigIndexPath(storeRoot), 'utf8'));
    if (!data || data.version !== SIG_INDEX_VERSION || typeof data.entries !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

export function writeSignatureIndex(storeRoot, entries, now = Date.now()) {
  fs.mkdirSync(storeRoot, { recursive: true });
  const data = { version: SIG_INDEX_VERSION, builtAt: now, entries };
  fs.writeFileSync(sigIndexPath(storeRoot), `${JSON.stringify(data)}\n`, 'utf8');
  return data;
}

/** 取某签名在索引里的条目（最多 limit 条，按时间从新到旧）。 */
export function lookupSignature(index, key, { limit = 2 } = {}) {
  if (!index || !key) return [];
  const list = index.entries[String(key)];
  if (!Array.isArray(list)) return [];
  return list.slice().sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0)).slice(0, limit);
}
