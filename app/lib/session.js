// Editor session: one open theme, shared by the Electron UI, the MCP server and the CLI.
// Every mutation goes through here so all front ends see the same state ('change' event).
import { EventEmitter } from 'node:events'
import { basename } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  decodeTheme, encodeTheme, decodeControlData, editableActionFields,
  setKeyTitle, setKeyImage, setKeySound, setBackgroundVideo, setKeyActionField,
  copyKey, pasteKey, removeKey, parseKeyClip, keyRaw, setKeyRaw,
} from './theme.js'
import { toKeyPng, toDeviceMp4, toDeviceWav } from './media.js'
import { Device } from './device.js'

const run = promisify(execFile)
const TIMEOUT = 60_000

export const DEFAULT_REMOTE = '/data/theme/MK10/mk10studio.Theme'
export const DEFAULT_SSH = { host: 'root@10.0.1.48', remote: DEFAULT_REMOTE }
// mode 'auto' (default: detect the firmware), 'serial' (stock firmware) or 'ssh' (LilAlpine)
export const DEFAULT_PUSH = { mode: 'auto', port: null, ...DEFAULT_SSH }
const CONFIG = '/mnt/SDCARD/config.json'

const KEY_OPS = new Set(['keyCut', 'keyPaste', 'keyDelete', 'keyRaw', 'undo'])
const num = (v) => (v === undefined || v === '' ? undefined : Number(v))

// Multi-state keys (e.g. keyboard_switch, a toggle): item jsonData holds the per-state image, title and
// keycode; State is the state the device shows first. Plain keys have no jsonData.
function statesOf(it) {
  try {
    const j = it.jsonData ? JSON.parse(it.jsonData) : null
    if (!j?.isMultiState || !Array.isArray(j.States)) return undefined
    return {
      state: Number(j.State) || 0,
      list: j.States.map((s) => ({ path: s.path || undefined, paths: s.paths || undefined, frameDelays: s.frameDelays || undefined, title: s.title, keyString: s.keyString, keycode: s.keycode })),
    }
  } catch {
    return undefined
  }
}

function actionOf(it) {
  if (!it.controlData) return undefined
  try {
    const cd = decodeControlData(it.controlData)
    const pick = Object.fromEntries(cd.fields.filter(([k]) => k !== 'type').map(([k, v]) => [k, v.value]))
    return { type: cd.type, ...pick, editable: editableActionFields(cd) }
  } catch (e) {
    return { type: 'undecodable', error: e.message }
  }
}

export class Session extends EventEmitter {
  theme = null
  pushing = false
  file = null
  dirty = false
  // edits counts every change; pushedEdits is its value when the last successful push started.
  // An edit made while a push runs keeps the theme "unpushed".
  edits = 0
  pushedEdits = 0
  undoStack = [] // snapshots taken before a key cut/paste/delete

  async open(file) {
    this.theme = decodeTheme(await readFile(file))
    this.file = file
    this.dirty = false
    this.edits = this.pushedEdits = 0
    this.undoStack = []
    this.emit('change', { kind: 'open' })
    return this.summary()
  }

  // Themes inside an app bundle (the vendor ScreenKey install) are never overwritten in place.
  get isProtected() {
    return !!this.file && /\.app\/Contents\//.test(this.file)
  }

  async save(file = this.file) {
    this.need()
    if (file === this.file && this.isProtected) {
      throw new Error(`${file} is the vendor's stock theme; save to a new path instead (Save As / save_theme with path)`)
    }
    await writeFile(file, encodeTheme(this.theme))
    this.file = file
    this.dirty = false
    this.emit('change', { kind: 'save' })
    return file
  }

  need() {
    if (!this.theme) throw new Error('no theme open')
  }

  touch(kind) {
    // undo covers only key clipboard edits; any other edit clears it, so an undo never rolls it back
    if (!KEY_OPS.has(kind)) this.undoStack = []
    this.dirty = true
    this.edits++
    this.emit('change', { kind })
  }

