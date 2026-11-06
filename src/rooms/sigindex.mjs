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

// 2026-11-03：加缓存。m5 一次会建几百张卡，每张都 readFile+JSON.parse 这个文件（实测单文件数百 KB），
// 直接把账算成了分钟级；按 (mtime, size) 缓存，写索引时失效。
const INDEX_CACHE = new Map();

export function loadSignatureIndex(storeRoot) {
  try {
    const file = sigIndexPath(storeRoot);
    const stat = fs.statSync(file);
    const hit = INDEX_CACHE.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.version !== SIG_INDEX_VERSION || typeof data.entries !== 'object') return null;
    INDEX_CACHE.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data });
    return data;
  } catch {
    return null;
  }
}

export function writeSignatureIndex(storeRoot, entries, now = Date.now()) {
  fs.mkdirSync(storeRoot, { recursive: true });
  const data = { version: SIG_INDEX_VERSION, builtAt: now, entries };
  const file = sigIndexPath(storeRoot);
  fs.writeFileSync(file, `${JSON.stringify(data)}\n`, 'utf8');
  // T346（2026-11-06 实测）：这里**必须**让缓存失效 —— 注释一直写着「写索引时失效」，但代码从没做。
  // 于是同进程内「重写一份**同样大小**的索引、且落在同一个 mtime 刻度」时，(mtimeMs,size) 两项都没变
  // ⇒ `loadSignatureIndex` 返回**陈旧数据**。`test/sigindex.test.mjs` 的「重写后必须失效」偶发红就是它
  // （单独跑必现、全量跑因时序错开而偶过 —— 典型 flaky）。
  INDEX_CACHE.delete(file);
  return data;
}

/** 取某签名在索引里的条目（最多 limit 条，按时间从新到旧）。 */
export function lookupSignature(index, key, { limit = 2 } = {}) {
  if (!index || !key) return [];
  const list = index.entries[String(key)];
  if (!Array.isArray(list)) return [];
  return list.slice().sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0)).slice(0, limit);
}
