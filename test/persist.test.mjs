// R15 persist 的 tombstone test：删掉 src/rooms/persist.mjs ⇒ 本文件整片红。
//
// 覆盖（docs/数据契约.md §6/§7，方案.md §4.11 可搬迁内核）：
//   - 目录结构 + 一个条目一个 JSON 文件 + manifest（version/user/counts/checksums/pathPolicy）
//   - 原子写（write tmp + rename）：不跑测试的进程能看到的永远是完整文件；无 .tmp 残留
//   - 幂等：同内容重放 ⇒ changed:false、journal 不追加、manifest 字节不变（updatedAt 不漂）
//   - 篡改：派生条目被改 ⇒ verify 报 checksum/mismatch ⇒ rebuild 修回；
//          权威条目被改 ⇒ verify 报错且 rebuild **拒绝**（不替篡改背书，只增不改）
//   - 崩溃恢复：journal 尾行被截断 ⇒ readJournal 不抛、rebuild 仍可跑
//   - 路径纪律：条目里的来源路径必须相对（绝对路径直接拒绝入馆）
//   - 可搬迁：原件缺失 ⇒ sourceStatus:"missing"，条目仍可读、state 不变（不失效）
//   - 未知 manifest 版本 ⇒ verify 报错、写入侧抛错（不静默降级）
//
// 只用临时目录（os.tmpdir）；不写 <DSH_HOME>；不新增依赖。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, appendFileSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createStore, sha256, encodeId, decodeId, validateRelPath, sameMemoryContent,
  relativizeSource, sourceStatusOf, findPathViolations, PersistError,
  STORE_DIRS, STORE_VERSION, MANIFEST_FILE, INDEX_FILE, META_KEY,
} from '../src/rooms/persist.mjs';

let tmp;
let seq = 0;

test.before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'kifuin-persist-'));
});
test.after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function freshStore(opts = {}) {
  seq += 1;
  return createStore({ root: path.join(tmp, `store-${seq}`), now: 1_700_000_000_000 + seq * 10_000, ...opts });
}

function fixtureTopic(id = 't:repo:deadbeef', key = 'mycf711/dsh-kifuin') {
  return {
    id,
    kind: 'repo',
    key,
    count: 2,
    occurrences: [{ seq: 1, quote: 'git clone https://github.com/MYCF711/dsh-kifuin.git', occurredAt: 1_700_000_000_500 }],
  };
}

function fixtureEpisode(id = 'ep-1234abcd', extra = {}) {
  return {
    id,
    sessionId: 'session-1234abcd-0000-4000-8000-000000000000',
    scopeKey: 'w:d:/work/demo',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_100_000,
    firstEventAt: 1_700_000_000_000,
    lastEventAt: 1_700_000_100_000,
    recordedAt: 1_700_000_000_000,
    timeSource: 'event',
    delegationDepth: 0,
    closure: {
      logPath: 'sessions/--D-work-demo--/session-1234abcd/session.v4.jsonl.zstd',
      graphPath: null,
      seqFrom: 1,
      seqTo: 9,
      eventCount: 9,
      nodeIds: [],
      edgeIds: [],
    },
    l0: '',
    l1: '',
    signals: { failures: 1, successes: 0, unsettled: 0, constraints: 0, tools: ['bash'] },
    threadIds: [],
    state: 'archived',
    sourceRoot: 'DSH_HOME',
    sourceStatus: 'missing',
    topics: [fixtureTopic(), { id: 't:file:00000000', kind: 'file', key: 'src/rooms/persist.mjs', count: 1, occurrences: [] }],
    ...extra,
  };
}

function readJson(abs) {
  return JSON.parse(readFileSync(abs, 'utf8'));
}

// ---------------------------------------------------------------------------
// 1 · 结构 / manifest / verify
// ---------------------------------------------------------------------------

