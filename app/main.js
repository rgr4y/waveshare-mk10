// Electron main: owns the single Session; all edits (UI, MCP) go through it.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, protocol, shell, systemPreferences, Tray } from 'electron'
import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises'
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, watch } from 'node:fs'
import { basename, dirname, extname, join, sep } from 'node:path'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { Session, DEFAULT_SSH } from './lib/session.js'
import { listIcons, iconPng, checkTitleDefaults } from './lib/theme.js'
import { hidToQmk, isModifier, CODE_TO_HID, qmkLabel } from './lib/qmk.js'
import { fontManifest, syncDeviceFonts, systemFonts, DEVICE_FONT_DIR } from './lib/fonts.js'
import { wire, Device } from './lib/device.js'
import { planKeyAction, runCommand, OPEN_GRACE_MS } from './lib/keyactions.js'
import { collectStats, readContract, sampleHost, ALL_STATS } from './lib/stats.js'

// device fonts, copied from the MK10 over ssh, served to the renderer as mk10font://f/<file>
protocol.registerSchemesAsPrivileged([{ scheme: 'mk10font', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
const fontDir = () => join(app.getPath('userData'), 'device-fonts')
let fonts = [] // manifest: [{file, family, weight, style}]

const STOCK_DIR = '/Applications/ScreenKeyMacOS.app/Contents/MacOS/theme/MK10/'
const MIME = { '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.wav': 'audio/wav' }
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'heic', 'svg']
const AUDIO_EXT = ['wav', 'mp3', 'm4a', 'aac', 'aif', 'aiff', 'flac', 'ogg', 'opus', 'caf']
const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'gif']
const STILL_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'heic'] // becomes a still clip (media.js STILL_RE)

const argv = process.argv.slice(app.isPackaged ? 1 : 2) // dev: [electron, '.', ...]; packaged: [exe, ...]
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : (argv[i + 1] ?? true) }
const DEV = argv.includes('--dev')
const SHOT = !!flag('--screenshot')
// a dev run is the generic, unsigned "Electron" binary: never register that as a login item
const MAC = process.platform === 'darwin'
const LOGIN_OK = app.isPackaged
// a .app started from Finder gets PATH=/usr/bin:/bin:/usr/sbin:/sbin; ffmpeg and zstd are Homebrew's
if (app.isPackaged) process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(':')

const session = new Session()
let win = null
let mcp = null
let tray = null
let settings = { lastFile: null, reopenLast: true, onboarded: false, keyActions: true, liveStats: true, mcp: { enabled: false, port: 47110 }, ssh: { ...DEFAULT_SSH } }
let settingsFile

// ---- settings
async function loadSettings() {
  settingsFile = join(app.getPath('userData'), 'settings.json')
  try {
    const s = JSON.parse(await readFile(settingsFile, 'utf8'))
    settings = { ...settings, ...s, mcp: { ...settings.mcp, ...s.mcp }, ssh: { ...settings.ssh, ...s.ssh } }
  } catch { /* first run */ }
  try { session.titleDefaults = checkTitleDefaults(settings.titleDefaults) } catch { settings.titleDefaults = {} }
}

async function saveSettings() {
  await mkdir(dirname(settingsFile), { recursive: true })
  await writeFile(settingsFile, JSON.stringify(settings, null, 2))
}

// ---- renderer messaging
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(`mk10:${ch}`, data) }
const status = (msg, extra = {}) => send('status', { msg, ...extra })
const log = (line) => { console.log(line); send('log', String(line)) }

session.on('change', (e) => { send('change', e); refreshTray() })

// Wrap an operation so progress/errors reach the status line; errors still reject to the caller.
async function task(label, fn) {
  status(`${label}…`, { busy: true })
  try {
    const r = await fn()
    status(`${label}: done`)
    return r
  } catch (e) {
    status(`${label} failed: ${e.message}`, { error: true })
    log(`${label} failed: ${e.stack ?? e.message}`)
    throw e
  }
}

// ---- actions (shared by IPC and menu)
async function openPath(file) {
  const s = await task(`Open ${basename(file)}`, () => session.open(file))
  if (session.translated) log(`open: ${session.translated} Chinese default descriptions changed to English (unsaved)`)
  settings.lastFile = file
  await saveSettings()
  return s
}

async function pull() {
  if (session.dirty || session.unpushed) {
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Cancel', 'Pull and replace'], defaultId: 0, cancelId: 0,
      message: 'Replace the open theme with the one on the device?',
      detail: session.dirty ? 'The open theme has unsaved changes.' : 'The open theme has edits not pushed to the device.',
    })
    if (r.response !== 1) return null
  }
  const pickDest = async (remote) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Save the device theme as', defaultPath: join(app.getPath('documents'), basename(remote)),
      filters: [{ name: 'ScreenKey theme', extensions: ['Theme'] }],
    })
    return r.canceled ? null : r.filePath
  }
  const dest = await task('Pull from device', () => session.pull(pushOpts(), log, pickDest))
  if (!dest) return status('Pull cancelled')
  firstFonts()
  return openPath(dest)
}

async function open() {
  const defaultPath = settings.lastFile ? dirname(settings.lastFile) : existsSync(STOCK_DIR) ? STOCK_DIR : undefined
  const r = await dialog.showOpenDialog(win, {
    title: 'Open theme', defaultPath, properties: ['openFile'],
    filters: [{ name: 'ScreenKey theme', extensions: ['Theme'] }, { name: 'All files', extensions: ['*'] }],
  })
  return r.canceled ? null : openPath(r.filePaths[0])
}

