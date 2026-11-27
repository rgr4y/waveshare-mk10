// Host stats for the device's info widgets (Phase 4). After a page loads the device sends a V1
// cmd 15 contract listing the widget keys it wants (deviceRequestSystemData) and whether values
// carry units (deviceRequestSystemDataShowUnit). The host answers with V1 cmd 1 maps of
// key -> string; text widgets show the string verbatim (docs/theme-format.md, Live data push).
// Key names are the vendor app's (strings in ScreenKeyMacOS; its stats come from bundled btop).
// The device fills hour/minute/date itself, so those are not sent.
import { cpus, totalmem, freemem } from 'node:os'
import { statfsSync, readFileSync, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { packV1 } from './proto.js'

export const V1_SYSTEM_DATA = 1

// V1 cmd 1 payload: u32 BE count, then per pair u32 BE byte length + UTF-16BE key, same for value
export function packSystemData(map) {
  const s = (x) => {
    const b = Buffer.from(String(x), 'utf16le').swap16()
    const n = Buffer.alloc(4)
    n.writeUInt32BE(b.length)
    return Buffer.concat([n, b])
  }
  const entries = Object.entries(map)
  const count = Buffer.alloc(4)
  count.writeUInt32BE(entries.length)
  return packV1(V1_SYSTEM_DATA, Buffer.concat([count, ...entries.flatMap(([k, v]) => [s(k), s(v)])]))
}

// every key collectStats can fill; sent until the device names the keys its page wants
export const ALL_STATS = ['CPU Usage', 'CPU Total', 'CPU Model', 'GPU Usage', 'RAM Usage', 'RAM Total Memory', 'RAM Used Memory',
  'RAM Available Memory', 'RAM Available Percent', 'Disk Total Space', 'Disk Available Space', 'Disk Free Space',
  'Disk Usage', 'Disk Available Percent', 'Download Speed', 'Upload Speed', 'Download Data', 'Upload Data']

const GB = 1024 ** 3
const gb = (n, unit) => `${(n / GB).toFixed(1)}${unit ? ' GB' : ''}`
const pct = (n, unit) => `${Math.round(n)}${unit ? '%' : ''}`

// CPU usage needs two samples; keep the previous one between calls
let lastCpu = null
function cpuUsage(list) {
  const t = list.reduce((a, c) => {
    const busy = c.times.user + c.times.nice + c.times.sys + c.times.irq
    return { busy: a.busy + busy, all: a.all + busy + c.times.idle }
  }, { busy: 0, all: 0 })
  const prev = lastCpu
  lastCpu = t
  if (!prev || t.all === prev.all) return null
  return (100 * (t.busy - prev.busy)) / (t.all - prev.all)
}

// macOS only, sampled async so collectStats stays synchronous (values are one tick behind):
// GPU busy % from the IOAccelerator's PerformanceStatistics, and used RAM the way Activity
// Monitor counts "Memory Used" (app memory + wired + compressed; vm_stat pages). Neither needs root.
let lastGpu = null
let lastUsedMem = null
export function sampleHost() {
  sampleNet()
  if (process.platform !== 'darwin') return
  execFile('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], { timeout: 2000 }, (err, out) => {
    const m = !err && /"Device Utilization %"=(\d+)/.exec(out)
    lastGpu = m ? Number(m[1]) : null
  })
  execFile('vm_stat', { timeout: 2000 }, (err, out) => {
    const page = Number(/page size of (\d+) bytes/.exec(out ?? '')?.[1])
    const n = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1])
    const used = (n('Anonymous pages') - n('Pages purgeable') + n('Pages wired down') + n('Pages occupied by compressor')) * page
    lastUsedMem = !err && used > 0 ? used : null
  })
}

// Network byte counters summed over physical interfaces: {rx, tx} or null.
// macOS `netstat -ib -n`: one <Link#N> row per interface; Ibytes/Obytes are 5th and 2nd from
// the right (the Address column can be empty). Only en* counts, so VPN tunnels (utun) don't
// double-count the traffic they carry.
export function parseNetstat(text) {
  let rx = 0
  let tx = 0
  let seen = false
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (!/^en\d+\*?$/.test(f[0] ?? '') || !line.includes('<Link#')) continue
    rx += Number(f.at(-5)) || 0
    tx += Number(f.at(-2)) || 0
    seen = true
  }
  return seen ? { rx, tx } : null
}
// Linux /proc/net/dev: rx bytes is the 1st field after "name:", tx bytes the 9th.
export function parseProcNetDev(text, isPhysical = () => true) {
  let rx = 0
  let tx = 0
  let seen = false
  for (const line of text.split('\n')) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line)
    if (!m || m[1] === 'lo' || !isPhysical(m[1])) continue
    const f = m[2].split(/\s+/).map(Number)
    rx += f[0] || 0
    tx += f[8] || 0
    seen = true
  }
  return seen ? { rx, tx } : null
}

