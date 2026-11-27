// HID usage (+ held modifiers) -> QMK keycode, the `keycode` a `keyboard` action stores (docs/theme-format.md).
// Table generated from the QMK source; see qmk-keycodes.json "source". The vendor GD32 fork's mapping is
// not verified beyond the codes tested on the device (mute/volume, 0xB4, 0xC1, 0xC2).
import { readFileSync } from 'node:fs'

const T = JSON.parse(readFileSync(new URL('./qmk-keycodes.json', import.meta.url)))
const hex = (n) => `0x${n.toString(16)}`

// QMK QK_MODS: Ctrl 0x100, Shift 0x200, Alt 0x400, GUI 0x800; 0x1000 makes all of them right-hand mods.
// HID modifier usages 0xE0-0xE3 are left Ctrl/Shift/Alt/GUI, 0xE4-0xE7 the right ones.
const MOD_BIT = [0x100, 0x200, 0x400, 0x800]
const MOD_FN = ['CTL', 'SFT', 'ALT', 'GUI']
export const isModifier = (page, usage) => page === 0x07 && usage >= 0xE0 && usage <= 0xE7

// held: Set of HID modifier usages (0xE0-0xE7) down at the time of the press.
// Returns { code, name } (name like "LCTL(LSFT(KC_S))"), or null when QMK has no keycode for it.
export function hidToQmk(page, usage, held = new Set()) {
  let base
  if (page === 0x07) base = T.keyboard[hex(usage)] && { code: usage, name: T.keyboard[hex(usage)] }
  else if (page === 0x0C) base = T.consumer[hex(usage)]
  else if (page === 0x01) base = T.system[hex(usage)]
  if (!base) return null
  let code = Number(base.code)
  let name = base.name
  if (isModifier(page, usage)) return { code, name } // a modifier pressed alone
  // QMK cannot mix left and right mods in one keycode: left wins when both sides are held
  const left = [...held].filter((u) => u >= 0xE0 && u <= 0xE3)
  const right = [...held].filter((u) => u >= 0xE4 && u <= 0xE7)
  const mods = left.length ? left.map((u) => u - 0xE0) : right.map((u) => u - 0xE4)
  const side = left.length ? 'L' : 'R'
  for (const m of [...new Set(mods)].sort().reverse()) {
    code |= MOD_BIT[m]
    name = `${side}${MOD_FN[m]}(${name})`
  }
  if (!left.length && right.length) code |= 0x1000
  return { code, name }
}

// KeyboardEvent.code (what Electron's before-input-event reports) -> HID keyboard usage (page 0x07),
// per the W3C UI Events code spec's USB HID column. Media keys never reach the app on macOS.
export const CODE_TO_HID = {
  Enter: 0x28, Escape: 0x29, Backspace: 0x2A, Tab: 0x2B, Space: 0x2C, Minus: 0x2D, Equal: 0x2E,
  BracketLeft: 0x2F, BracketRight: 0x30, Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35,
  Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39, PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48,
  Insert: 0x49, Home: 0x4A, PageUp: 0x4B, Delete: 0x4C, End: 0x4D, PageDown: 0x4E, ArrowRight: 0x4F,
  ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52, NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55,
  NumpadSubtract: 0x56, NumpadAdd: 0x57, NumpadEnter: 0x58, NumpadDecimal: 0x63, IntlBackslash: 0x64,
  ContextMenu: 0x65, NumpadEqual: 0x67, ControlLeft: 0xE0, ShiftLeft: 0xE1, AltLeft: 0xE2, MetaLeft: 0xE3,
  ControlRight: 0xE4, ShiftRight: 0xE5, AltRight: 0xE6, MetaRight: 0xE7,
}
for (let i = 0; i < 26; i++) CODE_TO_HID[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i
for (let i = 1; i <= 9; i++) CODE_TO_HID[`Digit${i}`] = 0x1D + i
CODE_TO_HID.Digit0 = 0x27
for (let i = 1; i <= 9; i++) CODE_TO_HID[`Numpad${i}`] = 0x58 + i
CODE_TO_HID.Numpad0 = 0x62
for (let i = 1; i <= 12; i++) CODE_TO_HID[`F${i}`] = 0x39 + i
for (let i = 13; i <= 24; i++) CODE_TO_HID[`F${i}`] = 0x5B + i

// QMK keycode -> label in the vendor's keyString style ("L Ctrl C"). Only a label: the device
// uses the int keycode. Mod order Ctrl, Win, Shift, Alt follows the one vendor sample ("L Win L Shift S").
const NAMES = new Map([
  ...Object.entries(T.keyboard).map(([u, n]) => [Number(u), n]),
  ...[...Object.values(T.consumer), ...Object.values(T.system)].map((x) => [Number(x.code), x.name]),
])
const MOD_KEYS = { 0xE0: 'L Ctrl', 0xE1: 'L Shift', 0xE2: 'L Alt', 0xE3: 'L Win', 0xE4: 'R Ctrl', 0xE5: 'R Shift', 0xE6: 'R Alt', 0xE7: 'R Win' }
const pretty = (n) => n.replace(/^KC_/, '').split('_').map((w) => (w.length > 1 ? w[0] + w.slice(1).toLowerCase() : w)).join(' ')
export function qmkLabel(code) {
  if (MOD_KEYS[code]) return MOD_KEYS[code]
  const mods = code < 0x2000 ? code & 0x1F00 : 0
  const base = mods ? code & 0xFF : code
  const name = NAMES.get(base)
  const side = mods & 0x1000 ? 'R' : 'L'
  const parts = [[0x100, 'Ctrl'], [0x800, 'Win'], [0x200, 'Shift'], [0x400, 'Alt']].filter(([b]) => mods & b).map(([, m]) => `${side} ${m}`)
  return [...parts, name ? pretty(name) : `0x${base.toString(16)}`].join(' ')
}
