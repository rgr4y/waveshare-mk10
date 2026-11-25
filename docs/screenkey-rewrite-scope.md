# MK10 host app rewrite — scope

2026-11-24. Answers the six questions in `docs/screenkey-host-rewrite-handoff.md`.
Stack decision (Rob): **Electron**. Working name: **mk10-studio** (`app/`).

Labels: **[verified]** = checked against our files/device this session;
**[3p]** = claimed by a third-party reverse-engineering repo, not yet checked by us;
**[guess]** = inference.

## TL;DR

- No fuller vendor source exists. **Rewrite**, don't clean up. [verified]
- Several community reimplementations exist (MK20/SK18, one Electron SK18 editor). Use them
  as reference. Only Terminus (MIT) is safe to port code from. The others are GPL-3.0 or unlicensed.
- `.Theme` = bare big-endian QDataStream: header map, a JSON page tree, and a path→blob asset
  map (every PNG/GIF/MP4 embedded). Byte-exact decode→encode works (`tools/qtheme.py`). [verified]
- Most features **render on the device** from the `.Theme`. The host only (a) pushes theme files,
  (b) feeds sensor/weather values, and (c) runs host-side actions (open URL, launch app, OBS, HA).
- Key presses: the GD32 is its own USB HID keyboard (`4250:426F`, QMK/VIA), so hotkeys work with no
  host app. Host actions need `keyStateChanged` events over the ACM serial port.
  [verified enumeration; event capture still needs Rob at the keys]
- MCP server lives **inside** the Electron app (localhost HTTP, opt-in toggle). The serial port
  is exclusive, so a separate stdio MCP process would fight the app for it.

## 1. Source

| Source | Contents | Verdict |
|---|---|---|
| `waveshareteam/Waveshare-ScreenKey` | README stub; Releases = closed `.exe`/`.dmg` | nothing |
| Waveshare org (217 repos), `gh search code` for protocol strings | no hits under waveshareteam | nothing |
| EN wiki / Google Drive zip | `OpenSourceLicenseDemo_V1.0` (~1.2k lines Qt) + firmware images | protocol reference only |
| CN wiki Baidu Pan (`wxdz`) | not downloaded; README notes same products | assume same (low risk) |
| `Terminus-Geospatial/Terminus-MK20-Tools` | **MIT**, Python: protocol, client, theme, profile + ~700-line protocol doc | **port-safe** |
| `alexmuraru27/MK20Control` | GPL-3.0 C#, most complete MK20 spec + pcaps + tests | read only (GPL) |
| `indiealexh/waveshare_sk18_ctlhost` | no license, Flutter; covers **MK10**, cites KeyboardDevice V2.32 addresses | read only |
| `jzellis/sk18-editor` | no license, **Electron/TS** SK18 editor (`qdatastream.ts`, `theme-io.ts`) | read only, UX reference |
| `elpapimango/sk18-image` | Apache/MIT mainline Linux for SK18 (DTS, panel driver) | relevant to v2 device side |

Clones: `src/community/`. Third-party docs are not byte-level truth. Example: ctlhost says the
wire magic is `5E 5A A5 A1`, but our working `mkproto.py` sends `A1 A5 5A 5E`. Trust the demo source and the device.

## 2. Feature inventory

Host and device share one codebase (`../PCMonitorLinux2/…` paths in both binaries), so a string
in the host binary doesn't prove where a feature runs. The table classifies by device-binary presence.