test('R15: 首次入馆 —— 八个子目录 + 一条目一文件 + manifest 自描述', () => {
  const store = freshStore();
  const dirs = store.ensureDirs();
  assert.deepEqual([...dirs].sort(), [...STORE_DIRS].sort(), 'episodes/topics/links/threads/joseki/claims/adjudications/journal');
  for (const dir of STORE_DIRS) {
    assert.ok(statSync(path.join(store.root, dir)).isDirectory(), `${dir}/ 必须是目录`);
  }

  const put = store.put('episodes', fixtureEpisode(), { at: 1_700_000_001_000 });
  assert.equal(put.changed, true);
  assert.equal(put.path, 'episodes/ep-1234abcd.json', '一个条目一个 JSON 文件，路径相对 root');
  const abs = path.join(store.root, put.path);
  assert.ok(existsSync(abs), '条目已落盘');

  const written = store.writeManifest(1_700_000_002_000);
  assert.equal(written.changed, true);
  const m = written.manifest;
  assert.equal(m.version, STORE_VERSION);
  assert.equal(m.user, 'owner', 'user 身份来自配置，不用机器名/哈希');
  assert.equal(m.pathPolicy, 'relative', '库内路径相对化');
  assert.deepEqual(m.counts, {
    episodes: 1, topics: 0, links: 0, threads: 0, joseki: 0, claims: 0, adjudications: 0,
  });
  assert.equal(
    m.checksums['episodes/ep-1234abcd.json'],
    sha256(readFileSync(abs)),
    'checksums 是文件内容的 sha256',
  );
  assert.ok(Number.isFinite(m.createdAt) && Number.isFinite(m.updatedAt), '双时钟用 epoch ms');

  const written0 = store.get('episodes', 'ep-1234abcd');
  const v = store.verify();
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.checked.files, 1);
  assert.equal(v.counts.episodes, 1);
  assert.equal(v.manifest.pathPolicy, 'relative');

  // 存进库的东西里没有绝对路径（搬库契约 §4.11 规则 2）
  const text = readFileSync(abs, 'utf8');
  assert.deepEqual(findPathViolations(written0), [], '路径字段全是相对路径');
  assert.ok(!text.includes(tmp), '条目里不得出现本机绝对前缀');
  assert.ok(text.includes('sessions/--D-work-demo--/session-1234abcd/session.v4.jsonl.zstd'), '来源路径相对 DSH_HOME');
});

test('R15: 条目 id 里的 ":" 不进文件名（Windows 可搬运）', () => {
  const store = freshStore();
  store.ensureDirs();
  store.put('topics', fixtureTopic());

  const names = readdirSync(path.join(store.root, 'topics'));
  assert.equal(names.length, 1);
  assert.ok(!names[0].includes(':'), `文件名不得含 ":"：${names[0]}`);
  assert.equal(decodeId(names[0].replace(/\.json$/, '')), 't:repo:deadbeef', '编码可逆');
  assert.equal(store.get('topics', 't:repo:deadbeef').key, 'mycf711/dsh-kifuin');
  assert.deepEqual(store.ids('topics'), ['t:repo:deadbeef']);
  assert.throws(() => encodeId(''), (err) => err instanceof PersistError && err.code === 'persist/invalid-id');
});

// ---------------------------------------------------------------------------
// 2 · 幂等 + 原子写
// ---------------------------------------------------------------------------

