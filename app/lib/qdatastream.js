// Big-endian Qt QDataStream reader/writer for the subset the MK10 .Theme files use.
// QVariant is represented as {type, null, value}; QVariantMap as ordered [[key, variant], ...]
// (order and the is-null byte are preserved so re-encoding is byte-exact).
export const NULL = 0xffffffff
export const T_BOOL = 1
export const T_INT = 2
export const T_MAP = 8
export const T_STRING = 10
export const T_BYTES = 12

export class QReader {
  constructor(buf) {
    this.b = buf
    this.p = 0
  }

  get remaining() {
    return this.b.length - this.p
  }

  take(n) {
    if (n < 0 || n > this.remaining) {
      throw new Error(`truncated: need ${n} at ${this.p}, have ${this.remaining}`)
    }
    const out = this.b.subarray(this.p, this.p + n)
    this.p += n
    return out
  }

  u8() {
    return this.take(1)[0]
  }

  u32() {
    return this.take(4).readUInt32BE(0)
  }

  i32() {
    return this.take(4).readInt32BE(0)
  }

  string() {
    const n = this.u32()
    if (n === NULL) return null
    if (n & 1) throw new Error(`odd QString byte length ${n} at ${this.p - 4}`)
    return Buffer.from(this.take(n)).swap16().toString('utf16le')
  }

  bytes() {
    const n = this.u32()
    return n === NULL ? null : Buffer.from(this.take(n))
  }

  variant() {
    const at = this.p
    const type = this.u32()
    const isNull = this.u8()
    let value
    switch (type) {
      case T_BOOL: {
        const v = this.u8()
        if (v > 1) throw new Error(`bool byte ${v} at ${this.p - 1}`)
        value = v === 1
        break
      }
      case T_INT: value = this.i32(); break
      case T_STRING: value = this.string(); break
      case T_BYTES: value = this.bytes(); break
      case T_MAP: value = this.vmap(); break
      default: throw new Error(`unsupported QVariant type id ${type} at offset ${at}`)
    }
    return { type, null: isNull, value }
  }

  vmap() {
    const n = this.u32()
    const out = []
    for (let i = 0; i < n; i++) out.push([this.string(), this.variant()])
    return out
  }
}

export class QWriter {
  constructor() {
    this.parts = []
  }

  raw(buf) {
    this.parts.push(buf)
    return this
  }

  u8(n) {
    return this.raw(Buffer.from([n]))
  }

  u32(n) {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return this.raw(b)
  }

  i32(n) {
    const b = Buffer.alloc(4)
    b.writeInt32BE(n)
    return this.raw(b)
  }

  string(s) {
    if (s === null) return this.u32(NULL)
    const b = Buffer.from(s, 'utf16le').swap16()
    return this.u32(b.length).raw(b)
  }

  bytes(b) {
    if (b === null) return this.u32(NULL)
    return this.u32(b.length).raw(b)
  }

  variant(v) {
    this.u32(v.type).u8(v.null)
    switch (v.type) {
      case T_BOOL: return this.u8(v.value ? 1 : 0)
      case T_INT: return this.i32(v.value)
      case T_STRING: return this.string(v.value)
      case T_BYTES: return this.bytes(v.value)
      case T_MAP: return this.vmap(v.value)
      default: throw new Error(`unsupported QVariant type id ${v.type}`)
    }
  }

  vmap(items) {
    this.u32(items.length)
    for (const [k, v] of items) this.string(k).variant(v)
    return this
  }

  toBuffer() {
    return Buffer.concat(this.parts)
  }
}
