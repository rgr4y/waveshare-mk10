# Info panel editor (MK10 Studio)

Date: 2026-11-27. Status: Phase 0 done; design awaiting Rob's approval.

## Intent

Make the 240x296 info panel (GC9307, `fb11`; theme canvas x 656..896, y 0..296) editable in MK10 Studio,
per page, folders included. Today the editor draws it read-only (`renderWidgets()` in
`app/public/app.js`, `.secondary { pointer-events: none }`). The goal is a general editor: any theme,
any page, without hand-editing JSON.

## What exists (verified)

- Each page, top-level or folder, has its own panel items in `items[]`. Stock theme: folders 4, 7, 11
  carry a full panel; folders 2, 5, 6, 12 and pages 9, 10 have none.
- Panel item types: 114 image/GIF (background, `backgroundType=secondary`, 656,0 240x296), 113 text
  (static `text_str` or live `system_data_name`), 111 clock digits, 101/109 rings, 102 bars.
- Type 113 items have no `w`/`h`; size comes from the font.
- Live data: `lib/stats.js` pushes `key -> string` maps (V1 cmd 1). Text widgets show the value as is.
  The device fills `hour`/`minute`/`date` itself.
- Stock themes already use non-vendor data names (`avg_dB`, `Cpu温度`, `平均分贝`).
- Session undo is snapshot-based (`lib/session.js`, `undoStack`, 20 deep, key ops only).
- MCP edits show live in the UI (`lib/mcp.js`).

## Goals

1. Select a panel object. Move it by mouse drag, or nudge with arrows (1 px; Shift = 10 px).
2. Align the selected object to the panel: left / center / right, top / middle / bottom.
3. Snap to grid, toggle on/off, grid size setting. Snap applies to drag and nudge.
4. Add objects: static text, data text (bound to a data name), clock, bar, ring, small image/GIF.
   Delete objects. Edit each type's fields in the Inspector.
5. Background: choose an image and set it with Fit / Fill / Stretch / Manual (pan + zoom) in a
   crop window that shows the 240x296 bounds and the overflow dimmed outside them.
6. Works on every page and folder page, including pages with no panel items yet.
7. Undo (Cmd+Z) for every panel edit.
8. MCP tools that mirror the UI edits.
9. Stretch: custom data sources (any key name -> value) beyond the built-in stats.

## Non-goals

- Multi-select, groups, rotation.
- Video backgrounds on the panel. Animated GIF input is kept as GIF; no video -> GIF conversion.
- Editing key-area widgets (`backgroundType=child`, x < 656). Same code could later, not now.
- On-device changes. Everything must run on the stock firmware and LilAlpine as they are.

## Anti-goals

- Preview that lies. If the device draws something differently from the editor (font metrics, ring
  values), the editor must say so (hint text in the Inspector) rather than pretend.
- Theme files the vendor app or device can't load. Only add fields the device tolerates
  (`mk10studio*` string fields, tested 2026-11-25).
- Bloated themes. The push runs at ~300 KB/s over serial.

## Constraints

- Text width depends on the font. Center/right alignment for type 113 uses the width measured in the
  editor. The device may draw it a few px off.
- Background images must be exactly 240x296 so the device never scales anything (not verified whether
  it scales; avoid depending on it).
