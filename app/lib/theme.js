// ScreenKey .Theme codec + editor helpers. Port of tools/qtheme.py; format: docs/theme-format.md.
// Layout: QVariantMap header | u32 pad1 | QByteArray JSON | QMap<QString,QByteArray> assets | u32 pad2
import { randomUUID } from 'node:crypto'
import { QReader, QWriter, T_BOOL, T_INT, T_MAP, T_STRING } from './qdatastream.js'

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// ---- Qt-compatible JSON writer (QJsonDocument::Indented, verified against qtbase 5.15 qjsonwriter.cpp)
// - 4-space indent, "key": value, ",\n" separators, trailing "\n" after the top-level value
// - object keys sorted (QJsonObject is a sorted map; UTF-16 code-unit order == JS default sort)
// - empty container is "{\n<indent>}" / "[\n<indent>]" (not "{}")
// - strings: escape only " \ and <0x20 (\b \f \n \r \t, else \u00xx); everything else raw UTF-8,
//   '/' and 0x7f unescaped; lone surrogates -> \uxxxx (lowercase hex)
// - integral numbers print without fraction; others shortest repr, exponent padded to 2 digits (C style)
function qEscape(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x22) out += '\\"'
    else if (c === 0x5c) out += '\\\\'
    else if (c < 0x20) {
      out += { 8: '\\b', 12: '\\f', 10: '\\n', 13: '\\r', 9: '\\t' }[c] ?? '\\u00' + c.toString(16).padStart(2, '0')
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length &&
               (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      out += s[i] + s[++i]
    } else if (c >= 0xd800 && c <= 0xdfff) {
      out += '\\u' + c.toString(16).padStart(4, '0')
    } else out += s[i]
  }
  return out
}

function qNum(n) {
  if (!Number.isFinite(n)) return 'null'
  return String(n).replace(/e([+-])(\d)$/, 'e$10$2')
}

function qValue(v, indent) {
  if (v === null || v === undefined) return 'null'
  if (v === true) return 'true'
  if (v === false) return 'false'
  if (typeof v === 'number') return qNum(v)
  if (typeof v === 'string') return `"${qEscape(v)}"`
  const pad = '    '.repeat(indent)
  const inner = '    '.repeat(indent + 1)
  if (Array.isArray(v)) {
    const body = v.map((x) => inner + qValue(x, indent + 1))
    return '[\n' + (body.length ? body.join(',\n') + '\n' : '') + pad + ']'
  }
  if (typeof v === 'object') {
    const body = Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => `${inner}"${qEscape(k)}": ${qValue(v[k], indent + 1)}`)
    return '{\n' + (body.length ? body.join(',\n') + '\n' : '') + pad + '}'
  }
  throw new Error(`unserialisable JSON value of type ${typeof v}`)
}

export function formatQtJson(value) {
  return qValue(value, 0) + '\n'
}

// ---- container
export function decodeTheme(buf) {
  const r = new QReader(buf)
  const header = r.vmap()
  const pad1 = r.u32()
  const raw = r.bytes()
  if (raw === null) throw new Error('theme JSON QByteArray is null')
  const jsonText = utf8.decode(raw)
  const assets = new Map()
  const n = r.u32()
  for (let i = 0; i < n; i++) {
    const k = r.string()
    if (k === null) throw new Error('null asset key')
    if (assets.has(k)) throw new Error(`duplicate asset key ${k}`)
    assets.set(k, r.bytes())
  }
  const pad2 = r.u32()
  if (r.remaining) throw new Error(`${r.remaining} trailing bytes after offset ${r.p}`)
  const json = JSON.parse(jsonText)
  const theme = { header, pad1, json, jsonText, assets, pad2 }
  // Snapshot so encodeTheme can tell whether json was mutated (in place, by anyone) since decode.
  Object.defineProperty(theme, '_snap', { value: JSON.stringify(json), writable: true })
  return theme
}

