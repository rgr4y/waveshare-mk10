// Device fonts: the MK10's Qt draws text with the fonts in /usr/share/fonts (QT_QPA_FONTDIR on the
// device). Studio copies that directory over ssh into its own cache and registers each face in the
// editor under the family names the font declares, so key titles and clocks render like the device.
// The fonts come from the user's own device and are not shipped with the app.
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const DEVICE_FONT_DIR = '/usr/share/fonts'
const FONT_RE = /\.(ttf|otf|ttc)$/i

// Family names (name IDs 1 and 16), weight (OS/2 usWeightClass) and italic (OS/2 fsSelection bit 0)
// of a TrueType/OpenType file; for a .ttc, its first face.
export function fontInfo(buf) {
  const off = buf.toString('latin1', 0, 4) === 'ttcf' ? buf.readUInt32BE(12) : 0
  const tables = {}
  for (let i = 0, n = buf.readUInt16BE(off + 4); i < n; i++) {
    const r = off + 12 + i * 16
    tables[buf.toString('latin1', r, r + 4)] = buf.readUInt32BE(r + 8)
  }
  const families = new Set()
  const t = tables.name
  if (t !== undefined) {
    const count = buf.readUInt16BE(t + 2)
    const strings = t + buf.readUInt16BE(t + 4)
    const recs = Array.from({ length: count }, (_, i) => {
      const r = t + 6 + i * 12
      return { platform: buf.readUInt16BE(r), lang: buf.readUInt16BE(r + 4), id: buf.readUInt16BE(r + 6), len: buf.readUInt16BE(r + 8), at: strings + buf.readUInt16BE(r + 10) }
    })
    const text = (r) => {
      const b = buf.subarray(r.at, r.at + r.len)
      return r.platform === 1 ? b.toString('latin1') : Buffer.from(b).swap16().toString('utf16le')
    }
    for (const id of [1, 16]) {
      // English Windows name first, then Mac Roman, then any Windows-platform name
      const r = recs.find((x) => x.id === id && x.platform === 3 && x.lang === 0x409) ??
        recs.find((x) => x.id === id && x.platform === 1 && x.lang === 0) ??
        recs.find((x) => x.id === id && x.platform === 3)
      if (r) families.add(text(r).trim())
    }
  }
  const os2 = tables['OS/2']
  return {
    families: [...families].filter(Boolean),
    weight: os2 === undefined ? 400 : buf.readUInt16BE(os2 + 4),
    italic: os2 === undefined ? false : !!(buf.readUInt16BE(os2 + 62) & 1),
  }
}

// [{file, family, weight, style}] for every font file in dir (unreadable files are skipped)
export async function fontManifest(dir) {
  let files
  try {
    files = (await readdir(dir)).filter((f) => FONT_RE.test(f)).sort()
  } catch {
    return []
  }
  const out = []
  for (const file of files) {
    try {
      const { families, weight, italic } = fontInfo(await readFile(join(dir, file)))
      for (const family of families) out.push({ file, family, weight, style: italic ? 'italic' : 'normal' })
    } catch { /* not a font we can read */ }
  }
  return out
}

// Copy the device font directory into dir (replaced only after a complete copy): ~85 MB, about a
// minute at the ~1.6 MB/s the device manages over ssh (2026-11-24). ssh + tar, so a
// host from settings never goes through a local shell.
export async function syncDeviceFonts(host, dir, { log = () => {}, timeout = 180000 } = {}) {
  const tmp = `${dir}.new`
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  log(`fonts: ${host}:${DEVICE_FONT_DIR} -> ${dir}`)
  await new Promise((resolve, reject) => {
    const src = spawn('ssh', ['-o', 'ConnectTimeout=5', host, `tar -C ${DEVICE_FONT_DIR} -cf - .`], { stdio: ['ignore', 'pipe', 'pipe'] })
    const dst = spawn('tar', ['-xf', '-', '-C', tmp], { stdio: ['pipe', 'ignore', 'pipe'] })
    src.stdout.pipe(dst.stdin)
    let err = ''
    src.stderr.on('data', (d) => { err += d })
    dst.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => { src.kill(); dst.kill(); reject(new Error(`font copy timed out after ${timeout / 1000} s`)) }, timeout)
    let left = 2
    const done = (name) => (code) => {
      if (code !== 0) { clearTimeout(timer); return reject(new Error(`${name} exited ${code}: ${err.trim()}`)) }
      if (--left === 0) { clearTimeout(timer); resolve() }
    }
    src.on('close', done('ssh'))
    dst.on('close', done('tar'))
  })
  const m = await fontManifest(tmp)
  if (!m.length) throw new Error('no readable fonts came back from the device')
  await rm(dir, { recursive: true, force: true })
  await rename(tmp, dir)
  log(`fonts: ${new Set(m.map((x) => x.file)).size} files, ${new Set(m.map((x) => x.family)).size} families`)
  return m
}
