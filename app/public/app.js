// Renderer: reads state from main via window.mk10, renders with <template> clones only.
const $ = (id) => document.getElementById(id)
const tpl = (id) => $(id).content.firstElementChild.cloneNode(true)

const ui = {
  summary: { file: null },
  page: 0,
  stateView: new Map(), // `${page},${row},${col}` -> preview state of a multi-state key
  sel: null, // {kind:'key', row, col} | {kind:'video'} | {kind:'page'} | {kind:'panel', index} (index into the page's items)
  panelZoom: false,
  assets: new Map(), // key -> Promise<{url, mime}|null>
  videoKey: null,
  dragEndAt: 0, // ms; the click that ends a key drag is ignored
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|svg)$/i
const VIDEO_RE = /\.(mp4|mov|m4v|mkv|avi|webm|gif)$/i
const BG_RE = /\.(mp4|mov|m4v|mkv|avi|webm|gif|png|jpe?g|webp|bmp|tiff?|heic)$/i // videos, or a still held as a clip
const ANY_MEDIA_RE = new RegExp(`${IMAGE_RE.source}|${VIDEO_RE.source}`, 'i')
const base = (p) => String(p).split('/').pop()

// ---- status / log
// Status toasts, stacked top right inside the canvas. A busy toast (push, transcode) is reused by the
// next status, so "Pushing…" turns into its result; others go after 3.5 s (errors 8 s); click dismisses.
const TOAST_MAX = 4
let busyToast = null
function setStatus({ msg, busy, error }) {
  if (!msg) return
  const box = $('toasts')
  let el = busyToast?.isConnected ? busyToast : null
  if (!el) {
    el = $('tpl-toast').content.firstElementChild.cloneNode(true)
    el.addEventListener('click', () => el.remove())
    box.append(el)
    while (box.children.length > TOAST_MAX) box.firstElementChild.remove()
  }
  el.textContent = msg
  el.dataset.state = error ? 'error' : busy ? 'busy' : 'idle'
  clearTimeout(el.timer)
  busyToast = busy ? el : null
  if (!busy) el.timer = setTimeout(() => el.remove(), error ? 8000 : 3500)
}

function addLog(line) {
  for (const el of [$('log'), ...($('busy').hidden ? [] : [$('busy-log')])]) {
    el.textContent += `${line}\n`
    el.scrollTop = el.scrollHeight
  }
  if ($('busy').hidden) return
  const pct = /^\s*(\d+)%$/.exec(line) // serial push progress
  if (pct) $('busy-bar').value = pct[1] / 100
}

// Push/pull progress over the main area. The panels go inert, so clicks and keys can't reach them.
function showBusy(kind) {
  const on = !!kind
  if (on && $('busy').hidden) {
    $('busy-title').textContent = kind === 'pull' ? 'Pulling from device…' : 'Pushing to device…'
    $('busy-log').textContent = ''
    $('busy-bar').removeAttribute('value') // indeterminate until a serial % line arrives
  }
  $('busy').hidden = !on
  for (const el of document.querySelectorAll('.layout > :not(#busy)')) el.inert = on
}

// errors are already shown by main's status; just swallow the rejection here
const run = (p) => Promise.resolve(p).catch((e) => setStatus({ msg: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), error: true }))

// ---- assets -> Blob URLs (cached; keys are unique per edit, so no invalidation needed)
function assetUrl(key) {
  if (!key) return Promise.resolve(null)
  if (!ui.assets.has(key)) {
    ui.assets.set(key, window.mk10.asset(key).then((a) => (a ? { url: URL.createObjectURL(new Blob([a.bytes], { type: a.mime })), mime: a.mime } : null)))
  }
  return ui.assets.get(key)
}

// A `paths` directory with frameDelays ("200,200,...") is a frame animation: play it, one delay per
// frame. Each call takes over the img; a loop stops once its img leaves the page or is refilled.
let animSeq = 0
async function fillImg(img, key, delays) {
  img.removeAttribute('src')
  const token = img.dataset.anim = String(++animSeq)
  const list = key && delays ? await window.mk10.frames(key) : []
  if (list.length < 2) {
    const a = await assetUrl(key)
    if (a && img.dataset.anim === token) img.src = a.url
    return
  }
  const urls = await Promise.all(list.map(assetUrl))
  const ds = String(delays).split(',').map(Number)
  let i = 0
  const step = () => {
    if (img.dataset.anim !== token || (i > 0 && !img.isConnected)) return
    img.src = urls[i % urls.length]?.url ?? ''
    setTimeout(step, ds[i % ds.length] || 100)
    i++
  }
  step()
}

// ---- helpers over the summary
const curPage = () => ui.summary.pages?.[ui.page]
const keyItems = (p) => (p?.items ?? []).filter((i) => i.type === '115')
const keyAt = (p, row, col) => keyItems(p).find((i) => i.row === row && i.col === col)
const videoItem = (p) => (p?.items ?? []).find((i) => i.type === '100' && i.backgroundType === 'main')

// Top-level pages are numbered 0..5 in theme order, and pageSwitch.jumpToPage uses that numbering, not
// the raw theme index (checked on the device 2026-11-25: jumpToPage 3 lands on the 4th top-level page).
// Folders are pages with a parent; a parent key's openPage action names the folder.
const topPages = () => (ui.summary.pages ?? []).filter((p) => p.parentIndex === undefined)
// The openPage key that opens folder p, with the index of the page it sits on. Usually on the parent,
// but a chain of folders ("Next 2/5" -> "Next 3/5") has it on the previous folder, so look everywhere.
function opener(p) {
  const pages = ui.summary.pages ?? []
  for (const q of [pages[p.parentIndex], ...pages].filter(Boolean)) {
    const k = keyItems(q).find((k) => k.action?.type === 'openPage' && k.action.pageName === p.name)
    if (k) return { ...k, pageIndex: q.index }
  }
  return null
}

// A multi-state key shows the image and title of its current state; Press Key steps the preview state
// (editor only, the theme keeps its State).
// A Freeze background toggle follows the device's video: state 2 (play icon) while paused.
const stateIndex = (it) => ui.stateView.get(`${ui.page},${it.row},${it.col}`)
  ?? (it.action?.mk10studioRun === 'freeze' && it.states.list.length > 1 ? Number(ui.bgPaused) : it.states.state)
// the drawn icon of a key, or of the state shown on a multi-state key (null: a plain image)
const iconOf = (k) => (k.states ? k.stateIcons?.[stateIndex(k)] ?? null : k.icon)
// image edits on a multi-state key go to the state shown in the editor
const shownState = (page, row, col) => {
  const k = keyAt(ui.summary.pages?.[page], row, col)
  return k?.states ? stateIndex(k) : undefined
}
function face(it) {
  const st = it.states?.list[stateIndex(it)]
  return st ? { ...it, path: st.path, paths: st.paths, frameDelays: st.frameDelays, title: st.title || it.title } : it
}

// "Press Key" in the editor: follow page-navigation actions (openPage, oneLevelUp, pageSwitch with
// pageSwitchMode 0). Anything else runs on the device or host, so the editor only says so.
function pressKey(page, row, col) {
  const pages = ui.summary.pages ?? []
  const key = keyAt(pages[page], row, col)
  if (key?.states && page === ui.page) {
    const n = (stateIndex(key) + 1) % key.states.list.length
    ui.stateView.set(`${page},${row},${col}`, n)
    const ks = key.states.list[n].keyString
    setStatus({ msg: `Press: state ${n + 1} of ${key.states.list.length}${ks ? ` (${ks})` : ''}, preview only` })
    return render()
  }
  const a = key?.action
  if (!a) return
  let to
  if (a.type === 'openPage') to = pages.findIndex((p) => p.name === a.pageName)
  else if (a.type === 'oneLevelUp') to = pages[page].parentIndex ?? -1
  else if (a.type === 'pageSwitch' && Number(a.pageSwitchMode) === 0) to = topPages()[Number(a.jumpToPage)]?.index ?? -1
  else return setStatus({ msg: `Press: ${a.type}${a.type === 'pageSwitch' ? ` (pageSwitchMode ${a.pageSwitchMode})` : ''} has no editor preview` })
  if (to < 0) return setStatus({ error: true, msg: `Press: ${a.type} target not found in this theme` })
  ui.page = to
  ui.sel = { kind: 'page' }
  render()
}

function pageName(p) {
  if (p.parentIndex === undefined) return `Page ${topPages().indexOf(p)}`
  return (opener(p)?.title ?? '').trim() || 'Folder'
}

function pageSummary(p) {
  const titles = keyItems(p).sort((a, b) => a.row - b.row || a.col - b.col).map((k) => (k.title ?? '').trim()).filter(Boolean)
  if (titles.length) return `${titles.slice(0, 3).join(', ')}${titles.length > 3 ? '…' : ''}`
  const n = keyItems(p).length
  return n ? `${n} key${n === 1 ? '' : 's'}` : 'no keys'
}

// ---- rendering
function renderTop() {
  const s = ui.summary
  const has = !!s.file
  $('filename').textContent = has ? s.file.split('/').pop().replace(/\.theme$/i, '') : 'No file open'
  $('filename').title = s.file ?? ''
  $('dirty').hidden = !s.dirty
  $('btn-save').disabled = !has
  $('btn-push').disabled = !has || !!s.pushing
  $('btn-pull').disabled = !!s.pushing
  showBusy(s.deviceOp)
  for (const id of ['brightness', 'volume']) $(id).disabled = !!s.pushing
  // device settings stay as they were for the push in flight
  for (const id of ['push-mode', 'ssh-host', 'serial-port', 'ssh-remote', 'btn-reboot']) $(id).disabled = !!s.pushing
  $('empty').hidden = has
  $('panel').hidden = !has
}

function renderPages() {
  const pages = ui.summary.pages ?? []
  const item = (p) => {
    const li = tpl('tpl-page')
    li.dataset.selected = String(p.index === ui.page)
    li.dataset.current = String(p.name === ui.summary.currentPage)
    li.dataset.folder = String(p.parentIndex !== undefined)
    li.querySelector('.page-label').textContent = pageName(p)
    li.querySelector('.page-sub').textContent = pageSummary(p)
    li.querySelector('.page-btn').title = `Theme page index ${p.index}${p.parentIndex !== undefined && !opener(p) ? '; no key opens this folder' : ''}`
    li.querySelector('.page-btn').addEventListener('click', () => { ui.page = p.index; ui.sel = { kind: 'page' }; render() })
    if (p.parentIndex !== undefined) {
      li.querySelector('.page-btn').addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        run(window.mk10.pageMenu(p.index))
      })
    }
    li.querySelector('.page-children').replaceChildren(...pages.filter((c) => c.parentIndex === p.index).map(item))
    return li
  }
  $('page-list').replaceChildren(...topPages().map(item))
  $('page-count').textContent = `${topPages().length} / 6`
}