async function save() {
  if (!session.theme) return null
  if (session.isProtected) return saveAs() // never overwrite the vendor's stock theme
  const f = await task('Save', () => session.save())
  return f
}

async function saveAs() {
  if (!session.theme) return null
  const r = await dialog.showSaveDialog(win, {
    // never default into the vendor .app bundle (Save As on the stock theme would land inside it)
    title: 'Save theme as',
    defaultPath: join(session.file && !session.isProtected ? dirname(session.file) : app.getPath('documents'), 'mk10studio.Theme'),
    filters: [{ name: 'ScreenKey theme', extensions: ['Theme'] }],
  })
  if (r.canceled) return null
  const f = await task('Save as', () => session.save(r.filePath))
  settings.lastFile = f
  await saveSettings()
  return f
}

async function pickFile(title, name, extensions) {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: [{ name, extensions }] })
  return r.canceled ? null : r.filePaths[0]
}

async function setKeyImage(page, row, col, file, state) {
  file ??= await pickFile('Choose key image', 'Images', IMAGE_EXT)
  if (!file) return null
  return task(state == null ? 'Set key image' : `Set state ${state + 1} image`, () => session.setKeyImage(page, row, col, file, state ?? undefined))
}

// Material Design Icons (@mdi/svg, the set Home Assistant uses): [name, search words, SVG path data],
// read once on first use. The renderer draws the path into the key PNG.
const MDI = new URL('./node_modules/@mdi/svg/', import.meta.url)
let mdi = null
const mdiIcons = () => (mdi ??= JSON.parse(readFileSync(new URL('meta.json', MDI), 'utf8')).filter((m) => !m.deprecated).map((m) => [
  m.name, [m.name, ...m.aliases, ...m.tags].join(' ').toLowerCase(),
  readFileSync(new URL(`svg/${m.name}.svg`, MDI), 'utf8').match(/ d="([^"]+)"/)[1],
]))

async function setKeySound(page, row, col, file) {
  if (file === null) return task('Clear key sound', () => session.setKeySound(page, row, col, null))
  file ??= await pickFile('Choose key sound', 'Audio', AUDIO_EXT)
  if (!file) return null
  return task('Set key sound', () => session.setKeySound(page, row, col, file))
}

async function setBackgroundVideo(page, file) {
  file ??= await pickFile('Choose background video or image', 'Video or image', [...VIDEO_EXT, ...STILL_EXT])
  if (!file) return null
  return task('Transcoding video (640x256 h264, can take a while)', () => session.setBackgroundVideo(page, file))
}

// this computer's fonts, scanned once (header reads only: ~0.3 s for 1000 files)
let sysFontsP = null
const sysFonts = () => (sysFontsP ??= systemFonts())

// Local font files for the families the theme uses that the device lacks. Device families come from the
// copied device fonts; before the first copy, a file whose name is already in the device's font dir
// counts as present. Copied files also go into the device-font cache, so the editor and the next push
// know about them.
async function missingFonts(log) {
  const onDevice = new Set(fonts.map((f) => f.family))
  const names = fonts.length ? null : new Set((await new Promise((resolve) => execFile('ssh', ['-o', 'ConnectTimeout=5', settings.ssh.host, `ls ${DEVICE_FONT_DIR}`], { timeout: 15000 },
    (err, out) => resolve(err ? [] : out.split('\n'))))).map((n) => n.trim().toLowerCase()))
  const sys = await sysFonts()
  const out = new Set()
  for (const fam of session.fontFamilies()) {
    if (onDevice.has(fam)) continue
    const files = sys.filter((f) => f.family === fam).map((f) => f.path).filter((p) => !names?.has(basename(p).toLowerCase()))
    if (!files.length && !names) log(`font ${fam}: not on the device or this computer; the device uses its default font`)
    for (const f of files) out.add(f)
  }
  return [...out]
}
async function cacheFonts(files) {
  if (!files.length) return
  await mkdir(fontDir(), { recursive: true })
  for (const f of files) await copyFile(f, join(fontDir(), basename(f)))
  fonts = await fontManifest(fontDir())
  send('fonts', fonts)
}

const pushOpts = () => ({
  mode: settings.pushMode ?? 'auto', port: process.env.MK10_PORT || settings.serialPort || null, ...settings.ssh,
  fonts: async (log) => {
    const files = await missingFonts(log)
    if (files.length && fonts.length) cacheFonts(files).catch((e) => log(`font cache: ${e.message}`))
    return files
  },
})

async function push() {
  if (!session.theme) return null
  const confirm = async (o) => (await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Push', 'Cancel'], defaultId: 0, cancelId: 1,
    message: o.mode === 'ssh' ? `Push to ${o.host} over ssh?` : 'Push to MK10 over USB?',
    detail: o.mode === 'ssh'
      ? `Copies the theme to ${o.remote}, then reloads it over USB serial if the MK10 is plugged in here; otherwise points config.json at it and restarts keyboard-device.`
      : `Writes the theme to ${o.remote} as a new timestamped file (~10 s for 12 MB), tells the device to load it, then deletes older mk10studio pushes.`,
  })).response === 0
  let mode
  const ask = async (o) => { mode = o.mode; return confirm(o) }
  // the lock covers detection and the confirm dialog too, so the mode can't change underneath
  const r = await task('Push', () => session.push(pushOpts(), log, ask))
  if (r === null) status('Push cancelled')
  else if (mode === 'ssh') firstFonts()
  return r
}

