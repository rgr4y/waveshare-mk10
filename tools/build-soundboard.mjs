// One-off: turn top-level Page 5 of a theme into a soundboard. Page 5 holds sounds 1-8; folders under
// it hold the rest, 8 per page. Row 1 col 3 = Next (openPage the next folder; the last one goes up a level,
// back to Page 5), row 1 col 4 = Home (pageSwitch to Page 0). Sound keys: keyboard KC_NO (0) + soundFile.
// Usage: python3 tools/soundboard-icons.py <icons dir>
//        node tools/build-soundboard.mjs <in.Theme> <out.Theme> <sounds dir with sounds.json> <icons dir>
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
const APP = new URL('../app/lib', import.meta.url).href
const T = await import(`${APP}/theme.js`)
const { toDeviceWav } = await import(`${APP}/media.js`)
const [input, output, soundsDir, iconsDir] = process.argv.slice(2)
if (!iconsDir) { console.error('usage: node tools/build-soundboard.mjs <in.Theme> <out.Theme> <sounds dir> <icons dir>'); process.exit(2) }
if (existsSync(output)) throw new Error(`${output} exists; refusing to overwrite`)

const t = T.decodeTheme(readFileSync(input))
const P = t.json.pages
const top = P.map((p, i) => [p, i]).filter(([p]) => p.parentPageName === undefined)
const [home, homeIdx] = top[5]
if ((home.items ?? []).length) throw new Error(`Page 5 (${home.pageName}) is not empty; refusing`)
console.log(`Page 5 = pages[${homeIdx}] ${home.pageName}`)

// controlData and item shape copied from real keys in this theme (field order matters to the firmware)
const realKey = (type) => {
  for (const p of P) for (const it of p.items ?? []) {
    if (String(it.type) === '115' && it.controlData && T.decodeControlData(it.controlData).type === type) return it
  }
  throw new Error(`no ${type} key to copy from`)
}
const action = (type, values) => {
  const cd = T.decodeControlData(realKey(type).controlData)
  for (const [k, v] of Object.entries(values)) {
    const f = cd.fields.find(([n]) => n === k)
    if (!f) throw new Error(`${type} has no field ${k}`)
    f[1].value = v
  }
  return T.encodeControlData(cd)
}

const icon = (name) => {
  const key = `/image/MK10/cache/soundboard-${name}.png`
  t.assets.set(key, readFileSync(join(iconsDir, `${name}.png`)))
  return key
}
const ICON = { speaker: icon('speaker'), next: icon('next'), home: icon('home') }
const titleParam = (size, align) => JSON.stringify({ FontFamily: 'Microsoft YaHei', FontSize: size, FontStyle: 'Bold', FontUnderline: false, ShowImage: true, ShowTitle: true, TitleAlignment: align, TitleColor: '#ffffff' })
let z = 1
const item = (row, col, { title = '', path, controlData, size = 16, align = 'bottom' }) => ({
  col: String(col), controlData, id: String(z), lock: '1', maxHeight: '304', maxWidth: '896', opacity: '100',
  path, rotate: '0', row: String(row), scale: '1', scaledHeightTo: '128', scaledWidthTo: '128', soundFile: '',
  title, titleParam: titleParam(size, align), type: '115', x: String(128 * col), y: String(128 * row), z: String(z++),
})

// sounds: sounds.json order and labels; prefer an existing WAV, else the mp3 (ffmpeg converts either)
const manifest = JSON.parse(readFileSync(join(soundsDir, 'sounds.json'), 'utf8'))
const sounds = Object.entries(manifest).map(([name, v]) => {
  const src = ['.wav', '.WAV', '.mp3'].map((e) => join(soundsDir, name + e)).find(existsSync)
  if (!src) throw new Error(`no file for ${name}`)
  return { label: v.label ?? name, src }
})
const PER = 8
const nPages = Math.ceil(sounds.length / PER)
const folders = Array.from({ length: nPages - 1 }, () => ({ canvas: structuredClone(home.canvas), items: [], pageName: randomUUID(), parentPageName: home.pageName }))
P.push(...folders)
const boardPages = [home, ...folders]
const SLOTS = [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [1, 0], [1, 1], [1, 2]]

for (const [n, pg] of boardPages.entries()) {
  pg.items = []
  z = 1
  const chunk = sounds.slice(n * PER, n * PER + PER)
  for (const [i, s] of chunk.entries()) {
    const [row, col] = SLOTS[i]
    const size = s.label.length > 16 ? 12 : 16
    pg.items.push(item(row, col, { title: s.label, path: ICON.speaker, size, controlData: action('keyboard', { keycode: 0, keyString: '' }) }))
  }
  const last = n === boardPages.length - 1
  pg.items.push(item(1, 3, {
    title: last ? 'First' : `Next ${n + 2}/${nPages}`, path: ICON.next, size: 18,
    controlData: last ? action('oneLevelUp', {}) : action('openPage', { pageName: folders[n].pageName }),
  }))
  pg.items.push(item(1, 4, { title: 'Home', path: ICON.home, size: 18, controlData: action('pageSwitch', { jumpToPage: 0, pageSwitchMode: 0 }) }))
  console.log(`page ${n + 1}/${nPages} ${pg.pageName}: ${chunk.map((s) => s.label).join(' | ')}`)
}

// now that the pages exist, attach sounds through the same code path as Studio's Choose…
const idx = (pg) => P.indexOf(pg)
for (const [n, pg] of boardPages.entries()) {
  for (const [i, s] of sounds.slice(n * PER, n * PER + PER).entries()) {
    const [row, col] = SLOTS[i]
    const key = T.setKeySound(t, idx(pg), row, col, await toDeviceWav(s.src, 1), s.label)
    process.stdout.write(`  ${key}\n`)
  }
}
const buf = T.encodeTheme(t)
T.decodeTheme(buf) // must read back
writeFileSync(output, buf)
console.log(`wrote ${output} (${(buf.length / 1e6).toFixed(1)} MB, was ${(readFileSync(input).length / 1e6).toFixed(1)} MB)`)