| Feature | Rendered | Host role | Storage / transport |
|---|---|---|---|
| Key tile: image, GIF (frame PNGs + delays), title/font/colour, sound | device | none at runtime | `.Theme` item type 115 |
| Pages / folders / pageSwitch / oneLevelUp / openPage | device | none | `controlData` types |
| Hotkey (`keyboard`: keycode, keyString) | device → GD32 HID [guess on exact path] | none | `controlData` `keyboard` |
| Text / password input | device (`keyboardInput`, `qmk_string`) | maybe auto-paste [guess] | `controlData` `password`/`text` |
| Open URL, launch app, open file/dir, window ops, screenshot, play music, system volume/media | — | **host executes** on key event | `controlData` (host-only types) |
| Main-screen background video | device (`videoplayerinterfaceAPP`) | none | type 100, mp4 embedded in `.Theme` |
| Info panel 240×296: text, GIF, arc/ring/bar gauges, digit clock | device | **feeds values** | types 113/114/109/101/102/111 + `system_data_name` |
| PC stats (CPU/GPU/RAM/disk/net/temps) | device draws | host collects + pushes (`SEND_SYSTEM_DATA_TO_DEVICE`, wire format **unknown**) | macOS source: bundled `btop` |
| Clock (digital/analog) | device (`DateTimeManager`) | maybe time sync [guess] | type 111/113 |
| Weather | device draws | host fetches OpenWeatherMap + pushes | system data |
| Audio spectrum / dB | device (ALSA mic + FFTW) | none | theme item |
| OBS / Home Assistant | device shows state | host WebSocket clients | system data + events |
| XiaoZhi AI | device | toggles | disabled on our image — skip |
| Device volume 0–7 / backlight 0–100 | device | JSON `setVolume`/`setBacklight` | |
| Boot logos | U-Boot | host generates `mk10.bin` (RGB565 LE 240×296) + `bootlogo.bmp` (24-bit 160×160) | FAT p1 `/mnt/SDCARD` |
| Live JPEG mirror | device | host streams cmd 100 | no vendor UI uses it; `mkpush.py` does |
| Theme store, QMK firmware update | — | `cbytecat.com` | **out of scope** |

Device JSON registry (in registration order): `getInfo setBacklight setVolume saveToFile setFileCRC
deleteFiles getFilesBySuffix playAudio stopAudio keyboardInput`. The longer list in the handoff is mostly
Qt signal names, not callable methods [guess; probe with a bogus method].

## 3. Theme format

Full schema: `docs/theme-format.md`. Codec: `tools/qtheme.py` (Python) and `app/lib/theme.js`
(Node, being built). Summary:

1. Header `QVariantMap`: `keyMacro` (null QByteArray), `keyMacroValue` (92-byte magic), `language`.
   [3p] A wrong `keyMacroValue` silently disables `text` actions, so preserve it.
2. u32 0.
3. QByteArray of indented UTF-8 JSON: `{main:{currentPage,version:"V3.0"}, pages:[{pageName,parentPageName?,canvas,items[]}]}`.
4. `QMap<QString,QByteArray>` assets keyed by device path (`/theme/MK10/MainScreen/<uuid>.mp4`, `/image/MK10/...png`).
5. u32 0.

`controlData` = base64 of a nested QVariantMap. [3p] Field set and order must match the vendor exactly,
or the firmware ignores the action. **Rule for the editor:** mutate in place and keep unknown
items and fields. New actions are cloned from a known-good template taken from the stock theme,
never synthesised from scratch.

Round trip: decode→encode is byte-identical [verified]. Edited themes load and render on the device
[verified]: new key title, new key image, and a new embedded background mp4 (the device extracts
assets itself on load). Details are in `docs/theme-format.md` § Device verification and § Serial protocol verification.

## 4. Where actions run

- **GD32 = USB HID** `syk_keyboards` `4250:426F`: keyboard, mouse, consumer, system control, and VIA raw HID
  (`FF60/61`). The macro buffer (`dynamic_keymap_macro_set_buffer`) lives in GD32 flash. Hotkeys therefore
  work with no host app. [verified enumeration]
