# ScreenKey `.Theme` file format (MK10 `defaultTheme.Theme`)

Decoder/encoder: `tools/qtheme.py` (stdlib only); round-trip test: `tools/test_qtheme.py`.
Host copy == device copy `/data/theme/MK10/defaultTheme.Theme`:
sha256 `88785d8bcaabb985c7811f25cbb299b81214307830a53187e2888c67d89cc7ca`, 13,198,510 bytes.
decode -> encode reproduces that sha256 exactly. Items marked (guess) are not verified.

## Container

Bare Qt `QDataStream`, big-endian. No magic, no version header (the stream version is not
stored; every type used encodes identically across Qt 4.x-5.x, so 5.12 is consistent but not provable
from bytes). Five consecutive objects, file ends exactly after the last one:

| # | object | encoding |
|---|--------|----------|
| 1 | `QVariantMap` header, 3 entries | u32 n; n x (QString key, QVariant) |
| 2 | u32 `0` | (guess) empty map/list or padding; decoder errors if nonzero |
| 3 | `QByteArray` JSON | u32 len (191,228), UTF-8 JSON, 4-space indented, trailing `\n` |
| 4 | `QMap<QString,QByteArray>` assets, 402 entries | u32 n; n x (QString path, QByteArray blob); keys sorted (UTF-16 order) |
| 5 | u32 `0` | (guess) as #2 |

Primitives: QString = u32 byte-length (0xffffffff = null) + UTF-16BE; QByteArray = u32 length
(0xffffffff = null) + bytes; QVariant = u32 type id + u8 is_null + payload. Type ids seen:
1 bool (u8), 2 int (i32), 10 QString, 12 QByteArray (8 QVariantMap is accepted by the reader but not present). Any other id raises.

### Header map (#1)
| key | type | value | meaning |
|-----|------|-------|---------|
| `keyMacro` | QByteArray | null (len 0xffffffff, is_null flag 0) | (guess) physical-key macro blob, unused |
| `keyMacroValue` | QByteArray | 92-byte ASCII base64 of `00000010` + 64 zero bytes | (guess) QDataStream of 16 x u32 zero = 16 empty hardware-key macro slots |
| `language` | int | 0 | (guess) UI language index |

### JSON (#3) schema
Top: `{ "main": {"currentPage": <page uuid>, "version": "V3.0"}, "pages": [13 pages] }`.
All leaf values are strings, except `canvas` (ints/bools). Numbers-as-strings throughout.

Page: `pageName` (uuid), optional `parentPageName` (uuid of page 0 = folder/child page), `canvas`
(`canvas_w`=896 int, `canvas_h`=304 int, `canvas_flip`/`canvas_rotate`/`showUnit` bool; absent on page 6),
`items[]`. 13 pages: 6 without `parentPageName` (indices 0,1,3,8,9,10), 7 children of
page 0 (`a64a0235-...` = currentPage). Pages 6, 9, 10 have no items.

Canvas layout (derived from x/y/maxWidth values): 896x304 virtual canvas. Key grid + main screen
occupy x 0..640, y 0..256 (5 cols x 2 rows of 128 px: `col` 0-4, `row` 0-1, `x`=col*128, `y`=row*128).
The info panel (secondary screen) occupies x 656..896, 240x296 (guess from type-114 `maxWidth/Height` 240x296 and item x of 656+).

Common item keys: `id`, `type`, `x`,`y`,`z` (z=-2 for main bg video), `scale`, `rotate`, `lock`
(always "1"), `backgroundType` (`main` | `secondary` | `child`; absent for keys), `backupX`/`backupY`
(guess: saved alt position), `itemName`, `path`, `paths`, `w`/`h`, `maxWidth`/`maxHeight`.

Item `type` ids (counts over all pages; meanings are guesses from key sets):

| type | n | role | type-specific keys |
|------|---|------|--------------------|
| 100 | 4 | main-screen background video (`backgroundType=main`, 640x256, z=-2) | `path` -> `.mp4` asset key |
| 101 | 6 | circular progress ring, secondary | `radius`,`margin`,`back_color`,`front_color`,`system_data_*` |
| 102 | 8 | progress bar | `w`,`h`,`corner_radius`,`border_*`,`lineargradient_*`,`front_color`,`back_color` |
| 109 | 7 | arc gauge | `angleMin/MaxValue` (225/315), `arcRadius`,`arcCircularInterval`,`gradientColor1-3`,`radius` |
| 111 | 6 | digital clock / picture-font digits (`backgroundType=child`) | `displayNum`,`displayType`,`transition`,`paths` -> `/image/MK10/PictureFont/...` dir, `text_font`,`system_data_name` (hour/minute/date) |

