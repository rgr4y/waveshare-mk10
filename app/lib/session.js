// Editor session: one open theme, shared by the Electron UI, the MCP server and the CLI.
// Every mutation goes through here so all front ends see the same state ('change' event).
import { EventEmitter } from 'node:events'
import { basename } from 'node:path'
import { readFile, stat, writeFile, copyFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  decodeTheme, encodeTheme, decodeControlData, editableActionFields,
  setKeyTitle, setKeyTitleParam, setKeyImage, setKeySound, setBackgroundVideo, setBackgroundVideoRect, setKeyBackground, setKeyTitleOutline, setBakedTitle, setKeyVectorIcon, setKeyActionField,
  copyKey, pasteKey, removeKey, moveKeys, parseKeyClip, keyRaw, setKeyRaw, pageRaw, setPageRaw, newKeyTypes, createKey, setKeyIcon, englishDescriptions, fontFamilies, deleteFolder,
} from './theme.js'
import { toKeyPng, toDeviceMp4, toDeviceWav } from './media.js'
import { Device } from './device.js'
import { BG_ASSET_RE } from './keyactions.js'
import { packV1, V1_RELOAD } from './proto.js'
import { DEVICE_FONT_DIR } from './fonts.js'
import { isPanelItem, movePanelItem, deletePanelItem, setPanelZ, alignPos, addPanelItem, setPanelItem, dataNames } from './panel.js'
import { readMacro, setKeyMacro } from './macro.js'

const run = promisify(execFile)
const TIMEOUT = 60_000
const ZSTD = process.env.ZSTD ?? 'zstd'
const md5 = (buf) => createHash('md5').update(buf).digest('hex')
const mb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`)

export const DEFAULT_REMOTE = '/data/theme/MK10/mk10studio.Theme'
// Display state on the device, appended to /var/log/mk10-display.log with a label. Run after every
// serial reload (and by hand when the panel is black) to find what a blackout looks like remotely:
// processes, disp layers (ch0 = video, ch1 = UI), fb0 pan and how many page-0 bytes are non-zero,
// and the app log tail.
export const displaySnap = (label) => `label='${String(label).replaceAll("'", '')}'; { echo "== $(date '+%F %T') $label"
echo "KD=[$(pidof KeyboardDevice)] VP=[$(pidof videoplayerinterfaceAPP)] fb0 pan=$(cat /sys/class/graphics/fb0/pan) nonzero=$(head -c 1089536 /dev/fb0 | tr -d '\\000' | wc -c)"
grep -E 'able ch' /sys/class/disp/disp/attr/sys | sed -E 's/^.*(enable|disable) (ch\\[[0-9]\\]).*z\\[ *([0-9]+)\\].*fb\\[ *([0-9]+), *([0-9]+);.*addr\\[ *([0-9a-f]+),.*/  \\1 \\2 z\\3 \\4x\\5 addr \\6/'
tail -n 5 /var/log/keyboard-device.log | sed 's/^/  log: /'; } >> /var/log/mk10-display.log 2>&1`
// Shell for the device: inject a V1 reload frame for `path` into /dev/ttyGS0 with TIOCSTI (0x5412;
// kernel 5.4 allows it for root), then wait up to 20 s for the app to rewrite config.json.
// Studio pauses its own serial traffic during a push, so the injected bytes don't interleave.
export const ttyReload = (path) => {
  if (!/^\/[\w./-]+$/.test(path)) throw new Error(`refusing odd theme path ${path}`)
  const hex = packV1(V1_RELOAD, Buffer.from(path, 'utf8')).toString('hex')
  return `c=/mnt/SDCARD/config.json; t0=$(stat -c %Y $c); sleep 1
