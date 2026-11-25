// MK10 serial framing, port of tools/mkproto.py (little-endian):
//   A1 A5 5A 5E | id u32 | cmd u32 | size u32 | crc32(size_le) u32 | data[size] | crc32(data) u32
import { crc32 as zcrc32 } from 'node:zlib'

export const HEADER = Buffer.from([0xa1, 0xa5, 0x5a, 0x5e])
export const CMD_SHOW_JPG = 100
export const CMD_JSON = 101
export const MIN_FRAME = 20 // header + id, cmd, size, size_crc
export const MAX_SIZE = 16 * 1024 * 1024 // sanity cap: a CRC-valid but absurd size is treated as garbage

export const crc32 = (buf) => zcrc32(buf) >>> 0

// V1 command frame (verified on device, docs/theme-format.md "Serial protocol verification"):
//   "AA551234 FIXEDCMDHEAD " | type u32 | cmd u32 | len u32 | crc32(payload) u32 | payload
// cmd 2 = SET_DEVICE_RELOAD: payload = UTF-8 theme path; device loads it, rewrites config.json,
// restarts the video player and echoes the path back. Also restores the layout after getInfo.
export const V1_MAGIC = Buffer.from('AA551234 FIXEDCMDHEAD ', 'ascii')
export const V1_RELOAD = 2

export function packV1(cmd, payload, type = 0) {
  const head = Buffer.alloc(16)
  head.writeUInt32LE(type >>> 0, 0)
  head.writeUInt32LE(cmd >>> 0, 4)
  head.writeUInt32LE(payload.length, 8)
  head.writeUInt32LE(crc32(payload), 12)
  return Buffer.concat([V1_MAGIC, head, payload])
}

export function pack(cmd, data, id = 1) {
  const out = Buffer.alloc(MIN_FRAME + data.length + 4)
  HEADER.copy(out)
  out.writeUInt32LE(id >>> 0, 4)
  out.writeUInt32LE(cmd >>> 0, 8)
  out.writeUInt32LE(data.length, 12)
  out.writeUInt32LE(crc32(out.subarray(12, 16)), 16)
  data.copy(out, MIN_FRAME)
  out.writeUInt32LE(crc32(data), MIN_FRAME + data.length)
  return out
}

// Streaming parser: push(chunk) returns the complete, CRC-valid frames [{id, cmd, data}] now available.
// Garbage before a header is skipped; bad size-CRC drops the 20-byte header (as mkproto.py);
// bad data-CRC drops the whole frame.
export class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0)
    this.dropped = 0 // frames/headers discarded (CRC fail), for diagnostics
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk)
    const frames = []
    for (;;) {
      if (this.buf.length < MIN_FRAME) break
      const i = this.buf.indexOf(HEADER)
      if (i < 0) {
        // keep a possible partial header at the tail
        this.buf = this.buf.subarray(Math.max(0, this.buf.length - (HEADER.length - 1)))
        break
      }
      if (i) this.buf = this.buf.subarray(i)
      if (this.buf.length < MIN_FRAME) break
      const size = this.buf.readUInt32LE(12)
      if (this.buf.readUInt32LE(16) !== crc32(this.buf.subarray(12, 16)) || size > MAX_SIZE) {
        this.dropped++
        this.buf = this.buf.subarray(size > MAX_SIZE ? HEADER.length : MIN_FRAME)
        continue
      }
      const end = MIN_FRAME + size + 4
      if (this.buf.length < end) break
      const data = Buffer.from(this.buf.subarray(MIN_FRAME, MIN_FRAME + size))
      const ok = this.buf.readUInt32LE(MIN_FRAME + size) === crc32(data)
      const id = this.buf.readUInt32LE(4)
      const cmd = this.buf.readUInt32LE(8)
      this.buf = this.buf.subarray(end)
      if (ok) frames.push({ id, cmd, data })
      else this.dropped++
    }
    return frames
  }
}