  // Plain-data view of the theme for UI and MCP. Item `index` is stable within a page.
  summary() {
    if (!this.theme) return { file: null }
    const { json, assets } = this.theme
    return {
      file: this.file,
      dirty: this.dirty,
      pushing: this.pushing,
      currentPage: json.main?.currentPage,
      assetCount: assets.size,
      pages: json.pages.map((p, index) => ({
        index,
        name: p.pageName,
        parent: p.parentPageName,
        parentIndex: p.parentPageName ? json.pages.findIndex((q) => q.pageName === p.parentPageName) : undefined,
        canvas: p.canvas,
        items: (p.items ?? []).map((it, i) => ({
          index: i,
          type: String(it.type),
          backgroundType: it.backgroundType || undefined,
          x: num(it.x), y: num(it.y),
          w: num(it.w ?? it.scaledWidthTo), h: num(it.h ?? it.scaledHeightTo),
          row: num(it.row), col: num(it.col),
          title: it.title,
          titleParam: it.titleParam ? JSON.parse(it.titleParam) : undefined,
          path: it.path || undefined,
          sound: it.soundFile || undefined,
          paths: it.paths || undefined,
          frameDelays: it.frameDelays || undefined,
          text: it.text_str,
          systemData: it.system_data_name,
          digits: num(it.displayNum),
          font: it.text_font || undefined,
          action: actionOf(it),
          states: statesOf(it),
        })),
      })),
    }
  }

  asset(key) {
    this.need()
    return this.theme.assets.get(key)
  }

  // ---- key clipboard: copy returns the clipboard text; cut/paste/delete are undoable
  copyKey(page, row, col) {
    this.need()
    return JSON.stringify(copyKey(this.theme, page, row, col))
  }

  canPaste(text) {
    return !!this.theme && !!parseKeyClip(text)
  }

  snapshot() {
    // ponytail: whole-theme snapshot (json clone + shallow asset map, buffers shared), last 20 kept
    this.undoStack.push({ json: structuredClone(this.theme.json), assets: new Map(this.theme.assets) })
    if (this.undoStack.length > 20) this.undoStack.shift()
  }

  keyRaw(page, row, col) {
    this.need()
    return keyRaw(this.theme, page, row, col)
  }

  setKeyRaw(page, row, col, raw) {
    this.need()
    this.snapshot()
    try {
      setKeyRaw(this.theme, page, row, col, raw) // throws before changing anything on bad input
    } catch (e) {
      this.undoStack.pop()
      throw e
    }
    this.touch('keyRaw')
  }

  cutKey(page, row, col) {
    const text = this.copyKey(page, row, col)
    this.deleteKey(page, row, col, 'keyCut')
    return text
  }

  deleteKey(page, row, col, kind = 'keyDelete') {
    this.need()
    this.snapshot()
    try {
      removeKey(this.theme, page, row, col)
    } catch (e) {
      this.undoStack.pop()
      throw e
    }
    this.touch(kind)
  }

  pasteKey(page, row, col, text) {
    this.need()
    this.snapshot()
    let warnings
    try {
      warnings = pasteKey(this.theme, page, row, col, text)
    } catch (e) {
      this.undoStack.pop()
      throw e
    }
    this.touch('keyPaste')
    return warnings
  }

  undo() {
    const s = this.undoStack.pop()
    if (!s) return false
    this.theme.json = s.json
    this.theme.assets = s.assets
    this.touch('undo')
    return true
  }

  setKeyTitle(page, row, col, title) {
    this.need()
    setKeyTitle(this.theme, page, row, col, title)
    this.touch('keyTitle')
  }

  setKeyActionField(page, row, col, field, value) {
    this.need()
    setKeyActionField(this.theme, page, row, col, field, value)
    this.touch('keyAction')
  }

  // input: path to any image ffmpeg can read, or a Buffer that is already a 128x128 PNG
  async setKeyImage(page, row, col, input) {
    this.need()
    const png = typeof input === 'string' ? await toKeyPng(input) : input
    const key = setKeyImage(this.theme, page, row, col, png)
    this.touch('keyImage')
    return key
  }

  // input: path to any audio file ffmpeg reads (converted to 48 kHz stereo WAV), or null to clear
  async setKeySound(page, row, col, input) {
    this.need()
    const wav = input ? await toDeviceWav(input) : null
    const key = setKeySound(this.theme, page, row, col, wav, input ? basename(input) : undefined)
    this.touch('keySound')
    return key
  }

  // input: path to any video ffmpeg can read (transcoded to the stock player format)
  async setBackgroundVideo(page, input) {
    this.need()
    const mp4 = typeof input === 'string' ? await toDeviceMp4(input) : input
    const key = setBackgroundVideo(this.theme, page, mp4)
    this.touch('video')
    return key
  }