Type 111 rendering (seen in the stock theme and mk10studio.Theme, 2026-11-24): on page 8, `displayType` is 1 and `paths` points to a directory of glyphs, `/image/MK10/PictureFont/点数字/0.png`–`9.png` (the dot font). On page 3, `displayType` is 0, `paths` is empty and `text_font` is "Microsoft YaHei". Checked on the device framebuffer (2026-11-24, LilAlpine, `/dev/fb1`-`fb10` are the key panels, 128x128 RGB565): page 8 draws the dot glyphs, each glyph scaled with its aspect kept into a `w/displayNum` slot (64x64, vertically centred, for 2 digits in 128x128). Studio draws them that way. Page 3 (`displayType` 0, empty `paths`) draws text in the `text_font` family (Microsoft YaHei, which the device has at `/usr/share/fonts/msyh.ttc`; the device's Qt uses `QT_QPA_FONTDIR=/usr/share/fonts`), regular weight, white, digits about 74 px tall in a 128 px cell, centred. The `12` point size in `text_font` is not what it draws.
| 113 | 65 | text label | `text_str`,`text_font` (QFont string),`front_color`,`text_customFont_*`,`system_data_flag`,`system_data_name` |
| 114 | 14 | dynamic image (gif) on secondary/child | `path` (.gif asset), `system_data_name` |
| 115 | 65 | physical key (the 128x128 LCD key) | `row`,`col`,`title`,`titleParam` (JSON string: font/colour/alignment),`soundFile`,`opacity`,`controlData` (action), `path` (static icon) / `paths` (dir of frame_N.png) + `frameDelays` (ms, CSV) for animated icons, `scaledWidthTo/HeightTo` 128 |

Extra fields (tested on the device 2026-11-25, KeyboardDevice V2.34 on LilAlpine): a key item with an added string field (`"mk10studio": "{\"studioTest\":1}"`) and two added controlData fields (`mk10studioExtra` QString, `mk10studioInt` int) loaded with no log error, drew normally, and its openPage action still worked. So Studio can keep its own per-key data (e.g. host-only actions) in a `mk10studio` string field. Not tested: whether the vendor Mac app keeps unknown fields when it re-saves a theme (its saves rebuild items).

Multi-state keys (seen 2026-11-24 on a `keyboard_switch` key, mk10studio.Theme page 9): the type 115 item has a `jsonData` string field, `{"isMultiState":true,"State":0,"States":[{"path","paths","title","frameDelays","keycode","keyString"}, ...]}`. Each press moves to the next state; the device shows that state's image and title and sends its `keycode` (HID usage: 10 = G, 4 = A). `State` is the state it starts on. The item's own `path` (`/static/icon/dark/keyboard_128x128.png`) is not what the device draws. The controlData for `keyboard_switch` holds no keys; they are only in `jsonData`.

`system_data_name` values seen include `CPU Usage`, `GPU...`, `date`, `hour`, `minute`, `randomNumbers`, `平均分贝`
(data source for gauges/labels; `system_data_flag` "1" = bound to live data (guess)).
Colours are strings `r=..,g=..,b=..,a=..`; fonts are `QFont::toString()` (`Arial,72,-1,5,75,0,0,0,0,0`).

### Key actions: `controlData`
Key (type 115) action is `controlData` = base64 of a nested QDataStream `QVariantMap` (u32 n, QString key,
QVariant value; all values here QString/int/bool). Verified by full parse (every byte consumed) for all 65 keys. Decoded `type` (key in the nested map):

| `type` | n | extra keys |
|--------|---|------------|
| `keyboard` | 24 | `keycode` (int, e.g. 262 = `L Ctrl C`), `keyString`, `description`, `parentDescription`, `iconPath` |
| `openWeb` | 25 | `Url`, `description`, `iconPath`, `AISoundControlKeyword` |
| `oneLevelUp` | 6 | `pageName`="parentPage" |
| `openPage` | 2 | `pageName` = uuid of the target (folder) page |
| `pageSwitch` | 7 | `pageSwitchMode` (int), `jumpToPage` (int: index among top-level pages, i.e. pages without `parentPageName`, in theme order; not the theme page index. Checked on the device 2026-11-25) |
| `password` | 1 | `password`, `isCopyPaste`, `isInputEnter` |

(Strings like `键盘`, `页面切换` are Chinese UI labels, host-GUI display only.)

### Assets (#4): 402 blobs, all referenced by items (0 unreferenced, 0 dangling)
| key prefix | n | format |
|------------|---|--------|
| `/image/MK10/...` (key icons, `cache/<name>/frame_N.png` animation frames, `PictureFont/*.png`, ApplicationIcon, Screenshot) | 373 | PNG |
| `/image/128x128/ApplicationIcon/*.gif` | 5 (+1 png PictureFont) | GIF (89a) |
| `/image/240x296/ApplicationIcon/*.gif` | 5 | GIF, secondary-screen animations (up to 3.6 MB) |
| `/plugins/SYK/Windows/actionIcons/*.png` | 9 | PNG |
| `/static/icon/dark/*.png` | 5 | PNG |
| `/theme/MK10/MainScreen/<uuid>.mp4` | 2 | MP4 (isom/mp42) 1,213,515 B and 541,199 B |
| `/theme/640x256/<name>.mp4` | 2 | MP4, 1,213,515 B (`..._1.mp4`) and 2,786,101 B (`Project 27.mp4`) |

No JPEG. No raw QImage/QPixmap variants; images are already-encoded PNG/GIF bytes.

## Main-screen background videos
Represented as type-100 items on pages 0, 1, 3, 8 (`backgroundType=main`), `path` = the asset key
(page 0: `/theme/MK10/MainScreen/2e37fe8c-....mp4`, page 1: `/theme/640x256/2e37..._1.mp4`, page 3: `/theme/640x256/Project 27.mp4`, page 8: `/theme/MK10/MainScreen/40624559-....mp4`).
`path` is both the embedded-asset key and the device-relative path under the theme root (the same key namespace as the on-disk `theme/` tree).
Embedded `/theme/MK10/MainScreen/*.mp4` blobs are byte-identical (sha256) to the host files in `theme/MK10/MainScreen/`
and the device `/data/theme/MK10/MainScreen/`; the `/theme/640x256/*.mp4` blobs match host `theme/640x256/*.mp4`.
`/theme/640x256/..._1.mp4` (6715ddd9...) is NOT identical to the `MainScreen/2e37...mp4` (1da95af7...) despite equal size/name stem (first bytes differ only in the mvhd creation/modification time, 1 s apart; rest not diffed).

## Comparison to host `theme/MK10/{Key,MainScreen,SecondaryScreen}`
- `Key/` and `SecondaryScreen/` are empty on host (and absent on the device): key icons and info-panel GIFs exist only inside the `.Theme` (embedded).
- `MainScreen/` holds 2 mp4s; the Theme embeds both (+2 more from `640x256/`, 4 videos, ~5.5 MB of the 13 MB; the `生机.gif` 3.6 MB is the largest other blob).
- The Theme file is self-contained: every `path`/`paths` resolves inside the assets map. The GUI/device presumably extracts to
  device paths on load (guess). Path strings are not absolute filesystem paths (`/image/...`, `/static/...`, `/plugins/...`, `/theme/...`).
- Device `/data/theme/MK10` has `defaultTheme.Theme` (identical sha256) + `MainScreen/` mp4s identical to host; not examined further.

## Host-only vs device-relevant (guesses)
- Host-only: `controlData.description/parentDescription/iconPath` (GUI strings/icons), `/plugins/SYK/Windows/actionIcons`,
  `/static/icon/dark/*` (GUI icons), header `language`/`keyMacro*`, `backupX/Y`, `lock`, `showUnit`, `AISoundControlKeyword`.
- Device-relevant: item geometry/type, key `keycode`/`Url`/page links (actions), per-key icon/frame assets, system-data bindings, the main-bg mp4s.

## Device verification (2026-11-24)

Device 10.0.0.10 (LilAlpine, stock KeyboardDevice). Scratch: `/private/tmp/claude-501/-Users-rob-workspace-waveshare-mk10/a4a96831-1eff-47c9-b3af-d4ab15f5364a/scratchpad/devtest/` (backup/, cap/, dec*/, mkedit.py). Backups of `/data/theme/MK10/`, `/file_info.json`, `/mnt/SDCARD/config.json` taken first, sha256 verified; /data had 26 GB free.
Helper: `tools/fbcap.py TAG [fbN...]` (ssh `cat /dev/fbN` -> PNG, `FBCAP_DIR` = output dir).

### 1. Framebuffers (baseline: `cap/base_*.png`)
| fb | virtual_size | bpp | stride | what |
|----|--------------|-----|--------|------|
| fb0 | 896x608 | 32 (BGRA) | 3584 | main panel, 2 pages of 896x304 (page 0 = visible; `cat` returns 2,179,072 B = 304 rows only). Contains key icons, info panel image, labels. **Video area (x 0..640) is black: the mp4 is on a separate HW video layer, not in fb0.** |
| fb1..fb10 | 128x128 | 16 (RGB565) | 256 | per-key LCDs (`fb_gc9107`) |
| fb11 | 240x296 | 16 | 480 | info panel (`fb_gc9307`) |

Captures: `cap/base_fb0.png`, `base_fb11.png`, `base_fb1.png`, `base_fb5.png` (same dir as scratch above).

### 2. Serial probes: NOT DONE (port busy)
`/dev/cu.usbmodemMK10_XXXXXXXXX` (= `tty.usbmodem...`) was held open by `ScreenKeyMacOS` (lsof, pid 92984); per the safety rule nothing was sent. Not verified on MK10: `Available methods` list, `getInfo` reply, `getInfo` side effect, `pushfile.py`.
- Static strings in `KeyboardDevice` show JSON methods `getInfo`, `saveToFile`, `setFileCRC`, `setDeviceVolume`, `setDeviceBl`, `setDeviceName`, `getDeviceNetworkState` and error text `Unknown method: %1. Available methods: [%2]`. No JSON method named reload/setTheme found.
- Third-party claim (SK18 doc, unverified on MK10): `getInfo` flips to protocol V2 and stops the on-device VideoPlayer. Observation: with ScreenKeyMacOS connected to the port the player was running normally, so connecting alone does not stop it.
- Theme switch w/o restart is probably the *V1* binary command channel (strings: `CMD_VALUE_SET_DEVICE_RELOAD`, `GET_DEVICE_THEME`, `SET_DEVICE_DELETE_THEME`, `FILE_START/END`, signal `device_proactive_theme_load_finish(path)`); Terminus-MK20 `protocol.md` s6.2 says `SET_DEVICE_RELOAD` = cmd 2 with the plain UTF-8 theme path, echoed back. Untested here. `mkproto.py` only speaks the JSON (cmd 101) framing.

### 3. Edited theme: WORKS via ssh path (a)
Edit (qtheme decode -> edit -> encode, `/private/tmp/claude-501/-Users-rob-workspace-waveshare-mk10/a4a96831-1eff-47c9-b3af-d4ab15f5364a/scratchpad/devtest/mkedit.py`): page 0 Clock key (id 108): `title` "Clock" -> "CCTEST", `path` -> NEW asset key `/image/MK10/cache/cctest_new.png` (generated 128x128 PNG, red, "NEW"; asset entry added to theme.json, list re-sorted by UTF-16 key order); HotKey key (id 104): PNG blob replaced in place under the same key (blue "EDIT"). Encoded with `qtheme.py encode` (13,199,047 B).
Recipe that worked:
```
scp ccTest.Theme root@10.0.0.10:/data/theme/MK10/ccTest.Theme
ssh root@10.0.0.10 'sed -i "s#MK10/defaultTheme.Theme#MK10/ccTest.Theme#" /mnt/SDCARD/config.json; rc-service keyboard-device restart'   # ~10 s
```
Result (`cap/A_fb0.png`): new title and both icons rendered; rest of the page unchanged. Log was clean (only the usual dd "No space left on device" on fb0 clear, which is normal).
- Load semantics: **every theme load extracts all assets to `/data<asset key>`** (402/403 files rewritten, incl. `/data/image/...`, `/data/static/...`, `/data/plugins/...`, and the mp4s to `/data/theme/MK10/MainScreen/` + `/data/theme/640x256/`). The stock MainScreen mp4s got new mtimes but identical sha256. In-place edited blobs therefore overwrite the on-disk stock copy (`/data/image/MK10/cache/windows_2.png` became my blue test image) until the default theme is reloaded (it re-extracts; verified restored sha).
- 3b (protocol-only push/switch): not run (serial busy, see 2). Expected path: `pushfile.py` (`saveToFile`+`setFileCRC`) to `/data/theme/MK10/x.Theme`, then switch needs either V1 `SET_DEVICE_RELOAD <path>` (unverified) or config.json edit + service restart (needs shell, not available over serial).

### 4. Background video swap: WORKS, embedding is enough
Stock: both MainScreen mp4s = h264 Main@4.1, 640x256, yuv420p, 4.0 s, 24 fps (2e37..., 2.4 Mb/s) / 25 fps (4062..., 1.06 Mb/s).
Replacement: `ffmpeg -f lavfi -i testsrc2=size=640x256:rate=24:duration=4 -c:v libx264 -profile:v main -level 4.1 -pix_fmt yuv420p -b:v 2400k -movflags +faststart <uuid>.mp4` (822 KB), embedded as `/theme/MK10/MainScreen/cc7e5700-0000-4000-8000-0000000000aa.mp4`, page-0 type-100 `path` repointed to it, nothing placed on disk by hand.
After switching config + restart: KeyboardDevice extracted the mp4 itself to `/data/theme/MK10/MainScreen/` and spawned
`/usr/bin/videoplayerinterfaceAPP -x 0 -y 0 -w 640 -h 256 -f /data/theme/MK10/MainScreen/cc7e5700-....mp4 -r 0` (args = page-0 video only; flags fixed). Player stayed up (~3% CPU, hardware Cedar decode) with no errors. **Not confirmed visually**: fb0 has no video plane (x<640 black in all captures, `cap/V1..V3_fb0.png`), so "frames differ" can't be shown from fb0; needs eyes on the panel or a SHOW_JPG snapshot over serial. (Info-panel/other fb changes in V1..V3 are only clock/CPU gauges.) Observed: the player path = `/data` + the asset key (extraction target), so the key must be `/theme/MK10/MainScreen/<name>.mp4` for the main page (unverified whether other dirs work for page 0).

### 5. file_info.json
Theme dropped by scp, never registered via `setFileCRC`: `/file_info.json` untouched (still lists only lunch.sh, _probe.txt, defaultTheme.Theme) and the theme loaded and rendered fine. So CRC registry is not required to load; it is probably only for host-side "is this file already there" checks (guess, unverified).

### Final device state
`config.json` restored byte-identical (sha 99def778...), service restarted, stock layout verified (`cap/R_fb0.png`, `R_fb11.png`), defaultTheme and both stock mp4s sha-identical to backup, `/file_info.json` unchanged. Test files deleted from device (ccTest.Theme, ccVid.Theme, cc7e... mp4, cctest_new.png). Nothing left behind.

### Open issues
1. Serial experiments (Available-methods list, getInfo side effect, pushfile, V1 RELOAD) blocked while ScreenKeyMacOS owns the port; need it closed (ask Rob) or a test run with it quit.
2. Video playback visual confirmation (no fb plane). Try SHOW_JPG snapshot via `mkcap.py` once serial is free, or eyeball.
3. Page switching/other pages of an edited theme not exercised; only page 0.
4. Extraction rewrites every asset on every load (403 files, finishes within the ~10 s restart): a custom host should expect extra writes and overwritten stock assets when reusing keys.

## Serial protocol verification (2026-11-24)

Port `/dev/cu.usbmodemMK10_XXXXXXXXX`, 115200 8N1 (rate irrelevant on CDC). Scratch/captures: `/private/tmp/claude-501/-Users-rob-workspace-waveshare-mk10/a4a96831-1eff-47c9-b3af-d4ab15f5364a/scratchpad/serialtest/` (cap/, getinfo.json, probe.py, v1.py). **ScreenKeyMacOS was not running** when this started (`osascript ... is running` = false, `lsof` clean), so nothing was quit; Rob should not need to relaunch anything. Leave it closed for the new app. Notes: `tools/pushfile.py`/`mkproto.py` auto-detect only `/dev/ttyACM*` (Linux): on macOS pass `-p /dev/cu.usbmodem...`; don't run them with `python3 -I` (breaks the `mkproto` import).

### Unknown method -> methods list (verified)
Send `{"method":"bogusMethod","parameters":{}}` (frame `A1 A5 5A 5E`, cmd 101), reply:
```
{"ack_method":"bogusMethod","errorString":"Unknown method: bogusMethod. Available methods: [deleteFiles, getFilesBySuffix, getInfo, keyboardInput, playAudio, saveToFile, setBacklight, setFileCRC, setVolume, stopAudio]","success":false}
```
(Note: static strings suggested `setDeviceVolume/setDeviceBl/setDeviceName`; the live names are `setVolume`, `setBacklight`; no `setDeviceName`, no reload/theme method.) The bogus call had no side effect (player kept running, V1 layout intact).

### getInfo (verified)
`getInfo` (no params) answers in ~0.2 s, 3173-byte JSON; full copy `getinfo.json`. Content:
```
{"ack_method":"getInfo","success":true,"result":{
  "deviceModel":"MK10","deviceVersion":"V2.34","deviceWidth":896,"deviceHeight":304,
  "devicePanel":{"screenWidth":896,"screenHeight":304,"rectCols":5,"rectRows":2,
    "rects":[ 10 x {"col":c,"row":r,"isKey":true,"x":128*c,"y":128*r,"width":128,"height":128},
              {"isKey":false,"x":656,"y":0,"width":240,"height":296} ]}}}
```
Side effects (all verified, device was in factory V1 state after restart):
- fb0 goes **entirely black** (all 896x304: key icons, labels, info panel image); fb0/fb11 then stay byte-identical (md5 constant over >2 min, gauges/clock frozen). Mean: the on-device layout renderer stops; host is expected to draw (SHOW_JPG, cmd 100, untested here).
- `videoplayerinterfaceAPP` **is killed** (gone from `ps` within 5 s; log ends with `XPLAYER_COMMAND_RESET`). `KeyboardDevice` keeps running.
- Port still answers JSON afterwards (`getFilesBySuffix` replied normally).
- Unsolicited frames: **none** in 45 s (3197 raw bytes = the getInfo reply only), and none in a further 20 s listen (`mklisten.py --raw`).
- Closing the port does **not** restore anything: still black, no player after >2 min with port closed. Observed recovery paths: `rc-service keyboard-device restart` (~10 s), or the V1 reload command below (verified, no restart needed; layout + player came back).
- Bogus-method call alone did not change state; `getInfo` is the V2 switch (matches the SK18 docs).

### Key events: verified (2026-11-24, Rob at the keys)
`mklisten.py --getinfo` while pressing keys. After getInfo, every press and release arrives as an unsolicited cmd 101 frame:

    {"method":"keyStateChanged","parameters":{"col":2,"pressed":true,"row":0}}
    {"method":"keyStateChanged","parameters":{"col":2,"pressed":false,"row":0}}

- One frame on press and one on release; no repeat frames seen. Presses were short (about 0.2 s), so long-hold behaviour is untested.
- `row` and `col` match the theme's key items (row 0..1, col 0..4). This JSON event does not report the page. The V1 cmd 13 frame sent with it carries the key's action (below), so the host does not need to track pages.
- **V1 key events, verified 2026-11-25** (Studio's JSON RPC window, physical presses on the stock-based theme): each press and each release also sends an old-style V1 frame, type 2, cmd 13 `DEVICE_ProactiveEscalationCMD`. It arrives about 1 ms before the matching `keyStateChanged`. The payload is an array of two Tagged-Value Maps: `{type: "keyState", row, col, pressed: 1|0}` (pressed is an int here, not a bool) and the key's full action map (e.g. `{type: "openWeb", Url, description, iconPath, AISoundControlKeyword}`). Seen for `openWeb`, `openPage`, `oneLevelUp` and `pageSwitch`. A page change is followed by a V1 cmd 15 JSON frame with the new page's contract (`deviceRequestSystemData`, `themePageSwitch: true`). `keyboard` keys (soundboard keys, keycode 0) send cmd 13 **on release only** (`pressed: 0`); their press gives only `keyStateChanged`. The action map is the item's `controlData` and nothing else: the item's `soundFile` is not sent (the device plays the sound itself). Format per Terminus-MK20 `protocol.md` §5.2 and §6.3; decoder in `app/lib/proto.js` (`V1Parser`, `decodeV1`).
- Frame ids count down from 0xFFFFFFFF (4294967287, 4294967286, ...). Host request ids count up from small numbers, so a collision looks unlikely.
- Knob and secondary-panel events were not exercised.
- **getInfo followed by a V1 reload keeps events flowing with the layout up** (`mklisten.py --getinfo --reload`, verified 2026-11-24). Afterwards, an fb0 capture showed the stock layout with a live clock, and `videoplayerinterfaceAPP` was running.
- Presses made during the reload are queued, not dropped. 22 frames that the run printed as arriving between 1.2 s and 4.5 s all came in together at 4.47 s, in press order, about 3.5 s after the reload was sent.

### Theme reload over the protocol (verified, MK10)
- Command: **V1 binary frame, cmd = 2** (`CMD_VALUE_SET_DEVICE_RELOAD`), plain UTF-8 theme path as payload, no length prefix. Value 2 is from the Terminus-MK20 / MK20Control docs and consistent with the moc enum order of `CMD_VALUE` strings in `KeyboardDevice` (FIND_DEVICE, SEND_SYSTEM_DATA_TO_DEVICE, SET_DEVICE_RELOAD, ... SEND_JSON). The vendor demo source only defines 100/101, it has no V1 commands. The ctlhost doc's V1 table (2 = IMAGE) and 21-byte header do **not** match; the Terminus layout does:
```
"AA551234 FIXEDCMDHEAD " (22 B ASCII, trailing space) | type u32 LE (0 = request) | cmd u32 LE | len u32 LE | crc32(payload) u32 LE | payload
```
- Sent `cmd=2` payload `/data/theme/MK10/ccReload.Theme` while in V1 state. After **3.7 s** two V1 frames came back (type 2 = reply): (a) cmd 15 SEND_JSON `{"deviceRequestImageName":[],"deviceRequestSyncData":[],"deviceRequestSystemData":["CPU Usage","minute","RAM Usage","GPU Usage","hour"],"deviceRequestSystemDataShowUnit":true,"themePageSwitch":true}`, then (b) cmd 2 echo of the path.
- Result: fb0 shows the new theme (Clock key title now "RELOAD", `cap/p5_reloaded_fb0.png`), new `videoplayerinterfaceAPP` pid, **`/mnt/SDCARD/config.json` `defaultTheme` rewritten to the new path immediately (persistent across restarts)**. Switch back with the same command and `/data/theme/MK10/defaultTheme.Theme` (again ~3.9 s, config rewritten back).
- Also works from the **V2 state** (after getInfo): the reply was just the echo (no SEND_JSON, 3.7 s), fb0 and the video player came back without a restart (`cap/p5_v2reload_fb0.png`). Whether the protocol stays V2 afterwards: not checked.
- Test theme: stock decoded by `qtheme.py`, key id 108 title "Clock" -> "RELOAD", re-encoded (13,198,472 B).

### Push over protocol (verified)
`tools/pushfile.py` (saveToFile 64 KiB chunks + setFileCRC): 13,198,472 B in **44.06 s wall (~300 KB/s)**; on-device sha256 identical to the local file. `setFileCRC` reply: `{"ack_method":"setFileCRC","result":{"crc":"3904832107","filePath":...},"success":true}` (crc = zlib crc32 of the whole file, as decimal string). `saveToFile` ack's `result.seek` is the offset of the chunk just written (not the new length). The real CRC registry is **`/data/file_info.json`** (updated by setFileCRC); `/file_info.json` (section 5 above) is a stale copy, so section 5's "never registered" conclusion applies to /data/file_info.json only if it was also absent, not checked then.

### getFilesBySuffix / deleteFiles (verified)
- `getFilesBySuffix {"suffixs":["Theme"]}` -> `result.filePaths = [{"crc":"<decimal>","filePath":"..."}]`, list appears to come from `/data/file_info.json` (inferred: it lists exactly its entries, and the CRC of defaultTheme 2287986407 matches zlib crc32 of the file). **Suffix without the dot**, case-insensitive: `".Theme"` returned an empty list, `"Theme"`/`"theme"` work. (inferred) only registered files are found (`sh`, `txt` -> empty even though /mnt/SDCARD/lunch.sh exists). Params errors: "Missing 'suffixs' parameter", "'suffixs' must be an array".
- `deleteFiles {"filePaths":["/data/theme/MK10/ccReload.Theme"]}` -> `{"result":{"deletedFiles":[...],"failedFiles":[]},"success":true}`; file gone from disk and removed from `/data/file_info.json` and from getFilesBySuffix.
- Loading the test theme re-extracted all assets (as in section 3); after the switch back the stock mp4s are sha-identical to backup.

### Final state
config.json restored byte-identical to backup (sha 99def778...) via stop / scp / start (note: at the start of this session the device config had `deviceBl: 0`, backup has 58; restored value is 58, source of the 0 unknown, ScreenKeyMacOS not running), defaultTheme.Theme and the 4 stock mp4s sha-identical to backup, ccReload.Theme deleted (disk + registry), service restarted, stock layout captured (`cap/final_fb0.png`, `final_fb11.png`; player running). Not tested: SHOW_JPG, keyboardInput, playAudio/stopAudio, setBacklight/setVolume, key events.

### Key sound effects and speaker volume (2026-11-24)
- From strings in `KeyboardDevice`, not yet tested: a key's `soundFile` is played by an `AudioPlayer` class that runs `tinyplay <file> -D <card> -d <device>`. Volume comes from `config.json` `deviceVolume` (JSON `setVolume {level}`; the vendor demo slider is 0-7), applied with `tinymix set "Headphone volume" <n>`. The mapping from 0-7 to the mixer value is unknown.
- The only sound card is `audiocodec` (`/proc/asound/cards`).
- Stock Tina ships tinyalsa in `/usr/bin`; LilAlpine did not, so sound effects and volume silently did nothing.
- Alpine's `tinyalsa` 2.0.0 does not work here: its `tinyplay` never starts the stream (pcm stays in `SETUP`, `hw_ptr` 0, exits 0 after 0.35 s), so only the amp click is heard. Its `tinymix` works.
- LilAlpine therefore ships the four stock tools (`tinycap tinymix tinypcminfo tinyplay`, glibc, tinyalsa built in) in `/usr/libexec/mk10`, which is first on `KeyboardDevice`'s PATH. `/usr/local/bin` has symlinks for the shell. Verified 2026-11-24: playback works (`tinyplay <wav> -D 0 -d 0`).
- Overlap (2026-11-24): the `tinyplay` in `/usr/libexec/mk10` is now a wrapper that runs `aplay` (alsa-utils) in the background through a dmix in `/etc/asound.conf`, 48 kHz with plug resampling. Key sounds mix instead of fighting over the device. alsa-lib drives this codec fine; only Alpine's tinyalsa 2.0.0 is broken. The app sees each sound finish at once, so the serial `stopAudio` no longer stops one. The stock binary is still there as `tinyplay.stock`.
- The stock `tinymix` exits 0 even when a set fails ("Invalid mixer control"). A set that works prints nothing.
- The stock `/etc/rc.local` sets the codec at boot: LINEOUT on, `DAC_DIFFER`, volume 25; mic boost on; mic gain 19/19/0. LilAlpine's `mk10-mixer` OpenRC boot service applies the same values.

### Live data push (verified on MK10, 2026-11-24)
- Old-style (V1) frame, **cmd 1** (`SEND_SYSTEM_DATA_TO_DEVICE`). The payload is a map: u32 BE count, then for each pair a u32 BE byte length plus a UTF-16BE key, and a u32 BE byte length plus a UTF-16BE value. Same as Terminus-MK20 §5.1/§5.3.
- The device acks with an empty V1 reply: type 2, cmd 1, len 0.
- Keys are the widgets' `system_data_name`. Every text widget bound to the key shows the value string verbatim (`"42%"`, `"0"`), and it updates at once. This worked with the device still in V2 mode after getInfo + reload.
- The type 109 rings on the stock main page **did not change** their arc for 0, 5, 42 or 95. Untested: type 101/102 gauges and bars on other pages.
- `hour`, `minute` and `date` were not pushed, yet the clock was correct, so the device fills those itself.
- After a V1 reload the device sends unsolicited V1 frames. Two are cmd 15 (SEND_JSON) `{"wifiState":N}`. One is cmd 15 with the contract: `deviceRequestSystemData` lists the keys the current page wants, here `date, hour, CPU Usage, GPU Usage, RAM Usage, minute`, plus `deviceRequestSystemDataShowUnit: true` and `themePageSwitch: true`. A V1 cmd 13 (`DEVICE_ProactiveEscalationCMD`) also appeared, as a Tagged-Value Map with `type: keyState, row, col, pressed`, followed by the key's action (`pageSwitch`). That suggests the MK20-style key events exist on MK10 too. Unclear whether a physical press caused it.
- Tool: `tools/mkv1.py`.
- Studio (2026-11-25): `lib/stats.js` sends the vendor key names (`CPU Usage`, `GPU Usage`, `RAM Usage`, `CPU Model`, `RAM … Memory`, `Disk …`; full list from the strings in ScreenKeyMacOS, whose stats come from a bundled btop). Verified from lenny with `cli.js stats`: the main page's CPU and RAM rings showed the pushed `8%`/`31%` within a second, framebuffer grab fb0/fb11. Text widgets with no value pushed show their placeholder (`Text`).

## Action catalogue (controlData types), 2026-11-24

Source: `allThemeTest.Theme`, which Rob built in ScreenKeyMacOS with one key per palette type and pulled from the device, plus the stock MK10 theme for `openWeb`, `openPage` and `oneLevelUp`. The templates are in `app/lib/action-templates.json`. Each entry has an English UI group and label (our names, not the vendor's), and its fields as `[name, QVariant type, default]`: 10 = QString, 2 = int, 1 = bool. The defaults are blanked except type, description, iconPath and parentDescription.

**Field order is not significant [verified by evidence].** The current vendor app writes every action with keys sorted, which is QMap order: 17 of 17 in allThemeTest. The stock theme has 63 of 69 unsorted, an older writer, probably QHash order. The device loads both. Templates therefore use sorted keys. The Terminus "misordered fields are ignored" note is better read as "missing or extra fields": QDataStream into QVariantMap rebuilds the map and does not care about order.

| Group | type | Fields beyond the common five (`AISoundControlKeyword`, `description`, `iconPath`, `parentDescription`, `type`) | Who runs it (unverified unless noted) |
|---|---|---|---|
| System input control | keyboard | keyString, keycode:int | device (GD32 HID) |
| | keyboard_switch | none | device? |
| | qmk_mouse | mouse_h, mouse_v, mouse_x, mouse_y, qmk_mouse_event, qmk_mouse_key (all int) | device (QMK) |
| | qmk_string ("Keyboard macro") | inputTextPercentEncoding | **device [verified 2026-11-24]**: with ScreenKey quit, pressing the key typed "asdfasdfasdf" into the focused field |
| | text | inputText, isCopyPaste:bool, isInputEnter:bool | host (MK20: serial event only, no HID) |
| | password | password (stored as 32 hex chars, apparently hashed or encrypted; unknown which), isCopyPaste, isInputEnter | host. Vendor ScreenKey asked for the macOS Accessibility ("control this computer") permission to type for some actions (Rob, 2026-11-24). Plan: route typing through the device (`keyboardInput`, untested) and fall back to Accessibility only for text the device cannot type. |
| System file control | openDir / openFile | path | **host** (openDir does nothing without the host [verified 2026-11-24]) |
| | openWeb | Url | host |
| System sound control | Loudspeaker / Microphone | volumeAdjustDevice (device name), volumeAdjustMode:int (0,1,3,4 seen), volumeadjustValue:int, isSwitchDefaultDevice:bool | **host [verified]**. For plain mute and volume use a `keyboard` action with a consumer keycode instead; the device runs it (below) |
| System tools | screenshot | saveDir | **host [verified]** |
| | playMusic | path, playMode:int, playState:int | **host [verified]** |
| Devices | deviceVolume | deviceVolumeAdjustMode:int, deviceVolumeadjustValue:int | device (MK10 speaker)? |
| Page switching | pageSwitch | jumpToPage:int, pageSwitchMode:int | device |
| | openPage / oneLevelUp | pageName | device |

Not yet captured: openApp, window ops, media keys, Action flow (`ControlFlow`, whose `controlDataList` is a QByteArray list of nested actions), OBS, Home Assistant, weather, and the MK20-only `encoder_*` types.

### `keyboard` keycode encoding (QMK keycodes) [inferred from all bundled themes]
`keycode` is a **QMK keycode**, and `keyString` is the human label the vendor app shows. The GD32 runs QMK, so these execute with no host.
- The low byte is the HID keyboard usage: `C` = 6, `Esc` = 41, `Caps Lock` = 57.
- Modifier bits follow QMK `QK_MODS`: 0x100 Ctrl, 0x200 Shift, 0x400 Alt, 0x800 GUI (Win/Cmd). For example, 262 = 0x106 `L Ctrl C`, 2582 = 0xA16 `L Win L Shift S`, and 1067 = 0x42B `L Alt Tab`.
- Consumer keys use the QMK basic codes: 168 = 0xA8 `KC_AUDIO_MUTE` "Mute", 169 `KC_AUDIO_VOL_UP` "Vol +", 170 `KC_AUDIO_VOL_DOWN` "Vol -". These come from the MK20 `encoder_keyboard` action. Next/prev/play would presumably be `KC_MEDIA_*` (0xAB-0xAE); that is untested.
- Launch and navigation consumer keys, tested on macOS 2026-11-24. Method: `keyboard` keycodes on page 1 of a temporary theme, keys pressed by hand. The HID usages are the upstream QMK `report.h` mapping; the vendor GD32 fork's mapping is not verified.
  - **Work:** 0xB4 `KC_WWW_SEARCH` (AC Search) opens **Siri/Spotlight**; 0xC1 `KC_MISSION_CONTROL` opens **Mission Control**; 0xC2 `KC_LAUNCHPAD` opens **Launchpad**.
  - **No visible effect:** 0xB5 `KC_WWW_HOME`, 0xB1 `KC_MAIL`, 0xB2 `KC_CALCULATOR`, 0xB3 `KC_MY_COMPUTER`, 0xBF `KC_CONTROL_PANEL`, 0xC0 `KC_ASSISTANT`. It was not checked with Karabiner-EventViewer whether these usages reached macOS.
  - No HID usage carries a URL, and QMK has no keycode for AL Internet Browser (0x196). Opening a URL stays a host action (`shell.openExternal`, which needs no macOS permission).
- **HID to QMK table:** `app/lib/qmk-keycodes.json`, generated 2026-11-24 from upstream QMK master `80973aa0b5`, `quantum/keycodes.h` plus `KEYCODE2CONSUMER`/`KEYCODE2SYSTEM` in `tmk_core/protocol/report.h`. `app/lib/qmk.js` turns a captured HID usage and the held modifiers into the keycode.
  - Keyboard page: QMK basic codes 0x04-0xA4 and 0xE0-0xE7 equal the HID usage. That covers F13-F24 (0x68-0x73).
  - Consumer: 27 QMK keycodes (0xA8-0xC2), each mapped to one consumer usage. A consumer usage outside that list has no QMK keycode, so the device can't send it. `KC_MEDIA_EJECT` (0xB0) sends 0xCC Stop/Eject, not 0xB8 Eject. `KC_MISSION_CONTROL` sends 0x29F and `KC_LAUNCHPAD` sends 0x2A0.
  - System: 0xA5-0xA7 power, sleep and wake (generic desktop 0x81-0x83).
  - Modifiers: QMK can't mix left and right modifiers in one keycode (0x1000 makes them all right-hand). The mapper uses the left ones when both sides are held.
  - The vendor fork matches upstream for the codes tested on the device (mute, volume, 0xB4, 0xC1, 0xC2). 0xC1/0xC2 are recent QMK additions, which suggests the fork isn't old. The rest is not verified.
- So "mute" and "volume" keys can be `keyboard` actions with these codes, and they work with the host app closed. A host-run `Loudspeaker` action is only needed for picking an output device or setting an exact level.