// Outlined titles (see setKeyTitleOutline in lib/theme.js): draw the key's own image plus its title with
// an outline into a 128x128 PNG, laid out like the preview tile (2 px padding, line height 1.15), and
// store it as the key image. Runs whenever a shown key's drawing is stale (sig differs), so edits from
// any path (inspector, paste, MCP) get redrawn once the key is on screen.
// ponytail: underline is drawn as a plain bar; the device's own spacing may differ from the preview
const baking = new Set()
// ---- Material Design Icons in the icon dialog: search by name, alias or tag; the chosen icon is
// drawn white into a 128x128 PNG, a little low like the line-art icons so a top title fits
const MDI_MAX = 120 // results shown at once
let mdiList = null // [name, words, path] from main, loaded on first search
let mdiPick = null // the key the dialog is choosing for
async function showMdi() {
  const words = $('mdi-q').value.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) {
    $('icon-grid-mdi').replaceChildren()
    $('mdi-info').textContent = ''
    return
  }
  mdiList ??= await window.mk10.mdiIcons()
  const hits = mdiList.filter(([, w]) => words.every((q) => w.includes(q)))
  $('icon-grid-mdi').replaceChildren(...hits.slice(0, MDI_MAX).map(([name]) => {
    const li = tpl('tpl-icon-item')
    const img = li.querySelector('img')
    img.loading = 'lazy'
    img.src = `../node_modules/@mdi/svg/svg/${name}.svg`
    li.querySelector('span').textContent = name
    li.querySelector('button').addEventListener('click', () => {
      const { page, row, col, state } = mdiPick
      $('icon-dlg').close()
      run(setVectorIcon(page, row, col, { name, color: '#ffffff', outline: '#000000', width: 0 }, state))
    })
    return li
  }))
  $('mdi-info').textContent = hits.length > MDI_MAX ? `${hits.length} matches, showing ${MDI_MAX}: type more to narrow` : `${hits.length} matches`
}
// icon: { name, color, outline, width } (outline width 0-8 px, 0 = none)
async function mdiPng(d, icon) {
  const c = new OffscreenCanvas(128, 128)
  const g = c.getContext('2d')
  g.translate(26, 32) // 76 px icon, centred across, 6 px low
  g.scale(76 / 24, 76 / 24)
  const p = new Path2D(d)
  if (icon.width) {
    g.lineJoin = 'round'
    g.lineWidth = (icon.width * 2 * 24) / 76 // half of the stroke is under the fill
    g.strokeStyle = icon.outline
    g.stroke(p)
  }
  g.fillStyle = icon.color
  g.fill(p)
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())
}
// premade line-art icon tinted: icon { premade, color, outline, width }; the outline is the tinted
// shape stamped around the icon at 16 angles, width px out
async function premadePng(icon) {
  const src = await createImageBitmap(new Blob([await window.mk10.iconPng(icon.premade)], { type: 'image/png' }))
  const tint = (color) => {
    const c = new OffscreenCanvas(128, 128)
    const g = c.getContext('2d')
    g.drawImage(src, 0, 0, 128, 128)
    g.globalCompositeOperation = 'source-in'
    g.fillStyle = color
    g.fillRect(0, 0, 128, 128)
    return c
  }
  const c = new OffscreenCanvas(128, 128)
  const g = c.getContext('2d')
  if (icon.width) {
    const o = tint(icon.outline)
    for (let i = 0; i < 16; i++) g.drawImage(o, Math.cos((i * Math.PI) / 8) * icon.width, Math.sin((i * Math.PI) / 8) * icon.width)
  }
  g.drawImage(tint(icon.color), 0, 0)
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())
}
// draw a Material Design or premade icon into the key (state: a multi-state key's state)
async function setVectorIcon(page, row, col, icon, state) {
  if (icon.premade) return window.mk10.setKeyVectorIcon(page, row, col, await premadePng(icon), icon, state)
  mdiList ??= await window.mk10.mdiIcons()
  const d = mdiList.find(([n]) => n === icon.name)?.[2]
  if (!d) throw new Error(`no Material Design icon named ${icon.name}`)
  return window.mk10.setKeyVectorIcon(page, row, col, await mdiPng(d, icon), icon, state)
}

// color pickers apply while the user drags: one call at a time, and the last color always lands
function liveColor(box, send) {
  let busy = false
  let next = null
  const go = (el) => {
    if (busy) { next = el; return }
    busy = true
    run(send(el)).finally(() => {
      busy = false
      if (next) { const n = next; next = null; go(n) }
    })
  }
  box.addEventListener('input', (e) => { if (e.target.type === 'color') go(e.target) })
}

async function bakeTitle(pageIndex, it) {
  const o = it.outline
  const tp = it.titleParam ?? {}
  const sig = JSON.stringify([it.title ?? '', tp.FontFamily, tp.FontSize, tp.FontStyle, !!tp.FontUnderline, tp.TitleAlignment, tp.TitleColor, o.color, o.width, o.base])
  const id = `${pageIndex}:${it.row},${it.col}:${sig}`
  if (o.sig === sig || baking.has(id)) return
  baking.add(id)
  try {
    const c = new OffscreenCanvas(128, 128)
    const g = c.getContext('2d')
    const a = o.base && await assetUrl(o.base)
    if (a) {
      const img = await createImageBitmap(await (await fetch(a.url)).blob())
      const k = Math.min(128 / img.width, 128 / img.height) // object-fit: contain, like the tile
      g.drawImage(img, (128 - img.width * k) / 2, (128 - img.height * k) / 2, img.width * k, img.height * k)
    }
    const size = tp.FontSize ?? 21
    const font = `${/italic/i.test(tp.FontStyle ?? '') ? 'italic ' : ''}${/bold/i.test(tp.FontStyle ?? '') ? 700 : 400} ${size}px "${tp.FontFamily ?? 'Arial'}", Arial, sans-serif`
    await document.fonts.load(font, it.title || 'A').catch(() => {})
    Object.assign(g, { font, textAlign: 'center', textBaseline: 'middle', lineJoin: 'round', miterLimit: 2 })
    const lines = String(it.title ?? '').split('\n')
    const lh = size * 1.15
    const top = tp.TitleAlignment === 'middle' ? (128 - lines.length * lh) / 2 : tp.TitleAlignment === 'bottom' ? 126 - lines.length * lh : 2
    lines.forEach((line, i) => {
      const y = top + i * lh + lh / 2
      g.lineWidth = o.width * 2
      g.strokeStyle = o.color
      g.strokeText(line, 64, y)
      g.fillStyle = tp.TitleColor ?? '#ffffff'
      g.fillText(line, 64, y)
      if (tp.FontUnderline && line) {
        const w = g.measureText(line).width
        const uy = y + size * 0.45
        g.fillStyle = o.color
        g.fillRect(64 - w / 2 - o.width, uy - o.width, w + 2 * o.width, Math.max(1, size / 14) + 2 * o.width)
        g.fillStyle = tp.TitleColor ?? '#ffffff'
        g.fillRect(64 - w / 2, uy, w, Math.max(1, size / 14))
      }
    })
    const png = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())
    await window.mk10.setBakedTitle(pageIndex, it.row, it.col, png, sig)
  } finally {
    baking.delete(id)
  }
}

function renderKeys() {
  const p = curPage()
  const box = $('keys')
  const tiles = []
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 5; col++) {
      const raw = keyAt(p, row, col)
      const it = raw && face(raw)
      const el = tpl(it ? 'tpl-key' : 'tpl-empty-key')
      el.style.left = `${col * 128}px`
      el.style.top = `${row * 128}px`
      el.dataset.slot = String(row * 5 + col)
      if (it) {
        if (raw.outline) run(bakeTitle(ui.page, raw))
        el.addEventListener('pointerdown', (e) => holdToDrag(e, el))
        const tp = it.titleParam ?? {}
        const t = el.querySelector('.key-title')
        t.textContent = tp.ShowTitle === false ? '' : (it.title ?? '')
        t.dataset.align = tp.TitleAlignment ?? 'top'
        t.style.color = tp.TitleColor ?? '#fff'
        t.style.fontFamily = `"${tp.FontFamily ?? 'Arial'}", Arial, sans-serif`
        t.style.fontSize = `${tp.FontSize ?? 21}px`
        t.style.fontWeight = /bold/i.test(tp.FontStyle ?? '') ? '700' : '400'
        t.style.fontStyle = /italic/i.test(tp.FontStyle ?? '') ? 'italic' : 'normal'
        t.style.textDecoration = tp.FontUnderline ? 'underline' : 'none'
        const img = el.querySelector('.key-img')
        if (tp.ShowImage === false) img.hidden = true
        else fillImg(img, it.path || it.paths, it.path ? null : it.frameDelays)
        // an image sets the key's image (GIF counts as an image here); a video goes to the background
        wireDrop(el, ANY_MEDIA_RE, (file) => {
          if (!IMAGE_RE.test(file)) return run(window.mk10.setBackgroundVideo(ui.page, file))
          select({ kind: 'key', row, col })
          return run(window.mk10.setKeyImage(ui.page, row, col, file, raw.states ? stateIndex(raw) : undefined))
        })
      }
      // empty slots take clicks (select, right-click Paste) and cover the background video, so a video
      // dropped on one still goes to the background; the page Inspector also replaces it
      else wireDrop(el, BG_RE, (file) => run(window.mk10.setBackgroundVideo(ui.page, file)))
      // empty slots select too, so a paste has a target
      el.dataset.selected = String(ui.sel?.kind === 'key' && ui.sel.row === row && ui.sel.col === col)
      el.addEventListener('click', (e) => {
        if (Date.now() - ui.dragEndAt < 400) return // the click that ends a drag
        // double click = Press Key. detail is the OS click count, so it survives the re-render the first click causes
        if (e.detail === 2 && it) return pressKey(ui.page, row, col)
        select({ kind: 'key', row, col })
        if (!it && !cellWidgets(p, row, col).length) openNewKey(row, col)
      })
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        select({ kind: 'key', row, col })
        run(window.mk10.keyMenu(ui.page, row, col, !!it))
      })
      tiles.push(el)
    }
  }
  box.replaceChildren(...tiles)
}

// ---- press and hold a key, then drag it to another slot. Keys in the way shift toward the nearest
// free slot (iOS home-screen style, the dragged key's own slot counts); on a page with no empty slot
// the target key swaps with the dragged one. Widget cells (clock digits etc.) are never targets.
const HOLD_MS = 350
const slotRC = (i) => [Math.floor(i / 5), i % 5]

function holdToDrag(e, el) {
  if (e.button !== 0) return
  const [x0, y0] = [e.clientX, e.clientY]
  const ring = $('hold-ring')
  ring.style.left = `${x0}px`
  ring.style.top = `${y0}px`
  ring.style.setProperty('--hold-ms', `${HOLD_MS}ms`)
  ring.classList.remove('on')
  void ring.offsetWidth // restart the fill animation
  ring.classList.add('on')
  const stop = () => {
    ring.classList.remove('on')
    clearTimeout(timer)
    removeEventListener('pointermove', moved)
    removeEventListener('pointerup', stop)
  }
  const moved = (m) => { if (Math.hypot(m.clientX - x0, m.clientY - y0) > 6) stop() }
  const timer = setTimeout(() => { stop(); startDrag(el, x0, y0) }, HOLD_MS)
  addEventListener('pointermove', moved)
  addEventListener('pointerup', stop)
}

