// Device fonts: the MK10's Qt draws text with the fonts in /usr/share/fonts (QT_QPA_FONTDIR on the
// device). Studio copies that directory over ssh into its own cache and registers each face in the
// editor under the family names the font declares, so key titles and clocks render like the device.
// The fonts come from the user's own device and are not shipped with the app.
import { spawn } from 'node:child_process'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEVICE_FONT_DIR = '/usr/share/fonts'
const FONT_RE = /\.(ttf|otf|ttc)$/i

// Family names (name IDs 1 and 16), weight (OS/2 usWeightClass) and italic (OS/2 fsSelection bit 0)
// of a TrueType/OpenType file; for a .ttc, its first face.
export function fontInfo(buf) {
  const off = buf.toString('latin1', 0, 4) === 'ttcf' ? buf.readUInt32BE(12) : 0
  const n = buf.readUInt16BE(off + 4)
  const t = tableDir(buf.subarray(off + 12, off + 12 + n * 16))
  const table = (tag) => t[tag] && buf.subarray(t[tag].at, t[tag].at + t[tag].len)
  return infoFromTables(table('name'), table('OS/2'))
}

// Same, reading only the header, table directory, name and OS/2 tables (system fonts run to GBs)
export async function fontInfoFile(path) {
  const fh = await open(path)
  try {
    const rd = async (pos, len) => {
      const b = Buffer.alloc(len)
      const { bytesRead } = await fh.read(b, 0, len, pos)
      if (bytesRead < len) throw new Error('short font file')
      return b
    }
    const head = await rd(0, 16)
    const off = head.toString('latin1', 0, 4) === 'ttcf' ? head.readUInt32BE(12) : 0
    const n = (await rd(off + 4, 2)).readUInt16BE(0)
    const t = tableDir(await rd(off + 12, n * 16))
    const table = (tag) => t[tag] && rd(t[tag].at, t[tag].len)
    return infoFromTables(await table('name'), await table('OS/2'))
  } finally {
    await fh.close()
  }
}

// table directory records (tag, checksum, offset, length) -> {tag: {at, len}}
function tableDir(dir) {
  const tables = {}
  for (let r = 0; r + 16 <= dir.length; r += 16) tables[dir.toString('latin1', r, r + 4)] = { at: dir.readUInt32BE(r + 8), len: dir.readUInt32BE(r + 12) }
  return tables
}

function infoFromTables(buf, os2) {
  const families = new Set()
  const t = 0
  if (buf) {
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
  return {
    families: [...families].filter(Boolean),
    weight: os2 ? os2.readUInt16BE(4) : 400,
    italic: os2 ? !!(os2.readUInt16BE(62) & 1) : false,
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

// Font directories of this computer (fontconfig's defaults on Linux)
const SYSTEM_FONT_DIRS = process.platform === 'darwin'
  ? ['/System/Library/Fonts', '/Library/Fonts', join(homedir(), 'Library/Fonts')]
  : ['/usr/share/fonts', '/usr/local/share/fonts', join(homedir(), '.local/share/fonts'), join(homedir(), '.fonts')]

// [{path, family, weight, style}] for every readable font file under dirs (recursive)
export async function systemFonts(dirs = SYSTEM_FONT_DIRS) {
  const out = []
  for (const dir of dirs) {
    let files
    try { files = (await readdir(dir, { recursive: true })).filter((f) => FONT_RE.test(f)) } catch { continue }
    for (const f of files) {
      const path = join(dir, f)
      try {
        const { families, weight, italic } = await fontInfoFile(path)
        for (const family of families) out.push({ path, family, weight, style: italic ? 'italic' : 'normal' })
      } catch { /* not a font we can read */ }
    }
  }
  return out
}
