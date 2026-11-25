// Renderer: reads state from main via window.mk10, renders with <template> clones only.
const $ = (id) => document.getElementById(id)
const tpl = (id) => $(id).content.firstElementChild.cloneNode(true)

const ui = {
  summary: { file: null },
  page: 0,
  stateView: new Map(), // `${page},${row},${col}` -> preview state of a multi-state key
  sel: null, // {kind:'key', row, col} | {kind:'video'}
  assets: new Map(), // key -> Promise<{url, mime}|null>
  videoKey: null,
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|svg)$/i
const VIDEO_RE = /\.(mp4|mov|m4v|mkv|avi|webm|gif)$/i
const ANY_MEDIA_RE = new RegExp(`${IMAGE_RE.source}|${VIDEO_RE.source}`, 'i')
const base = (p) => String(p).split('/').pop()

// ---- status / log
function setStatus({ msg, busy, error }) {
  const el = $('status')
  el.textContent = msg
  el.dataset.state = error ? 'error' : busy ? 'busy' : 'idle'
  el.title = msg
}

function addLog(line) {
  const el = $('log')
  el.textContent += `${line}\n`
  el.scrollTop = el.scrollHeight
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

// Top-level pages are numbered 0..5 in theme order: pageSwitch.jumpToPage values in the stock theme
// (1, 2, 3, 4 from page 0) fit that numbering, not the raw theme index (guess, not checked on the device).
// Folders are pages with a parent; a parent key's openPage action names the folder.
const topPages = () => (ui.summary.pages ?? []).filter((p) => p.parentIndex === undefined)
const opener = (p) => keyItems(ui.summary.pages?.[p.parentIndex])
  .find((k) => k.action?.type === 'openPage' && k.action.pageName === p.name)

// A multi-state key shows the image and title of its current state; Press Key steps the preview state
// (editor only, the theme keeps its State).
const stateIndex = (it) => ui.stateView.get(`${ui.page},${it.row},${it.col}`) ?? it.states.state
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
    setStatus({ msg: `Press: state ${n + 1} of ${key.states.list.length} (${key.states.list[n].keyString ?? ''}), preview only` })
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
  // device settings stay as they were for the push in flight
  for (const id of ['push-mode', 'ssh-host', 'ssh-remote']) $(id).disabled = !!s.pushing
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
    li.querySelector('.page-children').replaceChildren(...pages.filter((c) => c.parentIndex === p.index).map(item))
    return li
  }
  $('page-list').replaceChildren(...topPages().map(item))
  $('page-count').textContent = `${topPages().length} / 6`
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
      if (it) {
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
          if (raw.states) return setStatus({ error: true, msg: 'Multi-state key: its images are per state; replacing them is not supported yet' })
          select({ kind: 'key', row, col })
          return run(window.mk10.setKeyImage(ui.page, row, col, file))
        })
      }
      // empty slots take clicks (select, right-click Paste) and cover the background video, so a video
      // dropped on one still goes to the background; the page Inspector also replaces it
      else wireDrop(el, VIDEO_RE, (file) => run(window.mk10.setBackgroundVideo(ui.page, file)))
      // empty slots select too, so a paste has a target
      el.dataset.selected = String(ui.sel?.kind === 'key' && ui.sel.row === row && ui.sel.col === col)
      el.addEventListener('click', () => select({ kind: 'key', row, col }))
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

function renderBackground() {
  const v = videoItem(curPage())
  $('bg').dataset.selected = String(ui.sel?.kind === 'video')
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
  draw($('secondary'), all.filter((i) => !onKeyArea(i)), 656)
}

function draw(box, items, dx) {
  // approximate device z-order: images under gauges under text
  const rank = (t) => (t === '114' ? 0 : t === '113' || t === '111' ? 2 : 1)
  items.sort((a, b) => rank(a.type) - rank(b.type))
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
    } else {
      el = tpl('tpl-sec-box')
      el.querySelector('.box-type').textContent = `type ${it.type}`
      el.querySelector('.box-name').textContent = it.systemData ?? it.path ?? ''
      if (it.w) el.style.width = `${it.w}px`
      if (it.h) el.style.height = `${it.h}px`
    }
    el.style.left = `${it.x - dx}px`
    el.style.top = `${it.y}px`
    return el
  }))
}

