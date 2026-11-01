// R01 · logread —— 多帧 zstd 逐帧解码 + JSONL 事件包裹层解析
//
// ── 契约（docs/数据契约.md §1，M1 冻结；AGENTS §11 / 方案 §4.1、§4.9）─────────
// 职责：把 DSH 会话日志（**拼接式 zstd 容器** + JSONL 文本）读成 {header, events}。
//       单文件最多数千帧（本机实测 4,577 帧 / 7.05 MB / 明文 23.8 MB）；
//       `zlib.zstdDecompressSync` 整文件只出**首帧**，所以必须逐帧定位、逐帧解。
// 入口：
//   scanFrames(buffer)       -> { frames: [{start,end}], tornStart? }   // 只定位边界，不解压
//   readFrames(buffer)       -> { frames: Buffer[], truncated: boolean, ... }   ← 契约 §1.1 形状
//   readFrameBuffers(buffer) -> Buffer[]                                 // 只要明文的便捷入口
//   parseEvents(frames)      -> { header, events, truncated, badLines, ... }
// 输入：日志文件原始字节（Buffer / Uint8Array / ArrayBuffer）；parseEvents 收 readFrames 的返回，
//       也收裸 Buffer[]（对调用方宽容，语义不变）。
// 输出：
//   header = 首行 {"type":"session", version:4, id, createdAt, cwd,
//                  isSeeded, delegationDepth, agentPreset}
//   events = 其后每行 {"type":"…", seq:<非负整数>, time:<epoch ms>, data:{…}}
// 错误语义（与契约 §1 一致）：
//   · **坏尾/截断**（EOF 落在最后一帧内部，或末帧解压/校验失败）
//       ⇒ 已解出的前缀 + truncated:true，**绝不抛**（日志可能正被写入）
//   · **坏行**（JSON 断 / 非对象 / 缺 seq）⇒ 跳过并计数 `badLines`，**不抛**（契约 §1.3）
//   · **结构损坏**（帧魔数不对 / 保留位 / 保留块类型 / 非末帧解压失败）
//       ⇒ throw LogReadError，code='logread/corrupt'（帧级损坏不是"坏行"，必须可见）
//   · **未知版本** ⇒ throw LogReadError('logread: unsupported version <v>')（fail-closed）
//   · **缺 header** ⇒ throw LogReadError('logread: missing header')
// 允许依赖：node:zlib（零第三方依赖）。
// 禁止：写文件 / 写 <DSH_HOME> / 联网 / 依赖本仓其它房间（本房间只读、纯函数）。
//
// ── zstd 帧格式（RFC 8878 §3）───────────────────────────────────────────────
//   magic 28 B5 2F FD（LE 视作 uint32 = 0xFD2FB528）
//   Frame_Header_Descriptor：bit7-6 Frame_Content_Size_flag｜bit5 Single_Segment_flag
//                            bit4 Unused｜bit3 Reserved｜bit2 Content_Checksum_flag
//                            bit1-0 Dictionary_ID_flag
//   其后：Window_Descriptor（Single_Segment_flag=0 时 1B）｜Dictionary_ID（0/1/2/4B）
//         ｜Frame_Content_Size（0/1/2/4/8B；flag=0 时仅 Single_Segment 下 1B）
//   Block：3B 头 = last_block(1b) | block_type(2b) | block_size(21b)
//          type 0=Raw / 1=RLE（块内容恒 1B）/ 2=Compressed / 3=Reserved(非法)
//   Content_Checksum_flag=1 时帧末 4B 校验和。
// 注：不识别 skippable frame（magic 0x184D2A5X）——DSH 自己的读取器同样不识别，
//     保持"DSH 能读的我们才读"，避免静默接受上游不接受的内容。

import { zstdDecompressSync } from 'node:zlib';

/** zstd 帧魔数（LE 读取的 uint32）。 */
export const ZSTD_MAGIC = 0xfd2fb528;
/** 认识的日志格式版本（header.version）。不认识的必须报错，不许静默降级。 */
export const SUPPORTED_VERSIONS = Object.freeze([4]);
/** header 首行的 type 取值。 */
export const HEADER_TYPE = 'session';

