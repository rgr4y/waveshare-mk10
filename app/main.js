// Electron main: owns the single Session; all edits (UI, MCP) go through it.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, protocol, shell, systemPreferences, Tray } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createWriteStream, existsSync, mkdirSync, statSync, watch } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { Session, DEFAULT_SSH } from './lib/session.js'
import { hidToQmk, isModifier } from './lib/qmk.js'
import { fontManifest, syncDeviceFonts } from './lib/fonts.js'

// device fonts, copied from the MK10 over ssh, served to the renderer as mk10font://f/<file>
protocol.registerSchemesAsPrivileged([{ scheme: 'mk10font', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
const fontDir = () => join(app.getPath('userData'), 'device-fonts')
let fonts = [] // manifest: [{file, family, weight, style}]

const STOCK_DIR = '/Applications/ScreenKeyMacOS.app/Contents/MacOS/theme/MK10/'
const MIME = { '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4', '.jpg': 'image/jpeg' }
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'heic', 'svg']
const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'gif']

const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : (argv[i + 1] ?? true) }
const DEV = argv.includes('--dev')
const SHOT = !!flag('--screenshot')
// a dev run is the generic, unsigned "Electron" binary: never register that as a login item
const LOGIN_OK = app.isPackaged

const session = new Session()
let win = null
let mcp = null
let tray = null
let settings = { lastFile: null, reopenLast: true, onboarded: false, mcp: { enabled: false, port: 47110 }, ssh: { ...DEFAULT_SSH } }
let settingsFile

// ---- settings
async function loadSettings() {
  settingsFile = join(app.getPath('userData'), 'settings.json')
  try {
    const s = JSON.parse(await readFile(settingsFile, 'utf8'))
    settings = { ...settings, ...s, mcp: { ...settings.mcp, ...s.mcp }, ssh: { ...settings.ssh, ...s.ssh } }
  } catch { /* first run */ }
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

async function setKeyImage(page, row, col, file) {
  file ??= await pickFile('Choose key image', 'Images', IMAGE_EXT)
  if (!file) return null
  return task('Set key image', () => session.setKeyImage(page, row, col, file))
}

async function setBackgroundVideo(page, file) {
  file ??= await pickFile('Choose background video', 'Video', VIDEO_EXT)
  if (!file) return null
  return task('Transcoding video (640x256 h264, can take a while)', () => session.setBackgroundVideo(page, file))
}

const pushOpts = () => ({ mode: settings.pushMode ?? 'auto', port: process.env.MK10_PORT || null, ...settings.ssh })

async function push() {
  if (!session.theme) return null
  const confirm = async (o) => (await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Push', 'Cancel'], defaultId: 0, cancelId: 1,
    message: o.mode === 'ssh' ? `Push to ${o.host} over ssh?` : 'Push to MK10 over USB?',
    detail: o.mode === 'ssh'
      ? `Copies the theme to ${o.remote}, points config.json at it and restarts keyboard-device.`
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
const HIDTAP = join(import.meta.dirname, 'native', 'build', 'hidtap')
let capWin = null

function startHidtap(sendCap) {
  if (!existsSync(HIDTAP) || statSync(HIDTAP).mtimeMs < statSync(HIDTAP_SRC).mtimeMs) {
    // ponytail: compiled on first use with swiftc; packaging builds it ahead (Phase 5)
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
  if (op === 'undo') return task('Undo', () => { if (!session.undo()) throw new Error('nothing to undo') })
  if (op === 'paste') {
    return task(`Paste key ${slot(row, col)}`, async () => {
      const text = await clipboard.readText() // Electron 45: the clipboard API is async
      if (!session.canPaste(text)) throw new Error('the clipboard holds no MK10 Studio key')
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

const NATIVE_EDIT = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'delete'])

const PRIVACY_PANES = { accessibility: 'Privacy_Accessibility', screen: 'Privacy_ScreenCapture', automation: 'Privacy_Automation', input: 'Privacy_ListenEvent' }
const openPane = (pane) => {
  if (!Object.hasOwn(PRIVACY_PANES, pane)) throw new Error(`Unknown privacy pane: ${pane}`)
  return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES[pane]}`)
}
let axPrompted = false // the system "grant access" prompt shows at most once per app session

const PREFS = new Set(['reopenLast', 'onboarded']) // boolean prefs the renderer may set

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
  h('setKeyActionField', (p, r, c, f, v) => session.setKeyActionField(p, r, c, f, v))
  h('setKeyImage', setKeyImage)
  h('setBackgroundVideo', setBackgroundVideo)
  h('push', push)
  h('pull', pull)
  h('fonts', () => fonts)
  h('syncFonts', syncFonts)
  h('keyOp', keyOp)
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
  h('permissions', () => ({ accessibility: systemPreferences.isTrustedAccessibilityClient(false), screen: systemPreferences.getMediaAccessStatus('screen') }))
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
  })
  h('setSsh', async (ssh) => {
    if (session.pushing) throw new Error('push in progress: device settings are locked until it finishes')
    settings.ssh = { host: String(ssh.host), remote: String(ssh.remote) }
    if (['auto', 'serial', 'ssh'].includes(ssh.mode)) settings.pushMode = ssh.mode
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
  win.on('close', (e) => {
    if (app.isQuitting || win.forceClose) return
    e.preventDefault() // resident app: hide to tray; theme and MCP stay alive
    win.hide()
    app.dock.hide()
  })
  if (hidden && !SHOT) app.dock.hide()
  win.loadFile(join(import.meta.dirname, 'public', 'index.html'))
  return win
}

function showWindow() {
  app.dock.show()
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
  if (!SHOT) createTray()
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
  if (!app.isQuitting && (dirty || unpushed) && win && !win.forceClose) {
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