perl -e 'open(my $f, "+<", "/dev/ttyGS0") or die "ttyGS0: $!\n"; ioctl($f, 0x5412, $_) or die "TIOCSTI: $!\n" for split //, pack("H*", "${hex}")' || exit 1
i=0; while [ $i -lt 40 ]; do [ "$(stat -c %Y $c)" != "$t0" ] && exit 0; sleep 0.5; i=$((i+1)); done
echo "the app did not rewrite config.json within 20 s" >&2; exit 1`
}
export const DEFAULT_SSH = { host: 'root@10.0.1.48', remote: DEFAULT_REMOTE }
// mode 'auto' (default: detect the firmware), 'serial' (stock firmware) or 'ssh' (LilAlpine)
export const DEFAULT_PUSH = { mode: 'auto', port: null, ...DEFAULT_SSH }
const CONFIG = '/mnt/SDCARD/config.json'

const KEY_OPS = new Set(['keyCut', 'keyPaste', 'keyDelete', 'keyRaw', 'pageRaw', 'keyNew', 'keyMove', 'folderDelete', 'undo', 'panelMove', 'panelDelete', 'panelZ', 'panelAlign', 'panelAdd', 'panelSet'])
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

function macroOf(it) {
  try {
    return readMacro(it) ?? undefined
  } catch (e) {
    return { error: e.message }
  }
}

export class Session extends EventEmitter {
  theme = null
  pushing = false
  titleDefaults = {} // Settings > New key title: {FontFamily, FontSize, FontStyle}
  file = null
  dirty = false
  // edits counts every change; pushedEdits is its value when the last successful push started.
  // An edit made while a push runs keeps the theme "unpushed".
  edits = 0
  pushedEdits = 0
  held = null // Device kept open while the JSON RPC window is on; serial calls reuse it
  undoStack = [] // snapshots taken before a key cut/paste/delete

  async open(file) {
    this.theme = decodeTheme(await readFile(file))
    this.file = file
    // the vendor's Chinese default descriptions become English; that counts as an unsaved edit
    this.translated = englishDescriptions(this.theme)
    this.dirty = this.translated > 0
    this.edits = this.translated > 0 ? 1 : 0
    this.pushedEdits = 0
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
    const deviceOp = (this.opShown && this.pushing) || null // 'push' | 'pull', once confirmed
    if (!this.theme) return { file: null, pushing: !!this.pushing, deviceOp }
    const { json, assets } = this.theme
    return {
      file: this.file,
      dirty: this.dirty,
      pushing: !!this.pushing,
      deviceOp,
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
          z: num(it.z), scale: num(it.scale), radius: num(it.radius),
          flag: it.system_data_flag, color: it.front_color,
          crop: it.mk10studioCrop ? JSON.parse(it.mk10studioCrop) : undefined,
          w: num(it.w ?? it.scaledWidthTo), h: num(it.h ?? it.scaledHeightTo),
          row: num(it.row), col: num(it.col),
          title: it.title,
          titleParam: it.titleParam ? JSON.parse(it.titleParam) : undefined,
          icon: it.mk10studioIcon ? JSON.parse(it.mk10studioIcon) : undefined,
          stateIcons: it.mk10studioStateIcons ? JSON.parse(it.mk10studioStateIcons) : undefined,
          outline: it.mk10studioOutline ? { ...JSON.parse(it.mk10studioOutline), base: it.mk10studioBase || null, sig: it.mk10studioSig || '' } : undefined,
          path: it.path || undefined,
          sound: it.soundFile || undefined,
          paths: it.paths || undefined,
          frameDelays: it.frameDelays || undefined,
          text: it.text_str,
          raw: it.backgroundType === 'secondary' ? { ...it } : undefined, // Inspector fields
          systemData: it.system_data_name,
          digits: num(it.displayNum),
          font: it.text_font || undefined,
          action: actionOf(it),
          states: statesOf(it),
          macro: macroOf(it),
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

  pageRaw(page) {
    this.need()
    return pageRaw(this.theme, page)
  }

  setPageRaw(page, raw) {
    this.need()
    this.snapshot()
    try {
      setPageRaw(this.theme, page, raw) // throws before changing anything on bad input
    } catch (e) {
      this.undoStack.pop()
      throw e
    }
    this.touch('pageRaw')
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

  moveKeys(page, moves) {
    this.need()
    this.snapshot()
    try {
      moveKeys(this.theme, page, moves) // validates everything before moving anything
    } catch (e) {
      this.undoStack.pop()
      throw e
    }
    this.touch('keyMove')
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

  fontFamilies() {
    this.need()
    return fontFamilies(this.theme)
  }

  deleteFolder(page) {
    this.need()
    this.snapshot()
    let gone
    try {
      gone = deleteFolder(this.theme, page)
    } catch (e) {
      this.undoStack.pop()
      throw e
    }
    this.touch('folderDelete')
    return gone
  }

  newKeyTypes(page) {
    this.need()
    return newKeyTypes(this.theme, page)
  }

  createKey(page, row, col, type) {
    this.need()
    this.snapshot()
    try {
      createKey(this.theme, page, row, col, type, this.titleDefaults)
    } catch (e) {
      this.undoStack.pop()
      throw e
    }
    this.touch('keyNew')
  }

  get canUndo() {
    return this.undoStack.length > 0
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

  setKeyTitleParam(page, row, col, patch) {
    this.need()
    setKeyTitleParam(this.theme, page, row, col, patch)
    this.touch('keyTitle')
  }

  setKeyActionField(page, row, col, field, value) {
    this.need()
    setKeyActionField(this.theme, page, row, col, field, value)
    this.touch('keyAction')
  }

  setKeyMacro(page, row, col, steps) {
    this.need()
    setKeyMacro(this.theme, page, row, col, steps)
    this.touch('keyAction')
  }

  // input: path to any image ffmpeg can read, or a Buffer that is already a 128x128 PNG
  async setKeyImage(page, row, col, input, state) {
    this.need()
    const png = typeof input === 'string' ? await toKeyPng(input) : input
    const key = setKeyImage(this.theme, page, row, col, png, state)
    this.touch('keyImage')
    return key
  }

  setKeyIcon(page, row, col, name, state) {
    this.need()
    const key = setKeyIcon(this.theme, page, row, col, name, state)
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

  // input: path to a video or still image (transcoded like a page background)
  async setKeyBackground(page, row, col, input) {
    this.need()
    const key = setKeyBackground(this.theme, page, row, col, await toDeviceMp4(input))
    this.touch('keyAction')
    return key
  }

  // Swap background / Freeze background key presses (LilAlpine with vplayer installed as the
  // device's videoplayerinterfaceAPP; the stock launcher exits on SIGUSR1/2, so check first).
  // swap: a second press of the same key goes back to the page's own video.
  async backgroundKey(host, { run: kind, target }) {
    if (kind !== 'freeze' && !BG_ASSET_RE.test(target)) throw new Error(`not a background asset: ${target}`) // it goes into a shell line
    const sh = `P=$(pidof videoplayerinterfaceAPP) || { echo "no background video is playing" >&2; exit 2; }
