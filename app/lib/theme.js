// ScreenKey .Theme codec + editor helpers. Port of tools/qtheme.py; format: docs/theme-format.md.
// Layout: QVariantMap header | u32 pad1 | QByteArray JSON | QMap<QString,QByteArray> assets | u32 pad2
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
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

// Title look (item titleParam, compact JSON with sorted keys like the vendor writes it). Allowed values
// from the device daemon's strings (/data/KeyboardDevice): TitleAlignment top / middle / bottom,
// font style names Regular, Italic, Bold Italic; stock themes use "" and "Bold".
export const TITLE_STYLES = ['', 'Bold', 'Italic', 'Bold Italic']
export const TITLE_ALIGNS = ['top', 'middle', 'bottom']
const TITLE_CHECKS = {
  FontFamily: (v) => typeof v === 'string' && v.trim() !== '' && v.length <= 100,
  FontSize: (v) => Number.isInteger(v) && v >= 6 && v <= 96,
  FontStyle: (v) => TITLE_STYLES.includes(v),
  FontUnderline: (v) => typeof v === 'boolean',
  ShowImage: (v) => typeof v === 'boolean',
  ShowTitle: (v) => typeof v === 'boolean',
  TitleAlignment: (v) => TITLE_ALIGNS.includes(v),
  TitleColor: (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
}
export function setKeyTitleParam(theme, pageIndex, row, col, patch) {
  const it = needItem(theme, pageIndex, row, col)
  const tp = JSON.parse(it.titleParam || TITLE_PARAM)
  for (const [k, v] of Object.entries(patch)) {
    if (!TITLE_CHECKS[k]) throw new Error(`unknown title setting ${k}`)
    if (!TITLE_CHECKS[k](v)) throw new Error(`bad ${k}: ${JSON.stringify(v)}`)
    tp[k] = v
  }
  if (it.mk10studioOutline) Object.assign(tp, { ShowTitle: false, ShowImage: true }) // title is in the baked image
  it.titleParam = JSON.stringify(Object.fromEntries(Object.entries(tp).sort(([a], [b]) => (a < b ? -1 : 1))))
}

// Vendor default action descriptions in Chinese (every one in the themes bundled with ScreenKeyMacOS,
// checked 2026-11-25) and their English. Only these exact values change; anything else is the user's text.
const ZH_DESCRIPTIONS = {
  页面切换: 'Page switching', 创建文件夹: 'Create folder', 返回到上一层: 'Back to previous level',
  键盘: 'Keyboard', 系统输入控制: 'System input control', 打开网页: 'Open web page', 系统文件控制: 'System file control',
  操作流: 'Control flow', 编码器: 'Encoder', 系统音频: 'System audio', 系统音量: 'System volume',
}
// Replace those defaults in every item's description / parentDescription; returns how many changed
export function englishDescriptions(theme) {
  let n = 0
  for (const it of theme.json.pages.flatMap((p) => p.items ?? [])) {
    if (!it.controlData) continue
    const cd = decodeControlData(it.controlData)
    let hit = false
    for (const [k, v] of cd.fields) {
      if ((k === 'description' || k === 'parentDescription') && Object.hasOwn(ZH_DESCRIPTIONS, v.value)) {
        v.value = ZH_DESCRIPTIONS[v.value]
        hit = true
        n++
      }
    }
    if (hit) it.controlData = encodeControlData(cd)
  }
  return n
}

// Font families the theme's items name: key titles (titleParam FontFamily) and text widgets
// (text_font: a QFont::toString(), "family,pointSize,pixelSize,styleHint,weight,..."), in item fields
// or JSON inside them
export function fontFamilies(theme) {
  const out = new Set()
  const walk = (o) => {
    for (const [k, v] of Object.entries(o)) {
      const fam = typeof v === 'string' && (k === 'FontFamily' ? v : k === 'text_font' ? v.split(',')[0] : '').trim()
      if (fam) out.add(fam)
      else if (v && typeof v === 'object') walk(v)
      else if (typeof v === 'string' && /^[[{]/.test(v)) { try { walk(JSON.parse(v)) } catch { /* not JSON */ } }
    }
  }
  for (const it of theme.json.pages.flatMap((p) => p.items ?? [])) walk(it)
  return [...out]
}

// Action (controlData) fields that may be edited: existing QString fields only, never added, removed or
// reordered (firmware ignores actions with extra/misordered fields). `type` and fields tied to other
// data (keyString pairs with the int keycode; iconPath/parentDescription are editor metadata) are locked.
const LOCKED_ACTION_FIELDS = new Set(['type', 'iconPath', 'parentDescription', 'keyString', 'AISoundControlKeyword', 'mk10studioRun'])
// Int fields are locked too, except these, whose range the editor knows
const INT_ACTION_FIELDS = new Set(['jumpToPage'])
export const editableActionFields = (cd) =>
  cd.fields.filter(([k, v]) => (v.type === T_STRING && !LOCKED_ACTION_FIELDS.has(k)) || (v.type === T_INT && INT_ACTION_FIELDS.has(k))).map(([k]) => k)
// pageSwitch.jumpToPage counts top-level pages (no parentPageName) 0..n-1, not raw theme indexes
export const topLevelPageCount = (theme) => theme.json.pages.filter((p) => !p.parentPageName).length

export function setKeyActionField(theme, pageIndex, row, col, field, value) {
  const it = needItem(theme, pageIndex, row, col)
  if (!it.controlData) throw new Error(`key page ${pageIndex} row ${row} col ${col} has no action`)
  const cd = decodeControlData(it.controlData)
  if (!editableActionFields(cd).includes(field)) {
    throw new Error(`action field "${field}" is not editable (editable: ${editableActionFields(cd).join(', ') || 'none'})`)
  }
  const slot = cd.fields.find(([k]) => k === field)[1]
  if (slot.type === T_INT) {
    const n = Number(value)
    const top = topLevelPageCount(theme)
    if (field === 'jumpToPage' && !(Number.isInteger(n) && n >= 0 && n < top)) throw new Error(`jumpToPage must be 0-${top - 1}, got ${value}`)
    slot.value = n
  } else {
    const v = String(value)
    if (field === 'pageName' && !theme.json.pages.some((p) => p.pageName === v)) throw new Error(`no page named "${v}"`)
    slot.value = v
  }
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
  const oldBase = it.mk10studioBase
  const key = `/image/MK10/cache/${randomUUID()}.png`
  theme.assets.set(key, Buffer.from(pngBuffer))
  it.path = key
  if ('paths' in it) it.paths = ''
  delete it.frameDelays // static image replaces any animation
  delete it.mk10studioIcon // a new image is no longer the vector icon
  rebase(it, key)
  dropIfOrphan(theme, oldPath, false)
  dropIfOrphan(theme, oldDir, true)
  dropIfOrphan(theme, oldBase, false)
  return key
}

// ---- outlined titles. The device draws titles without outlines (titleParam has no such setting and
// KeyboardDevice has no text-path drawing), so Studio draws the title, outlined, into the key image:
//   mk10studioOutline  JSON {"color": "#rrggbb", "width": 1-8}
//   mk10studioBase     the key's own image (asset key, '' for none); the baked image is drawn from it
//   mk10studioSig      what the current baked image was drawn from; '' = needs drawing (the renderer
//                      draws it, see bakeTitle in public/app.js)
// While baked, titleParam ShowTitle is false (the device must not draw the title again) and ShowImage
// is true (the baked image carries the title).
const isAnimated = (it) => !!(it.paths || it.frameDelays || (it.jsonData && /States/.test(it.jsonData)))
function rebase(it, key) {
  if (!it.mk10studioOutline) return
  it.mk10studioBase = key
  it.mk10studioSig = ''
}
const patchTp = (it, patch) => {
  const tp = { ...JSON.parse(it.titleParam || TITLE_PARAM), ...patch }
  it.titleParam = JSON.stringify(Object.fromEntries(Object.entries(tp).sort(([a], [b]) => (a < b ? -1 : 1))))
}
// outline null or width 0 turns it off: the key gets its own image back and the device title again
export function setKeyTitleOutline(theme, pageIndex, row, col, outline) {
  const it = needItem(theme, pageIndex, row, col)
  const width = outline?.width ?? 0
  if (!width) {
    if (!it.mk10studioOutline) return
    const baked = it.path
    it.path = it.mk10studioBase ?? ''
    delete it.mk10studioOutline; delete it.mk10studioBase; delete it.mk10studioSig
    patchTp(it, { ShowTitle: true })
    dropIfOrphan(theme, baked, false)
    return
  }
  if (!Number.isInteger(width) || width < 1 || width > 8) throw new Error(`outline width must be 0-8, got ${width}`)
  if (!/^#[0-9a-f]{6}$/i.test(outline.color ?? '')) throw new Error(`bad outline color ${JSON.stringify(outline.color)}`)
  if (isAnimated(it)) throw new Error('outlined titles need a still image: this key is animated or has states')
  if (!it.mk10studioOutline) { it.mk10studioBase = it.path || ''; it.mk10studioSig = '' }
  it.mk10studioOutline = JSON.stringify({ color: outline.color.toLowerCase(), width })
  it.mk10studioSig = ''
  patchTp(it, { ShowTitle: false, ShowImage: true })
}
// the renderer's drawing of base image + outlined title; sig says what it was drawn from
export function setBakedTitle(theme, pageIndex, row, col, pngBuffer, sig) {
  const it = needItem(theme, pageIndex, row, col)
  if (!it.mk10studioOutline) throw new Error('this key has no outlined title')
  const old = it.path
  const key = `/image/MK10/cache/${randomUUID()}.png`
  theme.assets.set(key, Buffer.from(pngBuffer))
  it.path = key
  it.mk10studioSig = String(sig)
  if (old !== it.mk10studioBase) dropIfOrphan(theme, old, false)
}

// ---- vector icons (Material Design Icons). The renderer draws the icon, colored and outlined, into
// the key PNG; mk10studioIcon keeps what it was drawn from so the colors can change later:
//   mk10studioIcon  JSON {"name": mdi name, "color": "#rrggbb", "outline": "#rrggbb", "width": 0-8}
// Any other image set on the key drops it (setKeyImage / setKeyIcon).
export function setKeyVectorIcon(theme, pageIndex, row, col, pngBuffer, icon) {
  const { name, color, outline, width } = icon ?? {}
  if (!/^[a-z0-9-]+$/.test(name ?? '')) throw new Error(`bad icon name ${JSON.stringify(name)}`)
  for (const c of [color, outline]) if (!/^#[0-9a-f]{6}$/i.test(c ?? '')) throw new Error(`bad icon color ${JSON.stringify(c)}`)
  if (!Number.isInteger(width) || width < 0 || width > 8) throw new Error(`icon outline width must be 0-8, got ${width}`)
  const key = setKeyImage(theme, pageIndex, row, col, pngBuffer)
  needItem(theme, pageIndex, row, col).mk10studioIcon = JSON.stringify({ name, color: color.toLowerCase(), outline: outline.toLowerCase(), width })
  return key
}

// Key press sound. The vendor app stores it as item soundFile "/sound/<name>.wav" with the WAV in the asset
// map under the same key; the device has it at /data/sound/<name>.wav after a push (checked 2026-11-24).
// wavBuffer null clears it. A name already used by different bytes gets a -2, -3, ... suffix.
export function setKeySound(theme, pageIndex, row, col, wavBuffer, name = 'sound') {
  const it = needItem(theme, pageIndex, row, col)
  const old = it.soundFile
  let key = ''
  if (wavBuffer) {
    const base = String(name).replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'sound'
    const buf = Buffer.from(wavBuffer)
    for (let n = 1; ; n++) {
      key = `/sound/${base}${n > 1 ? `-${n}` : ''}.wav`
      const have = theme.assets.get(key)
      if (!have || have.equals(buf)) break
    }
    theme.assets.set(key, buf)
  }
  it.soundFile = key
  if (old && old !== key) dropIfOrphan(theme, old, false)
  return key || null
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

// Where the device shows the main background video. The app passes x/y/w/h to videoplayerinterfaceAPP
// (-x -y -w -h) and the display engine scales the 640x256 stream to that rect, aspect not kept
// (verified 2026-11-25: x 128 y 32 w 480 h 192 gave layer ch0 frame[128, 32, 480, 192]).
// Bounds: inside the 896x304 panel; the 32 px minimum is ours, the scaler's real limit is untested.
export const VIDEO_MIN = 32
export function setBackgroundVideoRect(theme, pageIndex, rect) {
  const it = (page(theme, pageIndex).items ?? [])
    .find((x) => String(x.type) === '100' && x.backgroundType === 'main')
  if (!it) throw new Error(`page ${pageIndex} has no main background video item (type 100)`)
  const { x, y, w, h } = rect ?? {}
  if (![x, y, w, h].every(Number.isInteger)) throw new Error('video x, y, w, h must be whole numbers')
  if (x < 0 || y < 0 || w < VIDEO_MIN || h < VIDEO_MIN || x + w > 896 || y + h > 304) {
    throw new Error(`video rect ${x},${y} ${w}x${h} must fit the 896x304 panel, at least ${VIDEO_MIN} px each way`)
  }
  Object.assign(it, { x: String(x), y: String(y), w: String(w), h: String(h) })
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

// one item as JSON: controlData decoded to its fields, JSON-in-string fields parsed
function itemToRaw(it) {
  const out = {}
  for (const [k, v] of Object.entries(it)) {
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

// the reverse; throws on anything the theme can't hold (item fields are strings)
function itemFromRaw(raw, at) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${at} must be a JSON object`)
  const next = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'controlData' && Array.isArray(v)) {
      checkVariants(v, `${at} controlData`)
      next[k] = encodeControlData({ fields: v })
    } else if (JSON_STRING_FIELDS.includes(k) && v && typeof v === 'object') next[k] = JSON.stringify(v)
    else if (typeof v === 'string') next[k] = v
    else throw new Error(`${at}: ${k} must be a string (item fields are strings in the theme)`)
  }
  return next
}

export function keyRaw(theme, pageIndex, row, col) {
  const raw = itemToRaw(needItem(theme, pageIndex, row, col))
  for (const k of SLOT_FIELDS) delete raw[k]
  return raw
}

export function setKeyRaw(theme, pageIndex, row, col, raw) {
  const it = needItem(theme, pageIndex, row, col)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the key must be a JSON object')
  for (const k of Object.keys(raw)) if (SLOT_FIELDS.includes(k)) throw new Error(`${k} is the key's slot; move keys with cut and paste`)
  const next = itemFromRaw(raw, 'the key')
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

// ---- raw page editing: the whole page (canvas, pageName, every item) as JSON, items as in keyRaw but
// with their slot fields. pageName and parentPageName are the page's identity (openPage keys and folders
// point at them) and must stay; items can be edited, added or removed.
export function pageRaw(theme, pageIndex) {
  const p = page(theme, pageIndex)
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, k === 'items' ? (v ?? []).map(itemToRaw) : v]))
}

export function setPageRaw(theme, pageIndex, raw) {
  const p = page(theme, pageIndex)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the page must be a JSON object')
  for (const k of ['pageName', 'parentPageName']) {
    if (raw[k] !== p[k]) throw new Error(`${k} must stay ${JSON.stringify(p[k] ?? null)}: other pages and keys point at it`)
  }
  if (!Array.isArray(raw.items)) throw new Error('items must be a list')
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'items' || !(k in p)) continue
    const kind = (x) => (Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x)
    if (kind(v) !== kind(p[k])) throw new Error(`${k} must stay a${kind(p[k]) === 'object' || kind(p[k]) === 'array' ? 'n' : ''} ${kind(p[k])}`)
  }
  const items = raw.items.map((r, i) => itemFromRaw(r, `item ${i}`))
  const slots = new Set()
  for (const it of items.filter(isKey)) {
    const slot = `${Number(it.row)},${Number(it.col)}`
    if (slots.has(slot)) throw new Error(`two keys at row ${it.row} col ${it.col}`)
    slots.add(slot)
  }
  // a path the page didn't use before must exist in the theme (device built-ins it already used are kept)
  const refs = (x) => [...Object.values(x).filter(assetRef), ...stateRefs(x)]
  const had = new Set((p.items ?? []).flatMap(refs))
  const missing = [...new Set(items.flatMap(refs))].filter((r) => !had.has(r) && !assetsUnder(theme, r).length)
  if (missing.length) throw new Error(`not in this theme: ${missing.join(', ')}`)
  const old = p.items ?? []
  const fields = { ...raw, items }
  for (const k of Object.keys(p)) if (!(k in fields)) delete p[k]
  Object.assign(p, fields)
  for (const it of old) dropItemOrphans(theme, it)
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

// a key-area widget (clock digits, GIF, gauge: backgroundType "child") in an empty cell is not free space
function needKeySlot(p, row, col) {
  const n = (v) => Number(v) || 0
  const under = (p.items ?? []).filter((i) => String(i.type) !== '115' && i.backgroundType === 'child' && n(i.x) < 656 &&
    n(i.x) < col * 128 + 128 && n(i.x) + (n(i.w) || 1) > col * 128 && n(i.y) < row * 128 + 128 && n(i.y) + (n(i.h) || 1) > row * 128)
  if (under.length) throw new Error(`r${row} c${col} holds a widget (type ${under.map((i) => i.type).join(', ')}), not a key slot`)
}

// Move keys within a page in one step: moves = [[fromRow, fromCol, toRow, toCol], ...]. Every target
// must be a key slot that is empty or vacated by another move, so a swap or a shifted run works.
export function moveKeys(theme, pageIndex, moves) {
  const p = page(theme, pageIndex)
  const items = moves.map(([r, c]) => needItem(theme, pageIndex, r, c))
  if (new Set(items).size !== items.length) throw new Error('a key is moved twice')
  const seen = new Set()
  for (const [, , r, c] of moves) {
    if (![0, 1].includes(r) || ![0, 1, 2, 3, 4].includes(c)) throw new Error(`r${r} c${c} is not a key slot`)
    if (seen.has(`${r},${c}`)) throw new Error(`two keys moved to r${r} c${c}`)
    seen.add(`${r},${c}`)
    const there = getItem(theme, pageIndex, r, c)
    if (there && !items.includes(there)) throw new Error(`r${r} c${c} already holds a key`)
    if (!there) needKeySlot(p, r, c)
  }
  moves.forEach(([, , r, c], i) => Object.assign(items[i], { row: String(r), col: String(c), x: String(c * 128), y: String(r * 128) }))
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
  if (!old) needKeySlot(p, row, col)
  const ids = theme.json.pages.flatMap((q) => (q.items ?? []).map((i) => Number(i.id))).filter(Number.isFinite)
  const id = String(Math.max(0, ...ids) + 1)
  Object.assign(item, { row: String(row), col: String(col), x: String(col * 128), y: String(row * 128), id, itemName: `control${id}` })
  p.items ??= []
  if (old) p.items[p.items.indexOf(old)] = item
  else p.items.push(item)
  if (old) dropItemOrphans(theme, old)
  return warnings
}

// ---- new keys from scratch: lib/action-templates.json holds each action type's controlData fields
// (vendor defaults). Left out: keyboard_switch (needs jsonData States) and openPage (needs a new
// folder page); oneLevelUp only on a folder page (one with parentPageName).
const ACTION_TEMPLATES = JSON.parse(readFileSync(new URL('./action-templates.json', import.meta.url), 'utf8'))
const NOT_CREATABLE = new Set(['keyboard_switch', 'openPage'])
const TITLE_PARAM = '{"FontFamily":"Microsoft YaHei","FontSize":16,"FontStyle":"","FontUnderline":false,"ShowImage":true,"ShowTitle":true,"TitleAlignment":"top","TitleColor":"#ffffff"}' // new keys: 16 px title at the top (Rob, 2026-11-25)

// [{type, group, label}] the palette offers on this page
export function newKeyTypes(theme, pageIndex) {
  const folder = !!page(theme, pageIndex).parentPageName
  return Object.entries(ACTION_TEMPLATES)
    .filter(([t]) => !NOT_CREATABLE.has(t) && (t !== 'oneLevelUp' || folder))
    .map(([type, { group, label }]) => ({ type, group, label }))
}

// A plain type 115 key of action `type` in an empty slot; the title is the action's label.
// Fields match a stock key; slot fields and the widget check come from pasteKey.
// TITLE_PARAM with the user's defaults for new keys (Settings > New key title) laid over it.
// Only font, size and style; invalid values are refused by setTitleDefaults before they get here.
export const TITLE_DEFAULT_KEYS = ['FontFamily', 'FontSize', 'FontStyle']
export function checkTitleDefaults(d) {
  const out = {}
  for (const k of TITLE_DEFAULT_KEYS) {
    if (d?.[k] === undefined || d[k] === null) continue
    if (!TITLE_CHECKS[k](d[k])) throw new Error(`bad ${k}: ${JSON.stringify(d[k])}`)
    out[k] = d[k]
  }
  return out
}
const titleParamFor = (defaults) => {
  const tp = { ...JSON.parse(TITLE_PARAM), ...checkTitleDefaults(defaults) }
  return JSON.stringify(Object.fromEntries(Object.entries(tp).sort(([a], [b]) => (a < b ? -1 : 1))))
}

export function createKey(theme, pageIndex, row, col, type, titleDefaults = {}) {
  if (!newKeyTypes(theme, pageIndex).some((t) => t.type === type)) throw new Error(`can't create a ${type} key on this page`)
  if (getItem(theme, pageIndex, row, col)) throw new Error(`r${row} c${col} already holds a key`)
  const t = ACTION_TEMPLATES[type]
  const fields = t.fields.map(([name, qtype, value]) => [name, { type: qtype, null: 0, value: name === 'pageName' && type === 'oneLevelUp' ? 'parentPage' : value }])
  const item = {
    type: '115', controlData: encodeControlData({ fields }), title: t.label, titleParam: titleParamFor(titleDefaults),
    path: '', paths: '', soundFile: '', lock: '1', opacity: '100', rotate: '0', scale: '1', z: '1',
    maxWidth: '896', maxHeight: '304', scaledWidthTo: '128', scaledHeightTo: '128',
  }
  // default image: the template's line-art icon
  const assets = {}
  if (t.icon) {
    const png = iconPng(t.icon)
    item.path = [...theme.assets].find(([, b]) => b.equals(png))?.[0] ?? `/image/MK10/cache/${randomUUID()}.png`
    assets[item.path] = png.toString('base64')
  }
  return pasteKey(theme, pageIndex, row, col, { mk10studio: 'key', v: 1, item, assets })
}

// ---- premade key icons: app/icons/<name>.svg (white line art, 128x128) rendered to <name>.png
// (`npm run icons`); the PNG is what goes into the theme
const ICON_DIR = new URL('../icons/', import.meta.url)
// plus icons/PictureFont/ (the vendor app's dot-matrix glyphs), named PictureFont/<name>
const pngs = (dir) => readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort()
export const listIcons = () => [...pngs(ICON_DIR), ...pngs(new URL('PictureFont/', ICON_DIR)).map((n) => `PictureFont/${n}`)]
export function iconPng(name) {
  if (!listIcons().includes(name)) throw new Error(`no icon named ${name}`)
  return readFileSync(new URL(`${name}.png`, ICON_DIR))
}

// Set a premade icon as the key's image; an asset with the same bytes is reused
export function setKeyIcon(theme, pageIndex, row, col, name) {
  const png = iconPng(name)
  const it = needItem(theme, pageIndex, row, col)
  const have = [...theme.assets].find(([, b]) => b.equals(png))?.[0]
  if (!have) return setKeyImage(theme, pageIndex, row, col, png)
  const [oldPath, oldDir, oldBase] = [it.path, it.paths, it.mk10studioBase]
  it.path = have
  if ('paths' in it) it.paths = ''
  delete it.frameDelays
  delete it.mk10studioIcon
  rebase(it, have)
  dropIfOrphan(theme, oldPath, false)
  dropIfOrphan(theme, oldDir, true)
  dropIfOrphan(theme, oldBase, false)
  return have
}

// Delete folder page pageIndex with every folder nested in it, and the openPage keys that open them.
// Assets nothing else references go too. A deleted page shown at start hands that over to the
// parent. Top-level pages are refused (pageSwitch keys number them). Returns the pageNames deleted.
export function deleteFolder(theme, pageIndex) {
  const p = page(theme, pageIndex)
  if (!p.parentPageName) throw new Error('only folder pages can be deleted')
  const gone = new Set([p.pageName])
  for (let grew = true; grew;) {
    grew = false
    for (const q of theme.json.pages) if (gone.has(q.parentPageName) && !gone.has(q.pageName)) { gone.add(q.pageName); grew = true }
  }
  const opens = (it) => {
    if (!isKey(it) || !it.controlData) return false
    const cd = decodeControlData(it.controlData)
    return cd.type === 'openPage' && gone.has(cd.fields.find(([k]) => k === 'pageName')?.[1].value)
  }
  const dropped = theme.json.pages.filter((q) => gone.has(q.pageName)).flatMap((q) => q.items ?? [])
  theme.json.pages = theme.json.pages.filter((q) => !gone.has(q.pageName))
  for (const q of theme.json.pages) {
    const keep = (q.items ?? []).filter((it) => !opens(it))
    if (keep.length !== (q.items ?? []).length) {
      dropped.push(...q.items.filter((it) => opens(it)))
      q.items = keep
    }
  }
  if (gone.has(theme.json.main?.currentPage)) theme.json.main.currentPage = p.parentPageName
  for (const it of dropped) dropItemOrphans(theme, it)
  return [...gone]
}
