// Info panel (canvas x 656..896, y 0..296) item operations. Pure: mutate the theme in place.
import { readFileSync } from 'node:fs'
import { page, dropIfOrphan } from './theme.js'
import { ALL_STATS } from './stats.js'

const TEMPLATES = JSON.parse(readFileSync(new URL('./panel-templates.json', import.meta.url), 'utf8'))

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

export const PANEL_KINDS = ['text', 'data', 'clock', 'bar', 'ring']

// Fields the Inspector may write, by item type. 109 and 114 have no add template but can be edited.
export const PANEL_FIELDS = {
  113: ['text_str', 'system_data_flag', 'system_data_name', 'text_font', 'front_color'],
  111: ['system_data_name', 'displayNum', 'displayType', 'paths', 'text_font', 'w', 'h'],
  102: ['system_data_name', 'w', 'h', 'front_color', 'back_color', 'corner_radius'],
  101: ['system_data_name', 'radius', 'scale', 'margin', 'front_color', 'back_color'],
  109: ['system_data_name', 'radius', 'scale', 'gradientColor1', 'gradientColor2', 'gradientColor3'],
  114: ['w', 'h'],
}

const maxOf = (items, key) => Math.max(0, ...items.map((o) => Number(o[key])).filter(Number.isFinite))

// Adds a template item centred on the panel, on top. Returns its index in the page's items.
export function addPanelItem(theme, pageIndex, kind) {
  if (!PANEL_KINDS.includes(kind)) throw new Error(`unknown panel object ${JSON.stringify(kind)}`)
  const items = page(theme, pageIndex).items ??= []
  const it = structuredClone(TEMPLATES[kind])
  // 101 ring: diameter = 2 x radius x scale; 113 text has no fixed box, so ~60x30
  const d = 2 * Number(it.radius) * Number(it.scale)
  const w = Number(it.w) || d || 60
  const h = Number(it.h) || d || 30
  const x = Math.round(PANEL.x + (PANEL.w - w) / 2)
  const y = Math.round((PANEL.h - h) / 2)
  Object.assign(it, {
    id: String(maxOf(items, 'id') + 1),
    x: String(x), y: String(y), backupX: String(x - PANEL.x), backupY: String(y),
    z: String(maxOf(items.filter(isPanelItem), 'z') + 1),
  })
  items.push(it)
  return items.length - 1
}

// Validates every name before writing any, so a bad field leaves the item untouched
export function setPanelItem(theme, pageIndex, index, fields) {
  const it = panelItem(theme, pageIndex, index)
  const ok = PANEL_FIELDS[String(it.type)] ?? []
  for (const name of Object.keys(fields)) {
    if (!ok.includes(name)) throw new Error(`${name} can't be edited on a type ${it.type} item`)
  }
  for (const [name, v] of Object.entries(fields)) it[name] = String(v)
}

// Names the device can be asked for: vendor stats, the clock, and whatever the theme already uses
export function dataNames(theme, extra = []) {
  const used = theme.json.pages.flatMap((p) => (p.items ?? []).map((it) => it.system_data_name))
  const all = [...ALL_STATS, 'hour', 'minute', 'date', ...used, ...extra].filter(Boolean)
  return [...new Set(all)].filter((n) => n !== 'randomNumbers').sort()
}
