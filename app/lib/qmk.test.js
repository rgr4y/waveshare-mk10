import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hidToQmk } from './qmk.js'

// expected codes are the ones in the stock themes (docs/theme-format.md) and QMK report.h
test('HID usage to QMK keycode', () => {
  assert.deepEqual(hidToQmk(0x07, 0x06, new Set([0xE0])), { code: 262, name: 'LCTL(KC_C)' }) // 262 = L Ctrl C
  assert.equal(hidToQmk(0x07, 0x16, new Set([0xE3, 0xE1])).code, 2582) // L Win L Shift S
  assert.equal(hidToQmk(0x07, 0x2B, new Set([0xE2])).code, 1067) // L Alt Tab
  assert.equal(hidToQmk(0x07, 0x06, new Set([0xE4])).code, 0x1106) // R Ctrl C
  assert.equal(hidToQmk(0x07, 0x73).name, 'KC_F24')
  assert.deepEqual(hidToQmk(0x0C, 0xE2), { code: 0xA8, name: 'KC_AUDIO_MUTE' })
  assert.equal(hidToQmk(0x0C, 0xCC).name, 'KC_MEDIA_EJECT') // QMK eject is Stop/Eject 0xCC, not 0xB8
  assert.equal(hidToQmk(0x0C, 0x2A0).name, 'KC_LAUNCHPAD')
  assert.equal(hidToQmk(0x01, 0x82).name, 'KC_SYSTEM_SLEEP')
  assert.equal(hidToQmk(0x0C, 0xB8), null) // no QMK keycode sends plain Eject
  assert.equal(hidToQmk(0xFF, 0x03), null)
})