/** logread 的错误类型；code 区分语义（corrupt / unsupported-version / missing-header / input）。 */
export class LogReadError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'LogReadError';
    this.code = code;
    if (detail) Object.assign(this, detail);
  }
}

function corrupt(message, detail) {
  return new LogReadError(`logread: corrupt: ${message}`, 'logread/corrupt', detail);
}

/** 接受 Buffer / Uint8Array / ArrayBuffer，统一成 Buffer 视图（零拷贝）。 */
function asBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new LogReadError('logread: input: expect Buffer/Uint8Array/ArrayBuffer', 'logread/input');
}

/**
 * 只定位完整帧的字节区间，不解压。
 * 逐帧走 frame header + block 链，任一位置超出缓冲即判"尾帧被截断"。
 * @param {Buffer|Uint8Array|ArrayBuffer} input 日志文件当前已有字节
 * @returns {{frames: {start: number, end: number}[], tornStart?: number}}
 */
export function scanFrames(input) {
  const buf = asBuffer(input);
  const frames = [];
  let offset = 0;

  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) return { frames, tornStart: start };
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw corrupt(`invalid frame magic at byte ${offset}`, { byte: offset });
    }
    offset += 4;
    if (offset === buf.length) return { frames, tornStart: start };

    const descriptor = buf.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0b00011000) !== 0) {
      throw corrupt(`reserved frame-header bit at byte ${offset - 1}`, { byte: offset - 1 });
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0b00100000) !== 0;
    const checksum = (descriptor & 0b00000100) !== 0;
    const dictionaryFlag = descriptor & 0b00000011;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const restHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - offset < restHeaderBytes) return { frames, tornStart: start };
    offset += restHeaderBytes;

    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0b11;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw corrupt(`reserved block type at byte ${offset - 3}`, { byte: offset - 3 });
      }
      // RLE 块的 Block_Size 是**解压后**长度，块内容固定 1 字节。
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }

  return { frames };
}

/**
 * 逐帧解码（契约 §1.1：`{frames: Buffer[], truncated: boolean}`）。
 *
 * 返回对象上的 `frames` 数组另挂非枚举元数据（`frames.truncated` 等），方便"只要明文"的调用方；
 * 两种取法等价：`readFrames(buf).truncated` === `readFrames(buf).frames.truncated`。
 * @param {Buffer|Uint8Array|ArrayBuffer} input
 * @returns {{frames: Buffer[], truncated: boolean, tornStart?: number, frameCount: number,
 *            decodedCount: number, byteLength: number}}
 */
export function readFrames(input) {
  const buf = asBuffer(input);
  const { frames: ranges, tornStart } = scanFrames(buf);
  const out = [];
  let truncated = tornStart !== undefined;

  for (let i = 0; i < ranges.length; i += 1) {
    const { start, end } = ranges[i];
    let plain;
    try {
      plain = zstdDecompressSync(buf.subarray(start, end));
    } catch (error) {
      const isTail = i === ranges.length - 1 && tornStart === undefined;
      // 末帧解压失败 = 撕裂写的另一种形态（校验和/块内容坏在尾部）——按坏尾处理，不抛。
      if (isTail) { truncated = true; break; }
      throw new LogReadError(
        `logread: corrupt: frame at byte ${start} failed to decompress: ${error?.message ?? error}`,
        'logread/corrupt',
        { byte: start, frameIndex: i, cause: error },
      );
    }
    out.push(plain);
  }

  Object.defineProperties(out, {
    truncated: { value: truncated, enumerable: false },
    tornStart: { value: tornStart, enumerable: false },
    frameCount: { value: ranges.length, enumerable: false },
    byteLength: { value: buf.length, enumerable: false },
  });

  return {
    frames: out,
    truncated,
    tornStart,
    frameCount: ranges.length,
    decodedCount: out.length,
    byteLength: buf.length,
  };
}