  // LilAlpine answers ssh and has /etc/alpine-release, so ssh wins when it answers. Stock Tina has no
  // ssh, only the vendor app's USB serial port (LilAlpine runs the same app, so it has the port too
  // and a serial push still works there). Errors when neither is found: never guesses a mode.
  // A busy device (theme reload, SPI frame push) can take seconds to finish the ssh handshake, so the
  // probe gets 10 s and logs why ssh failed before it falls back to serial.
  async detectMode({ host } = DEFAULT_SSH, log = () => {}) {
    const why = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'test -f /etc/alpine-release && echo lilalpine'], { timeout: 10000 })
      .then(({ stdout }) => (stdout.trim() === 'lilalpine' ? null : 'answers over ssh but has no /etc/alpine-release'),
        (e) => (e.killed ? 'no answer within 10 s' : (e.stderr || e.message).trim().split('\n').pop()))
    if (!why) return 'ssh'
    log(`auto: ${host} is not LilAlpine (${why})`)
    if ((await Device.list()).length) return 'serial'
    throw new Error(`no MK10 found: ${host} is not LilAlpine (${why}), and no MK10 USB serial port is present`)
  }

  // true when the theme changed since it was opened or last pushed
  get unpushed() {
    return this.edits !== this.pushedEdits
  }

  // One push at a time, from any caller (UI, menu, quit prompt, MCP). confirm(o) runs after auto
  // detection with the resolved mode; false cancels and push returns null.
  async push(opts = DEFAULT_PUSH, log = () => {}, confirm = null) {
    return this.deviceLock(async () => {
      const at = this.edits
      const r = await this.pushTo(opts, log, confirm)
      if (r !== null) this.pushedEdits = at
      return r
    })
  }

  // push and pull share one lock: one device operation at a time
  async deviceLock(fn) {
    if (this.pushing) throw new Error('a push or pull is already in progress')
    this.pushing = true
    this.emit('change', { kind: 'push' })
    try {
      return await fn()
    } finally {
      this.pushing = false
      this.emit('change', { kind: 'push' })
    }
  }

  // Pull the theme the device loads (config.json defaultTheme) into a local file. ssh only: the stock
  // firmware's serial API has no file read (its methods: deleteFiles, getFilesBySuffix, getInfo,
  // keyboardInput, playAudio, saveToFile, setBacklight, setFileCRC, setVolume, stopAudio).
  // pickDest(remotePath) returns the local path, or null to cancel. Returns the local path, or null.
  async pull(opts = DEFAULT_PUSH, log = () => {}, pickDest = async () => null) {
    return this.deviceLock(async () => {
      const o = { ...DEFAULT_PUSH, ...opts }
      if (o.mode === 'auto') {
        o.mode = await this.detectMode(o, log)
        log(`auto: ${o.mode === 'ssh' ? 'LilAlpine' : 'stock firmware'} detected`)
      }
      if (o.mode !== 'ssh') throw new Error('Pull needs LilAlpine (ssh): the stock firmware has no way to read a file back over USB')
      const { stdout } = await run('ssh', ['-o', 'ConnectTimeout=5', o.host, `cat ${CONFIG}`], { timeout: TIMEOUT })
      const remote = JSON.parse(stdout).defaultTheme
      // device data: refuse anything that isn't a plain absolute path before it goes into scp
      if (typeof remote !== 'string' || !/^\/[\w./-]+\.Theme$/i.test(remote)) throw new Error(`config.json defaultTheme is not a plain .Theme path: ${JSON.stringify(remote)}`)
      const dest = await pickDest(remote)
      if (!dest) return null
      log(`scp <- ${o.host}:${remote}`)
      await run('scp', ['-q', '-o', 'ConnectTimeout=5', `${o.host}:${remote}`, dest], { timeout: TIMEOUT })
      decodeTheme(await readFile(dest)) // fail here, not on open, if the copy is not a theme
      log(`pulled ${remote} -> ${dest}`)
      return dest
    })
  }

  async pushTo(opts, log, confirm) {
    const o = { ...DEFAULT_PUSH, ...opts }
    if (o.mode === 'auto') {
      o.mode = await this.detectMode(o, log)
      log(`auto: ${o.mode === 'ssh' ? 'LilAlpine' : 'stock firmware'} detected, pushing over ${o.mode}`)
    }
    if (confirm && !(await confirm(o))) return null
    if (o.mode === 'ssh') return this.pushSsh(o, log)
    if (o.mode === 'serial') return this.pushSerial(o, log)
    throw new Error(`unknown push mode ${o.mode}`)
  }

  // Protocol-only push (verified on device against KeyboardDevice V2.34): saveToFile chunks +
  // setFileCRC to a NEW file, V1 reload onto it, then delete older mk10studio pushes. The active
  // theme is never deleted or half-written: a failed push leaves the previous one in place.
  // ~10 s for 12 MB. Never sends getInfo (it blanks the panel).
  async pushSerial({ port, remote } = DEFAULT_PUSH, log = () => {}) {
    this.need()
    const path = port || (await Device.list())[0]?.path
    if (!path) throw new Error('MK10 serial port not found (is it plugged in? is ScreenKey running?)')
    const base = remote.replace(/\.Theme$/, '')
    const target = `${base}-${Date.now()}.Theme`
    const buf = encodeTheme(this.theme)
    const dev = new Device()
    await dev.open(path)
    try {
      log(`serial ${path}: writing ${(buf.length / 1e6).toFixed(1)} MB to ${target}`)
      let last = 0
      await dev.pushFile(buf, target, (done, total) => {
        const pct = Math.floor((done / total) * 10) * 10
        if (pct > last) { last = pct; log(`  ${pct}%`) }
      })
      log(`reload ${target}`)
      await dev.reloadTheme(target)
      const listed = (await dev.call('getFilesBySuffix', { suffixs: ['Theme'] })).result?.filePaths ?? []
      const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const stale = listed.map((f) => f.filePath).filter((f) => f !== target && new RegExp(`^${esc}-\\d+\\.Theme$`).test(f))
      if (stale.length) {
        const r = (await dev.call('deleteFiles', { filePaths: stale })).result
        log(`removed old pushes: ${(r?.deletedFiles ?? []).join(', ') || 'none'}${r?.failedFiles?.length ? `; failed: ${r.failedFiles.join(', ')}` : ''}`)
      }
    } finally {
      await dev.close()
    }
    log('pushed')
    return target
  }

  // Device levels over the USB serial JSON API ({"method":M,"parameters":{"level":N}}, vendor demo
  // mainwindow.cpp:742/755). Both firmwares run the vendor app, so serial works on either.
  // setBacklight: panel brightness 0-100. setVolume: speaker 0-7 (the app applies it as tinymix
  // "Headphone volume", range 0-7).
  static LEVELS = { setBacklight: ['brightness', 100], setVolume: ['volume', 7] }

  async setLevel(method, level) {
    const [name, max] = Session.LEVELS[method] ?? []
    if (!name) throw new Error(`unknown device level ${method}`)
    if (this.pushing) throw new Error(`push in progress: ${name} waits until it finishes`)
    const n = Math.round(Number(level))
    if (!(n >= 0 && n <= max)) throw new Error(`${name} must be 0-${max}, got ${level}`)
    const path = (await Device.list())[0]?.path
    if (!path) throw new Error('MK10 serial port not found (is it plugged in? is ScreenKey running?)')
    const dev = new Device()
    await dev.open(path)
    try {
      await dev.call(method, { level: n })
    } finally {
      await dev.close()
    }
    return n
  }

  // Verified recipe (docs/theme-format.md, Device verification): copy theme, point
  // config.json defaultTheme at it, restart KeyboardDevice. LilAlpine only (needs ssh).
  async pushSsh({ host, remote } = DEFAULT_SSH, log = () => {}) {
    this.need()
    const tmp = `${process.env.TMPDIR ?? '/tmp/'}mk10studio-push.Theme`
    await writeFile(tmp, encodeTheme(this.theme))
    log(`scp -> ${host}:${remote}`)
    await run('scp', ['-q', '-o', 'ConnectTimeout=5', tmp, `${host}:${remote}`], { timeout: TIMEOUT })
    const { stdout } = await run('ssh', ['-o', 'ConnectTimeout=5', host, `cat ${CONFIG}`], { timeout: TIMEOUT })
    const cfg = JSON.parse(stdout)
    if (cfg.defaultTheme !== remote) {
      log(`config.json defaultTheme: ${cfg.defaultTheme} -> ${remote}`)
      cfg.defaultTheme = remote
      const q = JSON.stringify(cfg).replaceAll("'", "'\\''")
      await run('ssh', [host, `printf '%s' '${q}' > ${CONFIG}.new && mv ${CONFIG}.new ${CONFIG} && sync`], { timeout: TIMEOUT })
    }
    log('rc-service keyboard-device restart')
    await run('ssh', [host, 'rc-service keyboard-device restart'], { timeout: TIMEOUT })
    // Once (2026-11-24) the restart came up without videoplayerinterfaceAPP (black background);
    // not reproduced since. Check for it so a silent miss shows in the log.
    const hasVideo = (this.theme.json.pages[0]?.items ?? []).some((x) => String(x.type) === '100' && x.path)
    const { stdout: ps } = !hasVideo ? { stdout: 'up' } : await run('ssh', [host,
      'for i in 1 2 3 4 5 6 7 8; do sleep 2; ps -o args | grep -q "[v]ideoplayerinterfaceAPP" && echo up && exit; done; echo down'],
    { timeout: TIMEOUT })
    if (ps.trim() !== 'up') log('warning: background video player did not start; push again or press a key on the device')
    log('pushed')
    return remote
  }
}