// moves [[fromSlot, toSlot], ...] for dropping the key at `from` on slot `to`
function dragPlan(from, to, occupied, fixed) {
  if (to === from || fixed.has(to)) return []
  if (!occupied.has(to)) return [[from, to]]
  const free = (i) => i >= 0 && i < 10 && i !== to && !fixed.has(i) && (i === from || !occupied.has(i))
  if (![...Array(10).keys()].some((i) => i !== from && free(i))) return [[from, to], [to, from]]
  let hole = -1
  for (let d = 1; hole < 0; d++) hole = free(to + d) ? to + d : free(to - d) ? to - d : -1 // ties go forward
  const step = hole > to ? 1 : -1
  const moves = [[from, to]]
  for (let i = to; i !== hole;) {
    let j = i + step
    while (fixed.has(j)) j += step
    moves.push([i, j])
    i = j
  }
  return moves
}

function startDrag(el, x0, y0) {
  const box = $('keys')
  const p = curPage()
  const from = Number(el.dataset.slot)
  const tiles = [...box.querySelectorAll('.key:not(.empty)')]
  const occupied = new Set(tiles.map((t) => Number(t.dataset.slot)))
  const fixed = new Set([...Array(10).keys()].filter((i) => cellWidgets(p, ...slotRC(i)).length))
  let to = from
  let moves = []
  box.dataset.dragging = 'true'
  el.dataset.lifted = 'true'
  const move = (e) => {
    const r = box.getBoundingClientRect()
    const z = r.width / 640
    el.style.transform = `translate(${(e.clientX - x0) / z}px, ${(e.clientY - y0) / z}px)`
    const col = Math.floor((e.clientX - r.left) / (128 * z))
    const row = Math.floor((e.clientY - r.top) / (128 * z))
    const t = row >= 0 && row < 2 && col >= 0 && col < 5 ? row * 5 + col : from
    if (t === to) return
    to = t
    moves = dragPlan(from, to, occupied, fixed)
    const dest = new Map(moves)
    for (const tile of tiles) {
      if (tile === el) continue
      const [r2, c2] = slotRC(dest.get(Number(tile.dataset.slot)) ?? Number(tile.dataset.slot))
      tile.style.left = `${c2 * 128}px`
      tile.style.top = `${r2 * 128}px`
    }
    for (const t2 of box.querySelectorAll('.key.empty')) t2.dataset.drop = String(moves.length > 0 && Number(t2.dataset.slot) === to)
  }
  const end = (e) => {
    removeEventListener('pointermove', move)
    removeEventListener('pointerup', end)
    removeEventListener('keydown', end, true)
    ui.dragEndAt = Date.now()
    if (e.type === 'keydown') e.preventDefault()
    const done = e.type === 'pointerup' ? moves : []
    const [row, col] = slotRC(done.length ? to : from)
    ui.sel = { kind: 'key', row, col }
    if (!done.length) return renderKeys()
    run(window.mk10.moveKeys(ui.page, done.map(([f, t]) => [...slotRC(f), ...slotRC(t)])).catch((err) => { renderKeys(); throw err }))
  }
  addEventListener('pointermove', move)
  addEventListener('pointerup', end)
  addEventListener('keydown', end, true) // any key cancels (Esc)
}

function renderBackground() {
  const v = videoItem(curPage())
  $('bg').dataset.selected = String(ui.sel?.kind === 'video')
  // where the device shows it (item x/y/w/h); a page without a video keeps the stock 640x256 slot
  const r = v ? { x: v.x ?? 0, y: v.y ?? 0, w: v.w ?? 640, h: v.h ?? 256 } : { x: 0, y: 0, w: 640, h: 256 }
  Object.assign($('bg').style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
  $('bg-none').hidden = !!v
  const video = $('bgvideo')
  const key = v?.path ?? null
  if (key === ui.videoKey) return
  ui.videoKey = key
  video.removeAttribute('src')
  video.load()
  if (!key) return
  assetUrl(key).then((a) => {
    if (a && ui.videoKey === key) { video.src = a.url; video.play().catch(() => {}) }
  })
}

const CLOCK = { hour: () => String(new Date().getHours()).padStart(2, '0'), minute: () => String(new Date().getMinutes()).padStart(2, '0'), second: () => String(new Date().getSeconds()).padStart(2, '0') }

// widgets: every item that is neither a key (115) nor the background video. backgroundType "child"
// widgets sit on the key area (x < 656) at their own x/y, e.g. clock digits or GIFs in key cells.
const widgetItems = (p) => (p?.items ?? []).filter((i) => i.type !== '115' && i.type !== '100' && i.backgroundType !== 'main')
const onKeyArea = (i) => i.backgroundType === 'child' && i.x < 656
const WIDGET_NAMES = { 111: 'clock digits', 113: 'text', 114: 'image', 101: 'ring', 109: 'ring', 102: 'bar' }
const widgetLabel = (i) => [WIDGET_NAMES[i.type] ?? `type ${i.type}`, i.systemData].filter(Boolean).join(' ')
// key-area widgets overlapping cell (row,col); items without a size count as a point at x/y
const cellWidgets = (p, row, col) => widgetItems(p).filter((i) => onKeyArea(i) &&
  i.x < col * 128 + 128 && i.x + (i.w || 1) > col * 128 && i.y < row * 128 + 128 && i.y + (i.h || 1) > row * 128)

// glyph clocks swap a digit image only when that digit changes; text clocks just set their text
// Qt 5 QFont weight (0-99, 50 normal, 75 bold) to CSS
const qtWeight = (w) => { const n = Number(w) || 50; return n <= 25 ? '300' : n <= 57 ? '400' : n <= 68 ? '600' : '700' }

function tickClock(el) {
  const v = CLOCK[el.dataset.clock]?.() ?? '--'
  if (!el.dataset.glyphs) return void (el.textContent = v)
  ;[...el.children].forEach((img, i) => {
    const ch = v[v.length - el.children.length + i] ?? '-'
    if (img.dataset.ch !== ch) { img.dataset.ch = ch; fillImg(img, `${el.dataset.glyphs}/${ch}.png`) }
  })
}
// clock widgets tick like the device's
setInterval(() => document.querySelectorAll('[data-clock]').forEach(tickClock), 1000)

function renderWidgets() {
  const all = widgetItems(curPage())
  draw($('widgets'), all.filter(onKeyArea), 0)
  draw($('secondary'), all.filter((i) => !onKeyArea(i)), 656, true)
}

// the info panel's items; the one that covers it all (type 114, 240x296 at its corner) is its background
const panelItems = (p) => (p?.items ?? []).filter((i) => i.backgroundType === 'secondary')
const isPanelBg = (i) => i.type === '114' && i.x === 656 && i.y === 0 && i.w === 240 && i.h === 296
const panelItem = (p, index) => panelItems(p).find((i) => i.index === index)
const selPanel = () => (ui.sel?.kind === 'panel' ? panelItem(curPage(), ui.sel.index) : null)

// byZ: the device draws the info panel by the numeric z field (higher on top)
function draw(box, items, dx, byZ = false) {
  // key-area widgets: approximate device z-order, images under gauges under text
  const rank = (t) => (t === '114' ? 0 : t === '113' || t === '111' ? 2 : 1)
  items.sort(byZ ? (a, b) => (Number(a.z) || 0) - (Number(b.z) || 0) : (a, b) => rank(a.type) - rank(b.type))
  box.replaceChildren(...items.map((it) => {
    let el
    if (it.type === '111') {
      // digital clock (system_data_name hour/minute/second). With paths set (displayType 1), one glyph
      // image per digit, aspect kept in a w/displayNum slot: matches the device framebuffer (2026-11-24).
      // Empty paths (displayType 0): text in text_font's family, white, digits ~0.58 h tall and centred
      // (device framebuffer, 2026-11-24: Microsoft YaHei regular, from /usr/share/fonts/msyh.ttc).
      el = tpl('tpl-sec-digits')
      el.dataset.clock = it.systemData ?? ''
      el.style.width = `${it.w ?? 128}px`
      el.style.height = `${it.h ?? 128}px`
      const n = it.digits || 2
      if (it.paths) {
        el.dataset.glyphs = it.paths
        el.replaceChildren(...Array.from({ length: n }, () => {
          const d = tpl('tpl-digit')
          d.style.width = `${(it.w ?? 128) / n}px`
          d.style.height = `${it.h ?? 128}px`
          return d
        }))
      } else {
        el.classList.add('sec-clock-text')
        const [family, , , , weight] = (it.font ?? '').split(',')
        el.style.fontFamily = `"${family || 'Microsoft YaHei'}", "PingFang SC", "Helvetica Neue", sans-serif`
        el.style.fontWeight = qtWeight(weight)
        el.style.fontSize = `${Math.round((it.h ?? 128) * 0.71)}px`
      }
      tickClock(el)
    } else if (it.type === '114') {
      el = tpl('tpl-sec-image')
      fillImg(el, it.path || it.paths, it.path ? null : it.frameDelays)
      el.style.width = `${it.w ?? 240}px`
      el.style.height = `${it.h ?? 296}px`
    } else if (it.type === '113') {
      el = tpl('tpl-sec-text')
      const clock = it.text === 'Text' ? CLOCK[it.systemData] : null
      if (clock) el.dataset.clock = it.systemData
      el.textContent = clock ? clock() : it.text === 'Text' && /usage/i.test(it.systemData ?? '') ? '--%' : (it.text ?? '')
      el.style.fontSize = clock || it.text === '：' ? '48px' : it.text === 'Text' ? '18px' : '14px'
    } else if (it.type === '109' || it.type === '101') {
      el = tpl('tpl-sec-ring')
      el.querySelector('.ring-label').textContent = it.systemData ?? ''
      if (it.radius) el.style.width = el.style.height = `${2 * it.radius * (it.scale || 1)}px`
    } else {
      el = tpl('tpl-sec-box')
      el.querySelector('.box-type').textContent = `type ${it.type}`
      el.querySelector('.box-name').textContent = it.systemData ?? it.path ?? ''
      if (it.w) el.style.width = `${it.w}px`
      if (it.h) el.style.height = `${it.h}px`
    }
    el.style.left = `${it.x - dx}px`
    el.style.top = `${it.y}px`
    el.dataset.index = it.index
    if (byZ) {
      el.style.zIndex = Number(it.z) || 0
      el.dataset.selected = String(ui.sel?.kind === 'panel' && ui.sel.index === it.index)
      el.dataset.bg = String(isPanelBg(it))
    }
    return el
  }))
}

// [key, value, editable] rows; editable fields come from the main process (existing text fields only)
// Studio's run keys are openFile actions with mk10studioRun (lib/keyactions.js); show them by what they do
const RUN_TYPE = { app: ['Run application', 'Application'], script: ['Run script', 'Script'], shortcut: ['Run Shortcut', 'Shortcut'],
  background: ['Swap background', 'Background'], freeze: ['Freeze background'] }
function actionRows(a) {
  if (!a) return [['type', '(none)']]
  const hide = new Set(['iconPath', 'parentDescription', 'AISoundControlKeyword', 'editable', 'mk10studioRun'])
  if (a.mk10studioRun === 'freeze') hide.add('path') // the key pauses the playing video; it has no file
  const edit = new Set(a.editable ?? [])
  const run = RUN_TYPE[a.mk10studioRun]
  return Object.entries(a).filter(([k, v]) => !hide.has(k) && (v !== '' || edit.has(k)))
    // keyboard_switch is a toggle: each press steps to the next state (States list below)
    .map(([k, v]) => [k, k === 'type' && run ? run[0] : k === 'type' && v === 'keyboard_switch' ? 'keyboard_switch (toggle)' : String(v), edit.has(k),
      k === 'path' && run ? run[1] : fieldLabel(a.type, k)])
}

// Shortcuts app names for Run Shortcut keys, read once (`shortcuts list`)
let shortcutNames = null
function shortcutOptions(current) {
  if (!shortcutNames) {
    shortcutNames = []
    window.mk10.shortcutNames().then((l) => { shortcutNames = l; if (ui.sel?.kind === 'key') renderInspector() })
  }
  const opts = [['', shortcutNames.length ? '(choose a Shortcut)' : '(no Shortcuts found)'], ...shortcutNames.map((n) => [n, n])]
  if (current && !shortcutNames.includes(current)) opts.push([current, `${current} (not found)`])
  return opts
}

// deviceVolumeadjustValue (type deviceVolume) -> "Adjust value"; the raw name stays in the tooltip
function fieldLabel(type, k) {
  const rest = k.toLowerCase().startsWith(type.toLowerCase()) && k.length > type.length ? k.slice(type.length) : k
  const words = rest.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return (words[0].toUpperCase() + words.slice(1)).replace(/\burl\b/gi, 'URL')
}

// openPage.pageName is a page's UUID: pick it from the page list instead (labels as in the sidebar)
function pageOptions(current) {
  const pages = ui.summary.pages ?? []
  // sidebar order: each top-level page, then its folders (depth-first)
  const tree = (p, trail) => [[p.name, `${trail}${pageName(p)} (${pageSummary(p)})`],
    ...pages.filter((c) => c.parentIndex === p.index).flatMap((c) => tree(c, `${trail}${pageName(p)} › `))]
  const opts = topPages().flatMap((p) => tree(p, ''))
  if (current && !opts.some(([v]) => v === current)) opts.unshift([current, `missing page ${current}`])
  return opts
}

// pageSwitch.jumpToPage: top-level page number 0..n-1 (see topPages)
function jumpOptions(current) {
  const opts = topPages().map((p, i) => [String(i), `${i} · ${pageName(p)} (${pageSummary(p)})`])
  if (!opts.some(([v]) => v === String(current))) opts.unshift([String(current), `${current} (no such page)`])
  return opts
}

function fillKv(dl, rows, onEdit, choices = {}) {
  // keep a field the user is typing in: don't rebuild under an active input
  if (dl.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return
  dl.replaceChildren(...rows.map(([k, v, editable, label]) => {
    const pick = editable && onEdit && choices[k]
    const r = tpl(pick ? 'tpl-kv-select' : editable && onEdit ? 'tpl-kv-edit' : 'tpl-kv')
    r.querySelector('dt').textContent = label ?? k
    if (label) r.querySelector('dt').title = k
    const input = r.querySelector('input, select')
    if (pick) {
      input.replaceChildren(...choices[k](v).map(([val, text]) => {
        const o = tpl('tpl-option')
        o.value = val
        o.textContent = text
        return o
      }))
    }
    if (input) {
      input.value = v
      input.dataset.field = k
      input.addEventListener('change', () => onEdit(k, input.value))
    } else r.querySelector('dd').textContent = v
    return r
  }))
}

function renderPageInspector(p) {
  const pages = ui.summary.pages
  const folder = p.parentIndex !== undefined
  const k = folder ? opener(p) : null
  $('pg-title').textContent = pageName(p)
  $('pg-name-field').hidden = !folder
  $('pg-name').disabled = !k
  $('pg-name').placeholder = k ? '' : 'No key opens this folder'
  if (document.activeElement !== $('pg-name')) $('pg-name').value = k ? (k.title ?? '') : ''
  fillKv($('pg-info'), [
    ['kind', folder ? `folder in ${pageName(pages[p.parentIndex])}` : 'top-level page'],
    ...(folder ? [['opened by', k ? `key "${(k.title ?? '').trim()}" on ${pageName(pages[k.pageIndex])}, row ${k.row} col ${k.col}` : 'no key']] : []),
    ...(folder ? [] : [['folders', String(pages.filter((c) => c.parentIndex === p.index).length)]]),
    ['keys', String(keyItems(p).length)],
    ['shown at start', p.name === ui.summary.currentPage ? 'yes' : 'no'],
    ['theme index', String(p.index)],
  ])
  const vid = videoItem(p)
  fillKv($('pg-video'), [['video', vid ? base(vid.path ?? '(none)') : 'none: this page has no video slot'], ['on device', ui.bgPaused ? 'paused' : 'playing']])
  $('btn-pg-video').hidden = !vid
  const img = (p.items ?? []).find((i) => i.type === '114' && i.backgroundType === 'secondary')
  fillKv($('pg-panel'), [['image', img ? base(img.path || img.paths || '(none)') : 'none']])
  loadPageRaw()
}

// pretty JSON, but one line per controlData field: ["jumpToPage", {"type":2,"null":0,"value":1}]
const rawText = (raw) => `{\n${Object.entries(raw).map(([k, v]) => `  ${JSON.stringify(k)}: ${k === 'controlData' && Array.isArray(v)
  ? `[\n${v.map((f) => `    ${JSON.stringify(f)}`).join(',\n')}\n  ]`
  : JSON.stringify(v, null, 2).replace(/\n/g, '\n  ')}`).join(',\n')}\n}`

// page JSON: same layout, each item indented inside "items"
const pageText = (raw) => `{\n${Object.entries(raw).map(([k, v]) => k === 'items' && Array.isArray(v)
  ? `  "items": [\n${v.map((it) => `    ${rawText(it).replace(/\n/g, '\n    ')}`).join(',\n')}\n  ]`
  : `  ${JSON.stringify(k)}: ${JSON.stringify(v, null, 2).replace(/\n/g, '\n  ')}`).join(',\n')}\n}`

async function loadPageRaw() {
  const page = ui.page
  const raw = await window.mk10.pageRaw(page).catch(() => null)
  if (ui.page !== page || ui.sel?.kind !== 'page') return
  $('page-json').value = raw ? pageText(raw) : ''
}

async function loadRaw() {
  const ta = $('raw-json')
  const sel = ui.sel
  const raw = await window.mk10.keyRaw(ui.page, sel.row, sel.col).catch(() => null)
  if (ui.sel !== sel) return // selection moved on while loading
  ta.value = raw ? rawText(raw) : ''
}

// Monaco (AMD build, node_modules/monaco-editor/min) loads on first use: ~17 MB, the app starts without it.
// ponytail: AMD is deprecated upstream; move to the ESM build if a bundler ever joins the project.
let monacoP = null
const loadMonaco = () => (monacoP ??= new Promise((resolve, reject) => {
  window.require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } })
  window.require(['vs/editor/editor.main'], () => resolve(window.monaco), (e) => { monacoP = null; reject(e) })
}))

