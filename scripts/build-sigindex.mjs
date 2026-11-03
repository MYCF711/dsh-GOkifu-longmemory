#!/usr/bin/env node
// 重建签名索引（N9）：扫所有 episode 的棋谱边，把带 errorSnippet 的失败边按归一化签名索引。
// 用法：node scripts/build-sigindex.mjs [--root <DSH_HOME>] [--store <memoryRoot>] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/rooms/persist.mjs';
import { loadGraphAt } from '../src/rooms/graphread.mjs';
import { extractErrorKey } from '../src/rooms/topic.mjs';
import { writeSignatureIndex } from '../src/rooms/sigindex.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const HOME = path.resolve(opt('root', process.env.DSH_HOME || 'D:/DeepSeek Harness/home'));
const storeRoot = path.resolve(opt('store', path.join(HOME, 'memory-context')));
const store = createStore({ root: storeRoot });
const episodes = store.list('episodes').map((x) => x.record).filter((e) => e && e.closure && e.closure.graphPath);
const entries = {};
let edges = 0;
let keyed = 0;
for (const ep of episodes) {
  const base = path.join(HOME, ep.closure.graphPath);
  if (!fs.existsSync(base)) continue;
  let graph;
  try { graph = loadGraphAt({ basePath: base }).graph; } catch { continue; }
  for (const edge of Object.values(graph?.edges ?? {})) {
    edges += 1;
    const snippet = String(edge?.errorSnippet ?? '').trim();
    if (!snippet) continue;
    const key = extractErrorKey(snippet);
    if (!key) continue;
    keyed += 1;
    if (!entries[key]) entries[key] = [];
    entries[key].push({
      episode: ep.id,
      edgeId: edge.id ?? null,
      seq: Number.isFinite(edge?.evidence?.start) ? edge.evidence.start : null,
      occurredAt: Number.isFinite(edge?.ts) ? edge.ts : (ep.lastEventAt ?? null),
      snippet: snippet.slice(0, 200),
    });
  }
}
const data = writeSignatureIndex(storeRoot, entries);
if (argv.includes('--json')) console.log(JSON.stringify({ episodes: episodes.length, edges, keyed, keys: Object.keys(entries).length, builtAt: data.builtAt }));
else console.log(`签名索引：${episodes.length} 局 · ${edges} 边 · ${keyed} 条失败原文 → ${Object.keys(entries).length} 个签名 · ${path.join(storeRoot, 'signature-index.json')}`);
