import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Session } from './session.js'
import { startMcp } from './mcp.js'

const THEME = '/Applications/ScreenKeyMacOS.app/Contents/MacOS/theme/MK10/defaultTheme.Theme'

test('mcp tools over streamable http', { skip: !existsSync(THEME) && 'stock theme missing' }, async () => {
  const session = new Session()
  await session.open(THEME)
  const mcp = await startMcp(session, { port: 0, log: () => {} })
  const client = new Client({ name: 'test', version: '0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)))
    const names = (await client.listTools()).tools.map((t) => t.name)
    for (const n of ['get_theme', 'get_page', 'set_key_title', 'get_asset', 'push_to_device', 'copy_key', 'paste_key']) assert.ok(names.includes(n), n)

    const page = await client.callTool({ name: 'get_page', arguments: { page: 0 } })
    const p0 = JSON.parse(page.content[0].text)
    assert.equal(p0.index, 0)
    const key = p0.items.find((i) => i.type === '115')
    assert.ok(key)

    const r = await client.callTool({ name: 'set_key_title', arguments: { page: 0, row: key.row, col: key.col, title: 'MCP!' } })
    assert.ok(!r.isError, r.content[0].text)
    assert.equal(session.dirty, true)
    const after = session.summary().pages[0].items.find((i) => i.row === key.row && i.col === key.col)
    assert.equal(after.title, 'MCP!')

    const bad = await client.callTool({ name: 'get_page', arguments: { page: 999 } })
    assert.equal(bad.isError, true)

    const png = [...session.theme.assets.keys()].find((k) => k.endsWith('.png'))
    assert.ok(png)
    const a = await client.callTool({ name: 'get_asset', arguments: { path: png } })
    assert.equal(a.content[0].type, 'image')
    assert.equal(a.content[0].mimeType, 'image/png')

    // copy_key -> paste_key onto page 9 (no keys), then undo puts the theme back
    const before = JSON.stringify(session.theme.json)
    const c = await client.callTool({ name: 'copy_key', arguments: { page: 0, row: key.row, col: key.col } })
    const { clip } = JSON.parse(c.content[0].text)
    const pr = await client.callTool({ name: 'paste_key', arguments: { page: 9, row: 1, col: 4, clip } })
    assert.ok(!pr.isError, pr.content[0].text)
    assert.equal(session.summary().pages[9].items.find((i) => i.row === 1 && i.col === 4)?.title, 'MCP!')
    assert.ok(session.undo())
    assert.equal(JSON.stringify(session.theme.json), before)
    session.cutKey(0, key.row, key.col)
    session.setKeyTitle(0, 0, 0, 'x') // any other edit clears undo
    assert.equal(session.undo(), false)

    // unpushed: any edit since open/push; an edit during a push keeps it unpushed (device push stubbed)
    assert.equal(session.unpushed, true)
    session.pushTo = async () => { session.setKeyTitle(0, 0, 0, 'during push') }
    await session.push()
    assert.equal(session.unpushed, true)
    session.pushTo = async () => 'ok'
    await session.push()
    assert.equal(session.unpushed, false)
    await assert.rejects(Object.assign(session, { pushTo: async () => { throw new Error('no device') } }).push())
    // one push at a time; the lock is released after a failure
    let release
    session.pushTo = () => new Promise((r) => { release = r })
    const first = session.push()
    assert.equal(session.summary().pushing, true)
    await assert.rejects(session.push(), /already in progress/)
    release('ok')
    await first
    assert.equal(session.pushing, false)
    // confirm declined: nothing is written and the theme stays unpushed
    delete session.pushTo
    session.setKeyTitle(0, 0, 0, 'z')
    assert.equal(await session.push({ mode: 'serial' }, () => {}, async () => false), null)
    assert.equal(session.unpushed, true)
    session.setKeyTitle(0, 0, 0, 'y')
    assert.equal(session.unpushed, true)

    // guard: foreign Origin rejected
    const res = await fetch(mcp.url, { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' })
    assert.equal(res.status, 403)
  } finally {
    await client.close()
    await mcp.close()
  }
})