// ---- new-key palette: click an empty slot, filter the action types, Enter adds the key
const palette = { types: [], shown: [], at: 0, row: 0, col: 0, page: 0 }
async function openNewKey(row, col) {
  const dlg = $('new-key-dlg')
  if (dlg.open) return
  palette.types = await window.mk10.newKeyTypes(ui.page).catch(() => [])
  Object.assign(palette, { row, col, page: ui.page })
  $('new-key-slot').textContent = `r${row} c${col} · ${pageName(curPage())}`
  $('new-key-q').value = ''
  filterNewKey()
  dlg.showModal()
}
const labelHits = (t, words) => words.filter((w) => t.label.toLowerCase().includes(w)).length
function filterNewKey() {
  const words = $('new-key-q').value.toLowerCase().split(/\s+/).filter(Boolean)
  palette.shown = palette.types.filter((t) => {
    const hay = `${t.label} ${t.group} ${t.type}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  }).sort((a, b) => labelHits(b, words) - labelHits(a, words)) // label matches first; sort is stable
  palette.at = 0
  $('new-key-list').replaceChildren(...palette.shown.map((t, i) => {
    const li = tpl('tpl-palette-item')
    li.querySelector('.pal-label').textContent = t.label
    li.querySelector('.pal-group').textContent = t.group
    li.addEventListener('click', () => pickNewKey(i))
    li.addEventListener('mousemove', () => { if (palette.at !== i) { palette.at = i; markNewKey() } })
    return li
  }))
  markNewKey()
}
function markNewKey() {
  ;[...$('new-key-list').children].forEach((li, i) => li.setAttribute('aria-selected', String(i === palette.at)))
  $('new-key-list').children[palette.at]?.scrollIntoView({ block: 'nearest' })
}
function pickNewKey(i = palette.at) {
  const t = palette.shown[i]
  if (!t) return
  $('new-key-dlg').close()
  run(window.mk10.createKey(palette.page, palette.row, palette.col, t.type))
}

let rawEd = null
// what: 'key' (the selected key) or 'page' (the whole current page)
async function openRawEditor(what = 'key') {
  const sel = ui.sel
  if ((what === 'key' && sel?.kind !== 'key') || $('raw-dlg').open) return
  const page = ui.page
  const raw = await (what === 'page' ? window.mk10.pageRaw(page) : window.mk10.keyRaw(page, sel.row, sel.col)).catch(() => null)
  if (!raw) return
  const monaco = await loadMonaco()
  const dlg = $('raw-dlg')
  dlg.dataset.what = what
  $('raw-dlg-what').textContent = what === 'page' ? 'Page' : 'Key'
  $('raw-dlg-key').textContent = what === 'page' ? pageName(curPage()) : `r${sel.row} c${sel.col} · ${pageName(curPage())}`
  $('raw-dlg-err').hidden = true
  dlg.dataset.page = page
  dlg.dataset.row = sel.row
  dlg.dataset.col = sel.col
  dlg.showModal()
  if (!rawEd) {
    rawEd = monaco.editor.create($('raw-editor'), {
      language: 'json', theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false },
      fontSize: 12, tabSize: 2, scrollBeyondLastLine: false, wordWrap: 'off', fixedOverflowWidgets: true,
    })
    rawEd.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, applyRawEditor)
    rawEd.onDidChangeModelContent(() => { $('raw-dlg-err').hidden = true })
  }
  rawEd.setValue(what === 'page' ? pageText(raw) : rawText(raw))
  rawEd.setScrollPosition({ scrollTop: 0 })
  rawEd.focus()
}

async function applyRawEditor() {
  const dlg = $('raw-dlg')
  const err = $('raw-dlg-err')
  let raw
  try {
    raw = JSON.parse(rawEd.getValue())
  } catch (e) {
    err.textContent = e.message
    err.hidden = false
    return
  }
  try {
    if (dlg.dataset.what === 'page') await window.mk10.setPageRaw(Number(dlg.dataset.page), raw)
    else await window.mk10.setKeyRaw(Number(dlg.dataset.page), Number(dlg.dataset.row), Number(dlg.dataset.col), raw)
  } catch (e) {
    err.textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    err.hidden = false // the text stays for fixing
    return
  }
  dlg.close()
  if (dlg.dataset.what === 'page') loadPageRaw()
  else loadRaw()
}

function renderPanelInspector(it) {
  const bg = isPanelBg(it)
  $('panel-title').textContent = bg ? 'Panel background' : (WIDGET_NAMES[it.type] ?? `type ${it.type}`)
  for (const [id, v] of [['panel-x', it.x - 656], ['panel-y', it.y]]) {
    const el = $(id)
    el.disabled = bg
    if (el !== document.activeElement) el.value = v
  }
  const info = [['data name', it.systemData || '(none)']]
  if (it.type === '113') info.push(['text', it.flag === '1' ? 'live value' : (it.text ?? '')])
  $('panel-info').replaceChildren(...info.flatMap(([k, v]) => {
    const dt = document.createElement('dt')
    const dd = document.createElement('dd')
    dt.textContent = k
    dd.textContent = v
    return [dt, dd]
  }))
  $('panel-arc-hint').hidden = it.type !== '109'
}

function renderInspector() {
  const p = curPage()
  const sel = ui.sel
  const key = sel?.kind === 'key' ? keyAt(p, sel.row, sel.col) : null
  const vid = sel?.kind === 'video' ? videoItem(p) : null
  const pg = sel?.kind === 'page' ? p : null
  const pan = selPanel()
  $('panel-bar').dataset.on = String(!!pan)
  $('insp-none').hidden = !!(key || vid || pg || pan)
  $('insp-panel').hidden = !pan
  if (pan) renderPanelInspector(pan)
  const under = sel?.kind === 'key' && !key ? cellWidgets(p, sel.row, sel.col) : []
  $('insp-hint').textContent = under.length ? `No key here, but not empty: ${under.map(widgetLabel).join(', ')}. Paste is blocked on this cell.`
    : sel?.kind === 'key' ? 'Empty slot. Paste a key here (Cmd+V or right-click). The background video is in the page Inspector (click the page).' : 'Click a page or a key.'
  $('insp-key').hidden = !key
  if (!key) $('insp-raw').hidden = true
  $('insp-video').hidden = !vid
  $('insp-page').hidden = !pg
  if (pg) renderPageInspector(pg)
  if (key) {
    $('key-pos').textContent = `${pageName(p)} · row ${sel.row} col ${sel.col}`
    if (document.activeElement !== $('key-title')) $('key-title').value = key.title ?? ''
    const tp = key.titleParam ?? {}
    for (const el of $('key-title-style').querySelectorAll('[data-tp]')) {
      if (el === document.activeElement) continue
      const v = tp[el.dataset.tp]
      if (el.id === 'tp-family') { fillFontSelect(v); continue }
      if (el.type === 'checkbox') el.checked = v !== false
      else el.value = v ?? ''
    }
    // outlined title: Studio draws it into the image, so the Title / Image switches are fixed while on
    const ol = key.outline
    const still = !(key.states || key.paths || key.frameDelays)
    $('tp-outline').hidden = !still && !ol
    for (const el of $('tp-outline').querySelectorAll('[data-ol]')) {
      if (el !== document.activeElement) el.value = el.dataset.ol === 'width' ? (ol?.width ?? 0) : (ol?.color ?? '#000000')
    }
    for (const k of ['ShowTitle', 'ShowImage']) document.querySelector(`[data-tp=${k}]`).closest('label').hidden = !!ol
    const ic = iconOf(key) // an icon Studio draws (MDI or premade), so its colors stay editable
    $('key-icon-style').hidden = !ic
    if (ic) for (const el of $('key-icon-style').querySelectorAll('[data-ic]')) if (el !== document.activeElement) el.value = ic[el.dataset.ic]
    const f = face(key)
    fillImg($('key-thumb'), f.path || f.paths, f.path ? null : f.frameDelays)
    $('key-states-grp').hidden = !key.states
    // a multi-state key: the buttons set the image of the state shown (Press Key / double-click steps it)
    $('btn-key-image').title = key.states ? `Replace state ${stateIndex(key) + 1} image…` : 'Replace image…'
    $('btn-key-icon').textContent = key.states ? `State ${stateIndex(key) + 1} icon…` : 'Choose icon…'
    $('key-sound').textContent = key.sound ? base(key.sound) : 'none'
    $('key-sound').title = key.sound ?? ''
    $('btn-key-sound-play').hidden = $('btn-key-sound-clear').hidden = !key.sound
    if (key.states) {
      const cur = stateIndex(key)
      fillKv($('key-states'), key.states.list.map((s, i) => [`state ${i + 1}${i === cur ? ' (shown)' : ''}`, `${s.keyString ?? ''} · keycode ${s.keycode}`]))
    }
    // every key: even the "complete" forms miss item fields (soundFile, opacity, titleParam, ...)
    $('insp-raw').hidden = false
    loadRaw()
    renderMacro(key)
    fillKv($('key-action'), actionRows(key.action), (field, value) =>
      run(window.mk10.setKeyActionField(ui.page, sel.row, sel.col, field, value)),
    key.action?.type === 'openPage' ? { pageName: pageOptions } : key.action?.type === 'pageSwitch' ? { jumpToPage: jumpOptions }
      : key.action?.mk10studioRun === 'shortcut' ? { path: shortcutOptions } : {})
    $('btn-run-pick').hidden = !['app', 'script', 'background'].includes(key.action?.mk10studioRun)
    $('btn-run-pick').textContent = { app: 'Choose application…', background: 'Choose image or video…' }[key.action?.mk10studioRun] ?? 'Choose script…'
  }
  if (vid) {
    fillKv($('video-info'), [['asset', base(vid.path ?? '(none)')], ['stream', '640 × 256, scaled to the box below']])
    const r = { x: vid.x ?? 0, y: vid.y ?? 0, w: vid.w ?? 640, h: vid.h ?? 256 }
    for (const el of $('video-rect').querySelectorAll('[data-vr]')) if (el !== document.activeElement) el.value = r[el.dataset.vr]
  }
  if (!key) stopListening()
}

// ---- macro editor (keyboard, qmk_string and action-flow keys; lib/macro.js). Every edit writes the
// whole step list; one tap or one text saves as a plain action, more steps as an action flow.
// A fresh key's empty template step (keycode 0, no text) counts as no step.
const macro = { steps: [], key: null, listen: null } // listen: {mode:'rec'|'one', at, ...}
const realSteps = (m) => (m && !m.error ? m.filter((s) => !(s.type === 'keyboard' && !s.keycode) && !(s.type === 'qmk_string' && !s.text)) : [])
const saveMacro = (steps) => {
  const prev = macro.steps
  macro.steps = steps
  if (!steps.length) return renderMacroSteps() // nothing to save until there is a step
  const plain = steps.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'label')))
  // refused (e.g. a move that splits a repeat): show the saved steps again
  return run(window.mk10.setKeyMacro(ui.page, ui.sel.row, ui.sel.col, plain).catch((e) => {
    macro.steps = prev
    renderMacroSteps()
    throw e
  }))
}

function renderMacro(key) {
  const on = !!key.macro
  $('key-macro').hidden = !on
  $('key-action-grp').hidden = on
  if (!on) return
  const id = `${ui.page},${ui.sel.row},${ui.sel.col}`
  if (macro.key !== id) stopListening()
  macro.key = id
  if (key.macro.error) { $('macro-hint').textContent = `Can't read this macro: ${key.macro.error}`; return }
  if (!macro.listen) macro.steps = realSteps(key.macro)
  renderMacroSteps()
}

function renderMacroSteps() {
  const list = $('macro-steps')
  if (list.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return
  let depth = 0
  const kinds = macro.steps.length > 1 ? 'action flow' : macro.steps.length ? 'single action' : 'empty: add or record steps'
  $('macro-kind').textContent = `(${kinds})`
  list.replaceChildren(...macro.steps.map((s, i) => {
    if (s.type === 'stopLoop') depth = Math.max(0, depth - 1)
    const li = tpl('tpl-macro-step')
    li.style.setProperty('--depth', depth)
    if (s.type === 'startLoop') depth++
    li.dataset.i = i
    li.querySelector('.ms-n').textContent = i + 1
    const known = ['keyboard', 'qmk_string', 'delay', 'startLoop', 'stopLoop'].includes(s.type)
    const ed = tpl(known ? `tpl-ms-${s.type}` : 'tpl-ms-other')
    if (s.type === 'keyboard') {
      ed.querySelector('.ms-keytype').value = String(s.keyType)
      const b = ed.querySelector('.ms-key')
      b.textContent = s.label ?? `keycode ${s.keycode}`
      b.classList.toggle('listening', macro.listen?.mode === 'one' && macro.listen.index === i)
    } else if (s.type === 'qmk_string') ed.querySelector('.ms-text').value = s.text
    else if (s.type === 'delay') ed.querySelector('.ms-ms').value = s.ms
    else if (s.type === 'startLoop') ed.querySelector('.ms-count').value = s.count
    else if (!known) ed.textContent = `${s.type} (made in the vendor app; kept as is)`
    li.querySelector('.ms-edit').append(ed)
    return li
  }))
  $('btn-macro-rec').textContent = macro.listen?.mode === 'rec' ? 'Stop recording' : 'Record keys'
  $('btn-macro-rec').classList.toggle('recording', macro.listen?.mode === 'rec')
  if (macro.listen?.mode === 'rec') list.scrollTop = list.scrollHeight
}

function listen(l) {
  macro.listen = { ...l, at: performance.now(), from: macro.steps.length }
  run(window.mk10.macroRecord(true))
  renderMacroSteps()
}
function stopListening() {
  const l = macro.listen
  if (!l) return
  macro.listen = null
  // release keys still down: after a Cmd/Ctrl combo the Cmd keyUp can be lost (Electron drops the
  // keyUps of a prevented keyDown), and a macro that ends with a key held leaves it held on the host
  if (l.mode === 'rec') {
    const held = new Map()
    for (const st of macro.steps.slice(l.from)) {
      if (st.type !== 'keyboard') continue
      if (st.keyType === 1) held.set(st.keycode, st)
      else if (st.keyType === 2) held.delete(st.keycode)
    }
    if (held.size) saveMacro([...macro.steps, ...[...held.values()].reverse().map((st) => ({ type: 'keyboard', keycode: st.keycode, keyType: 2, label: st.label }))])
  }
  run(window.mk10.macroRecord(false))
  if ($('key-macro').hidden === false) renderMacroSteps()
}

// a key event from main while listening: {down, code, label, combo} or {unknown}
function onMacroKey(k) {
  const l = macro.listen
  if (!l) return
  if (k.unknown) return setStatus({ msg: `${k.unknown}: no keycode for this key; add it another way`, error: true })
  if (l.mode === 'one') {
    // one tap of the key plus the modifiers held with it; a modifier alone counts on its release
    if (k.down) {
      if (!/^[LR] (Ctrl|Shift|Alt|Win)$/.test(k.label)) l.pick = k.combo ?? { code: k.code, label: k.label }
      else l.mod = { code: k.code, label: k.label }
      return
    }
    const pick = l.pick ?? l.mod
    if (!pick) return
    const step = { type: 'keyboard', keycode: pick.code, keyType: 0, label: pick.label }
    const steps = [...macro.steps]
    if (l.index === undefined) steps.push(step)
    else steps[l.index] = { ...steps[l.index], keycode: pick.code, label: pick.label }
    stopListening()
    return saveMacro(steps)
  }
  // recording: every down and up in order, pauses as delays when "With timing" is on;
  // a down straight followed by its up (no pause step between) folds into one tap
  const now = performance.now()
  const steps = [...macro.steps]
  const gap = Math.round((now - l.at) / 10) * 10
  l.at = now
  if ($('macro-timing').checked && l.started && gap > 0) steps.push({ type: 'delay', ms: gap })
  l.started = true
  const last = steps.at(-1)
  if (!k.down && last?.type === 'keyboard' && last.keyType === 1 && last.keycode === k.code) last.keyType = 0
  else steps.push({ type: 'keyboard', keycode: k.code, keyType: k.down ? 1 : 2, label: k.label })
  saveMacro(steps)
}

// background video box: fields edit x/y/w/h; with Keep 5:2 a width change sets the height and back
function wireVideoRect() {
  const vr = (k) => document.querySelector(`[data-vr=${k}]`)
  const save = (r) => run(window.mk10.setVideoRect(ui.page, r).catch((e) => { renderInspector(); throw e }))
  $('video-rect').addEventListener('change', (e) => {
    const r = Object.fromEntries(['x', 'y', 'w', 'h'].map((k) => [k, Math.round(Number(vr(k).value))]))
    if ($('video-aspect').checked && e.target.dataset.vr === 'w') r.h = Math.round(r.w / 2.5)
    if ($('video-aspect').checked && e.target.dataset.vr === 'h') r.w = Math.round(r.h * 2.5)
    save(r)
  })
  $('btn-video-reset').addEventListener('click', () => save({ x: 0, y: 0, w: 640, h: 256 }))
}

function wireMacro() {
  window.mk10.onMacroKey(onMacroKey)
  // while recording, keys go only to the recorder (main forwards them); the page never acts on them
  const swallow = (e) => { if (macro.listen) { e.preventDefault(); e.stopImmediatePropagation() } }
  window.addEventListener('keydown', swallow, true)
  window.addEventListener('keyup', swallow, true)
  $('btn-macro-rec').addEventListener('click', () => (macro.listen?.mode === 'rec' ? stopListening() : listen({ mode: 'rec' })))
  window.addEventListener('blur', stopListening)
  $('key-macro').addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]')?.dataset.add
    if (add === 'key') return listen({ mode: 'one' })
    if (add) {
      stopListening()
      const more = { text: [{ type: 'qmk_string', text: 'text' }], delay: [{ type: 'delay', ms: 100 }], loop: [{ type: 'startLoop', count: 2 }, { type: 'stopLoop' }] }[add]
      return saveMacro([...macro.steps, ...more])
    }
    const li = e.target.closest('.macro-step')
    if (!li) return
    const i = Number(li.dataset.i)
    if (e.target.closest('.ms-key')) return listen({ mode: 'one', index: i })
    const steps = [...macro.steps]
    if (e.target.closest('[data-del]')) {
      if (steps.length === 1) return setStatus({ msg: 'A macro needs at least one step: change this one instead', error: true })
      steps.splice(i, 1)
      return saveMacro(steps)
    }
    const mv = Number(e.target.closest('[data-mv]')?.dataset.mv)
    if (mv && steps[i + mv]) {
      ;[steps[i], steps[i + mv]] = [steps[i + mv], steps[i]]
      return saveMacro(steps)
    }
  })
  $('key-macro').addEventListener('change', (e) => {
    const li = e.target.closest('.macro-step')
    if (!li) return
    const i = Number(li.dataset.i)
    const s = { ...macro.steps[i] }
    const n = Number(e.target.value)
    if (e.target.matches('.ms-keytype')) s.keyType = n
    else if (e.target.matches('.ms-text')) s.text = e.target.value
    else if (e.target.matches('.ms-ms')) s.ms = Math.round(n)
    else if (e.target.matches('.ms-count')) s.count = Math.round(n)
    else return
    saveMacro(macro.steps.with(i, s))
  })
}

