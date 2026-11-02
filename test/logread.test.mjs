// R01 · logread 墓碑测试（tombstone：删掉 src/rooms/logread.mjs 就红）
//
// 覆盖：多帧 zstd 逐帧定位/解码｜header 与事件包裹层｜seq 单调｜坏尾不抛｜坏行计数｜结构损坏抛
// 真实语料：$DSH_HOME/sessions/**/session.v4.jsonl.zstd（含最大 7.05 MB / 4,577 帧那个）
// 语料缺席（DSH_HOME 未设）时真实语料断言 skip，合成夹具仍跑 —— 保证脱离 DSH 也能测。
// 契约：docs/数据契约.md §1（readFrames(buf) -> {frames, truncated}；parseEvents 坏行不抛）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';

import {
  LogReadError,
  SUPPORTED_VERSIONS,
  ZSTD_MAGIC,
  parseEvents,
  readFrameBuffers,
  readFrames,
  scanFrames,
} from '../src/rooms/logread.mjs';

// ── 夹具 ───────────────────────────────────────────────────────────────────
/** 一帧（带校验和，与 DSH 写盘参数一致）。 */
function frameOf(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  });
}

const HEADER = {
  type: 'session',
  version: 4,
  id: 'session-0123456789abcdef',
  createdAt: 1793513948708,
  cwd: 'E:\\workspace',
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
};
const EVENT_LINES = [
  { type: 'permission/preset', seq: 0, time: 1793513948710, data: { preset: 'workspace-write' } },
  { type: 'turn/start', seq: 1, time: 1793513949000, data: { turn: 1 } },
  { type: 'step/end', seq: 2, time: 1793513950000, data: { turn: 1, step: 0 } },
];
const jsonl = () => [HEADER, ...EVENT_LINES].map((r) => `${JSON.stringify(r)}\n`).join('');

/** 每条记录独立成帧（真实日志也是逐批追加成帧）。 */
function multiFrame(records) {
  return Buffer.concat(records.map((r) => frameOf(`${JSON.stringify(r)}\n`)));
}

// ── 真实语料：按体积排序的会话日志 ──────────────────────────────────────────
function sessionLogs() {
  const home = process.env.DSH_HOME;
  if (!home) return [];
  const root = join(home, 'sessions');
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.jsonl.zstd')) out.push({ path: p, size: statSync(p).size });
    }
  };
  walk(root);
  return out.sort((a, b) => b.size - a.size);
}

const CORPUS = sessionLogs();
const skipCorpus = (t) => {
  if (CORPUS.length === 0) {
    t.skip('DSH_HOME 未设置或没有会话日志：跳过真实语料断言');
    return true;
  }
  return false;
};

// ── 墓碑：房间面 ───────────────────────────────────────────────────────────
test('R01 墓碑：导出面存在（删掉房间即红）', () => {
  assert.equal(typeof readFrames, 'function');
  assert.equal(typeof scanFrames, 'function');
  assert.equal(typeof parseEvents, 'function');
  assert.equal(typeof readFrameBuffers, 'function');
  assert.equal(ZSTD_MAGIC, 0xfd2fb528, 'zstd 帧魔数必须是 28 B5 2F FD');
  assert.deepEqual([...SUPPORTED_VERSIONS], [4], '已知日志格式版本 = 4');
});