export function encodeTheme(theme) {
  const unchanged = theme._snap !== undefined && JSON.stringify(theme.json) === theme._snap
  const text = unchanged ? theme.jsonText : formatQtJson(theme.json)
  const w = new QWriter().vmap(theme.header).u32(theme.pad1)
  w.bytes(Buffer.from(text, 'utf8')).u32(theme.assets.size)
  for (const k of [...theme.assets.keys()].sort()) w.string(k).bytes(theme.assets.get(k))
  return w.u32(theme.pad2).toBuffer()
}

// ---- controlData: base64 QDataStream QVariantMap
export function decodeControlData(b64) {
  const r = new QReader(Buffer.from(b64, 'base64'))
  const fields = r.vmap()
  if (r.remaining) throw new Error(`controlData: ${r.remaining} trailing bytes`)
  const t = fields.find(([k]) => k === 'type')
  return { type: t ? t[1].value : null, fields }
}

export function encodeControlData(cd) {
  return new QWriter().vmap(cd.fields).toBuffer().toString('base64')
}

// ---- editor helpers (mutate in place; unknown fields/items untouched)
export const pages = (theme) => theme.json.pages

function page(theme, i) {
  const p = theme.json.pages[i]
  if (!p) throw new Error(`no page ${i}`)
  return p
}

const isKey = (it) => String(it.type) === '115'

export function listKeys(theme, pageIndex) {
  return (page(theme, pageIndex).items ?? []).filter(isKey)
    .map((item) => ({ row: Number(item.row), col: Number(item.col), title: item.title, item }))
}

export function getItem(theme, pageIndex, row, col) {
  return (page(theme, pageIndex).items ?? [])
    .find((it) => isKey(it) && Number(it.row) === row && Number(it.col) === col)
}

function needItem(theme, p, row, col) {
  const it = getItem(theme, p, row, col)
  if (!it) throw new Error(`no key at page ${p} row ${row} col ${col}`)
  return it
}

export function setKeyTitle(theme, pageIndex, row, col, title) {
  needItem(theme, pageIndex, row, col).title = String(title)
}

// Action (controlData) fields that may be edited: existing QString fields only, never added, removed or
// reordered (firmware ignores actions with extra/misordered fields). `type` and fields tied to other
// data (keyString pairs with the int keycode; iconPath/parentDescription are editor metadata) are locked.
const LOCKED_ACTION_FIELDS = new Set(['type', 'iconPath', 'parentDescription', 'keyString', 'AISoundControlKeyword'])
export const editableActionFields = (cd) =>
  cd.fields.filter(([k, v]) => v.type === T_STRING && !LOCKED_ACTION_FIELDS.has(k)).map(([k]) => k)

export function setKeyActionField(theme, pageIndex, row, col, field, value) {
  const it = needItem(theme, pageIndex, row, col)
  if (!it.controlData) throw new Error(`key page ${pageIndex} row ${row} col ${col} has no action`)
  const cd = decodeControlData(it.controlData)
  if (!editableActionFields(cd).includes(field)) {
    throw new Error(`action field "${field}" is not editable (editable: ${editableActionFields(cd).join(', ') || 'none'})`)
  }
  const v = String(value)
  if (field === 'pageName' && !theme.json.pages.some((p) => p.pageName === v)) throw new Error(`no page named "${v}"`)
  cd.fields.find(([k]) => k === field)[1].value = v
  it.controlData = encodeControlData(cd)
}

// image paths a multi-state key keeps per state, inside its jsonData string
function stateRefs(it) {
  try {
    return (JSON.parse(it.jsonData).States ?? []).flatMap((s) => [s.path, s.paths]).filter((v) => typeof v === 'string' && v.startsWith('/'))
  } catch {
    return []
  }
}

