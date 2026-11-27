// Host side of key actions (Phase 3b). Every press and release on the device arrives as a V1
// cmd 13 frame: [{type: 'keyState', row, col, pressed: 1|0}, <the key's action map>]
// (docs/theme-format.md, "V1 key events"). The device runs keyboard, macro and page actions
// itself; this decides which of the rest the Mac runs. Action maps come from theme data, so
// they are checked here and never handed to a shell.
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, posix, win32 } from 'node:path'

// Studio's own run actions: an openFile action map with mk10studioRun (the device forwards the whole
// map on a press). path holds the .app, the script, or the Shortcut's name.
export const RUN_KINDS = { app: 'runApp', script: 'runScript', shortcut: 'runShortcut', background: 'swapBackground', freeze: 'freezeBackground' }
// swapBackground's path: a theme asset the device extracts under /data (Studio writes these, see theme.js)
export const BG_ASSET_RE = /^\/theme\/MK10\/MainScreen\/[\w-]+\.mp4$/
const OSA_EXT = new Set(['.scpt', '.applescript'])
// what each platform accepts (the Windows sets go by extension: Windows has no exec bit)
const WIN_APP_EXT = new Set(['.exe', '.lnk'])
const WIN_SCRIPT_EXT = new Set(['.bat', '.cmd', '.ps1', '.exe'])

// openFile hands the file to its default app; for these that means running code
export const RISKY_EXT = new Set(['.app', '.command', '.sh', '.bash', '.zsh', '.csh', '.tool', '.terminal',
  '.scpt', '.applescript', '.workflow', '.action', '.pkg', '.mpkg', '.dmg', '.jar', '.py', '.pl', '.rb',
  '.js', '.webloc', '.inetloc', '.fileloc', '.url', '.prefpane', '.kext', '.mobileconfig'])

// host-run types from the vendor app that Studio does not run yet
export const NOT_YET = new Set(['text', 'password', 'Loudspeaker', 'Microphone', 'screenshot', 'playMusic', 'ControlFlow'])

// Presses made while the port was closed are queued and arrive in one burst when it opens
// (seen 2026-11-24: 30-odd events in the same millisecond, no keys touched). Key actions in the
// first OPEN_GRACE_MS after the port opens are dropped, so a launch or replug doesn't replay them.
export const OPEN_GRACE_MS = 1000

const expand = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

// -> null when there is nothing for the Mac to do (release frame, device-run action),
//    {run: 'url' | 'path', target, type} to run, {skip: reason, type} to report, or
//    {drop: true, type} for a press replayed when the port opened (sinceOpenMs < OPEN_GRACE_MS).
export function planKeyAction(payload, { stat = statSync, sinceOpenMs = Infinity, platform = process.platform } = {}) {
  if (!Array.isArray(payload)) return null
  const [state, a] = payload
  if (state?.type !== 'keyState' || !a?.type) return null
  if (!Number(state.pressed)) return null // run on press; the release frame repeats the action
  const type = String(a.type)
  // Studio's run keys: openFile, or keyboard_switch for toggles (the device flips the state image itself;
  // its keycode 0 types nothing). The press frame carries the action map but not the state.
  const studio = a.mk10studioRun && (type === 'openFile' || type === 'keyboard_switch')
  if (sinceOpenMs < OPEN_GRACE_MS && (studio || type === 'openWeb' || type === 'openDir' || type === 'openFile')) return { drop: true, type: RUN_KINDS[a.mk10studioRun] ?? type }
  const skip = (why) => ({ skip: `${type}: ${why}`, type })
  if (studio) return planRun(String(a.mk10studioRun), String(a.path ?? '').trim(), stat, platform)
  switch (type) {
    case 'openWeb': {
      const raw = String(a.Url ?? '').trim()
      let u
      try { u = new URL(raw) } catch { return skip(`not a URL: "${raw}"`) }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return skip(`only http and https URLs open, not ${u.protocol}`)
      return { run: 'url', target: u.href, type }
    }
    case 'openDir':
    case 'openFile': {
      const p = expand(String(a.path ?? '').trim())
      if (!isAbsolute(p)) return skip(`path must be absolute: "${a.path ?? ''}"`)
      let st
      try { st = stat(p) } catch { return skip(`not found: ${p}`) }
      if (type === 'openDir' && !st.isDirectory()) return skip(`not a folder: ${p}`)
      // .app, .workflow and .prefPane are folders that open by launching
      if (type === 'openDir' && RISKY_EXT.has(extname(p).toLowerCase())) return skip(`refusing to launch a bundle: ${p}`)
      if (type === 'openFile') {
        if (!st.isFile()) return skip(`not a file: ${p}`)
        if (RISKY_EXT.has(extname(p).toLowerCase()) || (st.mode & 0o111)) return skip(`refusing to open an executable or script: ${p}`)
      }
      return { run: 'path', target: p, type }
    }
    default:
      return NOT_YET.has(type) ? skip('not supported in Studio yet') : null
  }
}