// ── 合成夹具：多帧 ─────────────────────────────────────────────────────────
test('合成：逐条成帧的容器被逐帧定位（整文件解压只会出首帧）', () => {
  const buf = multiFrame([HEADER, ...EVENT_LINES]);
  const scanned = scanFrames(buf);
  assert.equal(scanned.frames.length, 4);
  assert.equal(scanned.tornStart, undefined);
  assert.equal(scanned.frames[0].start, 0);
  assert.equal(scanned.frames.at(-1).end, buf.length, '帧区间必须无缝铺满整个文件');
  for (let i = 1; i < scanned.frames.length; i += 1) {
    assert.equal(scanned.frames[i].start, scanned.frames[i - 1].end);
  }

  // 契约 §1.1：readFrames(buf) -> {frames: Buffer[], truncated: boolean}
  const decoded = readFrames(buf);
  assert.ok(Array.isArray(decoded.frames));
  assert.equal(decoded.frames.length, 4);
  assert.equal(decoded.truncated, false);
  assert.equal(decoded.frameCount, 4);
  assert.equal(decoded.decodedCount, 4);
  assert.equal(decoded.byteLength, buf.length);
  // 只要明文的入口与契约对象等价
  assert.deepEqual(readFrameBuffers(buf), decoded.frames);
  assert.equal(readFrameBuffers(buf).truncated, false, '数组上仍挂 truncated 元数据');

  const parsed = parseEvents(decoded);
  assert.equal(parsed.version, 4);
  assert.equal(parsed.header.id, HEADER.id);
  assert.deepEqual(parsed.events.map((e) => e.seq), [0, 1, 2]);
  assert.equal(parsed.events[0].type, 'permission/preset');
  assert.equal(parsed.events[0].time, 1793513948710);
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.badLines, 0);
  assert.equal(parsed.droppedPartialLine, false);
  assert.equal(parsed.eventsWithoutTime, 0);
  // 裸 Buffer[] 也吃得下（对调用方宽容，语义不变）
  assert.equal(parseEvents(decoded.frames).events.length, 3);
});

test('合成：单帧容器（一次性压缩）同样可解', () => {
  const decoded = readFrames(frameOf(jsonl()));
  assert.equal(decoded.frames.length, 1);
  const parsed = parseEvents(decoded);
  assert.equal(parsed.events.length, EVENT_LINES.length);
});

// ── 合成夹具：坏尾 / 截断不抛 ─────────────────────────────────────────────
test('合成：末帧被截断 ⇒ 返回前缀 + truncated:true，不抛', () => {
  const buf = multiFrame([HEADER, ...EVENT_LINES]);
  const full = scanFrames(buf);
  const cutAt = full.frames[2].start + Math.floor((full.frames[2].end - full.frames[2].start) / 2);
  const cut = buf.subarray(0, cutAt);

  let decoded;
  assert.doesNotThrow(() => { decoded = readFrames(cut); }, '截断帧不得抛错');
  assert.equal(decoded.truncated, true);
  assert.equal(decoded.frames.length, 2, '已解出前两帧');
  assert.equal(decoded.decodedCount, 2);
  assert.equal(decoded.frameCount, 2, '结构上只认到 2 个完整帧；第 3 帧记在 tornStart');
  assert.equal(decoded.tornStart, full.frames[2].start);

  const parsed = parseEvents(decoded);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.header.id, HEADER.id);
  assert.deepEqual(parsed.events.map((e) => e.seq), [0], '前缀事件仍然可读');
});

test('合成：末帧校验和损坏 ⇒ 按坏尾处理（truncated:true，不抛）', () => {
  const buf = Buffer.from(multiFrame([HEADER, ...EVENT_LINES]));
  buf.fill(0, buf.length - 4); // 抹掉末帧校验和
  let decoded;
  assert.doesNotThrow(() => { decoded = readFrames(buf); });
  assert.equal(decoded.truncated, true);
  assert.equal(decoded.frames.length, 3);
});

test('合成：只剩半个 frame header ⇒ truncated:true，不抛', () => {
  const buf = multiFrame([HEADER]);
  const decoded = readFrames(buf.subarray(0, buf.length - 2));
  assert.equal(decoded.truncated, true);
  assert.equal(decoded.frames.length, 0);
  assert.equal(decoded.tornStart, 0);
});

test('合成：尾部半行 JSON 被丢弃并标注（撕裂写）', () => {
  const text = `${JSON.stringify(HEADER)}\n${JSON.stringify(EVENT_LINES[0])}\n{"type":"turn/start","seq":1,"ti`;
  const parsed = parseEvents(readFrames(frameOf(text)));
  assert.equal(parsed.droppedPartialLine, true);
  assert.deepEqual(parsed.events.map((e) => e.seq), [0]);
});

