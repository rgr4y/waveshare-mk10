#!/usr/bin/env node
// mk10-studio CLI. Progress/verbose goes to stderr, results to stdout. Device commands have a 60 s hard limit.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { decodeTheme, encodeTheme, pages, listKeys } from './lib/theme.js'
import { Device } from './lib/device.js'

const log = (...a) => console.error('[mk10]', ...a)
const sha = (b) => createHash('sha256').update(b).digest('hex')
const usage = `usage: node cli.js <command>
  info <theme>            pages/keys summary
  roundtrip <theme>       decode -> encode, compare sha256
  ports                   list MK10 serial ports (read-only)
  call <method> [json]    call a device method (auto-detects port; MK10_PORT overrides)
  push <local> <remote>   push a file to the device`

async function openDevice() {
  const dev = new Device()
  let path = process.env.MK10_PORT
  if (!path) {
    const found = await Device.list()
    log(`found ${found.length} MK10 port(s)`)
    if (!found.length) throw new Error('no MK10 port found')
    path = found[0].path
  }
  log('opening', path)
  await dev.open(path)
  log('open (nothing sent yet)')
  return dev
}

const cmds = {
  async info(file) {
    log('reading', file)
    const t = decodeTheme(await readFile(file))
    log(`${t.assets.size} assets, json ${t.jsonText.length} chars`)
    pages(t).forEach((p, i) => {
      const keys = listKeys(t, i)
      const n = (p.items ?? []).length
      console.log(`page ${i} ${p.pageName}${p.parentPageName ? ` (child of ${p.parentPageName})` : ''}: ${n} items, ${keys.length} keys`)
      for (const k of keys) console.log(`  [r${k.row} c${k.col}] ${JSON.stringify(k.title)}`)
    })
  },

  async roundtrip(file) {
    const raw = await readFile(file)
    log('read', raw.length, 'bytes', sha(raw))
    const out = encodeTheme(decodeTheme(raw))
    log('re-encoded', out.length, 'bytes', sha(out))
    console.log(out.equals(raw) ? 'IDENTICAL' : 'DIFFERENT')
    if (!out.equals(raw)) process.exitCode = 1
  },

  async ports() {
    const l = await Device.list()
    log(`${l.length} MK10 port(s)`)
    for (const p of l) console.log(p.path, p.vendorId, p.productId, p.serialNumber ?? '')
  },

  async call(method, json) {
    if (!method) throw new Error(usage)
    const dev = await openDevice()
    try {
      log('-->', method, json ?? '')
      const r = await dev.call(method, json ? JSON.parse(json) : undefined, { timeout: 55000 })
      console.log(JSON.stringify(r, null, 2))
    } finally {
      await dev.close()
    }
  },

  async push(local, remote) {
    if (!local || !remote) throw new Error(usage)
    const buf = await readFile(local)
    log(`pushing ${buf.length} bytes -> ${remote}`)
    const dev = await openDevice()
    try {
      const r = await dev.pushFile(buf, remote, (d, t) => log(`  ${d}/${t} (${Math.round((100 * d) / t)}%)`), { timeout: 55000 })
      console.log(JSON.stringify(r, null, 2))
    } finally {
      await dev.close()
    }
  },
}

const [name, ...args] = process.argv.slice(2)
if (!cmds[name]) {
  console.error(usage)
  process.exit(2)
}
const kill = setTimeout(() => {
  console.error('[mk10] 60 s limit hit, aborting')
  process.exit(124)
}, 60000)
kill.unref()
try {
  await cmds[name](...args)
} catch (e) {
  console.error('[mk10] error:', e.message)
  process.exitCode = 1
}
process.exit()
