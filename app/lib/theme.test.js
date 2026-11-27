import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QWriter } from './qdatastream.js'
import {
  decodeTheme, encodeTheme, formatQtJson, decodeControlData, encodeControlData,
  pages, listKeys, getItem, setKeyTitle, setKeyImage, setKeySound, setBackgroundVideo,
  editableActionFields, setKeyActionField, copyKey, pasteKey, removeKey, moveKeys, parseKeyClip, keyRaw, setKeyRaw,
  pageRaw, setPageRaw, newKeyTypes, createKey, checkTitleDefaults, setKeyTitleParam, englishDescriptions, fontFamilies, deleteFolder, listIcons, setKeyIcon,
} from './theme.js'

// Pristine stock theme (ScreenKeyMacOS v1.1 bundle, captured 2026-11-24 before an accidental vendor-app save); sha in SHA256SUMS.txt
const REAL = new URL('../../img/stock/defaultTheme.Theme', import.meta.url).pathname
const skip = existsSync(REAL) ? false : 'real theme not installed'
const QTHEME = new URL('../../tools/qtheme.py', import.meta.url).pathname
const sha = (b) => createHash('sha256').update(b).digest('hex')
const load = () => readFileSync(REAL)

test('formatQtJson matches QJsonDocument::Indented rules', () => {
  const out = formatQtJson({ b: [], a: {}, c: ['x\n"\\/\u007f\u00e9\u0001', 1, 1.5, true, null], n: { z: 1, A: 2 } })
  assert.equal(out, [
    '{', '    "a": {', '    },', '    "b": [', '    ],', '    "c": [',
    '        "x\\n\\"\\\\/\u007f\u00e9\\u0001",', '        1,', '        1.5,', '        true,', '        null', '    ],',
    '    "n": {', '        "A": 2,', '        "z": 1', '    }', '}', '',
  ].join('\n'))
  assert.equal(formatQtJson('\ud800'), '"\\ud800"\n')
})

test('real theme: byte-identical round trip', { skip }, () => {
  const raw = load()
  assert.equal(sha(encodeTheme(decodeTheme(raw))), sha(raw))
})

test('real theme: Qt formatter reproduces the original JSON text exactly', { skip }, () => {
  const t = decodeTheme(load())
  assert.equal(formatQtJson(t.json), t.jsonText)
})

test('real theme: controlData round trips on every key', { skip }, () => {
  const t = decodeTheme(load())
  let n = 0
  pages(t).forEach((_, i) => {
    for (const { item } of listKeys(t, i)) {
      const cd = decodeControlData(item.controlData)
      assert.equal(encodeControlData(cd), item.controlData)
      assert.ok(cd.type)
      n++
    }
  })
  assert.equal(n, 65)
})