let lastNet = null // {rx, tx, at}
let netRate = null // {rx, tx} bytes per second
function takeNet(n) {
  if (!n) return
  const at = Date.now()
  if (lastNet && at > lastNet.at) netRate = { rx: Math.max(0, (n.rx - lastNet.rx) * 1000 / (at - lastNet.at)), tx: Math.max(0, (n.tx - lastNet.tx) * 1000 / (at - lastNet.at)) }
  lastNet = { ...n, at }
}
function sampleNet() {
  if (process.platform === 'darwin') {
    execFile('netstat', ['-ib', '-n'], { timeout: 2000 }, (err, out) => { if (!err) takeNet(parseNetstat(out)) })
  } else if (process.platform === 'linux') {
    try { takeNet(parseProcNetDev(readFileSync('/proc/net/dev', 'utf8'), (i) => existsSync(`/sys/class/net/${i}/device`))) } catch { /* no network keys */ }
  }
}

const rate = (bps, unit) => {
  const [v, u] = bps >= 1024 ** 2 ? [bps / 1024 ** 2, 'MB/s'] : [bps / 1024, 'KB/s']
  return `${v.toFixed(v < 10 ? 1 : 0)}${unit ? ` ${u}` : ''}`
}

// -> {key: value} for the requested keys this host can measure. Unknown keys (temperatures: Apple
// Silicon sensors need root or private IOKit calls; fans, power, the vendor's demo keys) are left
// out; the widget keeps its last text.
// RAM: macOS uses the vm_stat figure once sampleHost has run; elsewhere os.freemem() (Linux
// MemAvailable).
export function collectStats(keys, { showUnit = true, statfs = statfsSync, cpuList = cpus } = {}) {
  const want = new Set(keys)
  const out = {}
  const put = (k, f) => { if (want.has(k)) { const v = f(); if (v != null) out[k] = v } }
  if (want.has('CPU Usage') || want.has('CPU Total')) {
    const c = cpuUsage(cpuList())
    if (c != null) { put('CPU Usage', () => pct(c, showUnit)); put('CPU Total', () => pct(c, showUnit)) }
  }
  // no reading (Linux, ioreg failed): 0 rather than leaving the widget on its "Text" placeholder
  put('GPU Usage', () => pct(lastGpu ?? 0, showUnit))
  if (netRate) {
    put('Download Speed', () => rate(netRate.rx, showUnit))
    put('Upload Speed', () => rate(netRate.tx, showUnit))
  }
  if (lastNet) {
    put('Download Data', () => gb(lastNet.rx, showUnit))
    put('Upload Data', () => gb(lastNet.tx, showUnit))
  }
  put('CPU Model', () => cpus()[0]?.model?.trim())
  const total = totalmem()
  const free = lastUsedMem != null ? total - lastUsedMem : freemem()
  put('RAM Usage', () => pct((100 * (total - free)) / total, showUnit))
  put('RAM Total Memory', () => gb(total, showUnit))
  put('RAM Used Memory', () => gb(total - free, showUnit))
  put('RAM Available Memory', () => gb(free, showUnit))
  put('RAM Available Percent', () => pct((100 * free) / total, showUnit))
  if ([...want].some((k) => k.startsWith('Disk '))) {
    let d = null
    try { d = statfs('/') } catch { /* no disk keys */ }
    if (d) {
      const size = d.blocks * d.bsize
      const avail = d.bavail * d.bsize
      put('Disk Total Space', () => gb(size, showUnit))
      put('Disk Available Space', () => gb(avail, showUnit))
      put('Disk Free Space', () => gb(d.bfree * d.bsize, showUnit))
      put('Disk Usage', () => pct((100 * (size - avail)) / size, showUnit))
      put('Disk Available Percent', () => pct((100 * avail) / size, showUnit))
    }
  }
  return out
}

// The contract from a decoded V1 cmd 15 payload, or null if it isn't one
export function readContract(payload) {
  const keys = payload?.deviceRequestSystemData
  if (!Array.isArray(keys)) return null
  return { keys: keys.map(String), showUnit: payload.deviceRequestSystemDataShowUnit !== false }
}
