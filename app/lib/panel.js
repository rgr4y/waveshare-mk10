// Info panel (canvas x 656..896, y 0..296) item operations. Pure: mutate the theme in place.
import { page, dropIfOrphan } from './theme.js'

export const PANEL = { x: 656, w: 240, h: 296 }
export const isPanelItem = (it) => it?.backgroundType === 'secondary'
const isBackground = (it) => String(it.type) === '114' && Number(it.x) === PANEL.x && Number(it.y) === 0 &&
  Number(it.w) === PANEL.w && Number(it.h) === PANEL.h

// Throws on a stale or non-panel index, so a drag from an old summary never edits another item
function panelItem(theme, pageIndex, index) {
  const it = page(theme, pageIndex).items?.[index]
  if (!isPanelItem(it)) throw new Error(`no panel item ${index} on page ${pageIndex}`)
  return it
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

export function movePanelItem(theme, pageIndex, index, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('panel x and y must be whole numbers')
  const it = panelItem(theme, pageIndex, index)
  x = clamp(x, PANEL.x, PANEL.x + PANEL.w - 1)
  y = clamp(y, 0, PANEL.h - 1)
  Object.assign(it, { x: String(x), y: String(y), backupX: String(x - PANEL.x), backupY: String(y) })
}

export function deletePanelItem(theme, pageIndex, index) {
  const it = panelItem(theme, pageIndex, index)
  page(theme, pageIndex).items.splice(index, 1)
  dropIfOrphan(theme, it.path, false)
  dropIfOrphan(theme, it.paths, true)
}

// Draw order is the numeric z field; renumber 1..n so ties and gaps never accumulate
export function setPanelZ(theme, pageIndex, index, dir) {
  if (dir !== 'forward' && dir !== 'back') throw new Error(`bad z direction ${JSON.stringify(dir)}`)
  const it = panelItem(theme, pageIndex, index)
  if (isBackground(it)) throw new Error('the background stays at the bottom')
  const items = page(theme, pageIndex).items
  const order = items.filter((o) => isPanelItem(o) && !isBackground(o))
    .map((o, i) => ({ o, i }))
    .sort((a, b) => Number(a.o.z) - Number(b.o.z) || a.i - b.i)
    .map((e) => e.o)
  const at = order.indexOf(it)
  const to = clamp(at + (dir === 'forward' ? 1 : -1), 0, order.length - 1)
  order.splice(at, 1)
  order.splice(to, 0, it)
  order.forEach((o, i) => { o.z = String(i + 1) })
  return Number(it.z)
}

export function alignPos({ x, y, w, h }, how) {
  const X = { left: PANEL.x, center: PANEL.x + (PANEL.w - w) / 2, right: PANEL.x + PANEL.w - w }
  const Y = { top: 0, middle: (PANEL.h - h) / 2, bottom: PANEL.h - h }
  if (how in X) return { x: Math.round(X[how]), y: Math.round(y) }
  if (how in Y) return { x: Math.round(x), y: Math.round(Y[how]) }
  throw new Error(`unknown alignment ${JSON.stringify(how)}`)
}