test('real theme: setKeyTitle edit survives encode/decode and Python decodes it', { skip }, () => {
  const raw = load()
  const t = decodeTheme(raw)
  const before = structuredClone(t.json)
  const k = listKeys(t, 0)[0]
  setKeyTitle(t, 0, k.row, k.col, 'Edited \u4e2d "q"')
  const out = encodeTheme(t)
  assert.notEqual(sha(out), sha(raw))
  const t2 = decodeTheme(out)
  assert.equal(getItem(t2, 0, k.row, k.col).title, 'Edited \u4e2d "q"')
  before.pages[0].items.find((i) => i.row === String(k.row) && i.col === String(k.col) && i.type === '115').title = 'Edited \u4e2d "q"'
  assert.deepEqual(t2.json, before)
  assert.deepEqual(t2.header, t.header)
  assert.deepEqual([...t2.assets.keys()], [...decodeTheme(raw).assets.keys()])
  // re-encode of the edited file is stable
  assert.equal(sha(encodeTheme(t2)), sha(out))
  // Python decoder accepts it (its decode refuses unless in-memory re-encode is byte-identical)
  const d = mkdtempSync(join(tmpdir(), 'mk10-'))
  try {
    writeFileSync(join(d, 'x.Theme'), out)
    execFileSync('python3', [QTHEME, 'decode', join(d, 'x.Theme'), join(d, 'out')], { stdio: 'pipe' })
    assert.equal(readFileSync(join(d, 'out/pages.json'), 'utf8'), t2.jsonText)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('real theme: setKeyImage / setBackgroundVideo repoint and drop orphans only', { skip }, () => {
  const t = decodeTheme(load())
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const k = listKeys(t, 0).find((x) => x.item.path === '/image/MK10/cache/windows_2.png')
  assert.ok(k)
  const users = pages(t).flatMap((p) => p.items).filter((i) => i.path === k.item.path).length
  const key = setKeyImage(t, 0, k.row, k.col, png)
  assert.equal(k.item.path, key)
  assert.deepEqual(t.assets.get(key), png)
  assert.equal(t.assets.has('/image/MK10/cache/windows_2.png'), users !== 1) // dropped iff we were the only user

  const vid = pages(t)[0].items.find((i) => i.type === '100')
  const old = vid.path
  const vkey = setBackgroundVideo(t, 0, Buffer.from('mp4'))
  assert.match(vkey, /^\/theme\/MK10\/MainScreen\/[0-9a-f-]{36}\.mp4$/)
  assert.equal(vid.path, vkey)
  assert.equal(t.assets.has(old), false)
  assert.throws(() => setBackgroundVideo(t, 6, Buffer.alloc(1)))
  assert.deepEqual(decodeTheme(encodeTheme(t)).json, t.json)
})

test('unmodified json keeps original text even if it is not Qt-formatted', () => {
  const buf = new QWriter().vmap([]).u32(0).bytes(Buffer.from('{"a":1}')).u32(2)
    .string('/b').bytes(Buffer.from('1')).string('/a').bytes(null).u32(0).toBuffer()
  // asset order on the wire is wrong here on purpose; encode must sort
  const t = decodeTheme(buf)
  const out = encodeTheme(t)
  assert.equal(decodeTheme(out).jsonText, '{"a":1}')
  assert.deepEqual([...decodeTheme(out).assets.keys()], ['/a', '/b'])
  t.json.a = 2
  assert.equal(decodeTheme(encodeTheme(t)).jsonText, '{\n    "a": 2\n}\n')
})

test('real theme: action field edit changes only that value, keeps type/order, survives encode', { skip }, () => {
  const t = decodeTheme(load())
  let found
  t.json.pages.forEach((p, pi) => (p.items ?? []).forEach((it) => {
    if (!found && it.controlData && decodeControlData(it.controlData).type === 'openWeb') found = { pi, it }
  }))
  assert.ok(found, 'stock theme has an openWeb key')
  const { pi, it } = found
  const before = decodeControlData(it.controlData)
  assert.ok(editableActionFields(before).includes('Url'))
  assert.ok(!editableActionFields(before).includes('type'))
  setKeyActionField(t, pi, Number(it.row), Number(it.col), 'Url', 'https://example.com/x')
  const re = decodeControlData(decodeTheme(encodeTheme(t)).json.pages[pi].items.find((x) => x.row === it.row && x.col === it.col && x.controlData).controlData)
  assert.deepEqual(re.fields.map(([k, v]) => [k, v.type]), before.fields.map(([k, v]) => [k, v.type]))
  for (const [k, v] of re.fields) {
    assert.equal(v.value, k === 'Url' ? 'https://example.com/x' : before.fields.find(([q]) => q === k)[1].value)
  }
  assert.throws(() => setKeyActionField(t, pi, Number(it.row), Number(it.col), 'type', 'openApp'), /not editable/)
  assert.throws(() => setKeyActionField(t, pi, Number(it.row), Number(it.col), 'nope', 'x'), /not editable/)
})

test('real theme: pageSwitch jumpToPage is an int 0..top-level pages-1', { skip }, () => {
  const t = decodeTheme(load())
  let found
  t.json.pages.forEach((p, pi) => (p.items ?? []).forEach((it) => {
    if (!found && it.controlData && decodeControlData(it.controlData).type === 'pageSwitch') found = { pi, it }
  }))
  assert.ok(found, 'stock theme has a pageSwitch key')
  const { pi, it } = found
  const at = [t, pi, Number(it.row), Number(it.col)]
  assert.ok(editableActionFields(decodeControlData(it.controlData)).includes('jumpToPage'))
  assert.ok(!editableActionFields(decodeControlData(it.controlData)).includes('pageSwitchMode'))
  const top = t.json.pages.filter((p) => !p.parentPageName).length
  setKeyActionField(...at, 'jumpToPage', String(top - 1))
  const re = decodeControlData(decodeTheme(encodeTheme(t)).json.pages[pi].items.find((x) => x.row === it.row && x.col === it.col && x.controlData).controlData)
  const f = re.fields.find(([k]) => k === 'jumpToPage')[1]
  assert.equal(f.type, 2)
  assert.equal(f.value, top - 1)
  assert.throws(() => setKeyActionField(...at, 'jumpToPage', String(top)), /must be 0-/)
  assert.throws(() => setKeyActionField(...at, 'jumpToPage', 'x'), /must be 0-/)
})

test('real theme: openPage pageName must name an existing page', { skip }, () => {
  const t = decodeTheme(load())
  let found
  t.json.pages.forEach((p, pi) => (p.items ?? []).forEach((it) => {
    if (!found && it.controlData && decodeControlData(it.controlData).type === 'openPage') found = { pi, it }
  }))
  if (!found) return
  const { pi, it } = found
  assert.throws(() => setKeyActionField(t, pi, Number(it.row), Number(it.col), 'pageName', 'no-such-page'), /no page named/)
  setKeyActionField(t, pi, Number(it.row), Number(it.col), 'pageName', t.json.pages[0].pageName)
})

test('real theme: key clipboard copy, cut, paste across themes, asset reuse and rekeying', { skip }, () => {
  const a = decodeTheme(load())
  const gif = listKeys(a, 0).find((k) => k.item.paths) // GIF key: frames in a `paths` directory
  const png = listKeys(a, 0).find((k) => k.item.path && !k.item.paths)
  const text = JSON.stringify(copyKey(a, 0, png.row, png.col))
  assert.ok(parseKeyClip(text))
  assert.equal(parseKeyClip('{"mk10studio":"key","v":2,"item":{"type":"115"},"assets":{}}'), null)
  assert.equal(parseKeyClip('hello'), null)

  // same theme, empty slot: same bytes already there, so the asset key is reused, not duplicated
  const empty = [0, 1].flatMap((r) => [0, 1, 2, 3, 4].map((c) => [r, c])).find(([r, c]) => !getItem(a, 2, r, c))
  const nAssets = a.assets.size
  pasteKey(a, 2, empty[0], empty[1], text)
  const pasted = getItem(a, 2, empty[0], empty[1])
  assert.equal(pasted.path, png.item.path)
  assert.equal(a.assets.size, nAssets)
  assert.equal(pasted.x, String(empty[1] * 128))
  assert.notEqual(pasted.id, png.item.id)

  // cut the GIF key: its frames go once nothing references them; pasting brings them back under new keys
  const gclip = JSON.stringify(copyKey(a, 0, gif.row, gif.col))
  const frames = [...a.assets.keys()].filter((k) => k.startsWith(gif.item.paths + '/'))
  assert.ok(frames.length > 1)
  removeKey(a, 0, gif.row, gif.col)
  assert.equal(getItem(a, 0, gif.row, gif.col), undefined)
  assert.ok(frames.every((k) => !a.assets.has(k)))
  pasteKey(a, 0, gif.row, gif.col, gclip)
  const back = getItem(a, 0, gif.row, gif.col)
  assert.notEqual(back.paths, gif.item.paths)
  assert.equal([...a.assets.keys()].filter((k) => k.startsWith(back.paths + '/')).length, frames.length)

  // into another theme: replaces the key there, warns when an openPage target is missing
  const b = decodeTheme(load())
  b.json.pages = b.json.pages.slice(0, 2)
  const opener = listKeys(a, 0).find((k) => decodeControlData(k.item.controlData).type === 'openPage')
  const warn = pasteKey(b, 1, 0, 0, JSON.stringify(copyKey(a, 0, opener.row, opener.col)))
  assert.match(warn[0], /openPage target .* is not in this theme/)
  assert.equal(getItem(b, 1, 0, 0).title, opener.item.title)
  assert.deepEqual(decodeTheme(encodeTheme(a)).json, a.json)

  // multi-state key: state images live in jsonData; they count as references and travel with a copy
  const ms = a.json.pages[0].items.find((i) => String(i.type) === '115')
  const stateImg = '/image/MK10/cache/state-test.png'
  a.assets.set(stateImg, Buffer.from('state'))
  ms.jsonData = JSON.stringify({ State: 0, isMultiState: true, States: [{ path: stateImg, keycode: 10, keyString: 'G' }, { path: ms.path, keycode: 4, keyString: 'A' }] })
  const msClip = copyKey(a, 0, Number(ms.row), Number(ms.col))
  assert.ok(msClip.assets[stateImg])
  const c = decodeTheme(load())
  pasteKey(c, 1, 0, 0, JSON.stringify(msClip))
  assert.equal(c.assets.get(stateImg).toString(), 'state')
  removeKey(c, 1, 0, 0)
  assert.equal(c.assets.has(stateImg), false)
  pasteKey(c, 1, 0, 0, JSON.stringify(msClip))
  pasteKey(c, 1, 0, 1, JSON.stringify(msClip))
  removeKey(c, 1, 0, 0)
  assert.ok(c.assets.has(stateImg), 'still used by the other copy')

  // a key-area widget (clock digits, type 111 child) makes its cell occupied even with no key there
  const pi = a.json.pages.findIndex((q) => (q.items ?? []).some((i) => String(i.type) === '111' && i.backgroundType === 'child'))
  assert.ok(pi >= 0, 'stock theme has a clock page')
  const clk = a.json.pages[pi].items.find((i) => String(i.type) === '111' && i.backgroundType === 'child')
  const [cr, cc] = [Math.floor(Number(clk.y) / 128), Math.floor(Number(clk.x) / 128)]
  assert.equal(getItem(a, pi, cr, cc), undefined)
  assert.throws(() => pasteKey(a, pi, cr, cc, text), /holds a widget/)
})

test('raw key JSON round-trips, edits typed action fields and rejects bad input', { skip }, () => {
  const t = decodeTheme(load())
  const k = listKeys(t, 0).find((x) => decodeControlData(x.item.controlData).type === 'pageSwitch')
  const [p, r, c] = [0, k.row, k.col]
  const before = JSON.stringify(t.json)
  setKeyRaw(t, p, r, c, JSON.parse(JSON.stringify(keyRaw(t, p, r, c))))
  assert.equal(JSON.stringify(t.json), before, 'unchanged JSON writes the same item')

  const raw = keyRaw(t, p, r, c)
  raw.controlData.find(([n]) => n === 'jumpToPage')[1].value = 3
  setKeyRaw(t, p, r, c, raw)
  assert.equal(decodeControlData(getItem(t, p, r, c).controlData).fields.find(([n]) => n === 'jumpToPage')[1].value, 3)
  assert.equal(getItem(t, p, r, c).row, String(r), 'slot fields kept')

  const bad = (mut, re) => { const x = keyRaw(t, p, r, c); mut(x); const snap = JSON.stringify(t.json); assert.throws(() => setKeyRaw(t, p, r, c, x), re); assert.equal(JSON.stringify(t.json), snap) }
  bad((x) => { x.controlData.find(([n]) => n === 'jumpToPage')[1].value = '3' }, /32-bit integer/)
  bad((x) => { x.row = '1' }, /slot/)
  bad((x) => { x.type = '114' }, /stay "115"/)
  bad((x) => { x.path = '/image/MK10/cache/nope.png' }, /not in this theme/)
  bad((x) => { x.title = 5 }, /must be a string/)
})

test('real theme: setKeySound adds, dedupes, suffixes, clears and survives a round trip', { skip }, () => {
  const t = decodeTheme(load())
  const { row, col } = listKeys(t, 0)[0]
  const a = Buffer.from('RIFFaaaa')
  const b = Buffer.from('RIFFbbbb')
  assert.equal(setKeySound(t, 0, row, col, a, 'Boom Sound!.mp3'), '/sound/Boom_Sound_.wav')
  assert.equal(setKeySound(t, 0, row, col, a, 'Boom Sound!.mp3'), '/sound/Boom_Sound_.wav') // same bytes: same key
  const { row: r2, col: c2 } = listKeys(t, 0)[1]
  assert.equal(setKeySound(t, 0, r2, c2, b, 'Boom Sound!.wav'), '/sound/Boom_Sound_-2.wav') // clash: suffix
  const back = decodeTheme(encodeTheme(t))
  assert.equal(getItem(back, 0, row, col).soundFile, '/sound/Boom_Sound_.wav')
  assert.ok(back.assets.get('/sound/Boom_Sound_-2.wav').equals(b))
  assert.equal(setKeySound(t, 0, row, col, null), null)
  assert.equal(getItem(t, 0, row, col).soundFile, '')
  assert.equal(t.assets.has('/sound/Boom_Sound_.wav'), false) // orphan dropped
  assert.equal(t.assets.has('/sound/Boom_Sound_-2.wav'), true) // still used by the other key
})

test('real theme: page JSON round-trips byte-identical, edits items, keeps identity and slots', { skip }, () => {
  const raw = load()
  const t = decodeTheme(raw)
  const pi = t.json.pages.findIndex((p) => (p.items ?? []).some((it) => it.type === '115'))
  const pr = pageRaw(t, pi)
  setPageRaw(t, pi, structuredClone(pr))
  assert.ok(encodeTheme(t).equals(raw), 'unchanged page JSON writes the same bytes')
  const edit = structuredClone(pr)
  const k = edit.items.find((it) => it.type === '115')
  k.title = 'via page JSON'
  setPageRaw(t, pi, edit)
  const back = decodeTheme(encodeTheme(t)).json.pages[pi].items.find((it) => it.type === '115' && it.row === k.row && it.col === k.col)
  assert.equal(back.title, 'via page JSON')
  assert.throws(() => setPageRaw(t, pi, { ...pr, pageName: 'other' }), /pageName must stay/)
  assert.throws(() => setPageRaw(t, pi, { ...pr, items: 'x' }), /items must be a list/)
  assert.throws(() => setPageRaw(t, pi, { ...pr, canvas: 'x' }), /canvas must stay/)
  assert.throws(() => setPageRaw(t, pi, { ...pr, items: [...pr.items, { ...k }] }), /two keys at row/)
  assert.throws(() => setPageRaw(t, pi, { ...pr, items: [...pr.items, { type: '114', path: '/theme/nope.png' }] }), /not in this theme/)
  assert.throws(() => setPageRaw(t, pi, { ...pr, items: [{ type: 115 }] }), /must be a string/)
})

test('real theme: createKey makes a plain key of each offered type in an empty slot', { skip }, () => {
  const a = decodeTheme(load())
  const types = newKeyTypes(a, 0).map((t) => t.type)
  assert.ok(types.includes('openWeb') && !types.includes('openPage') && !types.includes('keyboard_switch'))
  assert.ok(!types.includes('oneLevelUp')) // page 0 is top level
  const folder = a.json.pages.findIndex((p) => p.parentPageName)
  assert.ok(newKeyTypes(a, folder).some((t) => t.type === 'oneLevelUp'))

  const pi = a.json.pages.findIndex((p, i) => i < 6 && [0, 1].some((r) => [0, 1, 2, 3, 4].some((c) => !getItem(a, i, r, c))))
  const [r, c] = [0, 1].flatMap((r) => [0, 1, 2, 3, 4].map((c) => [r, c])).find(([r, c]) => !getItem(a, pi, r, c))
  createKey(a, pi, r, c, 'openWeb')
  const it = getItem(a, pi, r, c)
  assert.equal(it.title, 'Open website')
  assert.equal(JSON.parse(it.titleParam).FontSize, 16)
  assert.equal(JSON.parse(it.titleParam).TitleAlignment, 'top')
  assert.equal(it.x, String(c * 128))
  const cd = decodeControlData(it.controlData)
  assert.equal(cd.fields.find(([k]) => k === 'type')[1].value, 'openWeb')
  assert.equal(encodeControlData(cd), it.controlData)
  setKeyActionField(a, pi, r, c, 'Url', 'https://example.com/')
  assert.throws(() => createKey(a, pi, r, c, 'openWeb'), /already holds a key/)
  // a type with a default icon gets it as its image; a second key reuses the same asset
  const free = [0, 1].flatMap((r) => [0, 1, 2, 3, 4].map((c) => [r, c])).filter(([r, c]) => !getItem(a, pi, r, c))
  if (free.length >= 2) {
    const n = a.assets.size
    createKey(a, pi, ...free[0], 'Loudspeaker')
    createKey(a, pi, ...free[1], 'Loudspeaker')
    const k1 = getItem(a, pi, ...free[0])
    assert.ok(a.assets.get(k1.path)?.subarray(1, 4).toString() === 'PNG')
    assert.equal(getItem(a, pi, ...free[1]).path, k1.path)
    assert.equal(a.assets.size, n + 1)
  }
  // Settings > New key title defaults go into titleParam; the rest keeps the built-in look
  const spare = [0, 1].flatMap((r) => [0, 1, 2, 3, 4].map((c) => [r, c])).find(([r, c]) => !getItem(a, pi, r, c))
  if (spare) {
    createKey(a, pi, ...spare, 'openWeb', { FontFamily: 'Arial', FontSize: 22, FontStyle: 'Bold' })
    const tp = JSON.parse(getItem(a, pi, ...spare).titleParam)
    assert.deepEqual([tp.FontFamily, tp.FontSize, tp.FontStyle, tp.TitleAlignment], ['Arial', 22, 'Bold', 'top'])
  }
  assert.deepEqual(checkTitleDefaults({ FontSize: 20, FontUnderline: true }), { FontSize: 20 })
  assert.throws(() => checkTitleDefaults({ FontSize: 200 }), /bad FontSize/)
  assert.throws(() => createKey(a, pi, r, c === 4 ? 3 : 4, 'openPage'), /can't create/)
  // the theme still round-trips through the codec
  const b = decodeTheme(encodeTheme(a))
  assert.equal(decodeControlData(getItem(b, pi, r, c).controlData).fields.find(([k]) => k === 'Url')[1].value, 'https://example.com/')
})

test('real theme: setKeyTitleParam edits the title look and keeps the vendor key order', { skip }, () => {
  const a = decodeTheme(load())
  const k = listKeys(a, 0)[0]
  setKeyTitleParam(a, 0, k.row, k.col, { FontSize: 30, TitleAlignment: 'middle', FontStyle: 'Bold Italic', TitleColor: '#ff8800', ShowImage: false })
  const s = getItem(a, 0, k.row, k.col).titleParam
  const tp = JSON.parse(s)
  assert.deepEqual(Object.keys(tp), [...Object.keys(tp)].sort())
  assert.equal(tp.FontSize, 30)
  assert.equal(tp.TitleAlignment, 'middle')
  assert.equal(tp.ShowImage, false)
  assert.ok(!s.includes(' '.repeat(2)) && !s.includes('\n'))
  for (const bad of [{ FontSize: 5 }, { FontSize: '30' }, { TitleAlignment: 'center' }, { FontStyle: 'Heavy' }, { TitleColor: 'red' }, { ShowTitle: 1 }, { Nope: 1 }]) {
    assert.throws(() => setKeyTitleParam(a, 0, k.row, k.col, bad))
  }
  assert.equal(JSON.parse(getItem(decodeTheme(encodeTheme(a)), 0, k.row, k.col).titleParam).TitleColor, '#ff8800')
})

test('real theme: englishDescriptions replaces the vendor Chinese default descriptions only', { skip }, () => {
  const a = decodeTheme(load())
  const zh = /\p{Script=Han}/u
  const descs = (t) => t.json.pages.flatMap((p) => p.items ?? []).filter((i) => i.controlData)
    .flatMap((i) => decodeControlData(i.controlData).fields.filter(([k]) => /escription$/.test(k)).map(([, v]) => v.value))
  assert.ok(descs(a).some((v) => zh.test(v)))
  assert.ok(englishDescriptions(a) > 0)
  assert.ok(!descs(a).some((v) => zh.test(v)), descs(a).filter((v) => zh.test(v)).join())
  assert.ok(descs(a).includes('Page switching'))
  assert.equal(englishDescriptions(a), 0)
  decodeTheme(encodeTheme(a))
})

test('real theme: fontFamilies lists title and text widget fonts', { skip }, () => {
  const f = fontFamilies(decodeTheme(load()))
  for (const x of ['Arial', 'Microsoft YaHei']) assert.ok(f.includes(x), f.join())
  assert.ok(!f.some((x) => x.includes(',')), f.join(' | ')) // text_font is a QFont string; family only
})

test('real theme: deleteFolder removes the folder, nested folders, opener keys and orphan assets', { skip }, () => {
  const a = decodeTheme(load())
  const pages = a.json.pages
  const opensName = (name) => a.json.pages.flatMap((p) => p.items ?? []).filter((i) => i.controlData &&
    decodeControlData(i.controlData).fields.some(([k, v]) => k === 'pageName' && v.value === name))
  const fi = pages.findIndex((p) => p.parentPageName && opensName(p.pageName).length)
  const f = pages[fi]
  const parent = pages.findIndex((p) => p.pageName === f.parentPageName)
  const openers = () => opensName(f.pageName)
  assert.ok(openers().length > 0)
  const n = pages.length
  const nAssets = a.assets.size
  a.json.main.currentPage = f.pageName
  const gone = deleteFolder(a, fi)
  assert.equal(a.json.pages.length, n - gone.length)
  assert.ok(!a.json.pages.some((p) => gone.includes(p.pageName) || gone.includes(p.parentPageName)))
  assert.equal(openers().length, 0)
  assert.equal(a.json.main.currentPage, pages[parent].pageName)
  assert.ok(a.assets.size <= nAssets)
  assert.throws(() => deleteFolder(a, a.json.pages.findIndex((p) => !p.parentPageName)), /only folder/)
  decodeTheme(encodeTheme(a))
})

test('real theme: setKeyIcon sets a premade icon, reusing its asset', { skip }, () => {
  const a = decodeTheme(load())
  assert.ok(listIcons().includes('speaker'))
  const [k1, k2] = listKeys(a, 0)
  setKeyIcon(a, 0, k1.row, k1.col, 'globe')
  const n = a.assets.size
  setKeyIcon(a, 0, k2.row, k2.col, 'globe')
  assert.equal(getItem(a, 0, k2.row, k2.col).path, getItem(a, 0, k1.row, k1.col).path)
  assert.ok(a.assets.size <= n)
  assert.throws(() => setKeyIcon(a, 0, k1.row, k1.col, '../x'), /no icon/)
})

test('moveKeys: move to an empty slot, shift a run, swap; rejects bad targets untouched', { skip }, () => {
  const t = decodeTheme(load())
  const slots = [0, 1].flatMap((r) => [0, 1, 2, 3, 4].map((c) => [r, c]))
  const pi = t.json.pages.findIndex((_, i) => slots.some(([r, c]) => !getItem(t, i, r, c)) && listKeys(t, i).length >= 2)
  const [a, b] = listKeys(t, pi)
  const empty = slots.find(([r, c]) => !getItem(t, pi, r, c))
  const ia = a.item
  moveKeys(t, pi, [[a.row, a.col, ...empty]])
  assert.equal(getItem(t, pi, ...empty), ia)
  assert.equal(ia.x, String(empty[1] * 128))
  assert.equal(getItem(t, pi, a.row, a.col), undefined)
  // swap
  moveKeys(t, pi, [[...empty, b.row, b.col], [b.row, b.col, ...empty]])
  assert.equal(getItem(t, pi, b.row, b.col), ia)
  assert.equal(getItem(t, pi, ...empty), b.item)
  // onto a key that does not move away
  const before = JSON.stringify(t.json)
  assert.throws(() => moveKeys(t, pi, [[b.row, b.col, ...empty]]), /already holds a key/)
  assert.throws(() => moveKeys(t, pi, [[b.row, b.col, 2, 0]]), /not a key slot/)
  assert.equal(JSON.stringify(t.json), before)
})