// ── 合成夹具：坏行计数不抛（契约 §1.3）/ 结构损坏必须可见 ─────────────────
test('合成：坏行 ⇒ 跳过并计数 badLines，不抛', () => {
  const text = [
    `${JSON.stringify(HEADER)}\n`,
    `${JSON.stringify(EVENT_LINES[0])}\n`,
    '{"type":"turn/start","seq":9\n', // JSON 断
    '{"type":"x","time":1}\n', // 缺 seq
    `${JSON.stringify(EVENT_LINES[2])}\n`,
  ].join('');
  const parsed = parseEvents(readFrames(frameOf(text)));
  assert.equal(parsed.badLines, 2);
  assert.deepEqual(parsed.badLineNumbers, [3, 4]);
  assert.deepEqual(parsed.events.map((e) => e.seq), [0, 2], '好行仍入列');
});

test('合成：坏魔数 ⇒ LogReadError logread/corrupt（帧级损坏不许静默）', () => {
  const buf = Buffer.from(multiFrame([HEADER, ...EVENT_LINES]));
  const second = scanFrames(buf).frames[1].start;
  buf.writeUInt32LE(0xdeadbeef, second);
  assert.throws(() => readFrames(buf), (error) => {
    assert.ok(error instanceof LogReadError);
    assert.equal(error.code, 'logread/corrupt');
    assert.equal(error.byte, second);
    return true;
  });
});

test('合成：保留块类型 ⇒ corrupt', () => {
  // 手工造一帧：magic + FHD(Single_Segment=1, FCS flag=0 ⇒ 1B) + FCS 0x00 + 块头 06 00 00（type=3）
  const buf = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0b00100000, 0x00, 0x06, 0x00, 0x00]);
  assert.throws(() => scanFrames(buf), /reserved block type/);
});

test('合成：未知版本 ⇒ logread: unsupported version 3', () => {
  const decoded = readFrames(frameOf(`${JSON.stringify({ ...HEADER, version: 3 })}\n`));
  assert.throws(() => parseEvents(decoded), (error) => {
    assert.ok(error instanceof LogReadError);
    assert.equal(error.code, 'logread/unsupported-version');
    assert.match(error.message, /logread: unsupported version 3/);
    return true;
  });
});

test('合成：缺 header（首行不是 session 记录）⇒ missing header', () => {
  assert.throws(() => parseEvents(readFrames(frameOf(`${JSON.stringify(EVENT_LINES[0])}\n`))), /logread: missing header/);
  assert.throws(() => parseEvents(readFrames(frameOf(''))), /logread: missing header/);
});

test('输入校验：parseEvents 只吃 {frames,truncated} 或 Buffer[]', () => {
  assert.throws(() => parseEvents('nope'), LogReadError);
  assert.throws(() => parseEvents([{}]), LogReadError);
  assert.throws(() => parseEvents(null), LogReadError);
  assert.throws(() => readFrames('nope'), LogReadError);
});