for p in $P; do case $(readlink /proc/$p/exe) in */vplayer) ;; *) echo "the device's video player can't pause or swap (vplayer is not installed)" >&2; exit 3;; esac; done
${kind === 'freeze' ? 'kill -USR1 $P' : `F=/data${target}; S=/run/mk10-background
[ -r "$F" ] || { echo "$F is not on the device: push the theme first" >&2; exit 4; }
if [ "$(cat $S 2>/dev/null)" = "$F" ]; then : > $S; else echo "$F" > $S; fi
kill -USR2 $P`}`
    await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, sh], { timeout: 15_000 }).catch((e) => {
      throw new Error(String(e.stderr ?? '').trim().split('\n').pop() || e.message)
    })
  }

  // the device's background video state as vplayer reports it; true = paused. Anything unreadable
  // (no vplayer, no ssh, player restarted) counts as playing.
  async backgroundPaused(host) {
    const out = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, 'cat /run/mk10-vplayer-state'], { timeout: 10_000 })
      .then(({ stdout }) => stdout.trim(), () => '')
    return out === 'paused'
  }

  // true when some key in the theme is a Freeze background toggle (worth watching the player for)
  hasFreezeKey() {
    return !!this.theme?.json.pages.some((p) => (p.items ?? []).some((it) => actionOf(it)?.mk10studioRun === 'freeze'))
  }

  setKeyTitleOutline(page, row, col, outline) {
    this.need()
    setKeyTitleOutline(this.theme, page, row, col, outline)
    this.touch('keyTitle')
  }

  setKeyVectorIcon(page, row, col, png, icon, state) {
    this.need()
    const key = setKeyVectorIcon(this.theme, page, row, col, png, icon, state)
    this.touch('keyImage')
    return key
  }

  setBakedTitle(page, row, col, png, sig) {
    this.need()
    setBakedTitle(this.theme, page, row, col, png, sig)
    this.touch('keyImage')
  }

  setVideoRect(page, rect) {
    this.need()
    setBackgroundVideoRect(this.theme, page, rect)
    this.touch('videoRect')
  }

  // Panel ops: the renderer calls panelBegin once per drag / nudge burst, then panelMove with snapshot:false
  panelBegin() {
    this.need()
    this.snapshot()
  }

  // runs op under one snapshot (or none when already taken); a throw leaves no undo entry
  panelOp(kind, snap, op) {
    this.need()
    if (snap) this.snapshot()
    let r
    try {
      r = op()
    } catch (e) {
      if (snap) this.undoStack.pop()
      throw e
    }
    this.touch(kind)
    return r
  }

  panelMove(page, index, x, y, { snapshot = true } = {}) {
    this.panelOp('panelMove', snapshot, () => movePanelItem(this.theme, page, index, x, y))
  }

  panelDelete(page, index) {
    this.panelOp('panelDelete', true, () => deletePanelItem(this.theme, page, index))
  }

  panelZ(page, index, dir) {
    return this.panelOp('panelZ', true, () => setPanelZ(this.theme, page, index, dir))
  }

  panelAdd(page, kind) {
    return this.panelOp('panelAdd', true, () => addPanelItem(this.theme, page, kind))
  }

  panelSet(page, index, fields) {
    this.panelOp('panelSet', true, () => setPanelItem(this.theme, page, index, fields))
  }

  dataNames() {
    this.need()
    return dataNames(this.theme)
  }

  panelAlign(page, index, how, size) {
    this.panelOp('panelAlign', true, () => {
      const it = this.theme.json.pages[page]?.items?.[index]
      if (!isPanelItem(it)) throw new Error(`no panel item ${index} on page ${page}`)
      const p = alignPos({ x: Number(it?.x), y: Number(it?.y), w: size?.w, h: size?.h }, how)
      movePanelItem(this.theme, page, index, p.x, p.y)
    })
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
    return this.deviceLock('push', async () => {
      const at = this.edits
      const r = await this.pushTo(opts, log, confirm)
      if (r !== null) this.pushedEdits = at
      return r
    })
  }

  // the UI's progress overlay (summary deviceOp) waits for this: after the confirm or save dialog,
  // so it never covers a question the user still has to answer
  opStarted() {
    this.opShown = true
    this.emit('change', { kind: 'push' })
  }

  // push and pull share one lock: one device operation at a time. pushing = 'push' | 'pull' | false
  async deviceLock(kind, fn) {
    if (this.pushing) throw new Error('a push or pull is already in progress')
    this.pushing = kind
    this.opShown = false
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
    return this.deviceLock('pull', async () => {
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
      this.opStarted()
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
    this.opStarted()
    if (o.mode === 'ssh') return this.pushSsh(o, log)
    if (o.mode === 'serial') return this.pushSerial(o, log)
    throw new Error(`unknown push mode ${o.mode}`)
  }

  // Protocol-only push (verified on device against KeyboardDevice V2.34): saveToFile chunks +
  // setFileCRC to a NEW file, V1 reload onto it, then delete older mk10studio pushes. The active
  // theme is never deleted or half-written: a failed push leaves the previous one in place.
  // ~10 s for 12 MB. Never sends getInfo (it blanks the panel).
  async pushSerial({ port, remote, fonts } = DEFAULT_PUSH, log = () => {}) {
    this.need()
    const files = (await fonts?.(() => {})) ?? []
    if (files.length) log(`warning: the stock firmware can't take fonts over USB; the device draws ${files.map((f) => basename(f)).join(', ')} text in its default font`)
    const base = remote.replace(/\.Theme$/, '')
    const target = `${base}-${Date.now()}.Theme`
    const buf = encodeTheme(this.theme)
    await this.withDevice(async (dev) => {
      log(`serial ${dev.port.path}: writing ${(buf.length / 1e6).toFixed(1)} MB to ${target}`)
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
    }, port)
    log('pushed')
    return target
  }

  // Reboot over ssh (LilAlpine; the vendor app has no reboot command over serial) and wait until
  // KeyboardDevice runs again. LilAlpine resets through the watchdog, so this takes a boot plus ~5 s.
  async rebootSsh(host, log = () => {}) {
    if (this.pushing) throw new Error('push in progress: reboot after it finishes')
    log(`reboot ${host}`)
    await run('ssh', ['-o', 'ConnectTimeout=5', host, 'sync; reboot'], { timeout: TIMEOUT }).catch((e) => {
      if (e.code !== 255) throw e // 255: ssh lost the link as the device went down
    })
    const t = Date.now()
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000))
      if (await run('ssh', ['-o', 'ConnectTimeout=3', host, 'pidof KeyboardDevice'], { timeout: 10_000 }).then(() => true, () => false)) break
      if (Date.now() - t > 120_000) throw new Error(`${host} not back within 120 s`)
    }
    log(`${host} back up (${Math.round((Date.now() - t) / 1000)} s)`)
  }

  // Run fn on an open Device. The port is exclusive (serialport locks it), so a held Device is
  // reused; otherwise a fresh one is opened and closed afterwards.
  async withDevice(fn, port = null) {
    if (this.held?.isOpen) return fn(this.held)
    const path = port || (await Device.list())[0]?.path
    if (!path) throw new Error('MK10 serial port not found (is it plugged in? is ScreenKey running?)')
    const dev = new Device()
    await dev.open(path)
    try {
      return await fn(dev)
    } finally {
      await dev.close()
    }
  }

  // Keep the serial port open (on) so the device's unsolicited messages arrive, or release it.
  // V1 frames from the held port are re-emitted as 'v1' (key events, page contracts).
  // Returns whether a Device is held. Not found or busy (a push holds it) returns false; the
  // caller retries.
  async holdDevice(on) {
    if (!on) {
      const d = this.held
      this.held = null
      await d?.close()
      return false
    }
    if (this.held?.isOpen) return true
    const path = (await Device.list())[0]?.path
    if (!path) return false
    const dev = new Device()
    dev.on('error', () => {}) // a port error ends in 'close', which drops it below
    dev.on('close', () => { if (this.held === dev) this.held = null })
    dev.on('v1', (m) => this.emit('v1', m))
    await dev.open(path)
    this.held = dev
    this.heldAt = Date.now()
    return true
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
    await this.withDevice((dev) => dev.call(method, { level: n }))
    return n
  }

  // Delta push for pushSsh: true when the device rebuilt `remote` from a patch and its md5 matches.
  async pushDelta({ host, remote, tmp, buf, basis }, log) {
    const old = await readFile(basis).catch(() => null)
    if (!old) return false
    // window must cover the whole basis; 2^27 (128 MB) is a sane cap for the device's RAM + zram
    const wlog = Math.max(20, Math.ceil(Math.log2(Math.max(old.length, buf.length))))
    if (wlog > 27) return false
    const patch = `${tmp}.zst`
    const t = Date.now()
    try {
      await run(ZSTD, ['-q', '-f', '-1', `--long=${wlog}`, `--patch-from=${basis}`, tmp, '-o', patch], { timeout: TIMEOUT })
      const size = (await stat(patch)).size
      if (size > buf.length / 2) return false // big change: plain copy is about as fast
      const rp = '/tmp/mk10studio-push.zst'
      await run('scp', ['-q', '-o', 'ConnectTimeout=5', patch, `${host}:${rp}`], { timeout: TIMEOUT })
      // exit 3: the device's file isn't the basis (pushed from elsewhere); 4: rebuilt file is wrong
      const sh = `sum() { md5sum < "$1" | cut -c1-32; }; trap 'rm -f ${rp} ${remote}.new' EXIT
[ "$(sum ${remote})" = ${md5(old)} ] || exit 3
zstd -q -d -f --long=${wlog} --patch-from=${remote} ${rp} -o ${remote}.new || exit 4
[ "$(sum ${remote}.new)" = ${md5(buf)} ] || exit 4
mv ${remote}.new ${remote} && sync`
      await run('ssh', ['-o', 'ConnectTimeout=5', host, sh], { timeout: TIMEOUT })
      log(`patched theme ${basename(remote)} (${mb(size)} delta, ${((Date.now() - t) / 1000).toFixed(1)} s) -> ${host}:${remote}`)
      return true
    } catch (e) {
      const why = { 3: 'device file differs from the last push', 4: 'patched file failed its md5' }[e.code] ?? (e.code === 'ENOENT' ? `${ZSTD} not found` : e.message.split('\n')[0])
      log(`delta push skipped (${why}); copying the whole theme`)
      return false
    } finally {
      await rm(patch, { force: true })
    }
  }

  // Verified recipe (docs/theme-format.md, Device verification): copy theme, point
  // config.json defaultTheme at it, restart KeyboardDevice. LilAlpine only (needs ssh).
  // o.fonts (optional, async): local font files the device lacks; copied into its font dir before the
  // restart, since the app reads its fonts at start
  async pushSsh({ host, remote, fonts, port } = DEFAULT_SSH, log = () => {}) {
    this.need()
    // one line per file copied, as it lands
    const copy = async (src, dest, what) => {
      const t = Date.now()
      await run('scp', ['-q', '-o', 'ConnectTimeout=5', src, `${host}:${dest}`], { timeout: TIMEOUT })
      log(`copied ${what} (${mb((await stat(src)).size)}, ${((Date.now() - t) / 1000).toFixed(1)} s) -> ${host}:${dest}`)
    }
    const files = (await fonts?.(log)) ?? []
    if (files.length) log(`fonts: ${files.length} file${files.length > 1 ? 's' : ''} the device lacks`)
    for (const f of files) await copy(f, `${DEVICE_FONT_DIR}/${basename(f)}`, `font ${basename(f)}`)
    const tmp = `${process.env.TMPDIR ?? '/tmp/'}mk10studio-push.Theme`
    const buf = encodeTheme(this.theme)
    await writeFile(tmp, buf)
    // Last theme pushed to this host:remote. When the device still has those exact bytes, send a
    // zstd --patch-from delta instead of the whole file (verified 2026-11-25: 22 MB theme, small edit
    // = 3 KB patch, 0.6 s to apply on the device). Any mismatch or failure falls back to scp.
    const basis = `${process.env.TMPDIR ?? '/tmp/'}mk10studio-basis-${md5(`${host}:${remote}`)}.Theme`
    if (!await this.pushDelta({ host, remote, tmp, buf, basis }, log)) await copy(tmp, remote, `theme ${basename(remote)}`)
    await copyFile(tmp, basis)
    // Hot reload (V1 cmd 2, ~5 s): no restart, and the app writes config.json defaultTheme itself.
    // Fonts are read only at app start, so a push that copied fonts still restarts.
    // ponytail: blackouts after a reload (2026-11-25) have no known cause or signature yet; record
    // the display state 6 s later, without holding the push lock
    const reloaded = () => {
      log('pushed')
      setTimeout(() => run('ssh', ['-o', 'ConnectTimeout=5', host, displaySnap(`after reload ${basename(remote)}`)], { timeout: TIMEOUT }).catch(() => {}), 6000)
      return remote
    }
    if (!files.length) {
      // 1. over ssh: TIOCSTI pushes the reload frame into /dev/ttyGS0's input queue, where the app
      // reads its USB host link, so the Mac's USB isn't needed. Done when the app rewrites
      // config.json (its mtime moves ~5 s later, same path or not; verified 2026-11-25).
      try {
        log(`reload ${remote} via the device's USB serial input (ssh)`)
        await run('ssh', ['-o', 'ConnectTimeout=5', host, ttyReload(remote)], { timeout: TIMEOUT })
        return reloaded()
      } catch (e) {
        log(`ssh reload failed (${(e.stderr || e.message).trim().split('\n').pop()})`)
      }
      // 2. MK10 on this computer's USB: the same frame over the real serial port
      if (this.held?.isOpen || port || (await Device.list()).length) {
        try {
          log(`reload ${remote} over USB serial`)
          await this.withDevice((dev) => dev.reloadTheme(remote), port)
          return reloaded()
        } catch (e) {
          log(`serial reload failed (${e.message})`)
        }
      }
      log('restarting the app instead')
    }
    // Stop the app before touching config.json: a stopping KeyboardDevice can write its old config
    // back (seen 2026-11-25: defaultTheme reverted right after a push), and one that hangs in its
    // SIGTERM handler is killed by the LilAlpine service's stop_post.
    log('rc-service keyboard-device stop')
    await run('ssh', [host, 'rc-service keyboard-device stop'], { timeout: TIMEOUT })
    const { stdout } = await run('ssh', ['-o', 'ConnectTimeout=5', host, `cat ${CONFIG}`], { timeout: TIMEOUT })
    const cfg = JSON.parse(stdout)
    if (cfg.defaultTheme !== remote) {
      log(`config.json defaultTheme: ${cfg.defaultTheme} -> ${remote}`)
      cfg.defaultTheme = remote
      const q = JSON.stringify(cfg).replaceAll("'", "'\\''")
      await run('ssh', [host, `printf '%s' '${q}' > ${CONFIG}.new && mv ${CONFIG}.new ${CONFIG} && sync`], { timeout: TIMEOUT })
    }
    log('rc-service keyboard-device start')
    await run('ssh', [host, 'rc-service keyboard-device start'], { timeout: TIMEOUT })
    // Healthy = exactly one KeyboardDevice, plus the background video player when page 0 has a
    // video (once, 2026-11-24, a restart came up without it). The start also bounces Wi-Fi (the
    // app relaunches wpa_supplicant), so failed ssh polls just retry.
    const hasVideo = (this.theme.json.pages[0]?.items ?? []).some((x) => String(x.type) === '100' && x.path)
    const check = `set -- $(pidof KeyboardDevice); [ $# = 1 ] && ${hasVideo ? 'pidof videoplayerinterfaceAPP >/dev/null' : 'true'}`
    const healthy = async (secs) => {
      for (const t = Date.now(); Date.now() - t < secs * 1000;) {
        await new Promise((r) => setTimeout(r, 3000))
        if (await run('ssh', ['-o', 'ConnectTimeout=3', host, check], { timeout: 10_000 }).then(() => true, () => false)) return true
      }
      return false
    }
    if (!await healthy(20)) {
      // ponytail: frozen screens with touch still working (2026-11-25) pass this check; no remote
      // signature known yet for that one, so it still needs a manual reboot
      log('app did not come back cleanly; rebooting the device')
      await run('ssh', [host, 'sync; reboot'], { timeout: TIMEOUT }).catch(() => {}) // sshd may die first
      if (!await healthy(120)) throw new Error('device not healthy within 120 s of the reboot')
      log('back up after reboot')
    }
    log('pushed')
    return remote
  }
}
