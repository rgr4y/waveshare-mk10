import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { runCommand, planKeyAction, OPEN_GRACE_MS } from './keyactions.js'

const press = (action, pressed = 1) => [{ type: 'keyState', row: 0, col: 1, pressed }, action]
const fakeStat = (files) => (p) => {
  const f = files[p]
  if (!f) throw new Error('ENOENT')
  return { isFile: () => f === 'file' || f === 'exec', isDirectory: () => f === 'dir', mode: f === 'exec' ? 0o755 : 0o644 }
}

test('planKeyAction: press runs host actions, release and device actions do nothing', () => {
  assert.deepEqual(planKeyAction(press({ type: 'openWeb', Url: ' https://www.amazon.com ' })),
    { run: 'url', target: 'https://www.amazon.com/', type: 'openWeb' })
  assert.equal(planKeyAction(press({ type: 'openWeb', Url: 'https://x.y' }, 0)), null)
  for (const type of ['keyboard', 'qmk_string', 'openPage', 'oneLevelUp', 'pageSwitch']) {
    assert.equal(planKeyAction(press({ type })), null, type)
  }
  assert.equal(planKeyAction({ notAnArray: true }), null)
  assert.equal(planKeyAction([{ type: 'other' }, { type: 'openWeb' }]), null)
})

test('planKeyAction: URL and path checks', () => {
  assert.match(planKeyAction(press({ type: 'openWeb', Url: 'file:///etc/passwd' })).skip, /only http and https/)
  assert.match(planKeyAction(press({ type: 'openWeb', Url: 'www.example.com' })).skip, /not a URL/)
  const stat = { stat: fakeStat({ '/Users/x/Docs': 'dir', '/Users/x/a.pdf': 'file', '/Users/x/run.command': 'file', '/Users/x/bin': 'exec', [`${homedir()}/Music`]: 'dir' }) }
  assert.deepEqual(planKeyAction(press({ type: 'openDir', path: '/Users/x/Docs' }), stat), { run: 'path', target: '/Users/x/Docs', type: 'openDir' })
  assert.deepEqual(planKeyAction(press({ type: 'openDir', path: '~/Music' }), stat), { run: 'path', target: `${homedir()}/Music`, type: 'openDir' })
  assert.deepEqual(planKeyAction(press({ type: 'openFile', path: '/Users/x/a.pdf' }), stat), { run: 'path', target: '/Users/x/a.pdf', type: 'openFile' })
  assert.match(planKeyAction(press({ type: 'openFile', path: '/Users/x/run.command' }), stat).skip, /executable or script/)
  assert.match(planKeyAction(press({ type: 'openFile', path: '/Users/x/bin' }), stat).skip, /executable or script/)
  assert.match(planKeyAction(press({ type: 'openFile', path: '/Users/x/Docs' }), stat).skip, /not a file/)
  assert.match(planKeyAction(press({ type: 'openDir', path: 'relative/dir' }), stat).skip, /absolute/)
  assert.match(planKeyAction(press({ type: 'openDir', path: '/nope' }), stat).skip, /not found/)
  assert.match(planKeyAction(press({ type: 'text', inputText: 'hi' })).skip, /not supported/)
  assert.match(planKeyAction(press({ type: 'openDir', path: '/Applications/Calculator.app' }), { stat: fakeStat({ '/Applications/Calculator.app': 'dir' }) }).skip, /bundle/)
})

test('planKeyAction: presses replayed right after the port opens are dropped', () => {
  const web = press({ type: 'openWeb', Url: 'https://example.com' })
  assert.deepEqual(planKeyAction(web, { sinceOpenMs: 5 }), { drop: true, type: 'openWeb' })
  assert.equal(planKeyAction(web, { sinceOpenMs: OPEN_GRACE_MS }).run, 'url')
  assert.equal(planKeyAction(press({ type: 'keyboard' }), { sinceOpenMs: 5 }), null)
})

