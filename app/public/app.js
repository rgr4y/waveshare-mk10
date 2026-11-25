// Renderer: reads state from main via window.mk10, renders with <template> clones only.
const $ = (id) => document.getElementById(id)
const tpl = (id) => $(id).content.firstElementChild.cloneNode(true)

const ui = {
  summary: { file: null },
  page: 0,
  sel: null, // {kind:'key', row, col} | {kind:'video'}
  assets: new Map(), // key -> Promise<{url, mime}|null>
  videoKey: null,
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|svg)$/i
const VIDEO_RE = /\.(mp4|mov|m4v|mkv|avi|webm|gif)$/i
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

async function fillImg(img, key) {
  img.removeAttribute('src')
  const a = await assetUrl(key)
  if (a) img.src = a.url
}

// ---- helpers over the summary
const curPage = () => ui.summary.pages?.[ui.page]
const keyItems = (p) => (p?.items ?? []).filter((i) => i.type === '115')
const keyAt = (p, row, col) => keyItems(p).find((i) => i.row === row && i.col === col)
const videoItem = (p) => (p?.items ?? []).find((i) => i.type === '100' && i.backgroundType === 'main')

function pageLabel(p) {
  const titles = keyItems(p).sort((a, b) => a.row - b.row || a.col - b.col).map((k) => (k.title ?? '').trim()).filter(Boolean)
  return `Page ${p.index}${titles.length ? ` — ${titles.slice(0, 3).join(', ')}${titles.length > 3 ? '…' : ''}` : ` — ${keyItems(p).length ? `${keyItems(p).length} keys` : 'no keys'}`}`
}

// ---- rendering
function renderTop() {
  const s = ui.summary
  const has = !!s.file
  $('filename').textContent = has ? s.file.split('/').pop() : 'No file open'
  $('filename').title = s.file ?? ''
  $('dirty').hidden = !s.dirty
  $('btn-save').disabled = !has
  $('btn-push').disabled = !has
  $('empty').hidden = has
  $('panel').hidden = !has
}

function renderPages() {
  const list = $('page-list')
  const pages = ui.summary.pages ?? []
  const depth = (p) => (p.parentIndex >= 0 && p.parentIndex !== undefined ? 1 + depth(pages[p.parentIndex]) : 0)
  const order = []
  const walk = (parent) => pages.filter((p) => (p.parentIndex ?? -1) === parent).forEach((p) => { order.push(p); walk(p.index) })
  walk(-1)
  list.replaceChildren(...order.map((p) => {
    const li = tpl('tpl-page')
    li.dataset.selected = String(p.index === ui.page)
    li.dataset.current = String(p.name === ui.summary.currentPage)
    li.style.paddingLeft = `${depth(p) * 16}px`
    li.querySelector('.page-label').textContent = pageLabel(p)
    li.querySelector('.page-btn').addEventListener('click', () => { ui.page = p.index; ui.sel = null; render() })
    return li
  }))
}

function renderKeys() {
  const p = curPage()
  const box = $('keys')
  const tiles = []
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 5; col++) {
      const it = keyAt(p, row, col)
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
        else fillImg(img, it.path || it.paths)
        el.dataset.selected = String(ui.sel?.kind === 'key' && ui.sel.row === row && ui.sel.col === col)
        el.addEventListener('click', () => select({ kind: 'key', row, col }))
        wireDrop(el, IMAGE_RE, (file) => {
          select({ kind: 'key', row, col })
          return run(window.mk10.setKeyImage(ui.page, row, col, file))
        })
      }
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

const CLOCK = { hour: () => String(new Date().getHours()).padStart(2, '0'), minute: () => String(new Date().getMinutes()).padStart(2, '0') }