test('R15: 幂等 —— 同内容重放不写盘、不追加 journal、manifest 字节不变', () => {
  const store = freshStore();
  store.ensureDirs();
  const first = store.put('episodes', fixtureEpisode(), { at: 1_700_000_001_000 });
  assert.equal(first.changed, true);

  const journalAfterFirst = store.readJournal();
  assert.equal(journalAfterFirst.parsed, 1, 'journal 记录一次真实入档');

  // 生产者可能会重新打 recordedAt（Date.now()）；内容相同 ⇒ 仍然算"未变更"
  const second = store.put('episodes', fixtureEpisode('ep-1234abcd', { recordedAt: 1_700_000_999_000 }), { at: 1_700_000_500_000 });
  assert.equal(second.changed, false, '同输入重放 = 同结果');
  assert.equal(store.readJournal().parsed, journalAfterFirst.parsed, '无变更不追加 journal');
  assert.equal(store.get('episodes', 'ep-1234abcd').recordedAt, 1_700_000_000_000, '入馆时钟不被重放改写');

  const m1 = store.writeManifest(1_700_000_600_000);
  assert.equal(m1.changed, true);
  const before = readFileSync(path.join(store.root, MANIFEST_FILE), 'utf8');
  const beforeStat = statSync(path.join(store.root, MANIFEST_FILE)).mtimeMs;
  const m2 = store.writeManifest(1_700_000_900_000);
  assert.equal(m2.changed, false, '无变更不重写 manifest');
  assert.equal(readFileSync(path.join(store.root, MANIFEST_FILE), 'utf8'), before, 'manifest 字节不变（updatedAt 不漂）');
  assert.equal(statSync(path.join(store.root, MANIFEST_FILE)).mtimeMs, beforeStat, '连 mtime 都不动');

  // 同一输入 → 两个不同的库 → checksums 完全相同（可复算）
  const other = freshStore();
  other.ensureDirs();
  other.put('episodes', fixtureEpisode(), { at: 1_700_000_001_000 });
  other.writeManifest(1_700_000_600_000);
  assert.deepEqual(store.verify().manifest.checksums, other.verify().manifest.checksums);
  assert.equal(other.verify().ok, true);
});

test('R15: 原子写 —— 不留 .tmp；崩溃残留的 .tmp 不是条目且可清理', () => {
  const store = freshStore();
  store.ensureDirs();
  store.put('episodes', fixtureEpisode());
  assert.deepEqual(
    readdirSync(path.join(store.root, 'episodes')).filter((n) => n.startsWith('.tmp-')),
    [],
    '正常的 put 不留临时文件',
  );

  // 模拟"写完 tmp、rename 前崩了"
  writeFileSync(path.join(store.root, 'episodes', '.tmp-crash-1'), '{"id":"ep-dead"');
  assert.deepEqual(store.ids('episodes'), ['ep-1234abcd'], '.tmp 不被当成条目');
  const cleaned = store.cleanupTmp();
  assert.deepEqual(cleaned.removed, ['episodes/.tmp-crash-1']);
  store.writeManifest(1_700_000_002_000);
  assert.equal(store.verify().ok, true, '清理后校验通过');
});

// ---------------------------------------------------------------------------
// 3 · 篡改：派生可重算，权威不可重算
// ---------------------------------------------------------------------------

test('R15: 篡改派生条目 → verify 报 checksum/mismatch → rebuild 修回', async () => {
  const store = freshStore();
  store.ensureDirs();
  store.put('episodes', fixtureEpisode());
  store.put('topics', { id: 't:repo:deadbeef', kind: 'repo', key: 'mycf711/dsh-kifuin', df: 1 });
  store.writeManifest(1_700_000_002_000);
  assert.equal(store.verify().ok, true);

  const topicRel = store.entryRelPath('topics', 't:repo:deadbeef');
  writeFileSync(path.join(store.root, topicRel), `${JSON.stringify({ id: 't:repo:deadbeef', hacked: true }, null, 2)}\n`);

  const bad = store.verify();
  assert.equal(bad.ok, false, '被改过的条目必须校验失败');
  assert.ok(
    bad.errors.some((e) => e.code === 'checksum/mismatch' && e.path === topicRel),
    `期望 checksum/mismatch，实际 ${JSON.stringify(bad.errors)}`,
  );

  const rb = await store.rebuild({ at: 1_700_000_800_000 });
  assert.ok(!rb.refused, '派生损坏不是拒绝理由');
  assert.equal(rb.episodes, 1);
  assert.ok(rb.derived.topics.written >= 0);

  const after = store.verify();
  assert.equal(after.ok, true, `rebuild 后应恢复：${JSON.stringify(after.errors)}`);
  const topic = store.get('topics', 't:repo:deadbeef');
  assert.equal(topic.hacked, undefined, '派生条目被重算（不再是被篡改的内容）');
  assert.equal(topic.df, 1);
  assert.ok(store.readIndex().includes('未列出 ≠ 不存在；完整清单见 index.md 树'), 'rebuild 重写 index.md');
});

