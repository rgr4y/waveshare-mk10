// ScreenKey .Theme codec + editor helpers. Port of tools/qtheme.py; format: docs/theme-format.md.
// Layout: QVariantMap header | u32 pad1 | QByteArray JSON | QMap<QString,QByteArray> assets | u32 pad2
import { randomUUID } from 'node:crypto'
import { QReader, QWriter, T_STRING } from './qdatastream.js'

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

// True if any item field (or controlData string field) points at the asset key
// (exact path, or a `paths` directory containing it). Undecodable controlData counts as referenced.
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
