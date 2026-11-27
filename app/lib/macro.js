// Macro keys: a key that types. One step is a plain `keyboard` or `qmk_string` action; more steps
// make an action flow (controlData type ControlFlow) that the device runs in order. Format and
// behaviour verified on the device 2026-11-25 (docs/theme-format.md, Action flows).
//
// Steps (API shape):
//   { type: 'keyboard', keycode, keyType }   QMK keycode (mods included); keyType 0 tap, 1 press, 2 release
//   { type: 'qmk_string', text }             typed as is (no percent decoding despite the field name)
//   { type: 'delay', ms }
//   { type: 'startLoop', count } ... { type: 'stopLoop' }
//   { type: <other>, raw }                   a vendor step Studio doesn't edit, kept byte-exact (raw = base64 QVariantMap)
import { readFileSync } from 'node:fs'
import { QReader, QWriter, T_BYTES, T_INT, T_STRING } from './qdatastream.js'
import { decodeControlData, encodeControlData, getItem } from './theme.js'
import { qmkLabel } from './qmk.js'

const TEMPLATES = JSON.parse(readFileSync(new URL('./action-templates.json', import.meta.url), 'utf8'))
export const KEY_TYPES = ['tap', 'press', 'release'] // keyType 0, 1, 2
const str = (value) => ({ type: T_STRING, null: 0, value })
const int = (value) => ({ type: T_INT, null: 0, value })

function fromFields(fields) {
  const o = Object.fromEntries(fields.map(([k, v]) => [k, v.value]))
  switch (o.type) {
    case 'keyboard': return { type: 'keyboard', keycode: o.keycode, keyType: o.keyType ?? 0, label: qmkLabel(o.keycode) }
    case 'qmk_string': return { type: 'qmk_string', text: o.inputTextPercentEncoding ?? '' }
    case 'delay': return { type: 'delay', ms: o.delayMs ?? 0 }
    case 'startLoop': return { type: 'startLoop', count: o.loopCount ?? 1 }
    case 'stopLoop': return { type: 'stopLoop' }
    default: return { type: o.type, raw: new QWriter().vmap(fields).toBuffer().toString('base64') }
  }
}

// a step's QVariantMap; the template's editor fields (description, iconPath, ...) ride along for the vendor app
function toFields(s) {
  const tpl = (type, own) => {
    const t = Object.fromEntries((TEMPLATES[type]?.fields ?? []).map(([k, q, v]) => [k, { type: q, null: 0, value: v }]))
    return { ...t, ...own }
  }
  let m
  switch (s.type) {
    case 'keyboard': m = tpl('keyboard', { keycode: int(s.keycode), keyType: int(s.keyType), keyString: str(qmkLabel(s.keycode)) }); break
    case 'qmk_string': m = tpl('qmk_string', { inputTextPercentEncoding: str(s.text) }); break
    case 'delay': m = { type: str('delay'), delayMs: int(s.ms) }; break
    case 'startLoop': m = { type: str('startLoop'), loopCount: int(s.count) }; break
    case 'stopLoop': m = { type: str('stopLoop') }; break
    default: return new QReader(Buffer.from(s.raw, 'base64')).vmap()
  }
  // Qt 5 QDataStream writes a QMap's entries in descending key order
  return Object.keys(m).sort().reverse().map((k) => [k, m[k]])
}

const decodeList = (b64) => {
  const r = new QReader(Buffer.from(b64, 'base64'))
  const n = r.u32()
  const out = []
  for (let i = 0; i < n; i++) out.push(r.vmap())
  return out
}
const encodeList = (steps) => {
  const w = new QWriter().u32(steps.length)
  for (const s of steps) w.vmap(toFields(s))
  return w.toBuffer().toString('base64')
}

// The key's steps, or null when it isn't a macro key. The device runs the item's controlDataList
// (a string field) when present, else the controlData action alone.
export function readMacro(item) {
  if (!item?.controlData) return null
  if (item.controlDataList) return decodeList(item.controlDataList).map(fromFields)
  const cd = decodeControlData(item.controlData)
  return cd.type === 'keyboard' || cd.type === 'qmk_string' ? [fromFields(cd.fields)] : null
}

function check(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('a macro needs at least one step')
  let depth = 0
  for (const [i, s] of steps.entries()) {
    const at = `step ${i + 1}`
    if (s.type === 'keyboard') {
      if (!Number.isInteger(s.keycode) || s.keycode <= 0 || s.keycode > 0xFFFF) throw new Error(`${at}: bad keycode ${s.keycode}`)
      if (![0, 1, 2].includes(s.keyType)) throw new Error(`${at}: keyType must be 0 (tap), 1 (press) or 2 (release)`)
    } else if (s.type === 'qmk_string') {
      if (typeof s.text !== 'string' || !s.text) throw new Error(`${at}: text is empty`)
    } else if (s.type === 'delay') {
      if (!Number.isInteger(s.ms) || s.ms < 0) throw new Error(`${at}: delay must be whole ms >= 0`)
    } else if (s.type === 'startLoop') {
      if (!Number.isInteger(s.count) || s.count < 1) throw new Error(`${at}: loop count must be >= 1`)
      depth++
    } else if (s.type === 'stopLoop') {
      if (--depth < 0) throw new Error(`${at}: loop end without a loop start`)
    } else if (typeof s.raw !== 'string') throw new Error(`${at}: unknown step type ${s.type}`)
  }
  if (depth) throw new Error('a loop start has no loop end')
}

// Writes the steps to the key. A single keyboard tap or text step stays a plain action (what the
// vendor app makes); anything else becomes an action flow.
export function setKeyMacro(theme, pageIndex, row, col, steps) {
  check(steps)
  const it = getItem(theme, pageIndex, row, col)
  if (!it) throw new Error(`no key at page ${pageIndex} row ${row} col ${col}`)
  const [one] = steps
  if (steps.length === 1 && ((one.type === 'keyboard' && one.keyType === 0) || one.type === 'qmk_string')) {
    it.controlData = encodeControlData({ fields: toFields(one).filter(([k]) => k !== 'keyType') })
    delete it.controlDataList
    return
  }
  const list = encodeList(steps)
  // controlData field order is the MK20 sample's; its controlDataList copy is for the vendor app,
  // the device reads the item field
  it.controlData = encodeControlData({ fields: [
    ['type', str('ControlFlow')],
    ['parentDescription', str('Control flow')],
    ['iconPath', str('/static/icon/dark/controlFlow.png')],
    ['description', str('Action flow')],
    ['controlDataList', { type: T_BYTES, null: 0, value: Buffer.from(list) }],
    ['AISoundControlKeyword', str('')],
  ] })
  it.controlDataList = list
}
