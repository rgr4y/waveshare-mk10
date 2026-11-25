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
  pages, listKeys, getItem, setKeyTitle, setKeyImage, setBackgroundVideo,
  editableActionFields, setKeyActionField, copyKey, pasteKey, removeKey, parseKeyClip, keyRaw, setKeyRaw,
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
