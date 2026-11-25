// JSON RPC window: read-only Monaco log of Studio's serial JSON-RPC traffic (main sends 'rpc').
const $ = (id) => document.getElementById(id)
const ARROW = { tx: '→', rx: '←', open: 'open', close: 'close' }
const MAX_LINES = 50_000 // older entries are dropped from the top past this
let count = 0
// main replays the log on load, often before Monaco is up: hold entries until it is
let pending = []
let append = (entries) => { pending.push(...entries) }
window.mk10.onRpc((entries) => append(entries))

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false }) + `.${String(ts % 1000).padStart(3, '0')}`
const format = (e) => e.dir === 'open' || e.dir === 'close'
  ? `// ${time(e.ts)} ${ARROW[e.dir]} ${e.path ?? ''}\n`
  : `// ${time(e.ts)} ${ARROW[e.dir]}\n${JSON.stringify(e.msg, null, 2)}\n`

window.require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } })
window.require(['vs/editor/editor.main'], () => {
  const monaco = window.monaco
  // jsonc: the per-entry header lines are comments
  const ed = monaco.editor.create($('rpc-editor'), {
    value: '', language: 'jsonc', theme: 'vs-dark', readOnly: true, automaticLayout: true,
    minimap: { enabled: false }, fontSize: 12, tabSize: 2, scrollBeyondLastLine: false, wordWrap: 'off',
  })
  const model = ed.getModel()
  append = (entries) => {
    const text = entries.map(format).join('')
    const end = model.getFullModelRange().getEndPosition()
    model.applyEdits([{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text }])
    const over = model.getLineCount() - MAX_LINES
    if (over > 0) model.applyEdits([{ range: new monaco.Range(1, 1, over + 1, 1), text: '' }])
    count += entries.length
    $('rpc-count').textContent = `${count} message${count === 1 ? '' : 's'}`
    if ($('rpc-follow').checked) ed.revealLine(model.getLineCount())
  }
  append(pending)
  pending = null
  $('rpc-clear').addEventListener('click', () => {
    model.setValue('')
    count = 0
    $('rpc-count').textContent = ''
    window.mk10.clearRpc()
  })
  $('rpc-wrap').addEventListener('change', (e) => ed.updateOptions({ wordWrap: e.target.checked ? 'on' : 'off' }))
})
