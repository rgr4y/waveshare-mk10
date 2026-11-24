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
} from './theme.js'

const REAL = '/Applications/ScreenKeyMacOS.app/Contents/MacOS/theme/MK10/defaultTheme.Theme'
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