test('R15: 篡改权威条目 → verify 报错且 rebuild 拒绝（不替篡改背书）', async () => {
  const store = freshStore();
  store.ensureDirs();
  store.put('episodes', fixtureEpisode());
  store.writeManifest(1_700_000_002_000);
  assert.equal(store.verify().ok, true);

  const abs = path.join(store.root, 'episodes', 'ep-1234abcd.json');
  const original = readJson(abs);
  writeFileSync(abs, `${JSON.stringify({ ...original, l0: '手改的记忆' }, null, 2)}\n`);

  const bad = store.verify();
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.code === 'checksum/mismatch' && e.path === 'episodes/ep-1234abcd.json'));

  const rb = await store.rebuild({ at: 1_700_000_800_000 });
  assert.equal(rb.refused, true, '权威条目不能靠 rebuild 重算');
  assert.equal(rb.reason, 'authoritative-drift');
  assert.ok(rb.errors.some((e) => e.path === 'episodes/ep-1234abcd.json'));

  assert.equal(store.verify().ok, false, 'rebuild 不得把篡改后的 sha256 盖进 manifest');
  assert.equal(store.get('episodes', 'ep-1234abcd').l0, '手改的记忆', '只增不改：不静默回滚内容');
});

test('R15: 手放进目录的文件 → verify 报 file/unlisted；派生文件被删 → rebuild 补回', async () => {
  const store = freshStore();
  store.ensureDirs();
  store.put('episodes', fixtureEpisode());
  store.put('topics', { id: 't:repo:deadbeef', kind: 'repo', key: 'mycf711/dsh-kifuin', df: 2 });
  store.writeManifest(1_700_000_002_000);
  assert.equal(store.verify().ok, true);

  writeFileSync(path.join(store.root, 'episodes', 'ep-deadbeef.json'), `${JSON.stringify({ id: 'ep-deadbeef' })}\n`);
  const unlisted = store.verify();
  assert.equal(unlisted.ok, false);
  assert.ok(unlisted.errors.some((e) => e.code === 'file/unlisted' && e.path === 'episodes/ep-deadbeef.json'));

  rmSync(path.join(store.root, 'episodes', 'ep-deadbeef.json'));
  assert.equal(store.verify().ok, true, '删掉的文件不在清单里就不算错');

  const topicAbs = path.join(store.root, 'topics', 't%3Arepo%3Adeadbeef.json');
  assert.ok(existsSync(topicAbs));
  rmSync(topicAbs);
  const missing = store.verify();
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.code === 'file/missing' && e.path === 'topics/t%3Arepo%3Adeadbeef.json'));

  const rb = await store.rebuild({ at: 1_700_000_800_000 });
  assert.ok(!rb.refused);
  assert.equal(store.verify().ok, true, 'rebuild 把派生文件补回来');
  assert.ok(existsSync(topicAbs));
});

// ---------------------------------------------------------------------------
// 4 · 崩溃恢复：截断的 journal 不抛
// ---------------------------------------------------------------------------