// Copy the device's fonts (ssh only: the stock firmware can't send files back).
async function syncFonts() {
  if (session.pushing) throw new Error('a push or pull is running; copy fonts after it')
  fonts = await task('Copy fonts from device', () => syncDeviceFonts(settings.ssh.host, fontDir(), { log }))
  send('fonts', fonts)
  return fonts.length
}
// after the first ssh push or pull: fetch fonts once, in the background
const firstFonts = () => { if (!fonts.length) syncFonts().catch(() => {}) } // reported via status

async function mcpToggle(on, port = settings.mcp.port) {
  if (mcp) { await mcp.close(); mcp = null }
  let url = null
  if (on) {
    const { startMcp } = await import('./lib/mcp.js')
    mcp = await startMcp(session, { port: Number(port), host: '127.0.0.1', log, pushOpts })
    url = mcp.url
  }
  settings.mcp = { enabled: !!on, port: Number(port) }
  send('mcp', url)
  refreshTray()
  await saveSettings()
  return url
}

// Resolve an asset key; a frame directory (`paths`) resolves to its first frame.
// frame files of a `paths` directory (frame_0.png, frame_1.png, ...), in frame order
function frames(dir) {
  if (!session.theme || !dir) return []
  const num = (a) => Number(/(\d+)\.\w+$/.exec(a)?.[1] ?? Infinity)
  return [...session.theme.assets.keys()].filter((a) => a.startsWith(`${dir}/`)).sort((a, b) => num(a) - num(b))
}

function asset(key) {
  let k = key
  let bytes = session.theme && session.asset(k)
  if (!bytes && session.theme) {
    k = frames(key)[0]
    bytes = k && session.asset(k)
  }
  return bytes ? { mime: MIME[extname(k).toLowerCase()] ?? 'application/octet-stream', bytes: new Uint8Array(bytes) } : null
}

// Dev runs (not packaged): label the build from git so it's clear which code is running.
// { label: "2026-11-25 02:21*", title: "main @ 17760a1, ..." }; null when packaged or git fails.
function devBuild() {
  if (app.isPackaged) return null
  try {
    const git = (...a) => execFileSync('git', ['-C', import.meta.dirname, ...a], { timeout: 5000 }).toString().trim()
    const [iso, sha] = git('log', '-1', '--format=%cI%x09%h').split('\t')
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
    const dirty = !!git('status', '--porcelain', '--', '.')
    const d = new Date(iso)
    const p2 = (n) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
    return {
      label: `${stamp}${dirty ? '*' : ''}${branch === 'main' ? '' : ` ${branch}`}`,
      title: `Dev build: ${branch} @ ${sha}, committed ${d.toLocaleString()}${dirty ? '; * = uncommitted changes in app/' : ''}`,
    }
  } catch {
    return null
  }
}
const BUILD = devBuild()

// ---- key capture window (proof of concept for keybinding). Two sources:
// 'input': Electron before-input-event, what the app sees (menu shortcuts are blocked while it is focused);
// 'hid': native/hidtap (IOHIDManager), raw HID usages incl. consumer keys that macOS handles itself.
const HIDTAP_SRC = join(import.meta.dirname, 'native', 'hidtap.swift')
// packaged: prebuilt by package.mjs and unpacked next to app.asar (a binary inside the asar can't run)
const HIDTAP = join(import.meta.dirname, 'native', 'build', 'hidtap').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
let capWin = null

// ---- macro recording: while on, every key the main window gets goes to the renderer's macro editor
// as {down, usage, code, label, combo} instead of the page or the menus (Cmd+Q, Cmd+C... are recorded).
// combo: the QMK keycode with the modifiers held at the time (for "one key" capture).
let macroRec = false
const recHeld = new Set()
// A keyDown prevented here never gets its keyUp (checked 2026-11-25 with sendInputEvent), so only
// Cmd/Ctrl combos are prevented (they would fire menu items); they are sent as a down plus an
// immediate up. Every other key reaches the page, whose recording listener swallows it.
function recordKey(e, i) {
  if (!macroRec || (i.type !== 'keyDown' && i.type !== 'keyUp')) return
  const usage = CODE_TO_HID[i.code]
  const mod = usage !== undefined && isModifier(0x07, usage)
  const menuCombo = !mod && (i.meta || i.control)
  if (menuCombo && i.type === 'keyDown') e.preventDefault()
  if (i.isAutoRepeat) return
  const down = i.type === 'keyDown'
  const send = (d) => win.webContents.send('mk10:macroKey', usage === undefined ? { down: d, unknown: i.code || i.key } : {
    down: d, usage, code: usage, label: qmkLabel(usage), combo: combo && { code: combo.code, label: qmkLabel(combo.code) },
  })
  if (mod) down ? recHeld.add(usage) : recHeld.delete(usage)
  const combo = usage === undefined ? null : hidToQmk(0x07, usage, recHeld)
  send(down)
  if (menuCombo && down) send(false)
}