- **T113 gadget** has only ACM + adb, no HID function. [verified]
- **Host actions** (URL, app launch, OBS, HA) need the host to receive JSON
  `{"method":"keyStateChanged","parameters":{"col","row","pressed",…}}` over ACM (vendor demo
  `mainwindow.cpp:565`). Verified on MK10: one frame per press and one per release, `{col,row,pressed}`,
  after `getInfo` switches the device to "V2" mode [verified, 2026-11-24].
- **`getInfo` blanks fb0 and kills the video player** [verified]. Closing the port doesn't undo it.
  A V1 reload (cmd 2) restores the layout, even while still in V2 [verified]. getInfo → reload
  keeps V2 key events flowing with the layout up [verified 2026-11-24]. Host actions are unblocked.
- App recipe: open port, send `getInfo`, then reload the active theme, then listen. Presses during the ~3.5 s
  reload are delivered late, not lost.

## 5. Stack: Electron

Decided. Shape:

```
app/
  main.js        Electron main: owns serial port, theme state, MCP server
  preload.js     contextBridge IPC
  cli.js         same lib, headless (scripting/CI)
  lib/           qdatastream, theme, proto, device — pure Node, tested with node:test
  public/        index.html, styles.css, app.js (no bundler, <template> rendering)
```

- **No TS, no bundler, no React.** The UI is small: a canvas mock of the 896×304 panel, a key grid, and an
  inspector. Add a bundler only if the UI outgrows that.
- **Serial:** `serialport` 13 in main. Prebuilt bindings load in Electron 45 arm64 [verified]. Under
  **Node 26** reads stall [verified, cause unknown]: one run got ~100 replies and then hung, and later runs
  saw the reply only on close. Under Electron's Node 24.22 a reply arrives in 5 ms. So the CLI runs via `ELECTRON_RUN_AS_NODE=1 electron` (`npm run cli`).
- **MCP:** `@modelcontextprotocol/sdk` Streamable HTTP on `127.0.0.1:<port>`, off by default, toggled
  in settings. Tools are thin wrappers over `lib/`: `list_pages`, `get_page`, `set_key_title`,
  `set_key_image` (path or base64), `set_key_action` (template-cloned), `set_background_video`,
  `save_theme`, `push_theme`, `device_info`. Edits land in the same in-memory theme the UI shows, so
  the user sees them live and can undo or save.
- **Video:** transcode user files with ffmpeg (system binary first, `ffmpeg-static` later) to the stock
  mp4 parameters (codec/res/fps from `ffprobe` of the stock files).
- **Rejected:** a PWA or web page with Web Serial can't run host actions (launch app, global hotkeys) or
  host an MCP server. SwiftUI is Mac-only and would mean rewriting the codec. PySide6 bundles poorly
  and has a weaker editor UX ceiling.

## 6. Device-side boundary

v1 keeps `KeyboardDevice` as the renderer and speaks its protocol and file format. Theme push is
protocol-only [verified against vendor `KeyboardDevice` V2.34 running on LilAlpine; stock Tina untested]: `deleteFiles`, then `saveToFile` chunks +
`setFileCRC`, then V1 reload cmd 2. That is about 10 s for 12 MB. ssh + `rc-service` remains as a LilAlpine option.
v2 option: a replacement renderer on Alpine (fb0 + fbtft panels directly, own JSON format).
`elpapimango/sk18-image` shows the mainline route for the sibling SK18. Out of scope.

## Phases