// True if any item field (or controlData string field, or jsonData state path) points at the asset
// key (exact path, or a `paths` directory containing it). Undecodable controlData counts as referenced.
function isReferenced(theme, key) {
  const hit = (s) => typeof s === 'string' && s.startsWith('/') && (s === key || key.startsWith(s + '/'))
  for (const p of theme.json.pages) {
    for (const it of p.items ?? []) {
      for (const [f, v] of Object.entries(it)) {
        if (f === 'controlData' && typeof v === 'string' && v) {
          try {
            if (decodeControlData(v).fields.some(([, x]) => x.type === T_STRING && hit(x.value))) return true
          } catch {
            return true
          }
        } else if (f === 'jsonData' && v) {
          if (stateRefs(it).some(hit)) return true
        } else if (hit(v)) return true
      }
    }
  }
  return false
}

function dropIfOrphan(theme, ref, isDir) {
  if (typeof ref !== 'string' || !ref.startsWith('/')) return
  for (const k of [...theme.assets.keys()]) {
    if ((k === ref || (isDir && k.startsWith(ref + '/'))) && !isReferenced(theme, k)) theme.assets.delete(k)
  }
}

export function setKeyImage(theme, pageIndex, row, col, pngBuffer) {
  const it = needItem(theme, pageIndex, row, col)
  const oldPath = it.path
  const oldDir = it.paths
  const key = `/image/MK10/cache/${randomUUID()}.png`
  theme.assets.set(key, Buffer.from(pngBuffer))
  it.path = key
  if ('paths' in it) it.paths = ''
  delete it.frameDelays // static image replaces any animation
  dropIfOrphan(theme, oldPath, false)
  dropIfOrphan(theme, oldDir, true)
  return key
}

export function setBackgroundVideo(theme, pageIndex, mp4Buffer) {
  const it = (page(theme, pageIndex).items ?? [])
    .find((x) => String(x.type) === '100' && x.backgroundType === 'main')
  if (!it) throw new Error(`page ${pageIndex} has no main background video item (type 100)`)
  const old = it.path
  const key = `/theme/MK10/MainScreen/${randomUUID()}.mp4`
  theme.assets.set(key, Buffer.from(mp4Buffer))
  it.path = key
  dropIfOrphan(theme, old, false)
  return key
}

// ---- key clipboard (Phase 3d). Plain-text JSON so a key pastes across themes, app instances and editors:
// {"mk10studio":"key","v":1,"item":{...type 115 item minus slot fields},"assets":{"<asset key>":"<base64>"}}
const SLOT_FIELDS = ['row', 'col', 'x', 'y', 'id', 'itemName']
const assetRef = (v) => typeof v === 'string' && v.startsWith('/')

// ---- raw key editing: the item as JSON, for key types the Inspector form doesn't cover.
// controlData (base64 QDataStream) becomes its QVariantMap fields, [name, {type, null, value}] with
// type 10 = QString, 2 = int, 1 = bool, 8 = map; jsonData and titleParam (JSON inside a string) are
// parsed. Slot fields (row, col, x, y, id, itemName) are left out and kept as they are.
const JSON_STRING_FIELDS = ['jsonData', 'titleParam']

function checkVariants(fields, at = 'controlData') {
  if (!Array.isArray(fields)) throw new Error(`${at} must be a list of [name, {type, null, value}]`)
  for (const f of fields) {
    const [name, v] = Array.isArray(f) ? f : []
    const where = `${at} field ${JSON.stringify(name)}`
    if (typeof name !== 'string' || !v || typeof v !== 'object') throw new Error(`${at}: each field is [name, {type, null, value}]`)
    if (v.null !== 0 && v.null !== 1) throw new Error(`${where}: null must be 0 or 1`)
    if (v.type === T_BOOL) { if (typeof v.value !== 'boolean') throw new Error(`${where}: type 1 (bool) needs true or false`) }
    else if (v.type === T_INT) { if (!Number.isInteger(v.value) || v.value < -(2 ** 31) || v.value >= 2 ** 31) throw new Error(`${where}: type 2 (int) needs a 32-bit integer`) }
    else if (v.type === T_STRING) { if (typeof v.value !== 'string' && v.value !== null) throw new Error(`${where}: type 10 (string) needs a string`) }
    else if (v.type === T_MAP) checkVariants(v.value, where)
    else throw new Error(`${where}: type ${v.type} can't be edited as JSON`)
  }
}

