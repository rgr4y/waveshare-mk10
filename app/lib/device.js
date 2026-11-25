// MK10 device over USB CDC serial. Nothing is sent on open().
// Replies to a call look like {ack_method, success, result?, errorString?}; unsolicited events
// look like {method, parameters} (e.g. keyStateChanged {col, row, pressed}). Old-style V1 frames
// in the same stream are decoded too and emitted as 'v1' {v1: cmd, name, type, payload}.
import { EventEmitter } from 'node:events'
import { SerialPort } from 'serialport'
import { pack, packV1, V1_RELOAD, V1_NAMES, FrameParser, V1Parser, decodeV1, crc32, CMD_JSON, CMD_SHOW_JPG } from './proto.js'

export const VID = '1d6b'
export const PID = '0104'
export const CHUNK = 64 * 1024

// Every JSON-RPC message any Device sends or receives, for the developer window:
// {dir: 'tx'|'rx'|'open'|'close', path, msg}. Listeners must not mutate msg.
export const wire = new EventEmitter()

export class Device extends EventEmitter {
  constructor() {
    super()
    this.port = null
    this.parser = new FrameParser()
    this.v1 = new V1Parser() // old-style frames the device sends on its own (key events, contract)
    this.pending = [] // {method, resolve, reject, timer}
    this.nextId = 1
  }

  static async list() {
    const all = await SerialPort.list()
    return all.filter((p) =>
      (p.vendorId?.toLowerCase() === VID && p.productId?.toLowerCase() === PID) ||
      /^\/dev\/(cu|tty)\.usbmodemMK10/.test(p.path))
      // macOS: serialport reports the blocking /dev/tty.* node; open the /dev/cu.* callout twin instead
      .map((p) => ({ ...p, path: p.path.replace(/^\/dev\/tty\.usbmodem/, '/dev/cu.usbmodem') }))
  }

  get isOpen() {
    return !!this.port?.isOpen
  }

  open(path) {
    if (this.port) return Promise.reject(new Error('already open'))
    const port = new SerialPort({ path, baudRate: 115200, autoOpen: false })
    port.on('data', (chunk) => this.#onData(chunk))
    port.on('error', (e) => this.emit('error', e))
    port.on('close', () => {
      wire.emit('msg', { dir: 'close', path })
      this.port = null
      this.#failAll(new Error('port closed'))
      this.emit('close')
    })
    return new Promise((resolve, reject) => {
      port.open((err) => {
        if (err) return reject(err)
        this.port = port
        this.parser = new FrameParser()
        this.v1 = new V1Parser()
        wire.emit('msg', { dir: 'open', path })
        resolve()
      })
    })
  }

  close() {
    const port = this.port
    if (!port?.isOpen) return Promise.resolve()
    return new Promise((resolve) => port.close(() => resolve()))
  }

  #onData(chunk) {
    this.emit('raw', chunk)
    for (const f of this.v1.push(chunk)) {
      const msg = { v1: f.cmd, name: V1_NAMES[f.cmd] ?? '?', type: f.type, payload: decodeV1(f.cmd, f.payload) }
      this.emit('v1', msg)
      wire.emit('msg', { dir: 'rx', path: this.port?.path, msg })
    }
    for (const f of this.parser.push(chunk)) {
      this.emit('frame', f)
      if (f.cmd !== CMD_JSON) continue
      let msg
      try {
        msg = JSON.parse(f.data.toString('utf8'))
      } catch {
        this.emit('badjson', f)
        wire.emit('msg', { dir: 'rx', path: this.port?.path, msg: { badJson: f.data.toString('utf8') } })
        continue
      }
      wire.emit('msg', { dir: 'rx', path: this.port?.path, msg })
      if (msg.ack_method !== undefined) {
        const i = this.pending.findIndex((p) => p.method === msg.ack_method)
        if (i < 0) {
          this.emit('ack', msg) // unmatched (late or from someone else)
          continue
        }
        const [p] = this.pending.splice(i, 1)
        clearTimeout(p.timer)
        if (msg.success === false) {
          p.reject(Object.assign(new Error(`${msg.ack_method}: ${msg.errorString ?? 'failed'}`), { response: msg }))
        } else p.resolve(msg)
      } else if (msg.method !== undefined) {
        this.emit('event', msg.method, msg.parameters ?? {})
        this.emit(msg.method, msg.parameters ?? {})
      } else this.emit('message', msg)
    }
  }

  #failAll(err) {
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer)
      p.reject(err)
    }
  }

  #write(buf) {
    if (!this.isOpen) return Promise.reject(new Error('port not open'))
    return new Promise((resolve, reject) => {
      this.port.write(buf, (err) => {
        if (err) return reject(err)
        this.port.drain((e) => (e ? reject(e) : resolve()))
      })
    })
  }

  // Resolves with the full ack object ({ack_method, success, result}); rejects on success:false or timeout.
  // Replies are matched by ack_method (FIFO among same-method calls).
  call(method, params, { timeout = 5000 } = {}) {
    const payload = { method }
    if (params !== undefined) payload.parameters = params
    const frame = pack(CMD_JSON, Buffer.from(JSON.stringify(payload)), this.nextId++ >>> 0)
    wire.emit('msg', { dir: 'tx', path: this.port?.path, msg: payload })
    return new Promise((resolve, reject) => {
      const p = { method, resolve, reject }
      p.timer = setTimeout(() => {
        this.pending = this.pending.filter((x) => x !== p)
        reject(new Error(`${method}: no reply within ${timeout} ms`))
      }, timeout)
      this.pending.push(p)
      this.#write(frame).catch((e) => {
        clearTimeout(p.timer)
        this.pending = this.pending.filter((x) => x !== p)
        reject(e)
      })
    })
  }

  // saveToFile in 64 KiB base64 chunks, then setFileCRC (as tools/pushfile.py). Returns the setFileCRC ack.
  async pushFile(buf, remotePath, onProgress, { timeout = 15000 } = {}) {
    for (let pos = 0; pos < buf.length; pos += CHUNK) {
      const seg = buf.subarray(pos, pos + CHUNK)
      await this.call('saveToFile', { filePath: remotePath, seek: pos, data: seg.toString('base64') }, { timeout })
      onProgress?.(Math.min(pos + seg.length, buf.length), buf.length)
    }
    return this.call('setFileCRC', { filePath: remotePath, crc: String(crc32(buf)) }, { timeout })
  }

  // Switch the device to a theme file already on it (V1 cmd 2). Resolves when the device
  // echoes the path (~4 s for the 13 MB stock theme).
  reloadTheme(path, { timeout = 30000 } = {}) {
    const want = Buffer.from(path, 'utf8')
    return new Promise((resolve, reject) => {
      let seen = Buffer.alloc(0)
      const done = (err) => {
        clearTimeout(timer)
        this.off('raw', onRaw)
        err ? reject(err) : resolve(path)
      }
      const onRaw = (chunk) => {
        seen = Buffer.concat([seen, chunk]).subarray(-64 * 1024)
        if (seen.includes(want)) done()
      }
      const timer = setTimeout(() => done(new Error(`reloadTheme: no echo within ${timeout} ms`)), timeout)
      this.on('raw', onRaw)
      wire.emit('msg', { dir: 'tx', path: this.port?.path, msg: { v1: V1_RELOAD, name: V1_NAMES[V1_RELOAD], type: 0, payload: path } })
      this.#write(packV1(V1_RELOAD, want)).catch(done)
    })
  }

  showJpeg(buf) {
    return this.#write(pack(CMD_SHOW_JPG, Buffer.from(buf), this.nextId++ >>> 0))
  }
}
