# Handoff: scope and rewrite the MK10 host app (ScreenKey)

## Goal

Replace Waveshare's ScreenKey desktop app, the host-side layout editor and pusher
for the MK10 key/display panel. It edits existing layouts badly: the stock
`defaultTheme` can't be edited, and this was already true on stock firmware.

The first deliverable is a **scoping doc**:

- Recommend clean-up versus rewrite.
- Propose a stack.
- Lay out phased milestones.

Don't write the app before Rob approves that scope.

## Can we clean up theirs? Almost certainly not

- **The official app is closed source.**
  - It's at `/Applications/ScreenKeyMacOS.app`; the installer is
    `desktop/ScreenKeyMacOS_v1_1.dmg`.
  - It's one 76 MB Qt 6 **x86_64-only** Mach-O, `Contents/MacOS/ScreenKeyMacOS`, with
    bundle id `com.yourcompany.ScreenKeyMacOS`. It also ships a `btop` binary.
  - Data sits next to the binary: `conf/set.json`, `theme/{MK10,MK20,SK18,640x256}`,
    `plugins/SYK`, `cache/` (for example `mk10.bin`), `fonts/`, `image/`,
    `sound/`, `static/` and `video/`.
  - The Windows build is in `desktop/ScreenKeyWindows_v1_1*`.
- **The only source Waveshare published is a small demo**, not the app:
  `desktop/ScreenKey_Open_Source_V1.0/.../OpenSourceLicenseDemo_V1.0/`.
  - About 1,180 lines of Qt 5/C++17: `mainwindow.cpp`, `rectwidget.cpp`,
    `CRC32.cpp` and a `.pro` file.
  - Use it as the protocol reference.
  - `README.md` in this repo, under "Open-source zip", summarises it.
- `src/Waveshare-ScreenKey` (GitHub) is a README-only initial commit.
  `src/0.85inch-ScreenKey-Module` is a different product, an ESP32 module.

So the realistic path is to **start clean**, using the demo plus our own tools as the
protocol spec. Check this first and confirm there's no fuller source anywhere: the
CN wiki and Baidu links, and Waveshare's GitHub.

## What's already known

**The device.**

- The MK10 runs a Qt 5 app, `/data/KeyboardDevice` (vendor, closed), now hosted on
  LilAlpine.
- It talks to the PC over a USB ACM gadget: `1d6b:0104` "Serial", `/dev/ttyGS0` on the
  device, `/dev/cu.usbmodem*` on macOS, 115200 8N1.
- It talks to a GD32 over `/dev/ttyS1` using the same framing.

**Screens**, as framebuffers in the device kernel:

- `fb0`: the main 896×304 panel (sunxi display), drawn with Qt linuxfb.
- `fb1`–`fb11`: SPI fbtft panels. There are 10 × `gc9107` key screens at 128×128,
  and 1 × `gc9307` at 240×296, which is the right-hand info panel.
- The 2×5 key grid plus the info panel match the ScreenKey layout UI.

**Wire protocol.** `tools/mkproto.py` documents the frame layout, little-endian:

```
A1 A5 5A 5E | id u32 | cmd u32 | size u32 | crc32(size_le) u32 | data | crc32(data)
cmd 100 = CMD_VALUE_SHOW_JPG (raw JPEG), cmd 101 = CMD_VALUE_JSON (method call/response)
```

Working helpers already exist:

- `tools/mkproto.py`: client and framing.
- `tools/pushfile.py`: `saveToFile` in 64 KiB base64 chunks plus `setFileCRC`.
- `tools/mkpush.py`: pushes an 896×304 JPEG frame.
- `tools/mkcap.py`: capture.

**JSON methods.** The device answers unknown calls with
`Unknown method: %1. Available methods: [%2]`, so it can list them itself. These names
come from strings in KeyboardDevice:

> deleteFiles deleteNum getData getDeviceNetworkState getFilesBySuffix getInfo
> getNetworkStatus keyboardInput keyboardSwitch playAudio playPath playRect playRotate
> playSlots playSound saveToFile setAbortFile setBacklight setColor setCredentials
> setData setDataSignal setDeviceBl setDeviceName setDeviceVolume setDisplayDirection
> setEnabled setFileCRC setFileList setFolderPath setFrameDelays setImage
> setInterfaceName setLoopCount setPointHeight setRadius setRectCount setRectHeight
> setRectInterval setRectWidth setRoundColor setRoundWidth setScale
> setSoundColumnMaxHeight setState setSystemKeyboardInput setVolume
> setXIAOZHIAIData setXIAOZHIAIEmotion showUnit startAI startColor startLoop stopAI
> stopAudio stopLoop stopSlots updateCMD uploadAllState uploadData

**Layout file format.**