test('R15: journal 尾行被截断 → 不抛、前缀可用、rebuild 仍可跑', async () => {
  const store = freshStore();
  store.ensureDirs();
  store.put('episodes', fixtureEpisode());
  const good = store.readJournal().parsed;
  assert.equal(good, 1);

  // 进程在写 journal 时被杀：一行写了一半、没有换行
  appendFileSync(store.journalPath, '{"v":1,"schema":"dsh-kifuin/memory-store@1","at":17000000');
  const j = store.readJournal();
  assert.equal(j.parsed, 1, '已写好的前缀照常读');
  assert.equal(j.dropped.partialTail, 1, '截断尾行被丢弃并计数');
  assert.equal(j.dropped.badLines, 0);

  store.writeManifest(1_700_000_002_000);
  const vTail = store.verify();
  assert.equal(vTail.ok, true, 'journal 坏尾不影响校验（journal 不是权威数据）');
  assert.ok(vTail.warnings.some((w) => w.code === 'journal/partial-tail'), JSON.stringify(vTail.warnings));

  // 中间坏行（不是尾行）→ 计 badLines，仍不抛
  appendFileSync(store.journalPath, '\nnot-json\n{"v":1,"op":"put","kind":"episodes","id":"ep-1234abcd"}\n');
  const j2 = store.readJournal();
  assert.equal(j2.parsed, 2);
  assert.equal(j2.dropped.badLines, 2, '截断行的坏 JSON + 中间坏行都算坏行');
  assert.equal(j2.dropped.partialTail, 0, '结尾是完整换行 ⇒ 不再算尾行截断');

  const rb = await store.rebuild({ at: 1_700_000_800_000 });
  assert.ok(!rb.refused, 'journal 坏尾不影响 rebuild（journal 不是权威）');
  const v = store.verify();
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => w.code === 'journal/bad-lines'));
});

// ---------------------------------------------------------------------------
// 5 · 路径纪律 / 版本闸 / 原件缺失
// ---------------------------------------------------------------------------

test('R15: 绝对路径拒绝入馆；手写条目里的绝对路径被 verify 抓出来', () => {
  const store = freshStore();
  store.ensureDirs();

  assert.throws(
    () => store.put('episodes', fixtureEpisode('ep-bad', {
      closure: { ...fixtureEpisode().closure, logPath: 'D:/sessions/x/session.v4.jsonl.zstd' },
    })),
    (err) => err instanceof PersistError && err.code === 'persist/absolute-path',
    '绝对路径搬库后必然失效，宁可不入馆',
  );
  assert.throws(
    () => store.put('episodes', fixtureEpisode('ep-bad2', {
      closure: { ...fixtureEpisode().closure, graphPath: '\\\\server\\share\\graph.json' },
    })),
    (err) => err.code === 'persist/absolute-path',
  );

  assert.deepEqual(findPathViolations({ a: { logPath: 'sessions/x' } }), [], '相对路径合法');
  assert.equal(validateRelPath('../escape').reason, 'escaping');
  assert.equal(validateRelPath('C:/x').reason, 'drive-letter');
  assert.equal(validateRelPath('/abs').reason, 'absolute');
  assert.equal(validateRelPath('a\\b').reason, 'backslash');
  assert.equal(relativizeSource(path.join(store.root, 'sessions', 'a.zstd'), store.root), 'sessions/a.zstd');

  // 手写文件（绕过 put）里的绝对路径 ⇒ verify 报 path/absolute
  store.put('episodes', fixtureEpisode());
  store.writeManifest(1_700_000_002_000);
  const abs = path.join(store.root, 'episodes', 'ep-1234abcd.json');
  const rec = readJson(abs);
  rec.closure.logPath = 'D:\\sessions\\x\\session.v4.jsonl.zstd';
  writeFileSync(abs, `${JSON.stringify(rec, null, 2)}\n`);
  const v = store.verify();
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'path/absolute'), JSON.stringify(v.errors));
});

test('R15: 未知 manifest 版本 —— verify 明确报错，写入侧拒绝（不静默降级）', () => {
  const store = freshStore();
  store.ensureDirs();
  writeFileSync(
    path.join(store.root, MANIFEST_FILE),
    JSON.stringify({ version: 99, user: 'owner', pathPolicy: 'relative', counts: {}, checksums: {}, createdAt: 1, updatedAt: 2 }),
  );

  const v = store.verify();
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'manifest/unsupported-version'));
  assert.throws(() => store.put('episodes', fixtureEpisode()), (err) => err.code === 'store/unsupported-version');
  assert.throws(() => store.writeManifest(1), (err) => err.code === 'store/unsupported-version');
});

test('R15: 缺 manifest ⇒ verify 拒绝并提示 rebuild（合约 §7）', () => {
  const store = freshStore();
  store.ensureDirs();
  const v = store.verify();
  assert.equal(v.ok, false);
  const err = v.errors.find((e) => e.code === 'manifest/missing');
  assert.ok(err);
  assert.match(String(err.hint), /rebuild/);
});

