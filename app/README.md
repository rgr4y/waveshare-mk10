# mk10-studio

Electron host for the Waveshare MK10 key panel (ScreenKey replacement).

- `lib/` core library (QDataStream, .Theme codec, serial framing, device). `npm test`, `npm run lint`.
- `npm run cli -- <cmd>` for theme info/roundtrip and device calls (`MK10_PORT` overrides port detection).
- Format docs: `../docs/theme-format.md`.

## Usage

```
npm install
npm start          # or: npm run serve  (launch the Electron editor)
npm run dev        # same, reloads the window when public/ changes
npm test           # node --test lib/
npm run lint       # npm run lint:fix to autofix
npm run cli -- ...  # headless theme info/roundtrip/device calls (runs under Electron's Node: serialport reads hang under Node 26)
```

Editor: Open a `.Theme` (the dialog starts in the stock ScreenKey theme dir when present; the stock
`defaultTheme.Theme` opens fine, edits are saved wherever you choose, so use Save As to keep the original).
Click a key to edit its title or replace its image (or drop an image on the key); click the background
video area, or drop a video on it, to replace the video (transcoded with ffmpeg to 640x256 h264).
Key actions are shown read-only for now. The last opened file is reopened on start.

Dev flags: `--open <file>`, `--select <page>,<row>,<col>` (or `<page>,video`), `--screenshot <out.png>` (capture after ~3 s and quit).

Needs `ffmpeg` on PATH (`FFMPEG` env overrides).

### MCP
The first-run dialog offers it, ticked by default (with Start at login). Enable it in Settings (Cmd+,) or from the tray menu; port
default 47110, bound to 127.0.0.1. The URL and the `claude mcp add` command show when on. Edits made via
MCP appear live in the UI.

### Key clipboard
Right-click a key (or an empty slot) for Cut, Copy, Paste and Delete Key. With no text field focused,
Cmd+X / Cmd+C / Cmd+V act on the selected key or slot, Backspace/Delete clears it, and Cmd+Z undoes the
last cut, paste or delete (up to 20; any other edit clears the undo list). The clipboard holds the key
as plain-text JSON with its images embedded, so it pastes into another theme or another running copy.
Paste replaces the key in the target slot or fills an empty one. MCP: `copy_key` and `paste_key`.
A cell covered by a key-area widget (clock digits, GIF, gauge) is not empty: the editor draws it and
Paste refuses it.

Pull from device (top bar, or File > Pull from Device…) downloads the theme the device loads
(`config.json` `defaultTheme`) over ssh, saves it where you choose and opens it. LilAlpine only: the stock
firmware's USB API has no file read. Push and pull share one lock. Key capture is in Settings.

Right-click > Press Key follows a navigation key in the editor: openPage opens its folder, oneLevelUp
goes to the parent, pageSwitch (pageSwitchMode 0) goes to top-level page `jumpToPage`. Other actions run
on the device or host, so the status line only names them.

### Key capture (proof of concept)
The red **Capture keys** button opens a window that logs every key press from two sources: what the app
receives (`before-input-event`, menu shortcuts blocked while it has focus), and raw HID usages from
`native/hidtap` (IOHIDManager, passive: keys still work). HID covers consumer keys macOS handles itself
(volume, brightness, media) and F13-F24. It needs Input Monitoring (in a dev run the grant shows as
"Electron"). The helper is compiled with `swiftc` on first use into `native/build/` (gitignored).
While the window is open, every event is also written as a JSON line to stderr, and in dev runs
appended to `/tmp/mk10.log`. **Save log…** writes the same lines to a file you choose.

### Resident app
- **Tray**: a text-only "MK10" item in the menu bar. Menu: current theme name, Open MK10 Studio, Push to
  device (disabled with no theme open), MCP server (checkbox, starts and stops it), Quit MK10 Studio.
- **Close to tray**: the window's close button hides it; the theme, unsaved edits and MCP keep running.
  The Dock icon shows only while the window is visible. Clicking the Dock icon or "Open MK10 Studio"
  brings the window back.
- **Quit**: Cmd+Q or the tray's Quit really quits. With edits that are unsaved, or not yet pushed to
  the device since the theme was opened or last pushed, it shows the window and asks: Cancel, Push to
  Device… (when unpushed; runs the normal push, then you quit again), or Discard changes / Quit anyway.
- **Single instance**: launching a second copy focuses the running window instead.
- **Start at login**: checkbox in Settings > General and in the first-run dialog. A login launch, or
  `--hidden`, starts in the menu bar only (no window, no Dock icon). The OS login item is the source of
  truth for the checkbox.
- **Permissions**: Settings > Permissions is read-only. It shows Accessibility and Screen Recording
  status (polled every 2 s while Settings is open) and Open buttons for the Accessibility, Screen
  Recording and Automation panes in System Settings. Nothing is requested at startup. The Accessibility
  button triggers the system prompt at most once per session, then opens the pane.

### Push to device
"Push to device" encodes the in-memory theme and makes it the active layout. Mode is picked in the
inspector (stored in `settings.json` under Electron's userData dir):

- **Auto** (default): before each push, checks the ssh host for `/etc/alpine-release`. LilAlpine pushes over
  ssh; otherwise, if an MK10 USB serial port is present (stock firmware), over USB serial. With neither, the
  push fails with an error instead of guessing.
- **USB serial** (verified on KeyboardDevice V2.34 under LilAlpine): writes the theme to a new
  `/data/theme/MK10/mk10studio-<timestamp>.Theme` with `saveToFile` + `setFileCRC`, sends the V1 reload
  command (cmd 2), which loads it and rewrites `/mnt/SDCARD/config.json`, then deletes older
  `mk10studio-*.Theme` pushes. A failed push leaves the active theme alone. About 10 s for 12 MB.
  Close the vendor ScreenKey app first; it holds the port.
- **ssh** (LilAlpine): scp, edit `config.json`, `rc-service keyboard-device restart`. Needs key-based ssh.

The app never sends `getInfo`: on the device it blanks the main panel and kills the video player
until a reload or restart.

### Env vars
`MK10_PORT` serial port override (CLI/device), `FFMPEG` ffmpeg binary.
