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
// One JSON value per line: '{ "a": 1, "b": [ 2 ] }'. JSON.stringify escapes newlines inside
// strings, so every newline in its indented output is structural.
const line = (v) => JSON.stringify(v, null, 1)?.replace(/\n\s*/g, ' ') ?? 'undefined'
// a top-level array (V1 cmd 13: state map, action map) gets one element per line
const body = (v) => Array.isArray(v) && v.length ? `[${v.map(line).join(',\n ')}]` : line(v)

// V1 (old-style) frames get their cmd and name in the header line and only the payload below
const format = (e) => {
  if (e.dir === 'open' || e.dir === 'close') return `// ${time(e.ts)} ${ARROW[e.dir]} ${e.path ?? ''}\n`
  const v1 = e.msg?.v1 !== undefined
  const head = v1 ? ` V1 cmd ${e.msg.v1} ${e.msg.name}${e.msg.type ? ` (type ${e.msg.type})` : ''}` : ''
  return `// ${time(e.ts)} ${ARROW[e.dir]}${head}\n${body(v1 ? e.msg.payload : e.msg)}\n`
}

window.require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } })
window.require(['vs/editor/editor.main'], () => {
  const monaco = window.monaco
  // 'json' highlighting ('jsonc' isn't registered in this build). The log isn't one JSON
  // document and the header lines are comments, so diagnostics are off.
  ;(monaco.json ?? monaco.languages.json)?.jsonDefaults?.setDiagnosticsOptions({ validate: false, allowComments: true })
  const ed = monaco.editor.create($('rpc-editor'), {
    value: '', language: 'json', theme: 'vs-dark', readOnly: true, automaticLayout: true,
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
