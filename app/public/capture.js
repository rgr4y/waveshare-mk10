// Key capture window (proof of concept for keybinding). Events come from main over 'capture'.
const $ = (id) => document.getElementById(id)
const hex = (n, w = 2) => `0x${n.toString(16).toUpperCase().padStart(w, '0')}`

// Names from the HID Usage Tables; unnamed usages show as hex only
const KEYBOARD = {
  0x28: 'Return', 0x29: 'Escape', 0x2A: 'Delete (Backspace)', 0x2B: 'Tab', 0x2C: 'Space', 0x39: 'Caps Lock',
  0x46: 'Print Screen', 0x47: 'Scroll Lock', 0x48: 'Pause', 0x49: 'Insert', 0x4A: 'Home', 0x4B: 'Page Up',
  0x4C: 'Delete Forward', 0x4D: 'End', 0x4E: 'Page Down', 0x4F: 'Right', 0x50: 'Left', 0x51: 'Down', 0x52: 'Up',
  0x65: 'Application', 0x66: 'Power', 0x7F: 'Mute', 0x80: 'Volume Up', 0x81: 'Volume Down',
  0xE0: 'Left Control', 0xE1: 'Left Shift', 0xE2: 'Left Alt/Option', 0xE3: 'Left GUI/Cmd',
  0xE4: 'Right Control', 0xE5: 'Right Shift', 0xE6: 'Right Alt/Option', 0xE7: 'Right GUI/Cmd',
}
for (let i = 0; i < 26; i++) KEYBOARD[0x04 + i] = String.fromCharCode(65 + i)
for (let i = 0; i < 9; i++) KEYBOARD[0x1E + i] = String(i + 1)
KEYBOARD[0x27] = '0'
for (let i = 0; i < 12; i++) KEYBOARD[0x3A + i] = `F${i + 1}`
for (let i = 0; i < 12; i++) KEYBOARD[0x68 + i] = `F${i + 13}`
const CONSUMER = {
  0x6F: 'Brightness Up', 0x70: 'Brightness Down', 0xB3: 'Fast Forward', 0xB4: 'Rewind', 0xB5: 'Next Track',
  0xB6: 'Previous Track', 0xB7: 'Stop', 0xB8: 'Eject', 0xCD: 'Play/Pause', 0xE2: 'Mute', 0xE9: 'Volume Up',
  0xEA: 'Volume Down', 0x221: 'AC Search', 0x223: 'AC Home', 0x224: 'AC Back', 0x225: 'AC Forward',
}
const PAGES = { 0x01: 'Generic Desktop', 0x07: 'Keyboard', 0x0C: 'Consumer' }
const hidName = (page, usage) => (page === 0x07 ? KEYBOARD[usage] : page === 0x0C ? CONSUMER[usage] : null) ?? hex(usage)

function addRow(src, ev, key, detail, dev, qmk = '') {
  const tr = $('tpl-cap-row').content.firstElementChild.cloneNode(true)
  tr.dataset.src = src
  tr.querySelector('.c-src').textContent = src
  tr.querySelector('.c-ev').textContent = ev
  tr.querySelector('.c-key').textContent = key
  tr.querySelector('.c-detail').textContent = detail
  tr.querySelector('.c-dev').textContent = dev
  tr.querySelector('.c-qmk').textContent = qmk
  const body = $('cap-rows')
  body.prepend(tr)
  while (body.children.length > 300) body.lastElementChild.remove()
}

// every raw event, oldest first, for Save log (JSON lines, one event per line, with a timestamp)
const events = []

window.mk10.onCapture((o) => {
  events.push({ ts: new Date().toISOString(), ...o })
  if (events.length > 20000) events.shift()
  if (o.t === 'input') {
    const mods = ['meta', 'control', 'alt', 'shift'].filter((m) => o[m]).join('+')
    return addRow('App', `${o.type === 'keyDown' ? 'down' : 'up'}${o.repeat ? ' (repeat)' : ''}`, o.key, o.code, mods)
  }
  if (o.t === 'hid') {
    const page = PAGES[o.page] ?? `page ${hex(o.page)}`
    return addRow('HID', o.value ? 'down' : 'up', hidName(o.page, o.usage), `${page} ${hex(o.page)}:${hex(o.usage)}${o.value > 1 ? ` value ${o.value}` : ''}`, o.device,
      o.value ? (o.qmk ? `${o.qmk.code} (${hex(o.qmk.code, 4)}) ${o.qmk.name}` : 'none') : '')
  }
  if (o.t === 'access') {
    $('cap-access').textContent = o.status[0].toUpperCase() + o.status.slice(1)
    $('cap-access').dataset.ok = String(o.status === 'granted')
    return
  }
  if (o.t === 'open') {
    $('cap-devices').textContent = o.result === 0 ? `${o.devices.length} devices: ${o.devices.join(', ')}` : `IOHIDManagerOpen returned ${hex(o.result >>> 0, 8)}; ${o.devices.length} devices: ${o.devices.join(', ')}`
    return
  }
  addRow(o.t === 'error' ? 'Error' : 'Log', '', '', o.msg, '')
})

$('cap-pane').addEventListener('click', () => window.mk10.openPrivacyPane('input'))
$('cap-clear').addEventListener('click', () => { $('cap-rows').replaceChildren()
  // keep the permission and device-list events so a saved log still says what was listening
  events.splice(0, events.length, ...events.filter((e) => e.t === 'access' || e.t === 'open'))
})
$('cap-save').addEventListener('click', async () => {
  try {
    const path = await window.mk10.saveCaptureLog(events.map((e) => JSON.stringify(e)).join('\n') + '\n')
    if (path) $('cap-saved').textContent = `Saved ${events.length} events to ${path}`
  } catch (e) {
    $('cap-saved').textContent = `Save failed: ${e.message}`
  }
})
