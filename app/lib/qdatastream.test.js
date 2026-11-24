import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QReader, QWriter, T_STRING, T_BYTES, T_INT, T_BOOL, T_MAP } from './qdatastream.js'

test('variants round trip incl. null string/bytes, non-BMP, nested map', () => {
  const map = [
    ['s', { type: T_STRING, null: 0, value: 'h\u00e9llo \u{1F600} \u4e2d' }],
    ['ns', { type: T_STRING, null: 1, value: null }],
    ['b', { type: T_BYTES, null: 0, value: Buffer.from([0, 1, 255]) }],
    ['nb', { type: T_BYTES, null: 0, value: null }],
    ['i', { type: T_INT, null: 0, value: -5 }],
    ['t', { type: T_BOOL, null: 0, value: true }],
    ['m', { type: T_MAP, null: 0, value: [['x', { type: T_INT, null: 0, value: 1 }]] }],
  ]
  const buf = new QWriter().vmap(map).toBuffer()
  const r = new QReader(buf)
  assert.deepEqual(r.vmap(), map)
  assert.equal(r.remaining, 0)
})

test('QString is UTF-16BE with u32 byte length; null = 0xffffffff', () => {
  assert.equal(new QWriter().string('A').toBuffer().toString('hex'), '000000020041')
  assert.equal(new QWriter().string(null).toBuffer().toString('hex'), 'ffffffff')
})

test('unknown QVariant type id throws (read and write)', () => {
  const bad = Buffer.from('00000063' + '00', 'hex')
  assert.throws(() => new QReader(bad).variant(), /unsupported QVariant type id 99/)
  assert.throws(() => new QWriter().variant({ type: 99, null: 0, value: 1 }), /unsupported/)
})

test('truncated input throws', () => {
  assert.throws(() => new QReader(Buffer.from('0000', 'hex')).u32(), /truncated/)
})
