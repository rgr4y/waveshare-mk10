// Host side of key actions (Phase 3b). Every press and release on the device arrives as a V1
// cmd 13 frame: [{type: 'keyState', row, col, pressed: 1|0}, <the key's action map>]
// (docs/theme-format.md, "V1 key events"). The device runs keyboard, macro and page actions
// itself; this decides which of the rest the Mac runs. Action maps come from theme data, so
// they are checked here and never handed to a shell.
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'

// Studio's own run actions: an openFile action map with mk10studioRun (the device forwards the whole
// map on a press). path holds the .app, the script, or the Shortcut's name.
export const RUN_KINDS = { app: 'runApp', script: 'runScript', shortcut: 'runShortcut' }
const OSA_EXT = new Set(['.scpt', '.applescript'])

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
export function planKeyAction(payload, { stat = statSync, sinceOpenMs = Infinity } = {}) {
  if (!Array.isArray(payload)) return null
  const [state, a] = payload
  if (state?.type !== 'keyState' || !a?.type) return null
  if (!Number(state.pressed)) return null // run on press; the release frame repeats the action
  const type = String(a.type)
  if (sinceOpenMs < OPEN_GRACE_MS && (type === 'openWeb' || type === 'openDir' || type === 'openFile')) return { drop: true, type: RUN_KINDS[a.mk10studioRun] ?? type }
  const skip = (why) => ({ skip: `${type}: ${why}`, type })
  if (type === 'openFile' && a.mk10studioRun) return planRun(String(a.mk10studioRun), String(a.path ?? '').trim(), stat)
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
function planRun(kind, raw, stat) {
  const type = RUN_KINDS[kind]
  const skip = (why) => ({ skip: `${type ?? kind}: ${why}`, type: type ?? kind })
  if (!type) return skip('unknown run kind')
  if (kind === 'shortcut') {
    if (!raw || raw.length > 200 || [...raw].some((ch) => ch.charCodeAt(0) < 32)) return skip(`not a Shortcut name: "${raw}"`)
    return { run: kind, target: raw, type }
  }
  const p = expand(raw)
  if (!isAbsolute(p)) return skip(`path must be absolute: "${raw}"`)
  let st
  try { st = stat(p) } catch { return skip(`not found: ${p}`) }
  if (kind === 'app') {
    if (!st.isDirectory() || extname(p).toLowerCase() !== '.app') return skip(`not an application (.app): ${p}`)
    return { run: kind, target: p, type }
  }
  if (!st.isFile()) return skip(`not a file: ${p}`)
  if (!OSA_EXT.has(extname(p).toLowerCase()) && !(st.mode & 0o111)) return skip(`not executable (chmod +x it, or use an AppleScript): ${p}`)
  return { run: kind, target: p, type }
}
