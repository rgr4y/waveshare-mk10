// Electron main: owns the single Session; all edits (UI, MCP) go through it.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, systemPreferences, Tray } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, watch } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { Session, DEFAULT_SSH } from './lib/session.js'

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

const pushOpts = () => ({ mode: settings.pushMode ?? 'serial', port: process.env.MK10_PORT || null, ...settings.ssh })

async function push() {
  if (!session.theme) return null
  const o = pushOpts()
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Push', 'Cancel'], defaultId: 0, cancelId: 1,
    message: o.mode === 'ssh' ? `Push to ${o.host} over ssh?` : 'Push to MK10 over USB?',
    detail: o.mode === 'ssh'
      ? `Copies the theme to ${o.remote}, points config.json at it and restarts keyboard-device.`
      : `Writes the theme to ${o.remote} as a new timestamped file (~10 s for 12 MB), tells the device to load it, then deletes older mk10studio pushes.`,
  })
  if (r.response !== 0) return null
  return task('Push', () => session.push(o, log))
}

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
function asset(key) {
  let k = key
  let bytes = session.theme && session.asset(k)
  if (!bytes && session.theme) {
    const frames = [...session.theme.assets.keys()].filter((a) => a.startsWith(`${key}/`))
    const num = (a) => Number(/(\d+)\.\w+$/.exec(a)?.[1] ?? Infinity)
    k = frames.sort((a, b) => num(a) - num(b))[0]
    bytes = k && session.asset(k)
  }
  return bytes ? { mime: MIME[extname(k).toLowerCase()] ?? 'application/octet-stream', bytes: new Uint8Array(bytes) } : null
}

const PRIVACY_PANES = { accessibility: 'Privacy_Accessibility', screen: 'Privacy_ScreenCapture', automation: 'Privacy_Automation' }
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
  h('setKeyTitle', (p, r, c, t) => session.setKeyTitle(p, r, c, t))
  h('setKeyActionField', (p, r, c, f, v) => session.setKeyActionField(p, r, c, f, v))
  h('setKeyImage', setKeyImage)
  h('setBackgroundVideo', setBackgroundVideo)
  h('push', push)
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
  h('settings', () => ({ ...settings, login: app.getLoginItemSettings(), loginSupported: LOGIN_OK, screenshot: SHOT, onboardPreview: SHOT && argv.includes('--onboard'), settingsFile, version: app.getVersion(), mcpUrl: mcp?.url ?? null, stockDir: existsSync(STOCK_DIR) ? STOCK_DIR : null }))
  h('setPref', async (key, value) => {
    if (!PREFS.has(key) || typeof value !== 'boolean') throw new Error(`unknown setting ${key}`)
    settings[key] = value
    await saveSettings()
  })
  h('setSsh', async (ssh) => {
    settings.ssh = { host: String(ssh.host), remote: String(ssh.remote) }
    if (ssh.mode === 'serial' || ssh.mode === 'ssh') settings.pushMode = ssh.mode
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
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
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
    { label: session.file ? basename(session.file) : 'No theme open', enabled: false },
    { label: 'Open MK10 Studio', click: showWindow },
    { label: 'Push to device', enabled: !!session.theme, click: guard(push) },
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
  if (!app.isQuitting && session.dirty && win && !win.forceClose) {
    if (!win.isVisible()) showWindow()
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Cancel', 'Discard changes'], defaultId: 0, cancelId: 0,
      message: 'Unsaved changes', detail: 'Quit without saving?',
    })
    if (r === 0) { e.preventDefault(); return }
  }
  app.isQuitting = true
  mcp?.close().catch(() => {})
})
app.on('activate', () => { if (win) showWindow() })
app.on('window-all-closed', () => app.quit())