- The Mac could not reach the device at 10.0.1.48 on 2026-11-27 ("No route to host"); lenny could.
  Device tests go through lenny (`ssh -J lenny`, serial on lenny's `/dev/ttyACM0`).

## Approaches

- **A. Edit in place (chosen by Rob).** Make the existing `#secondary` panel interactive in the main
  canvas. Reuses selection, Inspector, snapshot undo and MCP live update. A zoom toggle scales only
  the panel (1x / 2x) because 240x296 at 1:1 is small.
- **B. Dedicated panel-editor view.** A separate full-size canvas. More room, but selection, undo and
  Inspector would be wired twice. About twice the work for what A's zoom covers.

## Design

### Phase 0: device test (no UI)

**Done 2026-11-27** on the MK10 through lenny. Details in `docs/theme-format.md`, "Info panel geometry
and data"; capture `docs/screenshots/panel-probe-fb11.png`. Device restored, sha-verified.

| Question | Answer | Effect on the design |
|---|---|---|
| x/y anchor | Top-left of the box for 113, 102, 101, 109, 114. 113's box is the line box (glyphs start a bit below y). | No conversion; bounds math is direct. |
| Sizes | 102 = `w` x `h`. 101 diameter = 2 x `radius` x `scale`. 109 diameter = 2 x `radius` at scale 1. | Bounds for gauges come from these formulas. |
| PNG background | Works (240x296 PNG as type 114). | Stills bake to PNG. |
| Draw order | The `z` field, not array order. | Editor renders and hit-tests by `z`; add Forward/Back buttons (edit `z`). |
| Custom data names | Shown, and listed in the device's cmd 15 request. Unasked keys are ignored. | Phase 4 can follow the request list. |
| Bar/ring values | 102 and 101 follow values; `50` and `20%` both work. 109 arc never moves. | 109 gets an Inspector hint ("static on device"). |
| Empty folder panel | Blank, also when opened from the parent. | Folder pages are plain pages. Rob's "copy on first edit" choice is not needed. |

Not probed: type 111 clock digits on the panel. Phase 2 checks it on the device when it adds the clock.

### Phase 1: select, move, align, snap

- `#secondary` gets pointer events. Click selects an item (`ui.sel = { kind: 'panel', page, index }`).
  The index into the page's `items[]` identifies the item. A thin outline and handles show the bounds.
- Bounds: `w`/`h` when the item has them; gauge diameters from the Phase 0 formulas; for 113, the size
  of the rendered DOM element.
- `draw()` sorts by `z` (replaces today's type rank), and click hit-testing picks the top-most by `z`.
- Forward / Back buttons in the align bar change the selected item's `z`.
- Drag moves it. Arrows nudge 1 px, Shift 10 px. With snap on, positions round to the grid; Option held
  during drag bypasses snap.
- Align bar (above the panel, visible when a panel item is selected): left/center/right,
  top/middle/bottom, relative to 240x296.
- Snap toggle and grid size (default 8 px) in the align bar, saved in Settings.
- Zoom toggle 1x / 2x for the panel only.
- Positions may go partly off-panel. The editor clamps only so the item can't be lost entirely.
- Delete / Backspace removes the selected item (not the background unless it is selected explicitly).
- Session: `panelMove(page, index, x, y)`, `panelDelete(page, index)`. One undo snapshot per drag
  (on drag start), per nudge burst, and per align click. Panel ops join `KEY_OPS` (same snapshot undo);
  other edits still clear the stack as today. (Builder call: undo for every edit type is out of scope.)

### Phase 2: add objects and edit fields

- "Add object" picker, same style as new keys: Text, Data value, Clock, Bar, Ring, Image.
- New items copy the field set from a stock item of the same type (templates kept in a JSON file next
  to `action-templates.json`), then set position to the panel center.
- Inspector per type:
  - 113: text or data name (dropdown of known names from `stats.js` `ALL_STATS`, plus `hour`, `minute`,
    `date`, plus free text), font, size, color.
  - 111: data (`hour`/`minute`), digit count, text font or glyph set (`PictureFont`).
  - 102: data name, size, colors, corner radius.
  - 101/109: data name, radius, colors. 109 shows a hint: the device draws it static, values don't
    move it. The picker offers 101 as "Ring"; 109 is edit-only (existing items).
  - 114 (non-background): image or GIF file, size.
- Session: `panelAdd(page, type, fields)`, `panelSet(page, index, fields)`.

### Phase 3: background crop

- Click the panel background (or "Background…" in the page Inspector) to open a modal.
- The modal shows the image with a 240x296 window. The image outside the window is shown dimmed. Drag to
  pan, scroll or slider to zoom. Presets: Fit (contain, fill color for the rest), Fill (cover, centered),
  Stretch (ignore aspect), Manual.
- Apply bakes a 240x296 PNG (stills) or GIF (GIF input, ffmpeg crop+scale with palette) through
  `lib/media.js`, and sets or creates the type 114 item at 656,0 240x296, `backgroundType=secondary`.
- Re-crop: the item gets an `mk10studioCrop` string field with the source file's path on this computer
  and the crop parameters. Originals are not stored in the theme (GIF originals would bloat pushes).
  Opening the modal again starts from them if the source file still exists; otherwise it asks for a
  file. Any other way of setting the background drops the field.
- Pages with no background get "Add background".
- Session: `panelBackground(page, file, crop)`.

### Phase 4 (stretch): data sources

- MCP tool `set_data({ key: value, ... })` and a local endpoint on the MCP server port (127.0.0.1) that
  takes the same JSON. Values are merged into the map `stats.js` pushes.
- Settings: optional command sources (`name`, shell command, interval). Stdout trimmed = value.
- Custom names appear in the 113 data-name dropdown.
- The device lists custom names in its cmd 15 request (Phase 0), so custom keys follow the same rule
  as stats: pushed when the current page requests them, and command sources run only while requested.

### MCP

`add_panel_item`, `set_panel_item`, `move_panel_item`, `delete_panel_item`, `set_panel_background`
(with fit/fill/stretch or crop rect). Thin wrappers over the session methods.

## Left to the builder

- DOM structure of the handles, align bar layout and icons.
- Exact template field values for new items (from stock items).
- ffmpeg filter details for the crop.
- Test split: session methods get `node --test` coverage (move/add/delete/undo, crop math); UI is
  checked with `--screenshot` and on the device.