function render() {
  renderTop()
  if (!ui.summary.file) return
  // a delete, undo or page change can leave the selection pointing at nothing
  if (ui.sel?.kind === 'panel' && !selPanel()) ui.sel = { kind: 'page' }
  renderPages()
  renderKeys()
  renderBackground()
  renderWidgets()
  renderInspector()
  fit()
}

function select(sel) {
  ui.sel = sel
  renderKeys()
  renderBackground()
  renderWidgets()
  renderInspector()
}

// scale the 896x304 panel to the stage
function fit() {
  const st = $('stage')
  st.dataset.zoom = String(ui.panelZoom)
  // zoomed: the 296 px info panel fills the stage height and the stage scrolls sideways
  const z = ui.panelZoom ? Math.min((st.clientHeight - 80) / 304, 4) : Math.min((st.clientWidth - 40) / 896, (st.clientHeight - 80) / 304, 2)
  $('panel').style.zoom = String(Math.max(z, 0.3))
}

// ---- info panel: select, drag, nudge, align
const panelZoomOf = () => parseFloat($('panel').style.zoom) || 1
let panelSnap = true
let panelGrid = 8
const snapTo = (v, e) => (panelSnap && !e?.altKey ? Math.round(v / panelGrid) * panelGrid : v)

// box in canvas coords; text uses its measured size
function panelBox(index) {
  const el = $('secondary').querySelector(`[data-index="${index}"]`)
  return el && { x: el.offsetLeft + 656, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }
}

