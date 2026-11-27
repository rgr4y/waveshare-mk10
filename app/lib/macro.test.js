import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readMacro, setKeyMacro } from './macro.js'
import { decodeControlData, encodeControlData } from './theme.js'
import { T_STRING } from './qdatastream.js'

const theme = (controlData) => ({ json: { pages: [{ items: [{ type: '115', row: '0', col: '0', controlData }] }] } })
const plain = (type) => encodeControlData({ fields: [['type', { type: T_STRING, null: 0, value: type }]] })

test('macro: one tap or one text stays a plain action, more steps make a flow', () => {
  const t = theme(plain('keyboard'))
  const it = t.json.pages[0].items[0]
  setKeyMacro(t, 0, 0, 0, [{ type: 'keyboard', keycode: 262, keyType: 0 }])
  assert.equal(decodeControlData(it.controlData).type, 'keyboard')
  assert.equal(it.controlDataList, undefined)
  assert.deepEqual(readMacro(it), [{ type: 'keyboard', keycode: 262, keyType: 0, label: 'L Ctrl C' }])
  const kv = Object.fromEntries(decodeControlData(it.controlData).fields.map(([k, v]) => [k, v.value]))
  assert.equal(kv.keyString, 'L Ctrl C')
  assert.equal('keyType' in kv, false)

  const steps = [
    { type: 'keyboard', keycode: 0xE1, keyType: 1 }, { type: 'delay', ms: 250 },
    { type: 'startLoop', count: 3 }, { type: 'qmk_string', text: 'a b\n' }, { type: 'stopLoop' },
    { type: 'keyboard', keycode: 0xE1, keyType: 2 },
  ]
  setKeyMacro(t, 0, 0, 0, steps)
  const cd = decodeControlData(it.controlData)
  assert.equal(cd.type, 'ControlFlow')
  // the device reads the item field; controlData carries the same list as bytes of base64 text
  assert.equal(cd.fields.find(([k]) => k === 'controlDataList')[1].value.toString(), it.controlDataList)
  assert.deepEqual(readMacro(it).map((s) => { delete s.label; return s }), steps)

  setKeyMacro(t, 0, 0, 0, [{ type: 'qmk_string', text: 'hi' }])
  assert.equal(decodeControlData(it.controlData).type, 'qmk_string')
  assert.equal(it.controlDataList, undefined)
})

test('macro: vendor steps Studio does not edit survive a rewrite', () => {
  const t = theme(plain('keyboard'))
  const it = t.json.pages[0].items[0]
  setKeyMacro(t, 0, 0, 0, [{ type: 'keyboard', keycode: 4, keyType: 0 }, { type: 'delay', ms: 1 }])
  const audio = { type: 'devicePlayAudio', raw: Buffer.from('AAAAAQAAAAgAdAB5AHAAZQAAAAoAAAAAHgBkAGUAdgBpAGMAZQBQAGwAYQB5AEEAdQBkAGkAbw==', 'base64').toString('base64') }
  setKeyMacro(t, 0, 0, 0, [...readMacro(it), audio])
  assert.deepEqual(readMacro(it).at(-1), audio)
})

test('macro: rejects bad steps', () => {
  const t = theme(plain('keyboard'))
  assert.throws(() => setKeyMacro(t, 0, 0, 0, []), /at least one step/)
  assert.throws(() => setKeyMacro(t, 0, 0, 0, [{ type: 'startLoop', count: 2 }]), /no loop end/)
  assert.throws(() => setKeyMacro(t, 0, 0, 0, [{ type: 'stopLoop' }]), /without a loop start/)
  assert.throws(() => setKeyMacro(t, 0, 0, 0, [{ type: 'keyboard', keycode: 4, keyType: 3 }]), /keyType/)
  assert.throws(() => setKeyMacro(t, 0, 0, 0, [{ type: 'qmk_string', text: '' }]), /empty/)
  assert.equal(readMacro({ controlData: plain('openWeb') }), null)
})