export function keyRaw(theme, pageIndex, row, col) {
  const it = needItem(theme, pageIndex, row, col)
  const out = {}
  for (const [k, v] of Object.entries(it)) {
    if (SLOT_FIELDS.includes(k)) continue
    if (k === 'controlData' && v) {
      try {
        const { fields } = decodeControlData(v)
        checkVariants(fields)
        out[k] = fields
      } catch {
        out[k] = v // undecodable or binary fields: stays base64, saved back unchanged
      }
    } else if (JSON_STRING_FIELDS.includes(k) && v) {
      try { out[k] = JSON.parse(v) } catch { out[k] = v }
    } else out[k] = v
  }
  return out
}

export function setKeyRaw(theme, pageIndex, row, col, raw) {
  const it = needItem(theme, pageIndex, row, col)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the key must be a JSON object')
  const next = {}
  for (const [k, v] of Object.entries(raw)) {
    if (SLOT_FIELDS.includes(k)) throw new Error(`${k} is the key's slot; move keys with cut and paste`)
    if (k === 'controlData' && Array.isArray(v)) {
      checkVariants(v)
      next[k] = encodeControlData({ fields: v })
    } else if (JSON_STRING_FIELDS.includes(k) && v && typeof v === 'object') next[k] = JSON.stringify(v)
    else if (typeof v === 'string') next[k] = v
    else throw new Error(`${k} must be a string (item fields are strings in the theme)`)
  }
  if (next.type !== '115') throw new Error('type must stay "115" (a key)')
  // a path the key didn't have before must exist in the theme (device built-ins it already used are kept)
  const refs = (x) => [...Object.values(x).filter(assetRef), ...stateRefs(x)]
  const had = new Set(refs(it))
  const missing = refs(next).filter((r) => !had.has(r) && !assetsUnder(theme, r).length)
  if (missing.length) throw new Error(`not in this theme: ${missing.join(', ')}`)
  // rebuild in the item's own field order; fields new to it go last
  const old = { ...it }
  for (const k of Object.keys(it)) delete it[k]
  for (const k of Object.keys(old)) if (SLOT_FIELDS.includes(k) || k in next) it[k] = SLOT_FIELDS.includes(k) ? old[k] : next[k]
  for (const k of Object.keys(next)) if (!(k in it)) it[k] = next[k]
  dropItemOrphans(theme, old)
}

// asset keys an item field points at: the exact file, or every file under a `paths` directory
function assetsUnder(theme, ref) {
  if (theme.assets.has(ref)) return [ref]
  return [...theme.assets.keys()].filter((k) => k.startsWith(ref + '/'))
}

export function copyKey(theme, pageIndex, row, col) {
  const it = needItem(theme, pageIndex, row, col)
  const item = Object.fromEntries(Object.entries(it).filter(([k]) => !SLOT_FIELDS.includes(k)))
  const assets = {}
  for (const v of Object.values(item)) {
    if (assetRef(v)) for (const k of assetsUnder(theme, v)) assets[k] = theme.assets.get(k).toString('base64')
  }
  for (const v of stateRefs(item)) for (const k of assetsUnder(theme, v)) assets[k] = theme.assets.get(k).toString('base64')
  return { mk10studio: 'key', v: 1, item, assets }
}

// null unless text is a key clipboard this version can paste (a type 115 item whose action decodes)
export function parseKeyClip(text) {
  let c
  try { c = JSON.parse(text) } catch { return null }
  if (c?.mk10studio !== 'key' || c.v !== 1 || !c.item || String(c.item.type) !== '115') return null
  if (typeof c.assets !== 'object' || c.assets === null) return null
  if (c.item.controlData) {
    try { decodeControlData(c.item.controlData) } catch { return null }
  }
  return c
}