function wirePanel() {
  const box = $('secondary')
  let drag = null
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const el = e.target.closest('.sec')
    const index = el ? Number(el.dataset.index) : null
    const it = el ? panelItem(curPage(), index) : panelItems(curPage()).find(isPanelBg)
    // empty area: the background item when there is one, else the page
    if (!el || isPanelBg(it ?? {})) {
      select(it ? { kind: 'panel', index: it.index } : { kind: 'page' })
      return
    }
    if (ui.sel?.kind !== 'panel' || ui.sel.index !== index) select({ kind: 'panel', index })
    const cur = box.querySelector(`[data-index="${index}"]`)
    box.setPointerCapture(e.pointerId)
    drag = { index, x0: e.clientX, y0: e.clientY, px: cur.offsetLeft, py: cur.offsetTop, moved: false }
  })
  box.addEventListener('pointermove', (e) => {
    if (!drag) return
    const z = panelZoomOf()
    const dx = (e.clientX - drag.x0) / z
    const dy = (e.clientY - drag.y0) / z
    if (!drag.moved && Math.hypot(dx, dy) < 2) return // a click is not a move
    if (!drag.moved) { drag.moved = true; run(window.mk10.panelBegin()) } // one undo snapshot per drag
    drag.nx = snapTo(drag.px + dx, e)
    drag.ny = snapTo(drag.py + dy, e)
    const el = box.querySelector(`[data-index="${drag.index}"]`)
    if (el) { el.style.left = `${drag.nx}px`; el.style.top = `${drag.ny}px` }
  })
  const end = (e) => {
    const d = drag
    drag = null
    if (!d?.moved) return
    if (e.type === 'pointercancel') return render() // snap the element back
    run(window.mk10.panelMove(ui.page, d.index, 656 + Math.round(d.nx), Math.round(d.ny), { snapshot: false }))
  }
  box.addEventListener('pointerup', end)
  box.addEventListener('pointercancel', end)

  // align bar
  $('panel-bar').addEventListener('click', (e) => {
    const b = e.target.closest('button')
    const index = ui.sel?.index
    if (!b || ui.sel?.kind !== 'panel' || isPanelBg(selPanel())) return
    if (b.dataset.z) return void run(window.mk10.panelZ(ui.page, index, b.dataset.z))
    const r = panelBox(index)
    if (r) run(window.mk10.panelAlign(ui.page, index, b.dataset.align, { w: r.w, h: r.h }))
  })
  try { panelSnap = localStorage.getItem('panelSnap') !== 'false' } catch { /* storage unavailable: default on */ }
  try { panelGrid = Math.min(40, Math.max(2, Number(localStorage.getItem('panelGrid')) || 8)) } catch { /* default 8 */ }
  $('panel-snap').checked = panelSnap
  $('panel-grid').value = panelGrid
  $('panel-snap').addEventListener('change', (e) => {
    panelSnap = e.target.checked
    try { localStorage.setItem('panelSnap', String(panelSnap)) } catch { /* not persisted */ }
  })
  $('panel-grid').addEventListener('change', (e) => {
    panelGrid = Math.min(40, Math.max(2, Math.round(Number(e.target.value)) || 8))
    e.target.value = panelGrid
    try { localStorage.setItem('panelGrid', String(panelGrid)) } catch { /* not persisted */ }
  })
  $('panel-zoom').addEventListener('change', (e) => {
    ui.panelZoom = e.target.checked
    fit()
    $('stage').scrollLeft = ui.panelZoom ? 656 * panelZoomOf() : 0 // canvas x 656 into view
  })

  // inspector
  for (const [id, axis] of [['panel-x', 'x'], ['panel-y', 'y']]) {
    $(id).addEventListener('change', (e) => {
      const it = selPanel()
      const v = Math.round(Number(e.target.value))
      if (!it || e.target.value === '' || Number.isNaN(v)) return renderInspector()
      run(window.mk10.panelMove(ui.page, it.index, axis === 'x' ? 656 + v : it.x, axis === 'y' ? v : it.y))
    })
  }
  $('btn-panel-delete').addEventListener('click', () => deletePanelSel())
}

function deletePanelSel() {
  const it = selPanel()
  if (!it) return
  run(window.mk10.panelDelete(ui.page, it.index))
  select({ kind: 'page' })
}

// arrows: 1 px, Shift 10 px, snap on = one grid step. Rapid presses share one undo snapshot.
let nudge = { at: 0, x: 0, y: 0 }
function nudgePanel(e) {
  const it = selPanel()
  if (!it || isPanelBg(it)) return
  const fresh = Date.now() - nudge.at > 600
  if (fresh) {
    run(window.mk10.panelBegin())
    nudge = { at: 0, x: it.x - 656, y: it.y } // the summary lags the last nudge, so a burst tracks its own position
  }
  nudge.at = Date.now()
  const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1
  const step = (v) => {
    if (e.shiftKey) return v + dir * 10
    if (!panelSnap) return v + dir
    return (dir > 0 ? Math.floor(v / panelGrid) + 1 : Math.ceil(v / panelGrid) - 1) * panelGrid
  }
  if (e.key.endsWith('Left') || e.key.endsWith('Right')) nudge.x = step(nudge.x)
  else nudge.y = step(nudge.y)
  run(window.mk10.panelMove(ui.page, it.index, 656 + nudge.x, nudge.y, { snapshot: false }))
}

