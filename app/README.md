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
Toggle "MCP" in the top bar (port default 47110, bound to 127.0.0.1). The URL is shown when on; point an
MCP client at it. Edits made via MCP appear live in the UI.

### Push to device
"Push to device" encodes the in-memory theme and makes it the active layout. Mode is picked in the
inspector (stored in `settings.json` under Electron's userData dir):

- **USB serial** (default; verified on KeyboardDevice V2.34 under LilAlpine): writes the theme to a new
  `/data/theme/MK10/mk10studio-<timestamp>.Theme` with `saveToFile` + `setFileCRC`, sends the V1 reload
  command (cmd 2), which loads it and rewrites `/mnt/SDCARD/config.json`, then deletes older
  `mk10studio-*.Theme` pushes. A failed push leaves the active theme alone. About 10 s for 12 MB.
  Close the vendor ScreenKey app first; it holds the port.
- **ssh** (LilAlpine): scp, edit `config.json`, `rc-service keyboard-device restart`. Needs key-based ssh.

The app never sends `getInfo`: on the device it blanks the main panel and kills the video player
until a reload or restart.

### Env vars
`MK10_PORT` serial port override (CLI/device), `FFMPEG` ffmpeg binary.