| # | Phase | Contents | Effort |
|---|---|---|---|
| 1 | Core spike | Node codec + framing + device client + CLI; edited theme renders on device; bg video swap | **done 2026-11-24** |
| 2 | MVP editor | Electron shell: open `.Theme` (stock included), page list, panel preview, key image/title, bg video replace, save, push. MCP server toggle | **done 2026-11-24**: in-app MCP → live UI update → push verified on the device. The renderer buttons (title box, Replace…, drag-drop) are not yet clicked by hand. |
| 3a | Resident app | Menu-bar tray, close-to-tray, Dock icon only while the editor is open, single instance; first-run onboarding (MCP off by default); start at login (`--hidden`); read-only permissions status (see "macOS permissions"). The long-lived serial owner and key events on connect were dropped 2026-11-24: the device is reached over ssh/scp. **built 2026-11-24**, hand checks pending (validation §7b) | 0.5–1 day |
| 3b | Actions | Key event listener → run the key's action from the open theme: URL, app, file/dir, shell cmd, password paste; action-value editing **done 2026-11-24** | 2–3 days |
| 3c | Action palette | Drag an action type from a grouped, searchable list onto a key (vendor UX). Templates come from real vendor examples, because field order differs per type and the firmware ignores bad fields. All 17 types are in `app/lib/action-templates.json` (from the vendor allThemeTest) | 1–2 days |
| 3d | Key clipboard | Cut, copy and paste keys (Cmd+X/C/V and the context menu), within a theme and across themes. See "Key clipboard" below. **built 2026-11-24**, hand checks pending (validation §5b). Not built: the copy flash, and greying Edit > Paste (it stays enabled for text fields; the right-click Paste does grey out) | 0.5–1 day |
| 4 | Parity | Info-panel widgets editing; sensor feed (V1 cmd 1, format known; answer `deviceRequestSystemData`); weather; boot logo export | 1–2 weeks |
| 5 | Polish | Profiles, theme import/merge, packaging + Developer ID signing + notarization | 3–5 days |

## Key clipboard (Phase 3d)

- The clipboard holds plain-text JSON, so a key can be pasted into another theme, another app instance, or a text editor for inspection:
  `{"mk10studio": "key", "v": 1, "item": {…type 115 item, minus row/col…}, "assets": {"<asset key>": "<base64>"}}`.
- `assets` embeds the key's image (or the GIF frame directory) so the paste works when the target theme lacks those files. On paste, the assets get new UUID keys, and `path`/`paths` are rewritten to them.
- Detection: when the window gets focus or the selection changes, read the clipboard and parse it. Paste is enabled only for an object with `mk10studio: "key"` and a supported `v`, and an `item` that has `controlData` that decodes. Anything else leaves Paste disabled, without an error.
- Paste onto a key replaces it. Paste onto an empty slot creates the key there. The target `row`/`col` come from the selection, not from the clipboard.
- Cut = copy, then remove the key item; the slot becomes empty. Removed assets are dropped only when nothing else references them (`dropIfOrphan`).
- Page references: an openPage or pageSwitch action whose `pageName` does not exist in the target theme pastes with a warning in the log; the key stays as pasted.
- MCP: `copy_key` returns the same JSON, and `paste_key` accepts it.
- Shortcuts: Cmd+X, Cmd+C and Cmd+V act on the selected key whenever no text field has focus. You never need to click into anything first. Cmd+Z undoes a cut or paste. Delete/Backspace clears the key, the same as a cut without the copy.
- Text fields keep normal text copy/paste. The handler checks `document.activeElement`, and the Edit menu entries route to key actions only when no input has focus. This is the same rule the Esc deselect uses.
- The Edit menu shows Cut, Copy, Paste and Delete Key with their accelerators. Paste is greyed out when the clipboard holds no compatible key. A right-click on a key opens the same context menu.
- Feedback: after a copy, the key briefly flashes, and the status line says "Copied key r0 c1". A paste selects the pasted key.
- Open: multi-select (copy a whole row or page) is not in this phase.

## macOS permissions (Phase 3a onward)

What each feature needs from macOS. "[verified]" means it was tested on this Mac; everything else is from Apple docs and general practice, so check it when the feature is built.