// ---- drag & drop (files only; path resolved in preload)
function wireDrop(el, re, handler) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.dataset.drop = 'true' })
  el.addEventListener('dragleave', () => { el.dataset.drop = 'false' })
  el.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
    el.dataset.drop = 'false'
    const f = e.dataTransfer.files[0]
    if (!f) return
    if (!re.test(f.name)) return setStatus({ msg: `Not a supported file for this target: ${f.name}`, error: true })
    handler(window.mk10.pathFor(f))
  })
}

function setMcp(url) {
  $('mcp-toggle').checked = !!url
  $('mcp-port').disabled = !!url
  $('mcp-on').hidden = !url
  $('mcp-cmd').value = url ? `claude mcp add --transport http mk10 ${url}` : ''
  $('mcp-badge').hidden = !url
}

// ---- state sync
async function refresh() {
  const s = await window.mk10.summary()
  ui.summary = s
  if (s.pages) {
    if (!s.pages[ui.page]) ui.page = Math.max(s.pages.findIndex((p) => p.name === s.currentPage), 0)
  }
  render()
}

let lastFile = null
async function onChange(e) {
  const s = await window.mk10.summary()
  if (e.kind === 'open' || s.file !== lastFile) {
    lastFile = s.file
    ui.assets.forEach((p) => p.then((a) => a && URL.revokeObjectURL(a.url)))
    ui.assets.clear()
    ui.videoKey = null
    ui.sel = { kind: 'page' }
    ui.page = 0
    ui.stateView.clear()
    // start on the page the device shows
    const ci = s.pages?.findIndex((p) => p.name === s.currentPage) ?? -1
    if (ci >= 0) ui.page = ci
  } else if (!s.pages?.[ui.page]) {
    // the page went away (folder deleted); main selects its parent right after
    ui.page = 0
    ui.sel = { kind: 'page' }
  }
  await refresh()
}

// Title font picker: device fonts first, then this computer's (copied to the device on an ssh push).
// Before the device fonts are copied, its two stock title fonts stand in.
const fontLists = { device: [], system: [] }
function fillFontSelect(current, sel = $('tp-family')) {
  const device = fontLists.device.length ? fontLists.device : ['Arial', 'Microsoft YaHei']
  const onDevice = new Set(device)
  const group = (label, names) => {
    const g = tpl('tpl-optgroup')
    g.label = label
    g.replaceChildren(...names.map((n) => { const o = tpl('tpl-option'); o.value = o.textContent = n; return o }))
    return g
  }
  const groups = [group('On the device', device), group('This computer (copied on push)', fontLists.system.filter((n) => !onDevice.has(n)))]
  if (current && !onDevice.has(current) && !fontLists.system.includes(current)) groups.unshift(group('Not found', [current]))
  sel.replaceChildren(...groups)
  sel.value = current ?? ''
}

// Device fonts (copied from the MK10) override same-named system fonts, so titles and clocks use the
// faces the device draws with. Faces load only when something on screen uses them.
const fontFaces = []
function registerFonts(list) {
  for (const f of fontFaces.splice(0)) document.fonts.delete(f)
  for (const { file, family, weight, style } of list ?? []) {
    const f = new FontFace(family, `url("mk10font://f/${encodeURIComponent(file)}")`, { weight: String(weight), style })
    document.fonts.add(f)
    fontFaces.push(f)
  }
  fontLists.device = [...new Set((list ?? []).map((f) => f.family))].sort()
  const n = new Set((list ?? []).map((f) => f.file)).size
  $('fonts-info').textContent = n ? `${n} font files from the device` : 'None yet: copied after the first ssh push or pull'
}

// serial mode needs a port, not an ssh host
function showPushMode() {
  const serial = $('push-mode').value === 'serial'
  $('device-mode').textContent = $('push-mode').value
  $('ssh-host-field').hidden = serial
  $('btn-reboot').hidden = serial // ssh only: the vendor app has no reboot over serial
  $('serial-port-field').hidden = !serial
}