/**
 * 只要逐帧明文（`readFrames().frames` 的便捷入口）。
 * @param {Buffer|Uint8Array|ArrayBuffer} input
 * @returns {Buffer[]} 明文数组（同样挂 truncated 等非枚举元数据）
 */
export function readFrameBuffers(input) {
  return readFrames(input).frames;
}

/** 收 readFrames 的返回对象，也收裸 Buffer[]。 */
function normalizeFrames(input) {
  if (Array.isArray(input)) {
    return { frames: input, truncated: input.truncated === true, tornStart: input.tornStart };
  }
  if (input !== null && typeof input === 'object' && Array.isArray(input.frames)) {
    return { frames: input.frames, truncated: input.truncated === true, tornStart: input.tornStart };
  }
  throw new LogReadError('logread: input: expect {frames, truncated} from readFrames (or a Buffer[])', 'logread/input');
}

/**
 * 把逐帧明文拼成 JSONL，解析出 header 与事件（契约 §1.3：跳过空行，坏行计数不抛）。
 * @param {{frames: Buffer[], truncated?: boolean}|Buffer[]} decoded readFrames 的返回（或裸 Buffer[]）
 * @returns {{header: object, events: object[], truncated: boolean, badLines: number,
 *            badLineNumbers: number[], version: number, tornStart?: number,
 *            droppedPartialLine: boolean, eventsWithoutTime: number, lineCount: number}}
 */
export function parseEvents(decoded) {
  const { frames, truncated, tornStart } = normalizeFrames(decoded);
  for (const frame of frames) {
    if (!Buffer.isBuffer(frame) && !(frame instanceof Uint8Array)) {
      throw new LogReadError('logread: input: every frame must be a Buffer/Uint8Array', 'logread/input');
    }
  }

  const text = Buffer.concat(frames).toString('utf8');
  const lines = text.split('\n');

  // 尾行没有换行 = 写盘撕裂留下的半行 JSON。丢掉，但标注（不静默）。
  let droppedPartialLine = false;
  if (lines.length > 0 && lines[lines.length - 1] !== '') {
    lines.pop();
    droppedPartialLine = true;
  }

  let header = null;
  const events = [];
  const badLineNumbers = [];
  let eventsWithoutTime = 0;
  let lineCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === '' || raw === '\r') continue;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    lineCount += 1;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      record = undefined;
    }

    if (header === null) {
      const looksLikeHeader = record !== null && typeof record === 'object' && record !== undefined
        && typeof record.version === 'number';
      if (!looksLikeHeader || (record.type !== undefined && record.type !== HEADER_TYPE)) {
        throw new LogReadError(
          `logread: missing header (first record at line ${i + 1} is not {"type":"session"})`,
          'logread/missing-header',
          { line: i + 1 },
        );
      }
      header = record;
      if (!SUPPORTED_VERSIONS.includes(header.version)) {
        throw new LogReadError(`logread: unsupported version ${header.version}`, 'logread/unsupported-version', { version: header.version });
      }
      continue;
    }

    // 契约 §1.3：坏行不抛，计数；坏 = 非对象 / 缺 type / 缺非负整数 seq
    const wellFormed = record !== undefined && record !== null && typeof record === 'object'
      && typeof record.type === 'string'
      && typeof record.seq === 'number' && Number.isFinite(record.seq);
    if (!wellFormed) {
      badLineNumbers.push(i + 1);
      continue;
    }
    if (typeof record.time !== 'number' || !Number.isFinite(record.time)) eventsWithoutTime += 1;
    events.push(record);
  }

  if (header === null) {
    throw new LogReadError('logread: missing header (log has no records)', 'logread/missing-header');
  }

  return {
    header,
    events,
    version: header.version,
    truncated,
    tornStart,
    badLines: badLineNumbers.length,
    badLineNumbers,
    droppedPartialLine,
    eventsWithoutTime,
    lineCount,
  };
}
