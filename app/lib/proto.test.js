import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { pack, FrameParser, CMD_JSON, CMD_SHOW_JPG } from './proto.js'

const MKPROTO = new URL('../../tools', import.meta.url).pathname

function pyPack(cmd, data, id) {
  const code = 'import sys,mkproto;print(mkproto.pack(int(sys.argv[1]),bytes.fromhex(sys.argv[2]),int(sys.argv[3])).hex())'
  return Buffer.from(execFileSync('python3', ['-c', `import sys;sys.path.insert(0,${JSON.stringify(MKPROTO)})\n${code}`,
    String(cmd), data.toString('hex'), String(id)], { encoding: 'utf8' }).trim(), 'hex')
}

test('pack matches tools/mkproto.py', () => {
  for (const [cmd, data, id] of [
    [CMD_JSON, Buffer.from('{"method":"getInfo"}'), 1],
    [CMD_SHOW_JPG, Buffer.from([0xff, 0xd8, 0, 1, 2, 255]), 4242],
    [CMD_JSON, Buffer.alloc(0), 0],
  ]) {
    const js = pack(cmd, data, id)
    assert.equal(js.subarray(0, 4).toString('hex'), 'a1a55a5e')
    assert.equal(js.toString('hex'), pyPack(cmd, data, id).toString('hex'))
  }
})

test('parser: byte-at-a-time, back-to-back frames', () => {
  const a = pack(CMD_JSON, Buffer.from('one'), 1)
  const b = pack(CMD_JSON, Buffer.from('two'), 2)
  const p = new FrameParser()
  const got = []
  for (const x of Buffer.concat([a, b])) got.push(...p.push(Buffer.from([x])))
  assert.deepEqual(got.map((f) => [f.id, f.cmd, f.data.toString()]), [[1, 101, 'one'], [2, 101, 'two']])
})

test('parser: garbage prefix (incl. partial header) is skipped', () => {
  const f = pack(CMD_JSON, Buffer.from('x'), 7)
  const got = new FrameParser().push(Buffer.concat([Buffer.from([1, 2, 0xa1, 0xa5, 0x5a, 9, 9, 9]), f]))
  assert.equal(got.length, 1)
  assert.equal(got[0].id, 7)
})

test('parser: data CRC failure drops the frame and resyncs on the next', () => {
  const bad = pack(CMD_JSON, Buffer.from('bad!'), 1)
  bad[21] ^= 0xff
  const good = pack(CMD_JSON, Buffer.from('good'), 2)
  const p = new FrameParser()
  const got = p.push(Buffer.concat([bad, good]))
  assert.deepEqual(got.map((f) => f.data.toString()), ['good'])
  assert.equal(p.dropped, 1)
})

test('parser: size CRC failure resyncs', () => {
  const bad = pack(CMD_JSON, Buffer.from('bad!'), 1)
  bad[12] ^= 0x01
  const good = pack(CMD_JSON, Buffer.from('good'), 2)
  const got = new FrameParser().push(Buffer.concat([bad, good]))
  assert.deepEqual(got.map((f) => f.data.toString()), ['good'])
})
