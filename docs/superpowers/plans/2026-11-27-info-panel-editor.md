# Info Panel Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit the MK10's 240x296 info panel per page in MK10 Studio: select, drag, nudge, align, snap, z order, add/edit/delete objects, crop a background, and feed custom data.

**Architecture:** Pure item operations live in a new `app/lib/panel.js` (like `theme.js`, operating on the decoded theme). `Session` wraps them with snapshot undo and `touch()`. `main.js` exposes them over IPC (`mk10:<name>`, `preload.cjs`), `lib/mcp.js` over MCP. The renderer (`public/app.js`, classic script, `<template>` clones only) makes the existing `#secondary` panel interactive. Media baking goes through `lib/media.js` (system ffmpeg).

**Tech Stack:** Electron, Node ESM, `node --test`, eslint, ffmpeg, `@modelcontextprotocol/sdk` + zod.

**Spec:** `docs/superpowers/specs/2026-11-27-info-panel-editor-design.md`. Device facts: `docs/theme-format.md`, "Info panel geometry and data".

## Global Constraints

- Panel = canvas x 656..896, y 0..296. A panel item is one with `backgroundType === 'secondary'`. Item fields are strings in the theme.
- x/y = top-left of the item's box. Sizes: 102/114/111 = `w` x `h`; 101 diameter = 2 x `radius` x `scale`; 109 diameter = 2 x `radius` x `scale`; 113 = rendered text box (measured in the editor).
- Draw order = numeric `z` field (higher on top), not array order.
- Keep `backupX` = x - 656 and `backupY` = y whenever x/y change (the vendor app's own fields).
- Background: type 114 at 656,0, `w` 240, `h` 296, `z` 0, asset key `/image/240x296/ApplicationIcon/<uuid>.png|.gif`, always exactly 240x296.
- Studio-only data goes in `mk10studio*` string fields (device tolerates them). Background crop state: `mk10studioCrop`.
- Background originals are never stored in the theme.
- 109 arcs are static on the device: Inspector says so; the Add picker offers 101 as "Ring", never 109.
- Undo: panel ops join `KEY_OPS` in `lib/session.js`; one snapshot per drag, per nudge burst, per align/z click.
- Device tests go through lenny: `ssh -J lenny root@10.0.1.48`, serial `/dev/serial/by-id/usb-Allwinner_Serial_MK10-5e51345d-if00` on lenny. Never touch lenny `ttyUSB1` (UPS). Back up and sha-verify `mk10studio.Theme`, `/mnt/SDCARD/config.json`, `/data/file_info.json` before, restore after.
- `npm test` and `npm run lint` clean before every commit. Commit per task (Rob's project: commit without asking, never push).

## Review Focus

1. **Stale index after delete/add.** Item identity is the `items[]` index; after any change the renderer must re-read `summary()` before the next op. Test: `deletePanelItem` then `movePanelItem` on the old last index throws "no panel item" (Task 1).
2. **Key ops on panel items.** `movePanelItem` etc. must refuse a key (115) or the main video (100) by index. Test in Task 1.
3. **Drag at non-1 canvas zoom.** `#panel` uses CSS `zoom` from `fit()`; pointer deltas must be divided by the zoom, or objects run away from the cursor. Checked by hand in Task 2 at two window sizes.
4. **Typing in Inspector fields while a panel item is selected.** Arrow keys and Backspace must not nudge/delete when an INPUT/TEXTAREA/SELECT has focus (reuse `typing()`). Checked by hand in Task 2.
5. **Odd background inputs** (portrait image, tiny image, animated GIF, HEIC). Output must still be exactly 240x296, GIF stays animated. Test in Task 4 (`ffprobe` on outputs).

---

### Task 1: Panel item operations (lib) with undo

**Files:**
- Create: `app/lib/panel.js`, `app/lib/panel.test.js`
- Modify: `app/lib/session.js` (`KEY_OPS` line 52, new methods next to `setVideoRect`, `summary()` item fields), `app/main.js` (`registerIpc`), `app/preload.cjs`
- Modify: `app/lib/theme.js`: export `dropIfOrphan` (line 274) and `page` (line 113) for reuse

**Interfaces:**
- Produces (`lib/panel.js`):
  - `PANEL = { x: 656, w: 240, h: 296 }`
  - `isPanelItem(it) -> boolean`
  - `movePanelItem(theme, pageIndex, index, x, y) -> void`: integers only; clamps x to 656..895 and y to 0..295 (top-left stays on the panel; right/bottom may hang off); updates backupX/backupY.
  - `deletePanelItem(theme, pageIndex, index) -> void`: removes the item, `dropIfOrphan` on its `path`.
  - `setPanelZ(theme, pageIndex, index, dir: 'forward'|'back') -> number`: sorts the page's non-background panel items by (z, array index), moves this one a step in that list (no-op at the end), then renumbers them z = 1..n in list order; the background 114 keeps its z (0). Returns the new z.
  - `alignPos(box: {x, y, w, h}, how: 'left'|'center'|'right'|'top'|'middle'|'bottom') -> {x, y}` in canvas coords, relative to the panel; rounds to integers.
  - Every op throws `no panel item <index> on page <p>` when the index is out of range or not a panel item.
- Produces (`Session`): `panelMove(page, index, x, y)`, `panelDelete(page, index)`, `panelZ(page, index, dir)`, `panelAlign(page, index, how, size: {w, h})` (reads x/y from the item, `alignPos`, then move). Kinds `panelMove`, `panelDelete`, `panelZ`, `panelAlign` added to `KEY_OPS`. `panelBegin()` = `snapshot()` exposed so the renderer can take one snapshot at drag start; `panelMove(page, index, x, y, { snapshot: false })` skips its own snapshot.
- Produces (`summary()` items): add `z`, `scale`, `radius`, `flag` (`system_data_flag`), `color` (`front_color`), `crop` (parsed `mk10studioCrop`) — numbers via existing `num()`.
- Produces (IPC/preload): `panelMove`, `panelDelete`, `panelZ`, `panelAlign`, `panelBegin`, same argument order.

- [ ] **Step 1: Write failing tests** in `app/lib/panel.test.js`, loading the stock theme like `theme.test.js` (`REAL`, skip when missing). Page 0 of the stock theme has panel items (13 secondary items; background 114 at index found by `type === '114'`).

```js
test('movePanelItem sets x/y and backups, clamps top-left onto the panel', { skip }, () => {
  const t = decodeTheme(load()); const i = idx(t, 0, '113')
  movePanelItem(t, 0, i, 700, 50)
  assert.deepEqual(pick(t, 0, i), { x: '700', y: '50', backupX: '44', backupY: '50' })
  movePanelItem(t, 0, i, 10, -40)
  assert.deepEqual(pick(t, 0, i), { x: '656', y: '0', backupX: '0', backupY: '0' })
  movePanelItem(t, 0, i, 2000, 900)
  assert.deepEqual(pick(t, 0, i), { x: '895', y: '295', backupX: '239', backupY: '295' })
  assert.throws(() => movePanelItem(t, 0, i, 1.5, 0), /whole numbers/)
})
test('panel ops refuse keys, the video and stale indexes', { skip }, () => {
  const t = decodeTheme(load()); const key = idx(t, 0, '115')
  assert.throws(() => movePanelItem(t, 0, key, 700, 0), /no panel item/)
  const n = t.json.pages[0].items.length
  deletePanelItem(t, 0, idx(t, 0, '113'))
  assert.throws(() => movePanelItem(t, 0, n - 1, 700, 0), /no panel item/)
})
test('deletePanelItem drops the image asset when nothing else uses it', { skip }, () => { /* delete page 0's 114; its path is gone from t.assets iff no other item references it */ })
test('setPanelZ moves past the neighbour', { skip }, () => { /* on page 0: forward on the lowest non-background item puts it one step up; back on the top one one step down; z values are 1..n, background still 0 */ })
test('alignPos', () => {
  const b = { x: 700, y: 40, w: 40, h: 20 }
  assert.deepEqual(alignPos(b, 'left'), { x: 656, y: 40 })
  assert.deepEqual(alignPos(b, 'center'), { x: 756, y: 40 })
  assert.deepEqual(alignPos(b, 'right'), { x: 856, y: 40 })
  assert.deepEqual(alignPos(b, 'top'), { x: 700, y: 0 })
  assert.deepEqual(alignPos(b, 'middle'), { x: 700, y: 138 })
  assert.deepEqual(alignPos(b, 'bottom'), { x: 700, y: 276 })
})
test('session: panel ops are undoable and a key title edit clears the stack', { skip }, async () => { /* Session.open(REAL); panelMove; undo restores x; panelMove; setKeyTitle; canUndo false */ })
```

`pick` returns `{x, y, backupX, backupY}` of the item; `idx(t, p, type)` finds the first item of that type.

- [ ] **Step 2:** `cd app && node --test lib/panel.test.js` — expect FAIL (module not found).
- [ ] **Step 3:** Implement `lib/panel.js`, export `dropIfOrphan`/`page` from `theme.js`, add Session methods, summary fields, IPC + preload.
- [ ] **Step 4:** `npm test && npm run lint` — all pass.
- [ ] **Step 5:** Commit `Studio: panel item move/delete/z/align ops with undo`.

---

### Task 2: Interactive panel in the editor

**Files:**
- Modify: `app/public/app.js` (`renderWidgets`/`draw` ~536-620, `select`, `renderInspector`, global keydown ~1514, `fit` ~1129), `app/public/index.html` (align bar above `#secondary`, `insp-panel` Inspector section), `app/public/styles.css` (`.secondary` line 190–191)

**Interfaces:**
- Consumes: Task 1 IPC; `summary()` fields `z`, `scale`, `radius`, `w`, `h`.
- Produces: `ui.sel = { kind: 'panel', index }` (page is `ui.page`); `panelBox(index) -> {x, y, w, h}` in canvas coords (from the rendered element's `offsetLeft/Top/Width/Height` + 656, so 113 uses the measured box); `ui.panelZoom` boolean.

- [ ] **Step 1: Rendering.** `draw()` for the panel filters `isPanel = backgroundType === 'secondary'` (key-area widgets keep today's `onKeyArea`), sorts by numeric `z` ascending (replaces `rank`), sets `el.style.zIndex`, `el.dataset.index`. Sizes per Global Constraints (101/109: `2*radius*scale`; ring template gets that width/height). `.secondary` gets `pointer-events: auto`; the key-area `#widgets` stays non-interactive.
- [ ] **Step 2: Select + hit test.** Pointerdown on a panel element selects it (topmost by z wins because it is on top in the DOM stacking). Clicking empty panel area selects the background item if there is one, else `{kind:'page'}`. Selected element gets `data-selected="true"` outline.
- [ ] **Step 3: Drag.** On pointerdown on the selected item: `panelBegin()` once, then on pointermove compute `dx = (e.clientX - startX) / zoom` (zoom = `parseFloat($('panel').style.zoom)`), new pos = start + d, snapped when snap is on and Alt/Option not held (`Math.round(v / grid) * grid` on the panel-relative coordinate), move the element live; on pointerup call `panelMove(page, index, x, y, { snapshot: false })`. Background item is not draggable.
- [ ] **Step 4: Keyboard.** In the existing global keydown, when `ui.sel?.kind === 'panel'` and `!typing()` and no open dialog: arrows nudge 1 px (Shift 10 px; with snap on, one grid step), `preventDefault`. First nudge after a pause > 600 ms calls `panelBegin()`; each nudge calls `panelMove(..., { snapshot: false })`. Backspace/Delete → `panelDelete`. Escape keeps today's behaviour.
- [ ] **Step 5: Align bar.** Shown above the panel when a panel item is selected: Left, Center, Right, Top, Middle, Bottom → `panelAlign(page, index, how, {w, h} from panelBox)`; Forward / Back → `panelZ`; Snap checkbox + grid number input (default 8, min 2, max 40) stored in `localStorage` keys `panelSnap` / `panelGrid` (same try/catch pattern as `keyGaps`, line 1241); Zoom toggle → `ui.panelZoom`.
- [ ] **Step 6: Zoom.** When `ui.panelZoom`, `fit()` scales so the 240x296 panel fills the stage height (cap 4) and scrolls the stage so x 656 is in view; off = today's fit.
- [ ] **Step 7: Inspector.** New `insp-panel` section for `kind: 'panel'`: type name (`WIDGET_NAMES`), X / Y number inputs (panel-relative, 0..239 / 0..295, change → `panelMove`), data name read-only for now, and for 109 the hint "The device draws this arc static; pushed values don't move it." Delete button.
- [ ] **Step 8: Verify.** `npm run lint`; `npm start -- --open ../img/stock/defaultTheme.Theme --screenshot /tmp/…png` shows the panel unchanged at rest. By hand (Rob or the implementer in the app): drag at two window sizes (Review Focus 3), nudge with Shift, align all six ways on a text item, Forward/Back on overlapping items, Cmd+Z after a drag restores the old spot in one step, arrows in the X field don't nudge (Review Focus 4).
- [ ] **Step 9:** Commit `Studio: select, drag, nudge, align, snap and z order on the info panel`.

---

### Task 3: Add objects and edit their fields

**Files:**
- Create: `app/lib/panel-templates.json`
- Modify: `app/lib/panel.js`, `app/lib/panel.test.js`, `app/lib/session.js`, `app/main.js`, `app/preload.cjs`, `app/public/app.js`, `app/public/index.html`

**Interfaces:**
- Produces (`lib/panel.js`):
  - `PANEL_KINDS = ['text', 'data', 'clock', 'bar', 'ring']` (images: Task 4).
  - `addPanelItem(theme, pageIndex, kind) -> number` (new item's index): copies the template, `id` = max numeric id on the page + 1, `x`/`y` = panel center minus half the template's box (113: center point), `z` = max panel z + 1, backups set.
  - `PANEL_FIELDS` = per type, the editable field names:
    - 113: `text_str`, `system_data_flag`, `system_data_name`, `text_font`, `front_color`
    - 111: `system_data_name`, `displayNum`, `displayType`, `paths`, `text_font`, `w`, `h`
    - 102: `system_data_name`, `w`, `h`, `front_color`, `back_color`, `corner_radius`
    - 101: `system_data_name`, `radius`, `scale`, `margin`, `front_color`, `back_color`
    - 109: `system_data_name`, `radius`, `scale`, `gradientColor1`, `gradientColor2`, `gradientColor3`
    - 114: `w`, `h`
  - `setPanelItem(theme, pageIndex, index, fields: Record<string, string|number>) -> void`: rejects names not in `PANEL_FIELDS[type]` (`<name> can't be edited on a type <t> item`), stores `String(v)`.
- Produces (`Session`/IPC): `panelAdd(page, kind) -> index`, `panelSet(page, index, fields)`, `dataNames() -> string[]` (= `ALL_STATS` + `hour`, `minute`, `date` + every `system_data_name` in the theme + Task 6 custom names, sorted, unique, no `randomNumbers`). Kinds `panelAdd`, `panelSet` join `KEY_OPS`.
- Templates (from stock items, `docs/theme-format.md` field sets): `text` = 113 flag 0 `text_str` "Text", Arial 24 white; `data` = 113 flag 1 `CPU Usage`; `clock` = 111 `displayType` 0, `displayNum` 2, `system_data_name` `hour`, `w` 96 `h` 64, `text_font` Microsoft YaHei; `bar` = stock page 8's 102 (80x12); `ring` = page 1's 101 (radius 100, scale 0.4).

- [ ] **Step 1: Failing tests:** `addPanelItem` for each kind returns an index whose item `isPanelItem`, has a unique id, z above every other panel item, and lies inside the panel; `setPanelItem` writes strings and rejects `x` and unknown fields; `dataNames` contains `CPU Usage`, `hour`, `avg_dB` (stock page) and not `randomNumbers`.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** implement. **Step 4:** `npm test && npm run lint` pass.
- [ ] **Step 5: UI.** "Add object" button in the align bar (and in the page Inspector) opens a picker dialog reusing the `new-key-dlg` palette markup/style (`palette`): Text, Data value, Clock, Bar, Ring, Image (Image → Task 4; hidden until then). After add, select the new index. Inspector fields per type from `PANEL_FIELDS`: data name = `<input list>` with a `<datalist>` from `dataNames()` (free text allowed); colors use `<input type=color>` + alpha converted to/from `r=..,g=..,b=..,a=..`; font = family select (existing `fonts`/`systemFonts`) + size; changes call `panelSet`.
- [ ] **Step 6: Device check** (per Global Constraints): push a theme with one of each kind on a page via Push (ssh mode from lenny if the Mac can't reach the device), push values with `node cli.js stats` on lenny or `run.mjs`-style V1 cmd 1, grab `fb11` (`head -c 142080 /dev/fb11` → ffmpeg `rgb565le 240x296`). Confirm: clock shows the hour; data text shows the value; bar and ring move; each sits where the editor draws it (±3 px for text). Record the 111 result in `docs/theme-format.md` "Info panel geometry and data". Restore the device.
- [ ] **Step 7:** Commit `Studio: add and edit info panel objects`.

---

### Task 4: Background crop and panel images

**Files:**
- Modify: `app/lib/media.js`, `app/lib/panel.js`, `app/lib/panel.test.js`, `app/lib/session.js`, `app/main.js`, `app/preload.cjs`, `app/public/app.js`, `app/public/index.html`, `app/public/styles.css`
- Create: `app/lib/media.test.js`

**Interfaces:**
- Produces (`lib/media.js`):
  - `placement(mode: 'fit'|'fill'|'stretch', srcW, srcH, boxW = 240, boxH = 296) -> {x, y, w, h}`: where the scaled source lands in the box (fit = contain centered, fill = cover centered, stretch = 0,0,boxW,boxH). Manual mode is any rect the modal produces.
  - `toPanelImage(input, rect: {x, y, w, h}, { bg = '#000000', boxW = 240, boxH = 296 } = {}) -> Promise<{buf, ext: 'png'|'gif'}>`: ffmpeg `color=c=<bg>:s=<boxW>x<boxH>` source, `scale=<w>:<h>` the input, `overlay=<x>:<y>`; GIF input (`.gif`) keeps animation (`split`/`palettegen`/`paletteuse`, `-loop 0`) and returns gif; anything else returns a single-frame png.
  - `previewImage(input) -> Promise<{png: Buffer, w, h}>`: first frame, long side ≤ 1200 px, plus the source's real width/height (ffprobe).
- Produces (`lib/panel.js`):
  - `setPanelBackground(theme, pageIndex, buf, ext, crop) -> string` (asset key): replaces or creates the 114 background item (see Global Constraints), sets `mk10studioCrop` = `JSON.stringify(crop)` where `crop = { src, srcW, srcH, rect, bg }`; `dropIfOrphan` the old asset.
  - `addPanelImage(theme, pageIndex, buf, ext, w, h) -> number`: a non-background 114 item centered, z on top.
- Produces (`Session`/IPC): `panelBackground(page, file, rect, bg)`, `panelImage(page, file)` (fit inside 120x120, keeps aspect), `previewImage(file)` (IPC returns `{png: Uint8Array, w, h}`), `pickPanelImage()` (open dialog, `IMAGE_EXT` + gif). Kinds `panelBg`, `panelImage` join `KEY_OPS`.

- [ ] **Step 1: Failing tests** (`media.test.js`, skip when `ffmpeg` is missing): `placement('fit', 1000, 500)` = `{x: 0, y: 88, w: 240, h: 120}`; `placement('fill', 1000, 500)` = `{x: -176, y: 0, w: 592, h: 296}`; `placement('stretch', 10, 10)` = `{x: 0, y: 0, w: 240, h: 296}`. `toPanelImage` on a generated 400x100 PNG and on a 3-frame 50x50 GIF (make both with ffmpeg lavfi in a temp dir): `ffprobe` reports 240x296 for both; the GIF output has `nb_frames` 3 (Review Focus 5). `setPanelBackground` on a page with no 114 creates one at 656,0 z 0 with `mk10studioCrop`; on page 0 replaces the path and drops the old asset if unused.
- [ ] **Step 2:** Run, FAIL. **Step 3:** implement. **Step 4:** `npm test && npm run lint` pass.
- [ ] **Step 5: Modal UI.** `<dialog id="bg-dlg">`: a stage showing the preview image (blob URL from `previewImage`) with the 240x296 window drawn at 2x; image outside the window at 35% opacity (window = an element with a huge `box-shadow` or a clip). Drag pans, wheel and a slider zoom around the window center; Fit / Fill / Stretch buttons set the rect from `placement`; manual moves keep the aspect. Bg color input for exposed areas. Apply → `panelBackground(page, src, rect, bg)` (rect converted from 2x preview to 240x296 units and from preview to source scale where needed — the rect is always in panel px). Opening on an item with `crop` whose `src` still exists starts from that rect; otherwise asks for a file. Entry points: double-click the background in the panel, "Background…" button in the page Inspector (shows "Add background…" when none), dropping an image on the panel.
- [ ] **Step 6: Image object.** "Image" in the Add picker → `pickPanelImage` → `panelImage`.
- [ ] **Step 7: Verify.** Portrait photo, wide photo, GIF: Fit/Fill/Stretch/manual each produce the expected look in the editor; push one to the device and grab `fb11`: the crop matches the editor.
- [ ] **Step 8:** Commit `Studio: info panel background crop and images`.

---

### Task 5: MCP tools for the panel

**Files:**
- Modify: `app/lib/mcp.js`, `app/lib/mcp.test.js`, README MCP section

**Interfaces:**
- Consumes: Session methods from Tasks 1, 3, 4.
- Produces tools (zod schemas, `page` and `index` integers):
  - `add_panel_item {page, kind: enum PANEL_KINDS}` → `{index}`
  - `set_panel_item {page, index, fields: record<string, string|number>}`
  - `move_panel_item {page, index, x, y}` (canvas coords, like `get_page`)
  - `delete_panel_item {page, index}`
  - `set_panel_background {page, imagePath, mode: enum fit|fill|stretch, bg?: string}` → `{asset}` (rect from `placement` with the source size from `previewImage`)
  - Descriptions include `LAYOUT` and say indexes come from `get_page` and change after add/delete.

- [ ] **Step 1: Failing test** in `mcp.test.js`: the five names are listed; `add_panel_item` kind `text` then `move_panel_item` to 700,40 then `get_page` shows that item at x 700; `delete_panel_item` on a key index returns `isError`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npm test && npm run lint`.
- [ ] **Step 5:** Commit `Studio: MCP tools for the info panel`.

---

### Task 6 (stretch): Custom data sources

**Files:**
- Modify: `app/lib/stats.js`, `app/lib/stats.test.js`, `app/lib/mcp.js`, `app/lib/mcp.test.js`, `app/main.js`, `app/preload.cjs`, `app/public/app.js`, `app/public/index.html` (Settings dialog)

**Interfaces:**
- Produces (`lib/stats.js`): `setCustom(map: Record<string, string>) -> void` (merges; `null`/`''` value deletes the key), `customNames() -> string[]`; `collectStats(keys, opts)` adds custom values for wanted keys (custom wins over built-ins of the same name).
- Produces (MCP): tool `set_data {values: record<string, string>}`; HTTP `POST /data` on the MCP server (same Host/Origin guard, `content-type: application/json`, body `{"key": "value"}`, 204 on success, 400 on non-object or non-string values, body ≤ 64 KiB).
- Produces (`main.js`): `settings.dataSources = [{ name, command, interval }]` (interval seconds, min 1, default 5). Each tick of `pushStats`, a source runs only when `statsContract.keys` includes its `name` and its interval has passed: `execFile('/bin/sh', ['-c', command], { timeout: 5000 })`, trimmed stdout (first 200 chars) → `setCustom({[name]: out})`; failure → value `ERR` and a log line. IPC `setDataSources(list)` validates (name non-empty, unique, no `randomNumbers`) and saves. `dataNames()` (Task 3) includes `customNames()` and source names.

- [ ] **Step 1: Failing tests:** `setCustom({ foo: '42' })`; `collectStats(['foo', 'CPU Usage'])` has `foo: '42'`; `collectStats(['CPU Usage'])` has no `foo`; `setCustom({ foo: '' })` removes it. MCP: `set_data` then `collectStats(['k'])` sees it; `POST /data` with `{"k": 1}` → 400, with `{"k": "v"}` → 204.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npm test && npm run lint`.
- [ ] **Step 5: Settings UI:** a "Data sources" group: rows of name / command / interval with add and remove; the hint says commands run on this computer with your user's rights, only while the device's current page shows that name.
- [ ] **Step 6: Device check:** a source `echo hello` named `studio_hello` bound to a data text item; on the device the text shows `hello` (fb11 grab). Restore the device.
- [ ] **Step 7:** Commit `Studio: custom data sources (MCP set_data, POST /data, commands)`.

---

### Task 7: Docs and wrap-up

**Files:**
- Modify: `app/README.md` (new "Info panel" section: select/drag/nudge/align/snap/z, add objects, background crop, data sources, MCP tools), `docs/superpowers/specs/2026-11-27-info-panel-editor-design.md` (status: built; note snap prefs live in `localStorage`, not the settings file), `PROGRESS.md`

- [ ] **Step 1:** Write the docs. **Step 2:** `npm test && npm run lint`. **Step 3:** Commit `docs: info panel editor` with the PROGRESS entry in the same commit.