// -> {run: 'app' | 'script' | 'shortcut', target, type} or {skip}. Running still needs the user's
// one-time OK per target (main.js), since a theme from elsewhere can name any local program.
//   app:      macOS a .app bundle; Windows an .exe or .lnk; Linux a .desktop file or an executable
//   script:   macOS / Linux an executable file (macOS also AppleScript); Windows .bat, .cmd, .ps1, .exe
//   shortcut: macOS only, a Shortcut's name
//   background / freeze: the device's background video (swap to the key's asset / pause toggle)
function planRun(kind, raw, stat, platform) {
  const type = RUN_KINDS[kind]
  const skip = (why) => ({ skip: `${type ?? kind}: ${why}`, type: type ?? kind })
  if (!type) return skip('unknown run kind')
  // background keys act on the device's video player over ssh (main.js backgroundKey), nothing local
  if (kind === 'freeze') return { run: kind, target: '', type }
  if (kind === 'background') return BG_ASSET_RE.test(raw) ? { run: kind, target: raw, type } : skip(raw ? `not a background asset: "${raw}"` : 'choose an image or video for the key first')
  if (kind === 'shortcut') {
    if (platform !== 'darwin') return skip('Shortcuts are macOS only')
    if (!raw || raw.length > 200 || [...raw].some((ch) => ch.charCodeAt(0) < 32)) return skip(`not a Shortcut name: "${raw}"`)
    return { run: kind, target: raw, type }
  }
  const P = platform === 'win32' ? win32 : posix // the target platform's path rules
  const p = expand(raw)
  if (!P.isAbsolute(p)) return skip(`path must be absolute: "${raw}"`)
  let st
  try { st = stat(p) } catch { return skip(`not found: ${p}`) }
  const ext = P.extname(p).toLowerCase()
  const exec = st.isFile() && !!(st.mode & 0o111)
  const ok = { run: kind, target: p, type }
  if (kind === 'app') {
    if (platform === 'darwin') return st.isDirectory() && ext === '.app' ? ok : skip(`not an application (.app): ${p}`)
    if (platform === 'win32') return st.isFile() && WIN_APP_EXT.has(ext) ? ok : skip(`not an application (.exe or .lnk): ${p}`)
    return (st.isFile() && ext === '.desktop') || exec ? ok : skip(`not an application (.desktop or executable): ${p}`)
  }
  if (!st.isFile()) return skip(`not a file: ${p}`)
  if (platform === 'win32') return WIN_SCRIPT_EXT.has(ext) ? ok : skip(`not a script Windows runs (.bat, .cmd, .ps1, .exe): ${p}`)
  if (exec || (platform === 'darwin' && OSA_EXT.has(ext))) return ok
  return skip(`not executable (chmod +x it${platform === 'darwin' ? ', or use an AppleScript' : ''}): ${p}`)
}

// How main.js runs a planned app / script / Shortcut, never through a shell:
//   {open: path}                    hand it to the OS (shell.openPath): .app, .exe, .lnk
//   {cmd, args, cwd, detached}      spawn and let it run on its own (Linux apps)
//   {cmd, args, cwd, verbatim}      execFile and wait (up to 10 min); verbatim = Windows cmd.exe
//                                   quoting, passed as is
export function runCommand({ run, target }, platform = process.platform) {
  const P = platform === 'win32' ? win32 : posix
  const ext = P.extname(target).toLowerCase()
  const cwd = P.dirname(target)
  if (run === 'shortcut') return { cmd: '/usr/bin/shortcuts', args: ['run', target] }
  if (run === 'app') {
    if (platform !== 'linux') return { open: target }
    return ext === '.desktop' ? { cmd: 'gio', args: ['launch', target], cwd } : { cmd: target, args: [], cwd, detached: true }
  }
  if (platform === 'darwin' && OSA_EXT.has(ext)) return { cmd: '/usr/bin/osascript', args: [target], cwd }
  // cmd /s /c strips the outer pair of quotes, leaving the path quoted. Windows paths can't contain "
  if (platform === 'win32' && (ext === '.bat' || ext === '.cmd')) return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', `""${target}""`], cwd, verbatim: true }
  if (platform === 'win32' && ext === '.ps1') return { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', target], cwd }
  return { cmd: target, args: [], cwd }
}