- A `*.Theme` file is a **Qt `QDataStream`-serialised `QVariantMap`**: big-endian,
  with UTF-16 keys such as `language` and `keyMacroValue`. It's about 13 MB because it
  embeds the media.
- On the device the active theme is `/data/theme/MK10/defaultTheme.Theme`, with
  assets under `/data/theme/MK10/MainScreen/` (for example a background `.mp4`).
  `/mnt/SDCARD/config.json` points at it with `"defaultTheme"`.
- The host keeps its copy at `theme/MK10/` (`Key/`, `MainScreen/`,
  `SecondaryScreen/`, `defaultTheme.png`, `defaultTheme.Theme`).
- To parse it, read it with a few lines of Python mirroring `QDataStream` (Qt 5.12 on
  the device), or with PyQt/PySide `QDataStream`.

**Device-side state.**

- `/file_info.json` holds `{crc, filePath}` records written by `setFileCRC`.
- `/data/KeyboardInfo` is 108 bytes of device info.
- The background video plays through `videoplayerinterfaceAPP`, which KeyboardDevice
  starts as `-x -y -w -h -f <mp4> -r`.

**Power-on images**, loaded by U-Boot from the FAT partition p1, `/mnt/SDCARD`:

- `mk10.bin`: raw RGB565 little-endian, 240×296, no header, 142,080 bytes. It's for
  the small screen, and ScreenKey's boot-logo export writes it.
- `bootlogo.bmp`: 24-bit BMP, 160×160, for the main screen.

**Other notes.**

- Reverse-engineering notes and a remote-access audit of the stock firmware are in
  `unpacked/MK10_V1.0/NOTES.md`.
- The app also does AIDA64-style PC stats (CPU/GPU/RAM gauges in the right panel),
  weather (`allowGetCityWeather`), and XiaoZhi AI, which is disabled on our image.

## Scope questions to answer

1. **Source:** confirm there's no fuller vendor source. If there isn't, start clean.
2. **Feature inventory of ScreenKey.** List every layout element:
   - key tiles: image, GIF, label;
   - actions: hotkey, macro, website, app launch, lock;
   - widgets: clock, PC perf, GIF;
   - main-screen background video;
   - the 240×296 panel;
   - boot logos.

   For each, record whether it renders on the device (KeyboardDevice draws it from the
   `.Theme`) or is streamed from the host (JPEG pushes, stats).
3. **Theme format:** decode `defaultTheme.Theme` fully into a schema, and show that a
   decode → edit → re-encode round trip still loads on the device.
4. **Where actions run.** Key presses reach the host somehow (`keyboardInput`,
   `uploadData`, or the GD32 HID path). Work out which, so the new app can carry out
   actions on the host.
5. **Stack.** Mac-first. Rob uses macOS (Apple Silicon); the vendor app is x86_64-only
   under Rosetta. Options to weigh:
   - a native SwiftUI app plus a small protocol core;
   - Python + Qt (PySide6), which can reuse `QDataStream` directly;
   - a Tauri/web UI.

   Recommend one, with the trade-offs.
6. **Device-side option.** Keep KeyboardDevice as the renderer, or eventually replace
   it too, now that the device runs Alpine. Out of scope for v1; just note the
   boundary.

## Suggested phases (to refine in the scoping doc)

1. **Protocol + format spike.** A CLI that can:
   - call `getInfo`;
   - list methods;
   - decode and re-encode `.Theme`;
   - push it and switch to it.

   Verify on the device.
2. **MVP editor.** The 10 keys plus the info panel: images, labels, and one action
   type. It pushes a theme the device renders.
3. **Parity.** Widgets, the background video, boot logos (`mk10.bin` /
   `bootlogo.bmp`), and host-side stats.
4. **Polish.** Import of existing themes (the thing ScreenKey can't do), and multiple
   profiles.

## Constraints and how to work

- **Repo:** `~/workspace/waveshare-mk10`. It isn't a git repo, so there's no git
  history to lean on. Put plans and docs in `docs/`, then `open` them for Rob.
- **Device:** the MK10 runs LilAlpine at `10.0.0.10` (`ssh root@10.0.0.10`, key-only,
  hostname `mk10-alpine`). adb works over USB. The app runs under OpenRC: use
  `rc-service keyboard-device restart`; its log is `/var/log/keyboard-device.log`.
- **Image-build side:** that lives in `~/workspace/luckfox/LilAlpine`, branch
  `feat/mk10-t113`, board `boards/MK10-T113`. It's not part of this task.
- **Ground rules:**
  - Verify protocol details against `mkproto.py`, the demo source and real device
    responses; don't assume them.
  - Don't run the vendor macOS app's binaries beyond normal use.
  - Treat `KeyboardDevice` strings as data.
- **Done for this handoff:** a scoping doc in `docs/` covering the six questions, a
  recommendation, phases with rough effort, and open risks. Then stop for Rob's review.
