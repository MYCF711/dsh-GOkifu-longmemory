// T62（2026-11-09）· **每个 kind 一个 bundle 文件**：把"读 1.5 万个 json"变成"读一个文件"。
//
// 为什么：`store.list()` 每次都要逐个文件 `readFileSync + JSON.parse` —— 真库实测 6.9 秒
// （links 11083 个文件一个就 5.1 秒）。两个后果：
//   ① 进程内第一次查记忆要等这么久；② T61 加了"空闲即还"之后，闲置 10 分钟后的第一轮会卡 6 秒。
//
// 做法：慢路径读完一个 kind 之后，把它整份写成 `<root>/.cache/<kind>.bundle.json`（原子替换）。
// 失效判据（便宜且机械）：`manifest.json` 的 mtime+字节数 + **该 kind 目录的条目数**。
//   · store 每次真变更都会重写 manifest ⇒ mtime/size 变；
//   · 绕过 store 直接往目录里丢/删文件 ⇒ 条目数变。
//   任一不一致 ⇒ 返回 null，调用方走慢路径并重写 bundle。
//
// 纪律：
//   · **纯派生**：删掉 `.cache/` 只会让下一次变慢，读数一字不变；
//   · 写盘失败一律吞掉（缓存永远不许拖垮注入/工具）；
//   · 版本号不匹配 ⇒ 当作没有（不静默降级到"半新半旧"）。
import fs from 'node:fs';
import path from 'node:path';

export const KIND_BUNDLE_VERSION = 1;
export const WALK_BUNDLE_KINDS = Object.freeze(['topics', 'episodes', 'links', 'claims']);
export const KIND_BUNDLE_DIR = '.cache';

const bundleFile = (storeRoot, kind) => path.join(String(storeRoot ?? ''), KIND_BUNDLE_DIR, `${kind}.bundle.json`);

/** 该 kind 的失效判据（1 次 stat + 1 次 readdir）。没有 manifest ⇒ null（不启用）。 */
export function kindBundleStamp(storeRoot, kind) {
  const root = String(storeRoot ?? '');
  if (!root) return null;
  let manifest = '';
  try {
    const st = fs.statSync(path.join(root, 'manifest.json'));
    manifest = `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  let n = -1;
  try {
    n = fs.readdirSync(path.join(root, kind)).filter((name) => name.endsWith('.json')).length;
  } catch {
    n = -1;
  }
  return `v${KIND_BUNDLE_VERSION}|${manifest}|${kind}:${n}`;
}

/** 读某 kind 的 bundle；不匹配/损坏/版本不符 ⇒ null。 */
export function readKindBundle(storeRoot, kind, { stamp = kindBundleStamp(storeRoot, kind) } = {}) {
  if (!stamp) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(bundleFile(storeRoot, kind), 'utf8'));
    if (!parsed || parsed.version !== KIND_BUNDLE_VERSION || parsed.kind !== kind) return null;
    if (parsed.stamp !== stamp) return null;
    return Array.isArray(parsed.records) ? parsed.records : null;
  } catch {
    return null;
  }
}

/** 写某 kind 的 bundle（best-effort，原子替换）。 */
export function writeKindBundle(storeRoot, kind, records, { stamp = kindBundleStamp(storeRoot, kind) } = {}) {
  if (!stamp || !Array.isArray(records)) return false;
  const file = bundleFile(storeRoot, kind);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: KIND_BUNDLE_VERSION, kind, stamp, records }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败就随它 */ }
    return false;
  }
}

/** 删掉某个 kind（或全部）的 bundle：测试与人工排查用。 */
export function dropKindBundles(storeRoot, kinds = WALK_BUNDLE_KINDS) {
  let ok = true;
  for (const kind of kinds) {
    try { fs.rmSync(bundleFile(storeRoot, kind), { force: true }); } catch { ok = false; }
  }
  return ok;
}

/**
 * T65（2026-11-09）：**同一份 bundle 不重复解析**。
 *
 * 实测：一次"建卡"里 `store.list()` 会被调用多次（walk 一次、inject 再几次），而每次读 bundle 都要
 * `JSON.parse` 十几 MB（episodes bundle 12MB ≈ 100ms）⇒ 一次建卡 180ms 里有大半是**重复解析同一份数据**。
 * 这里加一层**极短命**的内存 memo（`KIND_MEMO_MS`）：stamp 一致就直接给数组。
 *
 * 为什么敢：① stamp 覆盖 manifest + 条目数（库一变立刻失效）；② TTL 只有几秒，且闲置就清；
 * ③ 它缓存的是"某个 stamp 对应的记录数组"，与磁盘 bundle 同源，不会比 bundle 更新鲜或更陈旧。
 */
export const KIND_MEMO_MS = 5_000;
const KIND_MEMO = new Map(); // `${root}|${kind}` -> { stamp, records, at }
let KIND_MEMO_TIMER = null;

export function dropKindMemo(storeRoot = null) {
  if (storeRoot === null) KIND_MEMO.clear();
  else for (const key of [...KIND_MEMO.keys()]) if (key.startsWith(`${storeRoot}|`)) KIND_MEMO.delete(key);
  if (KIND_MEMO.size === 0 && KIND_MEMO_TIMER) { clearTimeout(KIND_MEMO_TIMER); KIND_MEMO_TIMER = null; }
}

function scheduleMemoSweep() {
  if (KIND_MEMO_TIMER) return;
  KIND_MEMO_TIMER = setTimeout(() => {
    KIND_MEMO_TIMER = null;
    const now = Date.now();
    for (const [key, entry] of [...KIND_MEMO]) {
      if (now - entry.at > KIND_MEMO_MS) KIND_MEMO.delete(key);
    }
    if (KIND_MEMO.size > 0) scheduleMemoSweep();
  }, KIND_MEMO_MS);
  if (typeof KIND_MEMO_TIMER?.unref === 'function') KIND_MEMO_TIMER.unref();
}

/** 读 bundle 的**带 memo** 版本（stamp 一致且未过期 ⇒ 直接返回内存数组）。 */
export function readKindBundleCached(storeRoot, kind, { stamp = kindBundleStamp(storeRoot, kind), now = Date.now() } = {}) {
  if (!stamp) return null;
  const key = `${storeRoot}|${kind}`;
  const hit = KIND_MEMO.get(key);
  if (hit && hit.stamp === stamp && (now - hit.at) < KIND_MEMO_MS) return hit.records;
  const records = readKindBundle(storeRoot, kind, { stamp });
  if (!records) { KIND_MEMO.delete(key); return null; }
  KIND_MEMO.set(key, { stamp, records, at: now });
  scheduleMemoSweep();
  return records;
}
