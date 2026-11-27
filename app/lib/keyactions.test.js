import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { planKeyAction, OPEN_GRACE_MS } from './keyactions.js'

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