async function init() {
  const cfg = await window.mk10.settings()
  $('ssh-host').value = cfg.ssh.host
  if (cfg.build) { $('brand').textContent = cfg.build.label; $('brand').title = cfg.build.title; $('brand').dataset.dev = 'true' }
  $('ssh-remote').value = cfg.ssh.remote
  $('push-mode').value = cfg.pushMode ?? 'auto'
  $('serial-port').value = cfg.serialPort ?? ''
  showPushMode()
  let gaps = true
  try { gaps = localStorage.getItem('keyGaps') !== 'false' } catch { /* storage unavailable: default on */ }
  $('key-gaps').checked = gaps
  $('panel').dataset.gaps = String(gaps)
  $('key-gaps').addEventListener('change', (e) => {
    $('panel').dataset.gaps = String(e.target.checked)
    try { localStorage.setItem('keyGaps', String(e.target.checked)) } catch { /* not persisted */ }
  })

  // settings dialog (native <dialog>: Esc and the Done button close it)
  // permissions: passive status only, polled every 2 s while the dialog is open
  let permTimer = null
  const showPerms = async () => {
    const p = await window.mk10.permissions().catch(() => null)
    if (!p) return
    // screen is getMediaAccessStatus: granted | denied | restricted | not-determined | unknown
    const show = (id, ok, label) => { $(id).textContent = label; $(id).dataset.ok = ok }
    show('perm-accessibility', p.accessibility, p.accessibility ? 'Granted' : 'Not granted')
    const s = p.screen.replace('-', ' ')
    show('perm-screen', p.screen === 'granted', s[0].toUpperCase() + s.slice(1))
  }
  // New key title defaults: blank fields mean the built-in default (Microsoft YaHei, 16 px, Regular)
  const td = (k) => document.querySelector(`[data-td=${k}]`)
  const showTitleDefaults = () => {
    const d = cfg.titleDefaults ?? {}
    fillFontSelect(d.FontFamily ?? 'Microsoft YaHei', td('FontFamily'))
    td('FontSize').value = d.FontSize ?? 16
    td('FontStyle').value = d.FontStyle ?? ''
  }
  $('title-defaults').addEventListener('change', () => {
    const n = Number(td('FontSize').value)
    const d = { FontFamily: td('FontFamily').value || undefined, FontSize: Number.isInteger(n) && n >= 6 && n <= 96 ? n : undefined, FontStyle: td('FontStyle').value }
    cfg.titleDefaults = d
    run(window.mk10.setTitleDefaults(d))
  })
  const showRuns = async () => {
    const n = (await window.mk10.allowedRuns()).length
    $('runs-info').textContent = n ? `${n} allowed so far.` : 'None allowed yet.'
    $('btn-forget-runs').disabled = !n
  }
  $('btn-forget-runs').addEventListener('click', () => run(window.mk10.forgetRuns().then(showRuns)))
  const openSettings = () => {
    if ($('settings-dlg').open) return
    showTitleDefaults()
    showRuns()
    $('settings-dlg').showModal()
    showPerms()
    permTimer = setInterval(showPerms, 2000)
  }
  $('settings-dlg').addEventListener('close', () => clearInterval(permTimer))
  $('settings-dlg').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) return e.currentTarget.close() // click on the backdrop
    const pane = e.target.closest('[data-pane]')?.dataset.pane
    if (pane) run(pane === 'accessibility' ? window.mk10.requestAccessibility() : window.mk10.openPrivacyPane(pane))
  })
  window.mk10.onOpenSettings(openSettings)
  // first-run onboarding: closing it (button or Esc) counts as onboarded; MCP only if ticked
  $('onboard-dlg').addEventListener('close', () => {
    if ($('onboard-mcp').checked) run(window.mk10.mcpToggle(true, cfg.mcp.port)).then(() => {}, () => {})
    if (cfg.loginSupported && $('onboard-login').checked) run(window.mk10.setLoginItem(true))
    run(window.mk10.setPref('onboarded', true))
  })
  if ((!cfg.onboarded && !cfg.screenshot) || cfg.onboardPreview) $('onboard-dlg').showModal() // --screenshot --onboard previews it
  if (cfg.settingsPreview) openSettings() // --screenshot --settings previews it
  $('btn-settings').addEventListener('click', openSettings)
  $('btn-capture').addEventListener('click', () => run(window.mk10.openCapture()))
  wireMacro()
  wireVideoRect()
  $('btn-pull').addEventListener('click', () => run(window.mk10.pull()))
  // the device has no getter for either level, so each slider starts where it was last set from here
  for (const [id, method, label, start] of [['brightness', 'setBacklight', 'Brightness', 50], ['volume', 'setVolume', 'Volume', 4]]) {
    let v = start
    try { v = Number(localStorage.getItem(id) ?? start) } catch { /* storage unavailable */ }
    $(id).value = v
    $(id).addEventListener('change', (e) => run(window.mk10.setLevel(method, Number(e.target.value)).then((n) => {
      try { localStorage.setItem(id, String(n)) } catch { /* not persisted */ }
      setStatus({ msg: `${label} ${n}` })
    })))
  }
  $('raw-json').addEventListener('click', () => run(openRawEditor()))
  $('page-json').addEventListener('click', () => run(openRawEditor('page')))
  $('btn-page-raw-edit').addEventListener('click', () => run(openRawEditor('page')))
  $('btn-raw-edit').addEventListener('click', () => run(openRawEditor()))
  $('raw-dlg-apply').addEventListener('click', () => run(applyRawEditor()))
  $('raw-dlg-cancel').addEventListener('click', () => $('raw-dlg').close())
  $('btn-fonts').addEventListener('click', () => run(window.mk10.syncFonts()))
  window.mk10.onFonts(registerFonts)
  registerFonts(await window.mk10.fonts())
  window.mk10.systemFonts().then((l) => { fontLists.system = l; if (ui.sel?.kind === 'key') render() }).catch(() => {})
  $('mcp-badge').addEventListener('click', openSettings)
  $('reopen-last').checked = cfg.reopenLast !== false
  $('key-actions').checked = cfg.keyActions !== false
  $('key-actions').addEventListener('change', (e) => run(window.mk10.setPref('keyActions', e.target.checked)))
  $('live-stats').checked = cfg.liveStats !== false
  $('live-stats').addEventListener('change', (e) => run(window.mk10.setPref('liveStats', e.target.checked)))
  $('reopen-last').addEventListener('change', (e) => run(window.mk10.setPref('reopenLast', e.target.checked)))
  const showLogin = (l) => {
    $('login-item').checked = !!l.openAtLogin
    $('login-status').textContent = l.status === 'requires-approval' ? 'Approve MK10 Studio in System Settings \u2192 General \u2192 Login Items' : (l.status ?? '')
  }
  showLogin(cfg.login)
  if (!cfg.loginSupported) {
    $('onboard-more').hidden = true
    $('login-item').disabled = true
    $('login-status').textContent = 'Dev build: needs the packaged, signed app'
  }
  $('login-item').addEventListener('change', (e) => run(window.mk10.setLoginItem(e.target.checked)).then((l) => l && showLogin(l)))
  $('about-version').textContent = cfg.version ?? ''
  $('about-settings').textContent = cfg.settingsFile ?? ''
  $('btn-rpc').addEventListener('click', () => run(window.mk10.setPref('jsonRpcWindow', true)))
  $('btn-mcp-copy').addEventListener('click', () => {
    navigator.clipboard.writeText($('mcp-cmd').value).then(
      () => setStatus({ msg: 'Copied MCP command' }),
      () => { $('mcp-cmd').select(); setStatus({ msg: 'Copy failed: select the text and press Cmd+C', error: true }) })
  })
  $('mcp-port').value = cfg.mcp.port
  $('btn-open-stock').hidden = !cfg.stockDir

  window.mk10.onStatus(setStatus)
  const onBg = (p) => {
    ui.bgPaused = !!p
    // the device's toggle images follow the player, so drop any Press Key preview of them
    for (const k of [...ui.stateView.keys()]) {
      const [pg, r, c] = k.split(',').map(Number)
      if (keyAt(ui.summary?.pages?.[pg], r, c)?.action?.mk10studioRun === 'freeze') ui.stateView.delete(k)
    }
    if (ui.summary) render()
  }
  window.mk10.onBgState(onBg)
  window.mk10.bgState().then(onBg, () => {})
  window.mk10.onLog(addLog)
  // a select sent right after an open must land after that open's page reset, not before it
  let changing = Promise.resolve()
  window.mk10.onChange((e) => { changing = onChange(e) })
  window.mk10.onPress(({ page, row, col }) => pressKey(page, row, col))
  window.mk10.onSelect(async ({ page, row, col, kind }) => {
    await changing.catch(() => {})
    ui.page = page
    // dev: --select page,-1,N picks panel item N
    ui.sel = kind === 'page' ? { kind: 'page' } : Number.isNaN(row) ? { kind: 'video' } : row < 0 ? { kind: 'panel', index: col } : { kind: 'key', row, col }
    render()
  })

  $('btn-open').addEventListener('click', () => run(window.mk10.open()))
  $('btn-open-stock').addEventListener('click', () => run(window.mk10.openPath(`${cfg.stockDir}defaultTheme.Theme`)))
  $('btn-save').addEventListener('click', () => run(window.mk10.save()))
  $('btn-push').addEventListener('click', () => run(window.mk10.push()))
  $('btn-key-image').addEventListener('click', () => {
    if (ui.sel?.kind === 'key') run(window.mk10.setKeyImage(ui.page, ui.sel.row, ui.sel.col, null, shownState(ui.page, ui.sel.row, ui.sel.col)))
  })
  $('btn-key-icon').addEventListener('click', async () => {
    if (ui.sel?.kind !== 'key') return
    const { row, col } = ui.sel
    const page = ui.page
    const state = shownState(page, row, col)
    const names = await window.mk10.icons().catch(() => [])
    const item = (n) => {
      const li = tpl('tpl-icon-item')
      li.querySelector('img').src = `../icons/${n}.png`
      li.querySelector('span').textContent = n.replace(/^PictureFont\//, '')
      li.querySelector('button').addEventListener('click', () => {
        $('icon-dlg').close()
        run(window.mk10.setKeyIcon(page, row, col, n, state))
      })
      return li
    }
    $('icon-grid').replaceChildren(...names.filter((n) => !n.startsWith('PictureFont/')).map(item))
    $('icon-grid-pf').replaceChildren(...names.filter((n) => n.startsWith('PictureFont/')).map(item))
    mdiPick = { page, row, col, state }
    $('icon-dlg').showModal()
  })
  $('mdi-q').addEventListener('input', () => showMdi())
  $('icon-dlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close() })
  const selKey = () => (ui.sel?.kind === 'key' ? keyAt(curPage(), ui.sel.row, ui.sel.col) : null)
  $('btn-key-sound').addEventListener('click', () => {
    if (selKey()) run(window.mk10.setKeySound(ui.page, ui.sel.row, ui.sel.col))
  })
  $('btn-key-sound-clear').addEventListener('click', () => {
    if (selKey()) run(window.mk10.setKeySound(ui.page, ui.sel.row, ui.sel.col, null))
  })
  $('btn-key-sound-play').addEventListener('click', () => {
    const k = selKey()
    if (k?.sound) run(assetUrl(k.sound).then((a) => a && new Audio(a.url).play()))
  })
  $('btn-video').addEventListener('click', () => run(window.mk10.setBackgroundVideo(ui.page)))
  $('btn-pg-video').addEventListener('click', () => run(window.mk10.setBackgroundVideo(ui.page)))
  $('pg-name').addEventListener('change', (e) => {
    const p = curPage()
    const k = p && opener(p)
    if (k) run(window.mk10.setKeyTitle(k.pageIndex, k.row, k.col, e.target.value))
  })
  $('key-title-style').addEventListener('change', (e) => {
    const el = e.target
    if (ui.sel?.kind !== 'key' || !el.dataset.tp) return
    const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value
    run(window.mk10.setKeyTitleParam(ui.page, ui.sel.row, ui.sel.col, { [el.dataset.tp]: v }))
  })
  $('btn-run-pick').addEventListener('click', () => {
    const k = ui.sel?.kind === 'key' && keyAt(curPage(), ui.sel.row, ui.sel.col)
    if (k) run(window.mk10.pickRunTarget(ui.page, ui.sel.row, ui.sel.col, k.action?.mk10studioRun))
  })
  const sendOutline = () => {
    if (ui.sel?.kind !== 'key') return
    const v = (k) => document.querySelector(`[data-ol=${k}]`).value
    const width = Math.max(0, Math.min(8, Math.round(Number(v('width')) || 0)))
    return window.mk10.setKeyTitleOutline(ui.page, ui.sel.row, ui.sel.col, { width, color: v('color') })
  }
  $('tp-outline').addEventListener('change', () => run(sendOutline()))
  liveColor($('tp-outline'), sendOutline)
  liveColor($('key-title-style'), (el) => ui.sel?.kind === 'key' && el.dataset.tp
    && window.mk10.setKeyTitleParam(ui.page, ui.sel.row, ui.sel.col, { [el.dataset.tp]: el.value }))
  const sendIcon = () => {
    const k = selKey()
    const ic = k && iconOf(k)
    if (!ic) return
    const v = (n) => document.querySelector(`[data-ic=${n}]`).value
    const width = Math.max(0, Math.min(8, Math.round(Number(v('width')) || 0)))
    const which = ic.premade ? { premade: ic.premade } : { name: ic.name }
    return setVectorIcon(ui.page, ui.sel.row, ui.sel.col, { ...which, color: v('color'), outline: v('outline'), width }, shownState(ui.page, ui.sel.row, ui.sel.col))
  }
  $('key-icon-style').addEventListener('change', () => run(sendIcon()))
  liveColor($('key-icon-style'), sendIcon)
  // collapsible inspector groups (<details data-grp>): open or closed is remembered in this browser
  for (const d of document.querySelectorAll('details[data-grp]')) {
    try {
      const v = localStorage.getItem(`grp:${d.dataset.grp}`)
      if (v) d.open = v === 'open'
    } catch { /* storage off: groups start open */ }
    d.addEventListener('toggle', () => {
      try { localStorage.setItem(`grp:${d.dataset.grp}`, d.open ? 'open' : 'closed') } catch { /* not remembered */ }
    })
  }
  $('key-title').addEventListener('change', (e) => {
    if (ui.sel?.kind === 'key') run(window.mk10.setKeyTitle(ui.page, ui.sel.row, ui.sel.col, e.target.value))
  })
  const saveSsh = () => {
    showPushMode()
    return run(window.mk10.setSsh({ host: $('ssh-host').value, remote: $('ssh-remote').value, mode: $('push-mode').value, port: $('serial-port').value.trim() }))
  }
  $('ssh-host').addEventListener('change', saveSsh)
  $('serial-port').addEventListener('change', saveSsh)
  $('btn-reboot').addEventListener('click', () => { $('device-pop').hidePopover(); run(window.mk10.rebootDevice()) })
  // offer the MK10 ports present right now each time the popover opens
  $('device-pop').addEventListener('toggle', async (e) => {
    if (e.newState !== 'open') return
    const ports = await window.mk10.serialPorts().catch(() => [])
    $('serial-ports').replaceChildren(...ports.map((p) => { const o = tpl('tpl-option'); o.value = p; return o }))
  })
  $('ssh-remote').addEventListener('change', saveSsh)
  $('push-mode').addEventListener('change', saveSsh)

  window.mk10.onMcp(setMcp)
  setMcp(cfg.mcpUrl)
  $('mcp-toggle').addEventListener('change', (e) => {
    run(window.mk10.mcpToggle(e.target.checked, Number($('mcp-port').value))).then(() => {}, () => {})
  })

  $('bg').addEventListener('click', () => { if (videoItem(curPage())) select({ kind: 'video' }) })
  wireDrop($('bg'), BG_RE, (file) => {
    select({ kind: 'video' })
    return run(window.mk10.setBackgroundVideo(ui.page, file))
  })
  // a missed drop must not navigate the window to the file
  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', (e) => e.preventDefault())
  new ResizeObserver(fit).observe($('stage'))
  wirePanel()
  // Edit menu / shortcuts: text fields and selected text keep native behavior; otherwise act on the key
  const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || !!window.getSelection()?.toString()
  const keyEdit = (op) => {
    if (op === 'undo') return run(window.mk10.keyOp('undo'))
    if (op === 'delete' && ui.sel?.kind === 'panel') return deletePanelSel()
    if (ui.sel?.kind !== 'key' || op === 'redo') return
    if (op !== 'paste' && !keyAt(curPage(), ui.sel.row, ui.sel.col)) return
    run(window.mk10.keyOp(op, ui.page, ui.sel.row, ui.sel.col))
  }
  window.mk10.onEdit((op) => (typing() || document.querySelector('dialog[open]') ? run(window.mk10.nativeEdit(op)) : keyEdit(op)))
  window.addEventListener('keydown', (e) => {
    if (ui.sel?.kind === 'panel' && e.key.startsWith('Arrow') && !typing() && !document.querySelector('dialog[open]')) {
      e.preventDefault()
      nudgePanel(e)
      return
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !typing() && !document.querySelector('dialog[open]')) keyEdit('delete')
    if (e.key === 'Escape' && document.activeElement?.tagName !== 'INPUT') select(null)
  })

  $('new-key-q').addEventListener('input', filterNewKey)
  $('new-key-q').addEventListener('keydown', (e) => {
    const n = palette.shown.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (n) palette.at = (palette.at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
      markNewKey()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pickNewKey()
    }
  })
  $('new-key-dlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close() })

  await onChange({ kind: 'init' })
}

init()