| Feature | Permission / mechanism | Notes |
|---|---|---|
| Serial port `/dev/cu.usbmodemMK10*` | none | Plain POSIX open; already working [verified]. One process at a time, so vendor ScreenKey must be quit. |
| MCP server on `127.0.0.1:47110` | none | Loopback does not trigger the application firewall. |
| ssh push to `10.0.1.48` | **Local Network** (macOS 15+) | Contacting LAN hosts can prompt once for the responsible app (Electron). Not seen yet; check whether `ssh` spawned from Electron counts. |
| Open URL / app / file | none | `shell.openExternal`, `shell.openPath`, `open -a`. |
| Shell command action | none from macOS | User-authored commands run with the user's rights. Treat this as code execution: confirm the first time per key. |
| Password paste / type text, media keys, window ops | **Accessibility** (`kTCCServiceAccessibility`) | Needed to post synthetic key events (`CGEventPost`). Hotkeys don't need it, because the GD32 sends them as a real USB keyboard. |
| Control other apps via AppleScript (Music, Finder, OBS…) | **Automation** (Apple Events, prompt per target app) | Needs `NSAppleEventsUsageDescription` in Info.plist and the `com.apple.security.automation.apple-events` entitlement under the hardened runtime. |
| Screenshot action | **Screen Recording** (`kTCCServiceScreenCapture`) | macOS 15 re-prompts periodically for screen capture. |
| System volume | none (`osascript -e 'set volume …'` targets StandardAdditions in-process) | Check that it causes no Automation prompt. |
| Stats: CPU / RAM | none | `os` module and `vm_stat`. |
| Stats: GPU utilisation | none | `ioreg -r -c IOAccelerator` → `PerformanceStatistics` "Device Utilization %"; no root. |
| Stats: temperatures | no public API | SMC/IOHID sensors are private; `powermetrics` needs root. Leave out or mark unsupported. |
| Start at login | Login Items (`app.setLoginItemSettings` → SMAppService on macOS 13+) | The user gets a "background item added" notification; manage it in System Settings → General → Login Items. |
| Notifications (push done, device lost) | Notifications prompt | Optional. |
| Input Monitoring | **not needed** | We never read the Mac keyboard; key events come from the device over serial. |

Signing matters for all of the TCC grants above. macOS keys each grant to the app's code signature:
- In dev, grants attach to `node_modules/electron/dist/Electron.app` and can reset when Electron is reinstalled or upgraded.
- A distributed build needs Developer ID signing, the hardened runtime with the entitlements above, and notarization, or Gatekeeper blocks it and grants don't stick. That is Phase 5.

Onboarding: the tray app checks each permission only when a key that needs it is first used. `systemPreferences.isTrustedAccessibilityClient(false)` covers Accessibility, `getMediaAccessStatus('screen')` covers Screen Recording, and there is a prompt helper for Automation. On a miss, it explains why and opens the right System Settings pane (`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` and similar). Nothing is requested up front.

## Open risks

1. ~~**Key events + layout together.**~~ Solved: getInfo → V1 reload gives the layout and key events [verified].
   Watch for: anything else that sends getInfo (vendor app) blanks the layout again.
2. ~~Theme switch over protocol~~ is solved: V1 cmd 2 [verified].
3. ~~Sensor push wire format~~ is solved: V1 cmd 1 with a UTF-16BE string map [verified 2026-11-24, from Terminus-MK20 §5.3].
   Text widgets update. The type 109 ring arcs did not move on the stock page; 101/102 are untested.
   After a reload the device lists the keys it wants (`deviceRequestSystemData`, V1 cmd 15). See theme-format.md.
4. **controlData strictness** [3p]. Mitigated by template cloning.
4b. **Extracted-asset leak.** On every theme load the device extracts its assets to `/data/<asset key>`.
   Each push with new images or video leaves uuid files under `/data/image/MK10/cache/` and
   `/data/theme/MK10/MainScreen/`. There is no protocol call to list them, so for now clean up over ssh. Fix idea: reuse asset keys per key slot.
5. **The vendor app running concurrently** grabs the same serial port. The app must detect this and say so.
6. **Electron footprint** of about 250 MB. Accepted.