function startHidtap(sendCap) {
  if (!app.isPackaged && (!existsSync(HIDTAP) || statSync(HIDTAP).mtimeMs < statSync(HIDTAP_SRC).mtimeMs)) {
    // dev: compiled on first use with swiftc; package.mjs builds it ahead
    sendCap({ t: 'log', msg: 'building native/build/hidtap with swiftc…' })
    try {
      mkdirSync(dirname(HIDTAP), { recursive: true }) // swiftc does not create the output dir
      execFileSync('swiftc', ['-O', HIDTAP_SRC, '-o', HIDTAP], { timeout: 60_000 })
    } catch (e) {
      sendCap({ t: 'error', msg: `swiftc failed: ${e.stderr?.toString().trim() || e.message}` })
      return null
    }
  }
  const p = spawn(HIDTAP, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const held = new Set() // HID modifier usages down right now, for the QMK keycode of the next press
  createInterface({ input: p.stdout }).on('line', (l) => {
    let o
    try { o = JSON.parse(l) } catch { return }
    if (o.t === 'hid') {
      if (isModifier(o.page, o.usage)) o.value ? held.add(o.usage) : held.delete(o.usage)
      if (o.value) o.qmk = hidToQmk(o.page, o.usage, held)
    }
    sendCap(o)
  })
  p.stderr.on('data', (d) => sendCap({ t: 'error', msg: String(d).trim() }))
  p.on('exit', (code, sig) => sendCap({ t: 'log', msg: `hidtap exited (${sig ?? code})` }))
  return p
}

function openCapture() {
  if (capWin && !capWin.isDestroyed()) return capWin.focus()
  capWin = new BrowserWindow({
    width: 860, height: 600, title: 'Key capture', backgroundColor: '#14161a',
    webPreferences: { preload: join(import.meta.dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const w = capWin
  // every event also goes to stderr as a JSON line, and in dev runs to /tmp/mk10.log (appended)
  const file = app.isPackaged ? null : createWriteStream('/tmp/mk10.log', { flags: 'a' })
  const sendCap = (o) => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`
    process.stderr.write(line)
    file?.write(line)
    if (!w.isDestroyed()) w.webContents.send('mk10:capture', o)
  }
  let tap = null
  w.webContents.on('before-input-event', (e, i) => {
    e.preventDefault() // keep Cmd+Q/W/C… from reaching menus: everything is captured
    sendCap({ t: 'input', type: i.type, key: i.key, code: i.code, repeat: i.isAutoRepeat, shift: i.shift, control: i.control, alt: i.alt, meta: i.meta })
  })
  w.webContents.once('did-finish-load', () => { tap = startHidtap(sendCap) })
  w.on('closed', () => { tap?.stdin.end(); tap?.kill(); file?.end(); capWin = null })
  w.loadFile(join(import.meta.dirname, 'public', 'capture.html'))
}

// ---- serial port hold. Studio keeps the port open while key actions or live stats are on or the JSON RPC
// window is open, so the device's own messages arrive (retried every 2 s: unplugged, or busy).
// Pushes and levels reuse the held port. Holding it locks the vendor app out of the port.
const wantPort = () => ((settings.keyActions || settings.liveStats) && !SHOT) || !!(rpcWin && !rpcWin.isDestroyed())
let portWanted = false
function syncPort() {
  const want = wantPort()
  if (want) session.holdDevice(true).catch(() => {}) // busy or gone: the next tick retries
  else if (portWanted) session.holdDevice(false).catch(() => {})
  portWanted = want
}

// ---- live stats (Phase 4): once a second, the Mac's CPU/GPU/RAM/disk go to the info widgets the
// current page asked for (V1 cmd 15 contract; until one arrives, every key Studio can fill).
let statsContract = null
function onContract(m) {
  const c = m.v1 === 15 && readContract(m.payload)
  if (c) statsContract = c
}
function pushStats() {
  sampleHost() // async; feeds the next tick
  // one sample per tick (CPU usage is a delta since the last call): all of it to the editor preview,
  // the keys the page asked for to the device
  const all = collectStats(ALL_STATS, { showUnit: statsContract?.showUnit ?? true })
  send('stats', all)
  const dev = session.held
  if (!settings.liveStats || !dev?.isOpen || session.pushing) return
  const vals = statsContract ? Object.fromEntries(statsContract.keys.filter((k) => k in all).map((k) => [k, all[k]])) : all
  if (Object.keys(vals).length) dev.sendSystemData(vals).catch(() => {}) // port gone: syncPort reopens it
}

// Run application / script / Shortcut keys. A theme can come from anywhere and name any local
// program, so each target runs only after the user allows it once (remembered in settings.allowedRuns).
// Scripts run without a shell, in their own folder; AppleScripts through osascript.
const RUN_LABEL = { app: 'open the application', script: 'run the script', shortcut: 'run the Shortcut' }
async function runProgram({ run, target, type }) {
  const id = `${run}:${target}`
  settings.allowedRuns ??= []
  if (!settings.allowedRuns.includes(id)) {
    const ok = (await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'question', buttons: ['Allow', "Don't run"], defaultId: 1, cancelId: 1,
      message: `A key on the MK10 wants to ${RUN_LABEL[run]}:`, detail: `${target}\n\nAllow this key action from now on? You can revoke it in Settings.`,
    })).response === 0
    if (!ok) throw new Error('not allowed')
    settings.allowedRuns.push(id)
    await saveSettings()
  }
  const c = runCommand({ run, target })
  if (c.open) {
    const err = await shell.openPath(c.open)
    if (err) throw new Error(err)
    return
  }
  if (c.detached) {
    await new Promise((resolve, reject) => {
      const p = spawn(c.cmd, c.args, { cwd: c.cwd, detached: true, stdio: 'ignore' })
      p.once('error', reject).once('spawn', () => { p.unref(); resolve() })
    })
    return
  }
  // ponytail: 10 min cap and only the exit status is reported; stream output to the log if scripts need it
  // stdin closed at once: `shortcuts run` reads stdin to EOF as the Shortcut's input and hangs on an open pipe
  await new Promise((resolve, reject) => execFile(c.cmd, c.args, { cwd: c.cwd, windowsVerbatimArguments: !!c.verbatim, timeout: 600_000, maxBuffer: 4 << 20 }, (e, _out, err) => {
    if (e) return reject(new Error(`${type} exited ${e.code ?? e.signal}${err ? `: ${String(err).trim().split('\n').pop()}` : ''}`))
    log(`key: ${type} finished`)
    resolve()
  }).stdin.end())
}

// ---- key actions (Phase 3b): the device reports each press with the key's action (V1 cmd 13);
// the Mac runs the host-side ones. lib/keyactions.js decides what runs.
let replayed = 0 // presses dropped since the port last opened (queued while it was closed)
function onKeyEvent(m) {
  if (m.v1 !== 13 || !settings.keyActions) return
  const plan = planKeyAction(m.payload, { sinceOpenMs: Date.now() - (session.heldAt ?? 0) })
  if (!plan) return
  if (plan.drop) {
    if (!replayed++) setTimeout(() => { log(`key: ignored ${replayed} press(es) queued while the port was closed`); replayed = 0 }, OPEN_GRACE_MS)
    return
  }
  if (plan.skip) {
    log(`key: ${plan.skip}`)
    return status(`Key: ${plan.skip}`, { error: true })
  }
  log(`key: ${plan.type} ${plan.target}`)
  const done = plan.run === 'url' ? shell.openExternal(plan.target)
    : plan.run === 'path' ? shell.openPath(plan.target).then((err) => { if (err) throw new Error(err) })
    : plan.run === 'background' || plan.run === 'freeze' ? session.backgroundKey(settings.ssh.host, plan).finally(watchBackground)
    : runProgram(plan)
  done.catch((e) => { log(`key: ${plan.type} failed: ${e.message}`); status(`Key: ${plan.type} failed: ${e.message}`, { error: true }) })
}

// Background video pause state (vplayer's /run file over ssh), shown in the editor: after each
// background key and every 10 s while the theme has a Freeze background key and key actions are on.
// Unreadable = playing. ponytail: 10 s poll over plain ssh; a persistent ssh (ControlMaster) if it lags.
let bgPaused = false
async function watchBackground() {
  const p = await session.backgroundPaused(settings.ssh.host)
  if (p === bgPaused) return
  bgPaused = p
  if (win && !win.isDestroyed()) win.webContents.send('mk10:bgState', p)
}
setInterval(() => { if (settings.keyActions && session.hasFreezeKey()) watchBackground() }, 10_000)

// ---- developer: JSON-RPC window. Shows every message Studio's serial Device sends or gets.
// Long strings (saveToFile base64 chunks) are cut so the log stays readable.
const RPC_KEEP = 500
const rpcLog = [] // last RPC_KEEP entries, replayed when the window opens
let rpcWin = null
const clip = (v) => typeof v === 'string' && v.length > 200 ? `${v.slice(0, 80)}… (${v.length} chars)`
  : Array.isArray(v) ? v.map(clip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)])) : v
wire.on('msg', (e) => {
  const entry = { ts: Date.now(), dir: e.dir, path: e.path, msg: clip(e.msg) }
  rpcLog.push(entry)
  if (rpcLog.length > RPC_KEEP) rpcLog.shift()
  if (rpcWin && !rpcWin.isDestroyed()) rpcWin.webContents.send('mk10:rpc', [entry])
})

function setRpcWindow(on) {
  if (!on) return rpcWin?.close()
  if (rpcWin && !rpcWin.isDestroyed()) return rpcWin.focus()
  rpcWin = new BrowserWindow({
    width: 760, height: 720, title: 'JSON RPC', backgroundColor: '#14161a',
    webPreferences: { preload: join(import.meta.dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const w = rpcWin
  w.webContents.once('did-finish-load', () => {
    w.webContents.send('mk10:rpc', rpcLog)
    syncPort()
  })
  w.on('closed', () => {
    rpcWin = null
    syncPort()
    if (app.isQuitting || !settings.jsonRpcWindow) return
    settings.jsonRpcWindow = false // closed by hand; left open at quit, it reopens at launch
    saveSettings().catch(() => {})
  })
  w.loadFile(join(import.meta.dirname, 'public', 'rpc.html'))
}

// ---- key clipboard: the system clipboard holds the key as plain-text JSON (see theme.js copyKey)
const slot = (row, col) => `r${row} c${col}`
async function keyOp(op, page, row, col) {
  if (op === 'copy') {
    await clipboard.writeText(session.copyKey(page, row, col))
    return status(`Copied key ${slot(row, col)}`)
  }
  if (op === 'cut') return task(`Cut key ${slot(row, col)}`, async () => {
    // copy first, then cut: a failed clipboard write must not lose the key
    await clipboard.writeText(session.copyKey(page, row, col))
    session.cutKey(page, row, col)
  })
  if (op === 'delete') return task(`Delete key ${slot(row, col)}`, () => session.deleteKey(page, row, col))
  // nothing to undo or paste is a no-op with a status line, not an error
  if (op === 'undo') {
    if (!session.canUndo) return status('Nothing to undo')
    return task('Undo', () => { session.undo() })
  }
  if (op === 'paste') {
    const text = await clipboard.readText() // Electron 45: the clipboard API is async
    if (!session.canPaste(text)) return status('Nothing to paste: the clipboard holds no MK10 Studio key')
    return task(`Paste key ${slot(row, col)}`, async () => {
      for (const w of session.pasteKey(page, row, col, text)) log(`paste: ${w}`)
    })
  }
  throw new Error(`unknown key op ${op}`)
}

async function keyMenu(page, row, col, hasKey) {
  const canPaste = session.canPaste(await clipboard.readText())
  const go = (op) => () => keyOp(op, page, row, col).catch(() => {}) // reported via status
  Menu.buildFromTemplate([
    { label: 'Cut', enabled: hasKey, click: go('cut') },
    { label: 'Copy', enabled: hasKey, click: go('copy') },
    { label: 'Paste', enabled: canPaste, click: go('paste') },
    { type: 'separator' },
    { label: 'Delete Key', enabled: hasKey, click: go('delete') },
    { type: 'separator' },
    { label: 'Press Key', enabled: hasKey, click: () => send('press', { page, row, col }) },
  ]).popup({ window: win })
}

// Right-click on a folder in the page list
function pageMenu(page) {
  const pages = session.summary().pages ?? []
  const p = pages[page]
  if (p?.parentIndex === undefined) return
  const nested = (q) => pages.filter((c) => c.parentIndex === q.index).flatMap((c) => [c, ...nested(c)])
  const sub = nested(p).length
  const del = async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Delete this folder?',
      detail: `Deletes the folder${sub ? ` and the ${sub} folder${sub > 1 ? 's' : ''} inside it` : ''}, every key on ${sub ? 'them' : 'it'}, and the key that opens it. Cmd+Z undoes it.`,
    })
    if (response !== 0) return
    const parentName = pages[p.parentIndex].name
    await task('Delete folder', async () => session.deleteFolder(page)).catch(() => {}) // reported via status
    const parent = (session.summary().pages ?? []).findIndex((q) => q.name === parentName)
    if (parent >= 0) send('select', { page: parent, kind: 'page' })
  }
  Menu.buildFromTemplate([{ label: 'Delete Folder…', click: del }]).popup({ window: win })
}

const NATIVE_EDIT = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'delete'])

const PRIVACY_PANES = { accessibility: 'Privacy_Accessibility', screen: 'Privacy_ScreenCapture', automation: 'Privacy_Automation', input: 'Privacy_ListenEvent' }
const openPane = (pane) => {
  if (!Object.hasOwn(PRIVACY_PANES, pane)) throw new Error(`Unknown privacy pane: ${pane}`)
  return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES[pane]}`)
}
let axPrompted = false // the system "grant access" prompt shows at most once per app session

const PREFS = new Set(['reopenLast', 'onboarded', 'jsonRpcWindow', 'keyActions', 'liveStats']) // boolean prefs the renderer may set

function registerIpc() {
  const h = (name, fn) => ipcMain.handle(`mk10:${name}`, (_e, ...a) => fn(...a))
  h('open', open)
  h('openPath', openPath)
  h('save', save)
  h('saveAs', saveAs)
  h('summary', () => session.summary())
  h('asset', asset)
  h('frames', frames)
  h('setKeyTitle', (p, r, c, t) => session.setKeyTitle(p, r, c, t))
  h('setKeyTitleParam', (p, r, c, patch) => session.setKeyTitleParam(p, r, c, patch))
  h('setKeyActionField', (p, r, c, f, v) => session.setKeyActionField(p, r, c, f, v))
  h('setKeyMacro', (p, r, c, steps) => session.setKeyMacro(p, r, c, steps))
  h('macroRecord', (on) => { macroRec = !!on; recHeld.clear() })
  h('setKeyImage', setKeyImage)
  h('icons', () => listIcons())
  h('iconPng', (name) => iconPng(name)) // premade icon bytes, for tinting in the renderer
  h('setKeyIcon', (p, r, c, name, state) => session.setKeyIcon(p, r, c, name, state ?? undefined))
  h('mdiIcons', mdiIcons)
  h('setKeyVectorIcon', (p, r, c, png, icon, state) => session.setKeyVectorIcon(p, r, c, Buffer.from(png), icon, state ?? undefined))
  h('setKeySound', setKeySound)
  h('setBackgroundVideo', setBackgroundVideo)
  h('setKeyTitleOutline', (page, row, col, o) => session.setKeyTitleOutline(page, row, col, o))
  h('setBakedTitle', (page, row, col, png, sig) => session.setBakedTitle(page, row, col, Buffer.from(png), sig))
  h('pickRunTarget', async (page, row, col, kind) => {
    if (kind === 'background') {
      const file = await pickFile('Choose the image or video this key shows', 'Video or image', [...VIDEO_EXT, ...STILL_EXT])
      return file && task('Transcoding for the key (640x256 h264)', () => session.setKeyBackground(page, row, col, file))
    }
    const filters = { darwin: ['app'], win32: ['exe', 'lnk'] }[process.platform] // Linux: any file (.desktop or executable)
    const r = await dialog.showOpenDialog(win, kind === 'app'
      ? { title: 'Choose an application', defaultPath: MAC ? '/Applications' : undefined, properties: ['openFile'], filters: filters && [{ name: 'Applications', extensions: filters }] }
      : { title: 'Choose a script', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Scripts', extensions: ['bat', 'cmd', 'ps1', 'exe'] }] : undefined })
    if (r.canceled) return null
    session.setKeyActionField(page, row, col, 'path', r.filePaths[0])
    return r.filePaths[0]
  })
  h('shortcutNames', () => !MAC ? [] : new Promise((resolve) => execFile('/usr/bin/shortcuts', ['list'], { timeout: 15000 },
    (e, out) => resolve(e ? [] : String(out).split('\n').map((s) => s.trim()).filter(Boolean)))))
  h('allowedRuns', () => settings.allowedRuns ?? [])
  h('forgetRuns', async () => { settings.allowedRuns = []; await saveSettings() })
  h('setVideoRect', (page, rect) => session.setVideoRect(page, rect))
  h('panelBegin', () => session.panelBegin())
  h('panelMove', (p, i, x, y, o) => session.panelMove(p, i, x, y, o))
  h('panelDelete', (p, i) => session.panelDelete(p, i))
  h('panelZ', (p, i, dir) => session.panelZ(p, i, dir))
  h('panelAdd', (p, kind) => session.panelAdd(p, kind))
  h('panelSet', (p, i, f) => session.panelSet(p, i, f))
  h('dataNames', () => session.dataNames())
  h('panelAlign', (p, i, how, size) => session.panelAlign(p, i, how, size))
  h('bgState', () => bgPaused)
  h('push', push)
  h('pull', pull)
  h('setLevel', (method, level) => session.setLevel(method, level))
  h('fonts', () => fonts)
  h('systemFonts', async () => [...new Set((await sysFonts()).map((f) => f.family))].sort())
  h('syncFonts', syncFonts)
  h('keyOp', keyOp)
  h('pageMenu', pageMenu)
  h('keyRaw', (p, r, c) => session.keyRaw(p, r, c))
  h('setKeyRaw', (p, r, c, raw) => task(`Edit key ${slot(r, c)} JSON`, async () => session.setKeyRaw(p, r, c, raw)))
  h('pageRaw', (p) => session.pageRaw(p))
  h('newKeyTypes', (p) => session.newKeyTypes(p))
  h('moveKeys', (p, moves) => task(`Move key ${slot(moves[0][0], moves[0][1])}`, async () => session.moveKeys(p, moves)))
  h('createKey', (p, row, col, type) => task(`New key ${slot(row, col)}`, async () => session.createKey(p, row, col, type)))
  h('setPageRaw', (p, raw) => task('Edit page JSON', async () => session.setPageRaw(p, raw)))
  h('openCapture', openCapture)
  h('saveCaptureLog', async (text) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const r = await dialog.showSaveDialog(capWin ?? win, {
      title: 'Save key capture log', defaultPath: join(app.getPath('desktop'), `mk10-keycapture-${stamp}.jsonl`),
      filters: [{ name: 'JSON lines', extensions: ['jsonl'] }],
    })
    if (r.canceled) return null
    await writeFile(r.filePath, String(text))
    return r.filePath
  })
  h('keyMenu', keyMenu)
  h('nativeEdit', (op) => { if (NATIVE_EDIT.has(op)) win.webContents[op]() })
  h('mcpToggle', (on, port) => task(on ? 'Start MCP' : 'Stop MCP', () => mcpToggle(on, port)))
  h('setLoginItem', (on) => {
    if (!LOGIN_OK) throw new Error('Start at login needs a packaged, signed build (dev runs as "Electron")')
    app.setLoginItemSettings({ openAtLogin: !!on })
    return app.getLoginItemSettings()
  })
  // macOS privacy gates; Linux has none to ask for
  h('permissions', () => !MAC ? { accessibility: true, screen: 'granted' } : ({ accessibility: systemPreferences.isTrustedAccessibilityClient(false), screen: systemPreferences.getMediaAccessStatus('screen') }))
  h('openPrivacyPane', openPane)
  h('requestAccessibility', () => {
    if (!axPrompted) { axPrompted = true; systemPreferences.isTrustedAccessibilityClient(true) }
    return openPane('accessibility')
  })
  h('settings', () => ({ ...settings, login: app.getLoginItemSettings(), loginSupported: LOGIN_OK, screenshot: SHOT, onboardPreview: SHOT && argv.includes('--onboard'), settingsPreview: SHOT && argv.includes('--settings'), build: BUILD, settingsFile, version: app.getVersion(), mcpUrl: mcp?.url ?? null, stockDir: existsSync(STOCK_DIR) ? STOCK_DIR : null }))
  h('setPref', async (key, value) => {
    if (!PREFS.has(key) || typeof value !== 'boolean') throw new Error(`unknown setting ${key}`)
    settings[key] = value
    await saveSettings()
    if (key === 'jsonRpcWindow') setRpcWindow(value)
    if (key === 'keyActions' || key === 'liveStats') syncPort()
  })
  h('setTitleDefaults', async (d) => {
    settings.titleDefaults = session.titleDefaults = checkTitleDefaults(d)
    await saveSettings()
  })
  h('clearRpc', () => { rpcLog.length = 0 })
  h('rebootDevice', async () => {
    const { host } = settings.ssh
    const ok = (await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Reboot', 'Cancel'], defaultId: 0, cancelId: 1,
      message: `Reboot ${host}?`, detail: 'Over ssh (LilAlpine). The device is back in about 35 s; Studio waits for KeyboardDevice.',
    })).response === 0
    if (ok) await task('Reboot device', () => session.rebootSsh(host, log))
  })
  h('serialPorts', async () => (await Device.list()).map((p) => p.path))
  h('setSsh', async (ssh) => {
    if (session.pushing) throw new Error('push in progress: device settings are locked until it finishes')
    settings.ssh = { host: String(ssh.host), remote: String(ssh.remote) }
    if (['auto', 'serial', 'ssh'].includes(ssh.mode)) settings.pushMode = ssh.mode
    if (ssh.port !== undefined) settings.serialPort = String(ssh.port) || null // blank: first MK10 found
    await saveSettings()
  })
}

function buildMenu() {
  const guard = (fn) => () => fn().catch(() => {}) // already reported via status
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('openSettings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: guard(open) },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: guard(save) },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: guard(saveAs) },
        { type: 'separator' },
        { label: 'Pull from Device…', click: guard(pull) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      // Edit items go to the renderer: a focused text field gets the native action, otherwise the selected key
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('edit', 'undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('edit', 'redo') },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => send('edit', 'cut') },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => send('edit', 'copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => send('edit', 'paste') },
        { label: 'Delete Key', click: () => send('edit', 'delete') },
        { role: 'selectAll' },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]))
}

// ---- window
function createWindow() {
  // login launch (or --hidden): menu bar only, no window, no Dock icon
  const hidden = app.getLoginItemSettings().wasOpenedAtLogin || argv.includes('--hidden')
  win = new BrowserWindow({
    width: 1360, height: 760, minWidth: 1100, minHeight: 600, backgroundColor: '#14161a',
    show: !flag('--screenshot') && !hidden,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  })
  win.webContents.on('before-input-event', recordKey)
  win.on('close', (e) => {
    if (app.isQuitting || win.forceClose) return
    // Linux (test runs on lenny): no tray, so close means quit. Quit while the window still exists:
    // before-quit's unsaved-changes prompt needs it (closing first crashed with "Object has been destroyed").
    if (!MAC) { e.preventDefault(); app.quit(); return }
    e.preventDefault() // resident app: hide to tray; theme and MCP stay alive
    win.hide()
    app.dock?.hide()
  })
  if (hidden && !SHOT) app.dock?.hide()
  win.loadFile(join(import.meta.dirname, 'public', 'index.html'))
  return win
}

function showWindow() {
  app.dock?.show()
  win.show()
  win.focus()
}

// ---- tray (text-only: no icon asset yet)
function refreshTray() {
  if (!tray) return
  const guard = (fn) => () => fn().catch(() => {}) // already reported via status
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: session.file ? basename(session.file, extname(session.file)) : 'No theme open', enabled: false },
    { label: 'Open MK10 Studio', click: showWindow },
    { label: 'Push to device', enabled: !!session.theme && !session.pushing, click: guard(push) },
    { label: 'MCP server', type: 'checkbox', checked: !!mcp, click: guard(() => task(mcp ? 'Stop MCP' : 'Start MCP', () => mcpToggle(!mcp))) },
    { type: 'separator' },
    { label: 'Quit MK10 Studio', click: () => app.quit() },
  ]))
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('MK10')
  tray.setToolTip('MK10 Studio')
  refreshTray()
}

