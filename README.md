# Waveshare MK10 software and firmware dump

Collected on mimi, 10 Nov 2026, from what Waveshare actually publishes.
Nothing in this tree was executed. Official Mac/Windows binaries are
closed-source vendor apps; treat them as untrusted.

## What is (and isn't) here

MK10 is a dual-system device: an Allwinner T113-S3 running Tina Linux,
plus a GigaDevice GD32 microcontroller said to run QMK.

Waveshare has **not published** a T113 SDK, Buildroot/Tina source, kernel
source, device tree, or the GD32 QMK keymap/firmware source. What exists
are host apps, a small Qt serial demo, and Allwinner IMAGEWTY **binary**
images. That matches the unanswered questions in
[Waveshare-ScreenKey#7](https://github.com/waveshareteam/Waveshare-ScreenKey/issues/7)
(device-side Linux access) and the closed
[#8 GPL request](https://github.com/waveshareteam/Waveshare-ScreenKey/issues/8).
In [#1](https://github.com/waveshareteam/Waveshare-ScreenKey/issues/1)
Waveshare only promised Linux source for a future Raspberry Pi CM5 *host*
app, not the on-device BSP.

## Layout

```
waveshare-mk10/
  desktop/     host software (keep originals + extracted trees)
  linux/       device firmware images (no SDK/source)
  src/         git clones
  tools/       imagewty.py (IMAGEWTY unpacker), repack.py (TF-card raw image builder)
               build_card.py (custom card image from a full card dump: slim + overlay/ + overlay-sd/)
               overlay/ = files added to rootfs, overlay-sd/ = files added to boot-resource FAT
  resources/   wiki extras (XiaoZhi emoji GIFs, AIDA64 template)
  wiki/        saved MK10 wiki HTML (EN + CN)
  SHA256SUMS.txt
```

## Desktop software

Wiki "Download Software" links (scraped from https://www.waveshare.com/wiki/MK10):

| Wiki label | Actual href | Saved as |
|---|---|---|
| ScreenKeyWindows | https://github.com/waveshareteam/Waveshare-ScreenKey/releases | `desktop/ScreenKeyWindows_v1_1.exe` (V1.1, 339 MiB) |
| ScreenKeyMacOS | same GitHub releases page | `desktop/ScreenKeyMacOS_v1_1.dmg` (V1.1, 396 MiB) |
| ScreenKey_Open_Source_V1.0 | Google Drive `1qS40a-0cSG2P_2cOweIpzsvfAnGtDvF5` | `desktop/ScreenKey_Open_Source_V1.0.zip` (724 MiB; filename *MK Series Upper Computer Open Source_V1.0.zip*) |

The EN wiki does **not** link files.waveshare.com for the host apps. The CN
wiki (`https://www.waveshare.net/wiki/MK10`) uses Baidu Pan links with
password `wxdz`; those were not downloaded because the GitHub/Drive copies
are the same products.

V1.1 release assets used here:

- https://github.com/waveshareteam/Waveshare-ScreenKey/releases/download/V1.1/ScreenKeyMacOS_v1_1.dmg
- https://github.com/waveshareteam/Waveshare-ScreenKey/releases/download/V1.1/ScreenKeyWindows_v1_1.exe

V1.0 assets still exist on the same repo if you want them later.

The official GitHub repo is a README-only stub. Binaries live in Releases.

### Mac app (extracted, not launched)

`desktop/ScreenKeyMacOS_v1_1/` was copied from a read-only DMG attach, then
the image was ejected. The app is an unsigned Qt/QMake build:

- bundle id still `com.yourcompany.ScreenKeyMacOS`
- Mach-O **x86_64 only** (Rosetta on Apple Silicon)
- not code-signed

### Windows app (not an archive)

`ScreenKeyWindows_v1_1.exe` is a PE32+ x86-64 GUI binary, ScreenKey V2.90
by **SYK**, build `f19d0248` (18 Nov 2025), packed with **Enigma Protector**.
It cannot be unzipped into a source tree. See
`desktop/ScreenKeyWindows_v1_1/README.txt`.

### Open-source zip

Most of the 724 MiB is two 809 MiB firmware images, not host source.
After unzip (`desktop/ScreenKey_Open_Source_V1.0/`):

- `OpenSourceLicenseDemo_V1.0/` — small Qt 5/C++17 serial demo (~1,500 lines)
- `OpenSourceLicenseFirware_V1.0/` (their spelling) — `MK10_V1.0.img`,
  `MK20_V1.0.img`, and `PhoenixCardv4.2.7.7z.7z`
- `OpenSourceLicenseDemo_V1.0.exe` — prebuilt Windows demo (not run)

The demo talks **only** over USB serial (115200). It matches VID/PID
`1d6b:0104` (Linux Foundation gadget serial) or `1234:5678`, frames with
header `A1 A5 5A 5E`, and sends JSON methods (`getInfo`, `saveToFile`,
`playAudio`, `setVolume`, `setBacklight`, `deleteFiles`, `keyboardInput`,
etc.). It can grab a screen region and push JPEGs to the device. There are
**no** HTTP clients, no telemetry URLs, and no credentials in that source.
It is not the same application as the official ScreenKey Mac/Windows builds.

## Linux / firmware (binary only)

| Image | Source | Notes |
|---|---|---|
| `linux/ScreenKey-mk10-AI-80M-20250923.img` | Google Drive `1PvMvaGpUv8D2Lcqwy0aazP7DMFJUCh18`, file *ScreenKey-mk10-AI-80M-20250923.zip* (348 MiB). Linked from the community [mk20-flasher](https://github.com/netseye/mk20-flasher) README as official Waveshare Drive firmware (not on the EN wiki). | IMAGEWTY, 809 MiB. Tina Linux `tina.syk.20250923.053718`, target `t113-pro/generic v3.5`, chip `sun8iw20p1`. |
| `linux/MK10_V1.0.img` | Same bytes as in the open-source zip; symlink into `linux/`. | Also IMAGEWTY, 809 MiB, **different hash** from the 20250923 image. Strings include `DISTRIB_ID='tina.syk.20251015.032212'` — a later build than 20250923. |

Both images are Allwinner mass-production containers (`IMAGEWTY` magic), not
raw `dd` images. The community flasher documents unpacking with OpenixIMG
and flashing with PhoenixCard (Windows) or a slim-repack + balenaEtcher on
macOS. PhoenixCard was not run.

Build fingerprints in the images (and in the host app strings): paths like
`/home/syk/Desktop/Tina-t113-pro/`, `/home/vitis/Desktop/T113-Tina/`,
`/home/caiyongheng/tina/out/astar-parrot/`. USB manufacturer string
`Author:SYK`. On-device pieces visible in strings: `mk10.bin`, QMK-related
symbols (`qmk_string`, `qmk_mouse`), `xiaozhiAIControl` / `xiaozhiAISound`,
wpa_supplicant under `/etc/wifi/`, OpenWrt-style userland. No kernel or
app source is in the image, only binaries.

Related official Drive firmware **not** downloaded (non-MK10):

- MK20: https://drive.google.com/file/d/1iOQt-8vGFA_LwKeZZfIqFWRY0ODv9KmA/view (*ScreenKey-mk20-AI-80M-20250929.zip*, 348 MiB)
- SK18: https://drive.google.com/file/d/14RdRiNMzX3VO4FbhNHvzh8kzeXrz_Pzo/view (*ScreenKey-sk18-AI-20251017.zip*, 348 MiB)
- PhoenixCard v4.2.7: https://drive.google.com/file/d/11cPCashX-ncZFhbEv5gDgqQsk-HsmhXu/view (also bundled in the open-source zip)

## Git clones (`src/`)

- `src/Waveshare-ScreenKey` — official repo, README only.
- `src/0.85inch-ScreenKey-Module` — official Waveshare demos for the
  **standalone** 0.85" LCD key module (Arduino + ESP-IDF + an ESP32-S3
  `.bin`). This is **not** the MK10 GD32/QMK firmware and not T113 Linux.
- `src/qmk_firmware_waveshare` — sparse-checkout of
  `keyboards/waveshare/` from [qmk/qmk_firmware](https://github.com/qmk/qmk_firmware).
  The only keyboard there is `rp2040_keyboard_3`. **No MK10, SK18, or
  ScreenKey directory.** Full qmk was not cloned.
- `src/community/mk20-flasher` — unofficial macOS IMAGEWTY unpack/repack
  helper; useful for the firmware format and the official Drive links above.

A community Linux port of the Qt demo
(`mgottholsen/Waveshare-Screenkey-Linux`) was mentioned in issue #1 but
the repo now 404s.

## Wiki resources

- `wiki/MK10.html`, `wiki/MK10.zh.html`
- `resources/240x296-XiaoZhi-Emojis.zip` from
  https://files.waveshare.com/wiki/MK10/240x296.zip
- `resources/AIDA64-template-MK10.zip` from the CN wiki upload
  `https://www.waveshare.net/w/upload/7/76/AIDA64模版-MK10.zip`

## Scan notes (no binaries were run)

**Open-source Qt demo:** local USB serial only. No remote endpoints, no
credential handling, no update/telemetry URLs. Screen capture is sent to
the device over that serial link, not off-machine. `saveToFile` /
`deleteFiles` can write or delete paths on the device (default example
`/data/sound/temp.wav`).

**Official ScreenKey Mac/Windows apps:** these are the ones to be careful
with.

- Theme/plugin store and auto-update talk to **cbytecat.com**, not
  waveshare.com, including:
  - `https://www.cbytecat.com/appData/Keyboard/soft/macOS/manifest.json`
  - `https://www.cbytecat.com/appData/Keyboard/soft/macOS/ScreenKeyMacOS`
  - `http://www.cbytecat.com/getResources/themes?state=2&classify=`
  - `http://www.cbytecat.com/getResources/plugins?state=2&classify=`
  - `https://www.cbytecat.com/appData/Keyboard/qmk_firmware/`
- QMK/VIA blobs appear to be fetched from that host (`syk_keyboards_mk10_via.bin`
  and SK18/MK20 variants). Source for those is not in this tree.
- Weather: OpenWeatherMap API URLs, plus geolocation via
  `http://ip-api.com/json/` (sends the public IP to a third party).
- Home Assistant: `ws://homeassistant.local:8123/api/websocket` (user
  token; expected).
- Hardcoded string `key_SYK_123456` in both official binaries. Purpose
  unclear (could be a default key). No obvious hardcoded OpenWeather
  `appid=` was found in strings.
- Mac app is unsigned, x86_64-only, leftover Qt bundle id
  `com.yourcompany.ScreenKeyMacOS`.
- Windows app is Enigma-packed. GitHub
  [#3](https://github.com/waveshareteam/Waveshare-ScreenKey/issues/3)
  reports it ships a WinRing0-style kernel driver
  ([CVE-2020-14979](https://nvd.nist.gov/vuln/detail/CVE-2020-14979)).
  That was not verified by running the exe.
- btop appears embedded in the Mac binary (system-monitor UI).

**Firmware images:** lots of Qt/GNU/Microsoft license and font URLs, plus
HeWeather attribution (`https://www.heweather.com`) and leftover Qt demo
pages (Flickr, YouTube, even an old `google-analytics.com/urchin.js` URL
inside bundled example HTML). Those look like toolchain/Qt leftovers, not
a live C2 channel. XiaoZhi is present as on-device processes in the
20250923 image (`xiaozhiAIControl`, `xiaozhiAISound`). No device-side
Linux source is included, despite the images being labeled
"OpenSourceLicenseFirmware".

## SHA256

See `SHA256SUMS.txt` in this directory (computed 10 Nov 2026, 03:40 AM CST).
