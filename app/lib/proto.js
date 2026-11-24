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