// ---- V1 frames from the device (layout and payloads from Terminus-MK20-Tools docs/protocol.md
// §3-5, MIT). Header little-endian, payload internals big-endian.
export const V1_NAMES = ['FIND_DEVICE', 'SEND_SYSTEM_DATA_TO_DEVICE', 'SET_DEVICE_RELOAD', 'GET_DEVICE_THEME',
  'SET_DEVICE_BL', 'SET_DEVICE_SCAN_STATE', 'FILE_START', 'FILE_END', 'GET_DEVICE_VERSION', 'SET_DEVICE_CANVASFLIP',
  'GET_DEVICE_SCREENMESSAGE', 'SET_DEVICE_DELETE_THEME', 'SEND_PIXMAP', 'DEVICE_ProactiveEscalationCMD',
  'REQUEST_UPLOAD_KEY', 'SEND_JSON']
const V1_HEAD = 38 // magic 22 + type, cmd, len, crc

// Streaming parser: push(chunk) returns complete, CRC-valid V1 frames [{type, cmd, payload}].
export class V1Parser {
  constructor() {
    this.buf = Buffer.alloc(0)
    this.dropped = 0
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk)
    const frames = []
    for (;;) {
      const i = this.buf.indexOf(V1_MAGIC)
      if (i < 0) {
        this.buf = this.buf.subarray(Math.max(0, this.buf.length - (V1_MAGIC.length - 1)))
        break
      }
      if (i) this.buf = this.buf.subarray(i)
      if (this.buf.length < V1_HEAD) break
      const len = this.buf.readUInt32LE(30)
      if (len > MAX_SIZE) {
        this.dropped++
        this.buf = this.buf.subarray(V1_MAGIC.length)
        continue
      }
      if (this.buf.length < V1_HEAD + len) break
      const payload = Buffer.from(this.buf.subarray(V1_HEAD, V1_HEAD + len))
      const frame = { type: this.buf.readUInt32LE(22), cmd: this.buf.readUInt32LE(26), payload }
      const ok = this.buf.readUInt32LE(34) === crc32(payload)
      this.buf = this.buf.subarray(V1_HEAD + len)
      if (ok) frames.push(frame)
      else this.dropped++
    }
    return frames
  }
}

// Tagged-Value Map (QDataStream QVariantMap) to plain JS. Byte arrays show as {bytes: n}.
function readTagged(b) {
  let p = 0
  const u32 = () => { const v = b.readUInt32BE(p); p += 4; return v }
  const str = () => {
    const n = u32()
    if (n === 0xffffffff) return null
    const s = Buffer.from(b.subarray(p, p + n)).swap16().toString('utf16le')
    p += n
    return s
  }
  const value = () => {
    const type = u32()
    const isNull = b[p++]
    switch (type) {
      case 1: return isNull ? (p++, null) : !!b[p++]
      case 2: { const v = b.readInt32BE(p); p += 4; return isNull ? null : v }
      case 6: { const v = b.readDoubleBE(p); p += 8; return isNull ? null : v }
      case 8: return map()
      case 9: return Array.from({ length: u32() }, value)
      case 10: return str()
      case 12: { const n = u32(); if (n === 0xffffffff) return null; p += n; return { bytes: n } }
      default: throw new Error(`unknown tagged type ${type} at ${p - 5}`)
    }
  }
  const map = () => Object.fromEntries(Array.from({ length: u32() }, () => [str(), value()]))
  return { map, str, u32, done: () => p === b.length }
}

// Best-effort payload decode for display: cmd 13 = array of tagged maps, 15 = JSON, string maps
// for the rest; otherwise UTF-8 text or a hex preview.
export function decodeV1(cmd, payload) {
  const tries = {
    13: () => { const r = readTagged(payload); const out = Array.from({ length: r.u32() }, r.map); return r.done() ? out : undefined },
    15: () => JSON.parse(payload.toString('utf8')),
  }
  const stringMap = () => {
    const r = readTagged(payload)
    const out = Object.fromEntries(Array.from({ length: r.u32() }, () => [r.str(), r.str()]))
    return r.done() ? out : undefined
  }
  if (!payload.length) return null
  for (const f of [tries[cmd], stringMap].filter(Boolean)) {
    try { const v = f(); if (v !== undefined) return v } catch { /* next */ }
  }
  const text = payload.toString('utf8')
  if (!/[\p{Cc}�]/u.test(text.replace(/[\t\n\r]/g, ''))) return text
  return { hex: payload.subarray(0, 64).toString('hex') + (payload.length > 64 ? '…' : ''), bytes: payload.length }
}