function renderSecondary() {
  const items = (curPage()?.items ?? []).filter((i) => i.type !== '115' && i.type !== '100' && i.backgroundType !== 'main')
  // approximate device z-order: images under gauges under text
  const rank = (t) => (t === '114' ? 0 : t === '113' ? 2 : 1)
  items.sort((a, b) => rank(a.type) - rank(b.type))
  $('secondary').replaceChildren(...items.map((it) => {
    let el
    if (it.type === '114') {
      el = tpl('tpl-sec-image')
      fillImg(el, it.path || it.paths)
      el.style.width = `${it.w ?? 240}px`
      el.style.height = `${it.h ?? 296}px`
    } else if (it.type === '113') {
      el = tpl('tpl-sec-text')
      const clock = it.text === 'Text' ? CLOCK[it.systemData] : null
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
    el.style.left = `${it.x - 656}px`
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
    .map(([k, v]) => [k, String(v), edit.has(k)])
}

function fillKv(dl, rows, onEdit) {
  // keep a field the user is typing in: don't rebuild under an active input
  if (dl.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return
  dl.replaceChildren(...rows.map(([k, v, editable]) => {
    const r = tpl(editable && onEdit ? 'tpl-kv-edit' : 'tpl-kv')
    r.querySelector('dt').textContent = k
    const input = r.querySelector('input')
    if (input) {
      input.value = v
      input.dataset.field = k
      input.addEventListener('change', () => onEdit(k, input.value))
    } else r.querySelector('dd').textContent = v
    return r
  }))
}

function renderInspector() {
  const p = curPage()
  const sel = ui.sel
  const key = sel?.kind === 'key' ? keyAt(p, sel.row, sel.col) : null
  const vid = sel?.kind === 'video' ? videoItem(p) : null
  $('insp-none').hidden = !!(key || vid)
  $('insp-key').hidden = !key
  $('insp-video').hidden = !vid
  if (key) {
    $('key-pos').textContent = `page ${ui.page} · row ${sel.row} col ${sel.col}`
    if (document.activeElement !== $('key-title')) $('key-title').value = key.title ?? ''
    fillImg($('key-thumb'), key.path || key.paths)
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
  renderSecondary()
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
    if (ui.sel?.kind === 'key' && !keyAt(s.pages[ui.page], ui.sel.row, ui.sel.col)) ui.sel = null
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
    ui.sel = null
    ui.page = 0
    // start on the page the device shows
    const ci = s.pages?.findIndex((p) => p.name === s.currentPage) ?? -1
    if (ci >= 0) ui.page = ci
  }
  await refresh()
}

async function init() {
  const cfg = await window.mk10.settings()
  $('ssh-host').value = cfg.ssh.host
  $('ssh-remote').value = cfg.ssh.remote
  $('push-mode').value = cfg.pushMode ?? 'serial'
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
    $('perm-accessibility').textContent = p.accessibility ? 'granted' : 'not granted'
    $('perm-screen').textContent = p.screen
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
    if ($('onboard-login').checked) run(window.mk10.setLoginItem(true))
    run(window.mk10.setPref('onboarded', true))
  })
  if ((!cfg.onboarded && !cfg.screenshot) || cfg.onboardPreview) $('onboard-dlg').showModal() // --screenshot --onboard previews it
  $('btn-settings').addEventListener('click', openSettings)
  $('mcp-badge').addEventListener('click', openSettings)
  $('reopen-last').checked = cfg.reopenLast !== false
  $('reopen-last').addEventListener('change', (e) => run(window.mk10.setPref('reopenLast', e.target.checked)))
  const showLogin = (l) => {
    $('login-item').checked = !!l.openAtLogin
    $('login-status').textContent = l.status === 'requires-approval' ? 'Approve MK10 Studio in System Settings \u2192 General \u2192 Login Items' : (l.status ?? '')
  }
  showLogin(cfg.login)
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
  window.mk10.onChange((e) => { onChange(e) })
  window.mk10.onSelect(({ page, row, col }) => {
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
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.activeElement?.tagName !== 'INPUT') select(null)
  })

  await onChange({ kind: 'init' })
}

init()
