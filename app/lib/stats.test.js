import { test } from 'node:test'
import assert from 'node:assert/strict'
import { packSystemData, collectStats, readContract, parseNetstat, parseProcNetDev } from './stats.js'
import { V1Parser, decodeV1 } from './proto.js'

test('packSystemData: V1 cmd 1 string map the parser reads back', () => {
  const frame = packSystemData({ 'CPU Usage': '42%', 'RAM Usage': '7%' })
  const [f] = new V1Parser().push(frame)
  assert.equal(f.cmd, 1)
  assert.deepEqual(decodeV1(1, f.payload), { 'CPU Usage': '42%', 'RAM Usage': '7%' })
})

test('collectStats: only requested, measurable keys; units follow the contract', () => {
  const statfs = () => ({ blocks: 1000, bsize: 1024 ** 2, bavail: 250, bfree: 300 })
  const cpu = (busy, idle) => () => [{ times: { user: busy, nice: 0, sys: 0, irq: 0, idle } }]
  assert.deepEqual(collectStats(['CPU Usage'], { cpuList: cpu(100, 100) }), {}) // first sample: no delta yet
  const a = collectStats(['CPU Usage', 'RAM Usage', 'Disk Usage', 'GPU Usage', 'hour'], { statfs, cpuList: cpu(130, 170) })
  assert.equal(a['CPU Usage'], '30%')
  assert.deepEqual(Object.keys(a).sort(), ['CPU Usage', 'Disk Usage', 'GPU Usage', 'RAM Usage'])
  if (process.platform !== 'darwin') assert.equal(a['GPU Usage'], '0%')
  assert.match(a['RAM Usage'], /^\d+%$/)
  assert.equal(a['Disk Usage'], '75%')
  assert.equal(collectStats(['Disk Usage'], { statfs, showUnit: false })['Disk Usage'], '75')
  assert.equal(collectStats(['Disk Total Space'], { statfs })['Disk Total Space'], '1.0 GB')
})

test('readContract', () => {
  assert.deepEqual(readContract({ deviceRequestSystemData: ['CPU Usage'], deviceRequestSystemDataShowUnit: false }), { keys: ['CPU Usage'], showUnit: false })
  assert.equal(readContract({ wifiState: 1 }), null)
})

test('network counters: macOS netstat -ib and Linux /proc/net/dev', () => {
  const mac = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                       1164681     0  613372460  1164681     0  613372460     0
gif0*      1280  <Link#2>                             0     0          0        0     0          0     0
en0        1500  <Link#11>   aa:bb:cc:dd:ee:ff  100     0       5000      90     0       3000     0
en0        1500  10.0.1        10.0.1.5         100     -       5000      90     -       3000     -
utun3      1380  <Link#20>                          7     0        700       7     0        700     0
en1*       1500  <Link#12>                            1     0         10        1     0         20     0`
  assert.deepEqual(parseNetstat(mac), { rx: 5010, tx: 3020 })
  assert.equal(parseNetstat('Name Mtu'), null)
  const linux = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1055 6 0 0 0 0 0 0 1055 6 0 0 0 0 0 0
enx6c: 3000 67 0 0 0 0 0 0 900 53 0 0 0 0 0 0
docker0: 50 1 0 0 0 0 0 0 60 1 0 0 0 0 0 0`
  assert.deepEqual(parseProcNetDev(linux, (i) => i !== 'docker0'), { rx: 3000, tx: 900 })
})