// [key, value, editable] rows; editable fields come from the main process (existing text fields only)
function actionRows(a) {
  if (!a) return [['type', '(none)']]
  const hide = new Set(['iconPath', 'parentDescription', 'AISoundControlKeyword', 'editable'])
  const edit = new Set(a.editable ?? [])
  return Object.entries(a).filter(([k, v]) => !hide.has(k) && (v !== '' || edit.has(k)))
    // keyboard_switch is a toggle: each press steps to the next state (States list below)
    .map(([k, v]) => [k, k === 'type' && v === 'keyboard_switch' ? 'keyboard_switch (toggle)' : String(v), edit.has(k), fieldLabel(a.type, k)])
}

// deviceVolumeadjustValue (type deviceVolume) -> "Adjust value"; the raw name stays in the tooltip
function fieldLabel(type, k) {
  const rest = k.toLowerCase().startsWith(type.toLowerCase()) && k.length > type.length ? k.slice(type.length) : k
  const words = rest.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return (words[0].toUpperCase() + words.slice(1)).replace(/\burl\b/gi, 'URL')
}

function fillKv(dl, rows, onEdit) {
  // keep a field the user is typing in: don't rebuild under an active input
  if (dl.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return
  dl.replaceChildren(...rows.map(([k, v, editable, label]) => {
    const r = tpl(editable && onEdit ? 'tpl-kv-edit' : 'tpl-kv')
    r.querySelector('dt').textContent = label ?? k
    if (label) r.querySelector('dt').title = k
    const input = r.querySelector('input')
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
  fillKv($('pg-info'), [
    ['kind', folder ? `folder in ${pageName(pages[p.parentIndex])}` : 'top-level page'],
    ...(folder ? [['opened by', k ? `key "${(k.title ?? '').trim()}", row ${k.row} col ${k.col}` : 'no key']] : []),
    ...(folder ? [] : [['folders', String(pages.filter((c) => c.parentIndex === p.index).length)]]),
    ['keys', String(keyItems(p).length)],
    ['shown at start', p.name === ui.summary.currentPage ? 'yes' : 'no'],
    ['theme index', String(p.index)],
  ])
  const vid = videoItem(p)
  fillKv($('pg-video'), [['video', vid ? base(vid.path ?? '(none)') : 'none: this page has no video slot']])
  $('btn-pg-video').hidden = !vid
  const img = (p.items ?? []).find((i) => i.type === '114' && i.backgroundType === 'secondary')
  fillKv($('pg-panel'), [['image', img ? base(img.path || img.paths || '(none)') : 'none']])
}

// Raw JSON editor: for keys whose action has fields the form can't edit (int/bool, locked strings),
// toggle states, no action, or an action we can't decode.
function needsRaw(key) {
  const a = key.action
  if (!a || a.type === 'undecodable' || key.states) return true
  const edit = new Set(a.editable ?? [])
  const skip = new Set(['type', 'editable', 'iconPath', 'parentDescription', 'AISoundControlKeyword'])
  return Object.entries(a).some(([k, v]) => !skip.has(k) && !edit.has(k) && v !== '')
}

// pretty JSON, but one line per controlData field: ["jumpToPage", {"type":2,"null":0,"value":1}]
const rawText = (raw) => `{\n${Object.entries(raw).map(([k, v]) => `  ${JSON.stringify(k)}: ${k === 'controlData' && Array.isArray(v)
  ? `[\n${v.map((f) => `    ${JSON.stringify(f)}`).join(',\n')}\n  ]`
  : JSON.stringify(v, null, 2).replace(/\n/g, '\n  ')}`).join(',\n')}\n}`

async function loadRaw(force = false) {
  const ta = $('raw-json')
  const sel = ui.sel
  if (!force && (ta.dataset.dirty === 'true' || document.activeElement === ta)) return
  const raw = await window.mk10.keyRaw(ui.page, sel.row, sel.col).catch(() => null)
  if (ui.sel !== sel) return // selection moved on while loading
  ta.value = raw ? rawText(raw) : ''
  ta.dataset.dirty = 'false'
}

function renderInspector() {
  const p = curPage()
  const sel = ui.sel
  const key = sel?.kind === 'key' ? keyAt(p, sel.row, sel.col) : null
  const vid = sel?.kind === 'video' ? videoItem(p) : null
  const pg = sel?.kind === 'page' ? p : null
  $('insp-none').hidden = !!(key || vid || pg)
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
    const f = face(key)
    fillImg($('key-thumb'), f.path || f.paths, f.path ? null : f.frameDelays)
    $('key-states-h').hidden = $('key-states').hidden = !key.states
    $('btn-key-image').hidden = !!key.states // per-state images; item path is not what the device shows
    if (key.states) {
      const cur = stateIndex(key)
      fillKv($('key-states'), key.states.list.map((s, i) => [`state ${i + 1}${i === cur ? ' (shown)' : ''}`, `${s.keyString ?? ''} · keycode ${s.keycode}`]))
    }
    $('insp-raw').hidden = !needsRaw(key)
    if (needsRaw(key)) loadRaw()
    fillKv($('key-action'), actionRows(key.action), (field, value) =>
      run(window.mk10.setKeyActionField(ui.page, sel.row, sel.col, field, value)))
  }
  if (vid) fillKv($('video-info'), [['asset', base(vid.path ?? '(none)')], ['size', '640 × 256']])
}

function render() {
  renderTop()
  if (!ui.summary.file) return
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
  renderInspector()
}

// scale the 896x304 panel to the stage
function fit() {
  const st = $('stage')
  const z = Math.min((st.clientWidth - 40) / 896, (st.clientHeight - 80) / 304, 2)
  $('panel').style.zoom = String(Math.max(z, 0.3))
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
  }
  await refresh()
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
  const n = new Set((list ?? []).map((f) => f.file)).size
  $('fonts-info').textContent = n ? `${n} font files from the device` : 'None yet: copied after the first ssh push or pull'
}

async function init() {
  const cfg = await window.mk10.settings()
  $('ssh-host').value = cfg.ssh.host
  if (cfg.build) { $('brand').textContent = cfg.build.label; $('brand').title = cfg.build.title; $('brand').dataset.dev = 'true' }
  $('ssh-remote').value = cfg.ssh.remote
  $('push-mode').value = cfg.pushMode ?? 'auto'
  $('device-mode').textContent = $('push-mode').value
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
  const openSettings = () => {
    if ($('settings-dlg').open) return
    $('settings-dlg').showModal()
    showPerms()
    permTimer = setInterval(showPerms, 2000)
  }
  $('settings-dlg').addEventListener('close', () => clearInterval(permTimer))
  $('settings-dlg').addEventListener('click', (e) => {
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
  $('btn-pull').addEventListener('click', () => run(window.mk10.pull()))
  $('raw-json').addEventListener('input', (e) => { e.target.dataset.dirty = 'true' })
  $('btn-raw-revert').addEventListener('click', () => loadRaw(true))
  $('btn-raw-apply').addEventListener('click', async () => {
    let raw
    try {
      raw = JSON.parse($('raw-json').value)
    } catch (e) {
      return setStatus({ error: true, msg: `Raw JSON: ${e.message}` })
    }
    const { row, col } = ui.sel
    try {
      await window.mk10.setKeyRaw(ui.page, row, col, raw)
      loadRaw(true)
    } catch (e) {
      run(Promise.reject(e)) // status line; the edited text stays for fixing
    }
  })
  $('btn-fonts').addEventListener('click', () => run(window.mk10.syncFonts()))
  window.mk10.onFonts(registerFonts)
  registerFonts(await window.mk10.fonts())
  $('mcp-badge').addEventListener('click', openSettings)
  $('reopen-last').checked = cfg.reopenLast !== false
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
  $('btn-mcp-copy').addEventListener('click', () => {
    navigator.clipboard.writeText($('mcp-cmd').value).then(
      () => setStatus({ msg: 'Copied MCP command' }),
      () => { $('mcp-cmd').select(); setStatus({ msg: 'Copy failed: select the text and press Cmd+C', error: true }) })
  })
  $('mcp-port').value = cfg.mcp.port
  $('btn-open-stock').hidden = !cfg.stockDir

  window.mk10.onStatus(setStatus)
  window.mk10.onLog(addLog)
  // a select sent right after an open must land after that open's page reset, not before it
  let changing = Promise.resolve()
  window.mk10.onChange((e) => { changing = onChange(e) })
  window.mk10.onPress(({ page, row, col }) => pressKey(page, row, col))
  window.mk10.onSelect(async ({ page, row, col }) => {
    await changing.catch(() => {})
    ui.page = page
    ui.sel = Number.isNaN(row) ? { kind: 'video' } : { kind: 'key', row, col }
    render()
  })

  $('btn-open').addEventListener('click', () => run(window.mk10.open()))
  $('btn-open-stock').addEventListener('click', () => run(window.mk10.openPath(`${cfg.stockDir}defaultTheme.Theme`)))
  $('btn-save').addEventListener('click', () => run(window.mk10.save()))
  $('btn-push').addEventListener('click', () => run(window.mk10.push()))
  $('btn-key-image').addEventListener('click', () => {
    if (ui.sel?.kind === 'key') run(window.mk10.setKeyImage(ui.page, ui.sel.row, ui.sel.col))
  })
  $('btn-video').addEventListener('click', () => run(window.mk10.setBackgroundVideo(ui.page)))
  $('btn-pg-video').addEventListener('click', () => run(window.mk10.setBackgroundVideo(ui.page)))
  $('key-title').addEventListener('change', (e) => {
    if (ui.sel?.kind === 'key') run(window.mk10.setKeyTitle(ui.page, ui.sel.row, ui.sel.col, e.target.value))
  })
  const saveSsh = () => {
    $('device-mode').textContent = $('push-mode').value
    return run(window.mk10.setSsh({ host: $('ssh-host').value, remote: $('ssh-remote').value, mode: $('push-mode').value }))
  }
  $('ssh-host').addEventListener('change', saveSsh)
  $('ssh-remote').addEventListener('change', saveSsh)
  $('push-mode').addEventListener('change', saveSsh)

  window.mk10.onMcp(setMcp)
  setMcp(cfg.mcpUrl)
  $('mcp-toggle').addEventListener('change', (e) => {
    run(window.mk10.mcpToggle(e.target.checked, Number($('mcp-port').value))).then(() => {}, () => {})
  })

  $('bg').addEventListener('click', () => { if (videoItem(curPage())) select({ kind: 'video' }) })
  wireDrop($('bg'), VIDEO_RE, (file) => {
    select({ kind: 'video' })
    return run(window.mk10.setBackgroundVideo(ui.page, file))
  })
  // a missed drop must not navigate the window to the file
  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', (e) => e.preventDefault())
  new ResizeObserver(fit).observe($('stage'))
  // Edit menu / shortcuts: text fields and selected text keep native behavior; otherwise act on the key
  const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || !!window.getSelection()?.toString()
  const keyEdit = (op) => {
    if (op === 'undo') return run(window.mk10.keyOp('undo'))
    if (ui.sel?.kind !== 'key' || op === 'redo') return
    if (op !== 'paste' && !keyAt(curPage(), ui.sel.row, ui.sel.col)) return
    run(window.mk10.keyOp(op, ui.page, ui.sel.row, ui.sel.col))
  }
  window.mk10.onEdit((op) => (typing() || document.querySelector('dialog[open]') ? run(window.mk10.nativeEdit(op)) : keyEdit(op)))
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'Backspace' || e.key === 'Delete') && !typing() && !document.querySelector('dialog[open]')) keyEdit('delete')
    if (e.key === 'Escape' && document.activeElement?.tagName !== 'INPUT') select(null)
  })

  await onChange({ kind: 'init' })
}

init()