function watchPublic() {
  let t
  watch(join(import.meta.dirname, 'public'), { recursive: true }, () => {
    clearTimeout(t)
    t = setTimeout(() => win?.webContents.reloadIgnoringCache(), 100)
  })
}

async function screenshot(out) {
  await new Promise((r) => setTimeout(r, Number(flag('--screenshot-delay')) || 3000))
  const img = await win.webContents.capturePage()
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, img.toPNG())
  console.log(`screenshot: ${out}`)
  win.forceClose = true
  app.quit()
}

// the screenshot run skips the lock so it works while a real instance is open
const gotLock = SHOT || app.requestSingleInstanceLock()
if (!gotLock) app.quit()
else app.on('second-instance', () => { if (win) showWindow() })

app.whenReady().then(async () => {
  if (!gotLock) return
  await loadSettings()
  fonts = await fontManifest(fontDir())
  protocol.handle('mk10font', (req) => {
    const name = decodeURIComponent(new URL(req.url).pathname.slice(1))
    if (!name || name.includes('/') || name.startsWith('.')) return new Response('bad font name', { status: 400 })
    return net.fetch(pathToFileURL(join(fontDir(), name)).toString())
  })
  if (!LOGIN_OK && !SHOT && app.getLoginItemSettings().openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: false })
    console.log('dev build: removed the "Electron" login item an earlier dev run added')
  }
  registerIpc()
  buildMenu()
  createWindow()
  if (!SHOT && MAC) createTray()
  if (settings.jsonRpcWindow && !SHOT) setRpcWindow(true)
  session.on('v1', onKeyEvent)
  session.on('v1', onContract)
  setInterval(pushStats, 1000)
  syncPort()
  setInterval(syncPort, 2000)
  if (DEV) watchPublic()
  win.webContents.once('did-finish-load', async () => {
    const shot = flag('--screenshot')
    const file = flag('--open') || (settings.reopenLast ? settings.lastFile : null)
    if (file && existsSync(file)) await openPath(file).catch((e) => log(`reopen failed: ${e.message}`))
    if ((!shot && settings.mcp.enabled) || argv.includes('--mcp')) await mcpToggle(true).catch((e) => log(`MCP start failed: ${e.message}`))
    const sel = flag('--select')
    if (sel) {
      const [page, row, col] = String(sel).split(',').map(Number)
      send('select', { page, row, col })
    }
    if (argv.includes('--settings')) send('openSettings')
    if (shot) await screenshot(shot)
  })
})

app.on('before-quit', (e) => {
  const { dirty, unpushed } = session
  if (!app.isQuitting && (dirty || unpushed) && win && !win.isDestroyed() && !win.forceClose) {
    if (!win.isVisible()) showWindow()
    const buttons = ['Cancel', ...(unpushed ? ['Push to Device…'] : []), dirty ? 'Discard changes' : 'Quit anyway']
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons, defaultId: 0, cancelId: 0,
      message: dirty && unpushed ? 'Unsaved changes, not pushed to the device' : dirty ? 'Unsaved changes' : 'Changes not pushed to the device',
      detail: dirty && unpushed ? 'The theme has edits that are neither saved nor on the device. Quit anyway?'
        : dirty ? 'The device has these changes, but the file does not. Quit without saving?'
          : 'The file is saved, but the device still shows the previous version. Quit anyway?',
    })
    if (r === 0) { e.preventDefault(); return }
    if (buttons[r] === 'Push to Device…') { e.preventDefault(); push().catch(() => {}); return } // reported via status
  }
  app.isQuitting = true
  mcp?.close().catch(() => {})
})
app.on('activate', () => { if (win) showWindow() })
app.on('window-all-closed', () => app.quit())