test('planKeyAction: Studio run keys (openFile + mk10studioRun)', () => {
  const stat = fakeStat({ '/Applications/Notes.app': 'dir', '/x/go.sh': 'exec', '/x/plain.sh': 'file', '/x/a.scpt': 'file', '/x/dir': 'dir' })
  const plan = (kind, path) => planKeyAction(press({ type: 'openFile', mk10studioRun: kind, path }), { stat, platform: 'darwin' })
  assert.deepEqual(plan('app', '/Applications/Notes.app'), { run: 'app', target: '/Applications/Notes.app', type: 'runApp' })
  assert.match(plan('app', '/x/dir').skip, /not an application/)
  assert.deepEqual(plan('script', '/x/go.sh'), { run: 'script', target: '/x/go.sh', type: 'runScript' })
  assert.match(plan('script', '/x/plain.sh').skip, /not executable/)
  assert.equal(plan('script', '/x/a.scpt').run, 'script') // AppleScript runs through osascript
  assert.match(plan('script', 'go.sh').skip, /absolute/)
  assert.deepEqual(plan('shortcut', ' Morning '), { run: 'shortcut', target: 'Morning', type: 'runShortcut' })
  assert.match(plan('shortcut', '').skip, /not a Shortcut name/)
  assert.match(plan('rm', '/x/go.sh').skip, /unknown run kind/)
  // plain openFile still refuses scripts
  assert.match(planKeyAction(press({ type: 'openFile', path: '/x/go.sh' }), { stat }).skip, /refusing/)
  assert.equal(planKeyAction(press({ type: 'openFile', mk10studioRun: 'app', path: '/Applications/Notes.app' }), { stat, sinceOpenMs: 10 }).drop, true)
})

test('planKeyAction: run keys on Windows and Linux', () => {
  const win = (kind, path, files) => planKeyAction(press({ type: 'openFile', mk10studioRun: kind, path }), { stat: fakeStat(files), platform: 'win32' })
  assert.equal(win('app', 'C:\\Apps\\x.exe', { 'C:\\Apps\\x.exe': 'file' }).run, 'app')
  assert.match(win('app', 'C:\\Apps\\x.txt', { 'C:\\Apps\\x.txt': 'file' }).skip, /\.exe or \.lnk/)
  assert.equal(win('script', 'C:\\s\\a.ps1', { 'C:\\s\\a.ps1': 'file' }).run, 'script') // no exec bit needed
  assert.match(win('script', 'C:\\s\\a.py', { 'C:\\s\\a.py': 'file' }).skip, /\.bat, \.cmd/)
  assert.match(win('shortcut', 'Morning', {}).skip, /macOS only/)
  const lin = (kind, path, files) => planKeyAction(press({ type: 'openFile', mk10studioRun: kind, path }), { stat: fakeStat(files), platform: 'linux' })
  assert.equal(lin('app', '/usr/share/applications/f.desktop', { '/usr/share/applications/f.desktop': 'file' }).run, 'app')
  assert.equal(lin('app', '/opt/x/run', { '/opt/x/run': 'exec' }).run, 'app')
  assert.match(lin('script', '/x/a.scpt', { '/x/a.scpt': 'file' }).skip, /not executable \(chmod \+x it\)/)
})

test('runCommand: never a shell; per-platform launchers', () => {
  assert.deepEqual(runCommand({ run: 'app', target: '/Applications/Notes.app' }, 'darwin'), { open: '/Applications/Notes.app' })
  assert.deepEqual(runCommand({ run: 'script', target: '/x/a.scpt' }, 'darwin'), { cmd: '/usr/bin/osascript', args: ['/x/a.scpt'], cwd: '/x' })
  assert.deepEqual(runCommand({ run: 'script', target: '/x/go.sh' }, 'linux'), { cmd: '/x/go.sh', args: [], cwd: '/x' })
  assert.equal(runCommand({ run: 'app', target: '/opt/x/run' }, 'linux').detached, true)
  assert.deepEqual(runCommand({ run: 'app', target: '/a/f.desktop' }, 'linux').args, ['launch', '/a/f.desktop'])
  const bat = runCommand({ run: 'script', target: 'C:\\My Scripts\\go.bat' }, 'win32')
  assert.deepEqual([bat.cmd, bat.args.at(-1), bat.verbatim], ['cmd.exe', '""C:\\My Scripts\\go.bat""', true])
  assert.equal(runCommand({ run: 'script', target: 'C:\\s\\a.ps1' }, 'win32').cmd, 'powershell.exe')
  assert.deepEqual(runCommand({ run: 'shortcut', target: 'Morning' }, 'darwin').args, ['run', 'Morning'])
})
