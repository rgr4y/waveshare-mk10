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
    for (const n of ['get_theme', 'get_page', 'set_key_title', 'get_asset', 'push_to_device']) assert.ok(names.includes(n), n)

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

    // guard: foreign Origin rejected
    const res = await fetch(mcp.url, { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' })
    assert.equal(res.status, 403)
  } finally {
    await client.close()
    await mcp.close()
  }
})