// ── 真实语料 ───────────────────────────────────────────────────────────────
test('真实：最大的会话日志（>6 MB）逐帧可解，header/事件/seq 全对', (t) => {
  if (skipCorpus(t)) return;
  const biggest = CORPUS[0];
  assert.ok(biggest.size > 6 * 1024 * 1024, `最大日志应 >6 MB，实测 ${biggest.size} B`);

  const t0 = Date.now();
  const buf = readFileSync(biggest.path);
  const decoded = readFrames(buf);
  const parsed = parseEvents(decoded);
  const elapsedMs = Date.now() - t0;

  // 多帧：整文件解压只出首帧，所以帧数必须远大于 1
  assert.equal(decoded.truncated, false, '正在写入之外的日志不该被判截断');
  assert.ok(decoded.frameCount > 1000, `帧数应 >1000，实测 ${decoded.frameCount}`);
  assert.equal(decoded.frames.length, decoded.frameCount, '每帧都应解出');
  assert.equal(decoded.byteLength, buf.length);
  assert.equal(scanFrames(buf).frames.at(-1).end, buf.length);

  // header 契约（§1.2）
  const h = parsed.header;
  assert.equal(h.type, 'session');
  assert.equal(h.version, 4);
  assert.match(h.id, /^session-[0-9a-f-]{36}$/);
  assert.equal(typeof h.createdAt, 'number');
  assert.equal(typeof h.cwd, 'string');
  assert.ok(h.cwd.length > 0);
  assert.equal(typeof h.isSeeded, 'boolean');
  assert.equal(typeof h.delegationDepth, 'number');
  assert.ok(h.agentPreset === undefined || typeof h.agentPreset === 'string');

  // 事件契约（§1.3）：seq 严格单调，time 有限且不倒退
  assert.ok(parsed.events.length > 1000, `事件数应 >1000，实测 ${parsed.events.length}`);
  assert.equal(parsed.eventsWithoutTime, 0, '真实日志每条事件都带 time');
  assert.equal(parsed.badLines, 0, '真实日志没有坏行');
  assert.equal(parsed.droppedPartialLine, false);
  let prevSeq = -Infinity;
  let prevTime = -Infinity;
  const times = [];
  for (const event of parsed.events) {
    assert.equal(typeof event.type, 'string');
    assert.ok(event.seq > prevSeq, `seq 必须严格单调：${prevSeq} → ${event.seq}`);
    prevSeq = event.seq;
    assert.ok(Number.isFinite(event.time));
    assert.ok(event.time >= prevTime, `time 不应倒退：${prevTime} → ${event.time}`);
    prevTime = event.time;
    times.push(event.time);
  }
  const firstEventAt = Math.min(...times);
  const lastEventAt = Math.max(...times);
  assert.ok(firstEventAt <= lastEventAt, 'firstEventAt 必须 <= lastEventAt');
  assert.ok(lastEventAt >= h.createdAt, '最后一件事不早于会话创建');

  console.log(`# 最大日志 ${buf.length} B / ${decoded.frameCount} 帧 / ${parsed.events.length} 事件 / ${elapsedMs} ms`);
});

test('真实：第二大的会话日志同样可解（≥2 个真实样本）', (t) => {
  if (skipCorpus(t)) return;
  assert.ok(CORPUS.length >= 2);
  const second = CORPUS[1];
  const decoded = readFrames(readFileSync(second.path));
  const parsed = parseEvents(decoded);
  assert.ok(decoded.frameCount >= 2);
  assert.equal(decoded.truncated, false);
  assert.equal(parsed.header.version, 4);
  assert.ok(parsed.events.length > 0);
  let prev = -Infinity;
  for (const event of parsed.events) {
    assert.ok(event.seq > prev);
    prev = event.seq;
  }
});

test('真实：真日志截断到中间帧 ⇒ 前缀可读且不抛（模拟正在写盘）', (t) => {
  if (skipCorpus(t)) return;
  const target = CORPUS[0];
  const buf = readFileSync(target.path);
  const scanned = scanFrames(buf);
  const victim = scanned.frames[Math.floor(scanned.frames.length * 0.6)];
  const cutAt = victim.start + Math.floor((victim.end - victim.start) / 2);
  const cut = buf.subarray(0, cutAt);

  let decoded;
  assert.doesNotThrow(() => { decoded = readFrames(cut); }, '截断的真实日志不得抛');
  assert.equal(decoded.truncated, true);
  assert.equal(decoded.tornStart, victim.start);
  const expectedPrefix = Math.floor(scanned.frames.length * 0.6);
  assert.equal(decoded.frames.length, expectedPrefix, '前缀帧数应与截断位置吻合');

  const parsed = parseEvents(decoded);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.header.id, parseEvents(readFrames(buf)).header.id, 'header 不受截断影响');
  assert.ok(parsed.events.length > 0);
  assert.equal(parsed.badLines, 0, '截断只丢尾帧，前面的行仍完整');
  let prev = -Infinity;
  for (const event of parsed.events) {
    assert.ok(event.seq > prev);
    prev = event.seq;
  }
});
