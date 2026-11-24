// MCP server (Streamable HTTP, stateless) exposing the shared Session to LLM clients.
// Runs inside the Electron main process; tools are thin wrappers over Session.
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const LAYOUT = 'MK10 layout: main panel 896x304 px. Keys are 2 rows x 5 cols of 128 px (row 0..1, col 0..4) at x=col*128, y=row*128. '
  + 'Right 240x296 info panel at x>=656 (backgroundType "secondary"). Main background video is 640x256 (type 100, backgroundType "main"). '
  + 'Pages are indexed from 0; child pages have parentIndex.'

const page = z.number().int().min(0).describe('page index')
const row = z.number().int().min(0).max(1).describe('key row 0..1')
const col = z.number().int().min(0).max(4).describe('key col 0..4')

const ok = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] })
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e?.message ?? String(e) }] })
const wrap = (fn) => async (args) => {
  try {
    return await fn(args)
  } catch (e) {
    return fail(e)
  }
}

const isPng = (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

function buildServer(session, { log, pushOpts }) {
  const s = new McpServer({ name: 'mk10-studio', version: '0.1.0' })
  const tool = (name, description, inputSchema, fn) =>
    s.registerTool(name, { description, inputSchema }, wrap(fn))

  tool('get_theme', `Summary of the open theme: file, dirty flag, pages (index, name, parentIndex, item counts). ${LAYOUT}`, {}, () => {
    const m = session.summary()
    return ok({
      file: m.file,
      dirty: m.dirty,
      pages: m.pages?.map((p) => ({
        index: p.index,
        name: p.name,
        parentIndex: p.parentIndex,
        keys: p.items.filter((i) => i.type === '115').length,
        widgets: p.items.filter((i) => i.type !== '115').length,
      })) ?? [],
    })
  })

  tool('get_page', `Items of one page: keys (row/col/title/action/path) and widgets (type, backgroundType, geometry, systemData, text, video path). ${LAYOUT}`,
    { page }, ({ page }) => {
      const p = session.summary().pages?.[page]
      if (!p) throw new Error(session.theme ? `no page ${page}` : 'no theme open')
      return ok(p)
    })

  tool('open_theme', 'Open a .Theme file (replaces the current in-memory theme).',
    { path: z.string() }, async ({ path }) => { await session.open(path); return ok(trim(session.summary())) })

  tool('save_theme', 'Save the theme to path (default: the file it was opened from).',
    { path: z.string().optional() }, async ({ path }) => ok({ saved: await session.save(path) }))

  tool('set_key_title', `Set the title of a key. ${LAYOUT}`,
    { page, row, col, title: z.string() }, ({ page, row, col, title }) => {
      session.setKeyTitle(page, row, col, title)
      return ok({ page, row, col, title })
    })

  tool('set_key_action_field', `Change the value of one existing text field of a key's action (e.g. Url of openWeb, pageName of openPage, password of password). Only fields listed in the key's action.editable (get_page) can change; the action type and field set never change. ${LAYOUT}`,
    { page, row, col, field: z.string(), value: z.string() }, ({ page, row, col, field, value }) => {
      session.setKeyActionField(page, row, col, field, value)
      return ok({ page, row, col, field, value })
    })

  tool('set_key_image', `Set a key image from a file path (any format ffmpeg reads; cover-cropped to 128x128 PNG) or base64 PNG/JPG data. Give exactly one. ${LAYOUT}`,
    { page, row, col, imagePath: z.string().optional(), imageBase64: z.string().optional() },
    async ({ page, row, col, imagePath, imageBase64 }) => {
      if (!imagePath === !imageBase64) throw new Error('give exactly one of imagePath or imageBase64')
      let dir
      try {
        let src = imagePath
        if (imageBase64) {
          dir = await mkdtemp(join(tmpdir(), 'mk10mcp-'))
          src = join(dir, 'in.img')
          await writeFile(src, Buffer.from(imageBase64.replace(/^data:[^,]*,/, ''), 'base64'))
        }
        return ok({ asset: await session.setKeyImage(page, row, col, src) })
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true })
      }
    })

  tool('set_background_video', `Replace the main background video of a page from any video file path (ffmpeg transcodes to 640x256 h264, can take a while). ${LAYOUT}`,
    { page, videoPath: z.string() }, async ({ page, videoPath }) =>
      ok({ asset: await session.setBackgroundVideo(page, videoPath) }))

  s.registerTool('get_asset', {
    description: 'Fetch a theme asset by its path (e.g. a key image path from get_page). PNGs come back as image content; other assets return size and type only.',
    inputSchema: { path: z.string() },
  }, async ({ path }) => {
    try {
      const buf = session.asset(path)
      if (!buf) throw new Error(`no asset ${path}`)
      if (isPng(buf)) return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }] }
      return ok({ path, size: buf.length, type: extname(path).slice(1) || 'unknown' })
    } catch (e) {
      return fail(e)
    }
  })

  tool('push_to_device', 'Push the current in-memory theme to the MK10 and make it the active layout. Default is USB serial (~10 s for 12 MB: writes a new timestamped file, reloads it, prunes older mk10studio pushes); ssh mode restarts the on-device app (~10 s blank). Does not save the local file.',
    {}, async () => ok({ pushed: await session.push(typeof pushOpts === 'function' ? pushOpts() : pushOpts, log) }))

  return s
}

// open_theme result: same trim as get_theme
function trim(m) {
  return { file: m.file, dirty: m.dirty, pages: m.pages?.map((p) => ({ index: p.index, name: p.name, parentIndex: p.parentIndex, items: p.items.length })) ?? [] }
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]'])
const hostOk = (h) => { try { return LOCAL.has(new URL(`http://${h}`).hostname) } catch { return false } }
const originOk = (o) => { try { return LOCAL.has(new URL(o).hostname) } catch { return false } }

export async function startMcp(session, { port = 47110, host = '127.0.0.1', log = console.error, pushOpts } = {}) {
  const http = createServer(async (req, res) => {
    const deny = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain' }).end(msg) }
    try {
      // DNS-rebinding guard: Host and (if sent) Origin must be local. SDK's own option is deprecated.
      if (!hostOk(req.headers.host ?? '')) return deny(403, 'bad Host')
      if (req.headers.origin !== undefined && !originOk(req.headers.origin)) return deny(403, 'bad Origin')
      if (new URL(req.url, 'http://x').pathname !== '/mcp') return deny(404, 'not found')
      if (req.method !== 'POST') return deny(405, 'stateless server: POST only')
      // stateless: fresh server + transport per request
      const server = buildServer(session, { log, pushOpts })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => { transport.close(); server.close() })
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (e) {
      log(`mcp: ${e.stack ?? e}`)
      if (!res.headersSent) deny(500, 'internal error')
    }
  })
  await new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, host, resolve)
  })
  const url = `http://${host}:${http.address().port}/mcp`
  log(`mcp: listening on ${url}`)
  return {
    url,
    close: () => new Promise((resolve) => { http.close(() => resolve()); http.closeAllConnections() }),
  }
}
