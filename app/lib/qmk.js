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