function dropItemOrphans(theme, it) {
  for (const v of [...Object.values(it), ...stateRefs(it)]) if (assetRef(v)) dropIfOrphan(theme, v, !theme.assets.has(v))
}

export function removeKey(theme, pageIndex, row, col) {
  const items = page(theme, pageIndex).items ?? []
  const it = needItem(theme, pageIndex, row, col)
  items.splice(items.indexOf(it), 1)
  dropItemOrphans(theme, it)
}

// Paste onto (page,row,col): replaces a key there, or fills an empty slot. Assets keep their key when
// the theme already holds the same bytes there; otherwise they get new UUID keys and the item's
// references are rewritten. Returns warnings (e.g. an openPage target missing from this theme).
export function pasteKey(theme, pageIndex, row, col, clip) {
  const c = parseKeyClip(typeof clip === 'string' ? clip : JSON.stringify(clip))
  if (!c) throw new Error('clipboard holds no MK10 Studio key')
  const p = page(theme, pageIndex)
  const bytes = Object.fromEntries(Object.entries(c.assets).map(([k, b]) => [k, Buffer.from(b, 'base64')]))
  const item = structuredClone(c.item)
  for (const [f, v] of Object.entries(item)) {
    if (!assetRef(v)) continue
    const keys = Object.keys(bytes).filter((k) => k === v || k.startsWith(v + '/'))
    if (!keys.length || keys.every((k) => theme.assets.get(k)?.equals(bytes[k]))) continue
    const dot = v.lastIndexOf('.')
    const nv = `${v.slice(0, v.lastIndexOf('/'))}/${randomUUID()}${keys.includes(v) && dot > v.lastIndexOf('/') ? v.slice(dot) : ''}`
    for (const k of keys) theme.assets.set(k === v ? nv : nv + k.slice(v.length), bytes[k])
    item[f] = nv
  }
  const warnings = []
  for (const v of stateRefs(item)) {
    for (const k of Object.keys(bytes).filter((k) => k === v || k.startsWith(v + '/'))) {
      if (!theme.assets.has(k)) theme.assets.set(k, bytes[k])
      else if (!theme.assets.get(k).equals(bytes[k])) warnings.push(`state image ${k} differs in this theme; the key shows this theme's copy`)
    }
  }
  if (item.controlData) {
    const cd = decodeControlData(item.controlData)
    const target = cd.type === 'openPage' && cd.fields.find(([k]) => k === 'pageName')?.[1].value
    if (target && !theme.json.pages.some((q) => q.pageName === target)) warnings.push(`openPage target ${target} is not in this theme`)
  }
  const old = getItem(theme, pageIndex, row, col)
  // a key-area widget (clock digits, GIF, gauge: backgroundType "child") in an empty cell is not free space
  const n = (v) => Number(v) || 0
  const under = !old && (p.items ?? []).filter((i) => String(i.type) !== '115' && i.backgroundType === 'child' && n(i.x) < 656 &&
    n(i.x) < col * 128 + 128 && n(i.x) + (n(i.w) || 1) > col * 128 && n(i.y) < row * 128 + 128 && n(i.y) + (n(i.h) || 1) > row * 128)
  if (under?.length) throw new Error(`r${row} c${col} holds a widget (type ${under.map((i) => i.type).join(', ')}), not a key slot`)
  const ids = theme.json.pages.flatMap((q) => (q.items ?? []).map((i) => Number(i.id))).filter(Number.isFinite)
  const id = String(Math.max(0, ...ids) + 1)
  Object.assign(item, { row: String(row), col: String(col), x: String(col * 128), y: String(row * 128), id, itemName: `control${id}` })
  p.items ??= []
  if (old) p.items[p.items.indexOf(old)] = item
  else p.items.push(item)
  if (old) dropItemOrphans(theme, old)
  return warnings
}
