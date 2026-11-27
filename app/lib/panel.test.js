import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { decodeTheme, listKeys } from './theme.js'
import { movePanelItem, deletePanelItem, setPanelZ, alignPos } from './panel.js'
import { Session } from './session.js'

const REAL = new URL('../../img/stock/defaultTheme.Theme', import.meta.url).pathname
const skip = existsSync(REAL) ? false : 'real theme not installed'
const load = () => readFileSync(REAL)
const items = (t, p = 0) => t.json.pages[p].items
const idx = (t, p, type) => items(t, p).findIndex((it) => String(it.type) === type)
const pick = (t, p, i) => { const { x, y, backupX, backupY } = items(t, p)[i]; return { x, y, backupX, backupY } }
const isBg = (it) => String(it.type) === '114' && it.x === '656' && it.y === '0'
const panel = (t) => items(t).filter((it) => it.backgroundType === 'secondary')

test('movePanelItem sets x/y and backups, clamps top-left onto the panel', { skip }, () => {
  const t = decodeTheme(load()); const i = idx(t, 0, '113')
  movePanelItem(t, 0, i, 700, 50)
  assert.deepEqual(pick(t, 0, i), { x: '700', y: '50', backupX: '44', backupY: '50' })
  movePanelItem(t, 0, i, 10, -40)
  assert.deepEqual(pick(t, 0, i), { x: '656', y: '0', backupX: '0', backupY: '0' })
  movePanelItem(t, 0, i, 2000, 900)
  assert.deepEqual(pick(t, 0, i), { x: '895', y: '295', backupX: '239', backupY: '295' })
  assert.throws(() => movePanelItem(t, 0, i, 1.5, 0), /whole numbers/)
})

test('panel ops refuse keys, the video and stale indexes', { skip }, () => {
  const t = decodeTheme(load())
  assert.throws(() => movePanelItem(t, 0, idx(t, 0, '115'), 700, 0), /no panel item/)
  assert.throws(() => movePanelItem(t, 0, idx(t, 0, '100'), 700, 0), /no panel item/)
  const n = items(t).length
  deletePanelItem(t, 0, idx(t, 0, '113'))
  assert.throws(() => movePanelItem(t, 0, n - 1, 700, 0), /no panel item/)
})

test('alignPos', () => {
  const b = { x: 700, y: 40, w: 40, h: 20 }
  assert.deepEqual(alignPos(b, 'left'), { x: 656, y: 40 })
  assert.deepEqual(alignPos(b, 'center'), { x: 756, y: 40 })
  assert.deepEqual(alignPos(b, 'right'), { x: 856, y: 40 })
  assert.deepEqual(alignPos(b, 'top'), { x: 700, y: 0 })
  assert.deepEqual(alignPos(b, 'middle'), { x: 700, y: 138 })
  assert.deepEqual(alignPos(b, 'bottom'), { x: 700, y: 276 })
  assert.throws(() => alignPos(b, 'nope'), /unknown alignment/)
})

test('deletePanelItem drops the orphaned asset, keeps a shared one', { skip }, () => {
  const t = decodeTheme(load()); const i = idx(t, 0, '114')
  const ref = items(t)[i].path
  assert.ok(t.assets.has(ref))
  const shared = t.json.pages.some((p, pi) => p.items.some((it, ii) => !(pi === 0 && ii === i) && it.path === ref))
  deletePanelItem(t, 0, i)
  assert.equal(t.assets.has(ref), shared)
  // a second item on the same asset keeps it
  const t2 = decodeTheme(load()); const j = idx(t2, 0, '114')
  items(t2).push({ ...items(t2)[j] })
  deletePanelItem(t2, 0, j)
  assert.ok(t2.assets.has(ref))
})

test('setPanelZ steps one place, renumbers 1..n, background stays', { skip }, () => {
  const t = decodeTheme(load())
  const bgI = items(t).findIndex(isBg)
  const order = () => panel(t).filter((it) => !isBg(it)).sort((a, b) => Number(a.z) - Number(b.z))
  const lo = items(t).indexOf(order()[0])
  assert.equal(setPanelZ(t, 0, lo, 'forward'), 2)
  assert.deepEqual(order().map((it) => it.z), order().map((_, k) => String(k + 1)))
  assert.equal(order()[1], items(t)[lo])
  const top = items(t).indexOf(order().at(-1))
  const n = order().length
  assert.equal(setPanelZ(t, 0, top, 'back'), n - 1)
  assert.equal(order()[n - 2], items(t)[top])
  assert.deepEqual(order().map((it) => it.z), order().map((_, k) => String(k + 1)))
  assert.equal(items(t)[bgI].z, '0')
  assert.throws(() => setPanelZ(t, 0, bgI, 'forward'), /background stays/)
  assert.throws(() => setPanelZ(t, 0, lo, 'up'), /bad z direction/)
})

test('Session: panelMove undoes, a non-panel edit clears undo, panelBegin groups a drag', { skip }, async () => {
  const s = new Session(); await s.open(REAL)
  const i = idx(s.theme, 0, '113'); const x0 = items(s.theme)[i].x
  s.panelMove(0, i, 700, 50)
  assert.equal(items(s.theme)[i].x, '700')
  s.undo()
  assert.equal(items(s.theme)[i].x, x0)
  s.panelMove(0, i, 700, 50)
  const k = listKeys(s.theme, 0)[0]
  s.setKeyTitle(0, k.row, k.col, 'zz')
  assert.equal(s.canUndo, false)
  s.panelBegin()
  s.panelMove(0, i, 710, 50, { snapshot: false })
  s.panelMove(0, i, 720, 50, { snapshot: false })
  s.undo()
  assert.equal(items(s.theme)[i].x, '700')
  assert.throws(() => s.panelAlign(0, idx(s.theme, 0, '115'), 'left', { w: 1, h: 1 }), /no panel item/)
})