test('R15: 原件缺失 ⇒ sourceStatus:"missing"，条目仍可读、state 不变（不失效）', async () => {
  const store = freshStore();
  store.ensureDirs();
  const ep = fixtureEpisode();
  assert.equal(ep.sourceStatus, 'missing', '合成夹具的来源日志不在本机');
  store.put('episodes', ep);
  store.writeManifest(1_700_000_002_000);

  const v = store.verify();
  assert.equal(v.ok, true, '缺原件不影响完整性校验');
  const back = store.get('episodes', 'ep-1234abcd');
  assert.equal(back.sourceStatus, 'missing');
  assert.equal(back.state, 'archived', 'missing ≠ invalidated');
  assert.equal(sourceStatusOf('sessions/nope/session.v4.jsonl.zstd', store.root), 'missing');
  const rb = await store.rebuild({ at: 1_700_000_900_000 });
  assert.ok(!rb.refused, '缺原件不是拒绝 rebuild 的理由（记忆是记录，不是原件）');
  assert.equal(store.get('episodes', 'ep-1234abcd').sourceStatus, 'missing', 'rebuild 后仍标 missing');
});

// ---------------------------------------------------------------------------
// 6 · 派生目录只能由 rebuild 替换；权威目录只增不改
// ---------------------------------------------------------------------------

test('R15: replaceDerived 只允许派生目录；权威目录拒绝替换', () => {
  const store = freshStore();
  store.ensureDirs();
  store.put('episodes', fixtureEpisode());
  assert.throws(
    () => store.replaceDerived('episodes', []),
    (err) => err instanceof PersistError && err.code === 'persist/authoritative-kind',
  );
  assert.throws(
    () => store.replaceDerived('joseki', []),
    (err) => err.code === 'persist/authoritative-kind',
  );

  store.put('topics', fixtureTopic('t:repo:aaaaaaaa', 'a/b'));
  store.put('topics', fixtureTopic('t:repo:bbbbbbbb', 'c/d'));
  const replaced = store.replaceDerived('topics', [fixtureTopic('t:repo:aaaaaaaa', 'a/b')]);
  assert.equal(replaced.total, 1);
  assert.deepEqual(replaced.removed, ['topics/t%3Arepo%3Abbbbbbbb.json'], '派生目录可以收缩（索引可重算）');
  assert.deepEqual(store.ids('topics'), ['t:repo:aaaaaaaa']);
});

test('R15: sameMemoryContent —— 忽略存储簿记与生成时刻，只比内容', () => {
  assert.equal(sameMemoryContent({ id: 'a', x: 1, [META_KEY]: { updatedAt: 1 } }, { id: 'a', x: 1, [META_KEY]: { updatedAt: 2 } }), true);
  assert.equal(sameMemoryContent({ id: 'a', x: 1, updatedAt: 1 }, { id: 'a', x: 1, updatedAt: 2 }), true);
  assert.equal(sameMemoryContent({ id: 'a', x: 1 }, { id: 'a', x: 2 }), false);
  assert.equal(sameMemoryContent({ id: 'a', x: 1 }, { id: 'a', x: 1, y: 2 }), false);
});

test('R15: 空库也能 verify / rebuild（不假装有内容）', async () => {
  const store = freshStore();
  store.ensureDirs();
  store.writeManifest(1_700_000_002_000);
  const v = store.verify();
  assert.equal(v.ok, true);
  assert.equal(v.checked.files, 0);

  const rb = await store.rebuild({ at: 1_700_000_800_000 });
  assert.ok(!rb.refused);
  assert.equal(rb.episodes, 0);
  assert.equal(store.verify().ok, true);
  assert.ok(store.readIndex().includes('（暂无棋谱）'));
  assert.ok(readFileSync(path.join(store.root, INDEX_FILE), 'utf8').includes('未列出 ≠ 不存在'));
});
