
## 2026-11-23: MK10 TF-card image rebuilt from MK10_V1.0.img

Outcome
- Wrote `tools/imagewty.py`, a small unpacker for unencrypted IMAGEWTY v3
  images (lists or extracts items). The OpenixIMG clone+build was blocked
  in-session, and the format is plain enough to parse directly.
- Copied the community `repack.py` to `tools/repack.py` and added `--src`/`--out`
  plus a check that the image's own `sunxi_gpt.fex` matches the script's
  partition table. The MK10 GPT is identical to the MK20 one: boot-resource 504,
  env 66040, env-redund 66544, boot 67048, rootfs 79648, UDISK 2176800.
- Extracted `linux/MK10_V1.0.img` (Tina 20251015) to `linux/unpacked-MK10_V1.0/`.
- Built `linux/out/mk10-V1.0-4G.img` (3840 MiB, the same sector count as the
  original 4 GB card).

Root cause of two bugs in the community repack.py (MK20 flasher)
- It ignored `cardscript.fex [card_boot] start = 40960`. PhoenixCard shifts
  every GPT partition by 40960 sectors on a TF card. The original card has
  boot-resource at LBA 41464 and rootfs at 120608; the script put them at 504
  and 79648. Fixed with `CARD_BOOT_START`.
- LBA0 was sector 0 of `sunxi_mbr.fex` (`softw411`, no 55AA). macOS couldn't
  see any partitions in the image. LBA0 now comes from `sunxi_gpt.fex`, the
  protective MBR (0xEE, 55AA).
- After both fixes, `diskutil info` partition offsets for s1-s6 match the
  original card exactly. UDISK ends 2015 sectors earlier than on the card;
  PhoenixCard leaves about 1 MiB at the end.
- Self-check fixes: eGON.BT0 sits at offset 4, and env is U-Boot redundant
  format (CRC over bytes 5+). All checks pass now.

Slim (1064 MiB) image dropped: UDISK would be about 1 MB. The rootfs scripts
run `do_check_format /dev/by-name/UDISK` and `resize2fs`, which grows the
filesystem but not the partition, so the overlay would have no room.

What goes on the card: boot0_sdcard @16, boot_package @32800, GPT, then
boot-resource @41464, env x2, boot @108008, rootfs @120608, UDISK @2217760
(starts empty; the firmware formats it).
Not written to the card (PhoenixSuit/USB/NAND items and placeholders):
sys_config, config, board, split_xxxx, sys_partition, sunxi.fex, boot0_nand,
standalone u-boot.fex, u-boot-crash, toc0/toc1, fes1, usbtool(+crash),
aultools/aultls32, cardtool, cardscript, dlinfo, arisc, vmlinux, tinaconf, V*.fex.

Verification
- repack self-check all pass. Attached the image read-only: GUID scheme, six
  partitions, offsets equal to disk4s1-s6.
- Not flashed or booted.

Open
- V1.0 (Tina 20251015) was chosen without knowing which build the device runs.
  boot-resource carries `mk10.bin` (142 KB, likely GD32 firmware), so the
  device may reflash its MCU from it.

### Update: the device runs a newer build than anything published
- The original card (backup `img/mk10-orig.dmg`, attached read-only) runs
  `DISTRIB_ID='tina.syk.20260226.024712'`. The newest public image is V1.0,
  20251015, so flashing `linux/out/mk10-V1.0-4G.img` would be a downgrade.
- Plan instead: clone the backup. `img/mk10-orig-20260226-raw.img` is a dd of
  the attached dmg, and it keeps UDISK, so themes and Wi-Fi come along too.
- `img/head` is the first 1 GiB of the compressed dmg (bzip2 data), not raw
  sectors, so it can be deleted.
- `img/mk10-factory-raw.img` (2 GiB) is 20251015 with `softw411` at LBA0. The
  original card has a 55AA protective MBR at LBA0, which supports the LBA0 fix
  in `tools/repack.py`.
- Raw clone: 4,026,531,840 B, sha256 b04916b7edfb20a033d4a5ce119c1dde2442f3019195d5923b9a714c52a2a092; GPT header present at LBA1.

### Slim 20260226 rootfs + Entware (img/mk10-20260226-slim.img)
Built from the original card clone, not from V1.0. Only boot-resource and
rootfs differ from `img/mk10-orig-20260226-raw.img`. GPT, boot0,
boot_package, env, boot and UDISK are byte-identical (checked by SHA-256 per region).

Rootfs (`tools/slim_rootfs.py`, debugfs -w on a copy, then e2fsck -fy):
720 MiB used -> 186 MiB (10,329 files, 1,173 dirs removed).
- 18 demo/test opkg packages, by their .list files, with status stanzas and
  rc.d links: tinatest (+S99tinatest), directfb, directfb-examples,
  camerademo, tplayerdemo, softap-demo, wifimanager-demo, jpegdecodedemo,
  awrpaf_demo, libsec_key-demo, gpio_ir_test, xr819s-rftest, iozone3,
  memtester, stress, rwcheck, mtop, cpu_monitor.
- /arm-qt: bin (qmake etc.), include, examples, mkspecs, doc, qml, *.a/*.prl.
  Kept lib/*.so and plugins. KeyboardDevice NEEDED = Qt5 Core/Gui/Widgets/
  Xml/Charts/SerialPort + cedar libs, all still present.
- /usr/share/fonts (Windows font-folder dump, QT_QPA_FONTDIR): kept msyh.ttc
  plus every TTF/OTF under 3 MB. Removed the big CJK TTC/TTFs, the .fon bitmaps
  and StaticCache.dat.
- /data/xiaozhiAIControl, /data/xiaozhiAISound. boost/opus/speexdsp kept
  because videoplayerinterfaceAPP depends on them.
- /.fseventsd (macOS litter from an earlier r/w mount).
- Grepped the remaining /usr /data /arm-qt /arm-tslib /lib /bin /sbin for
  directfb/tinatest lib names: no references.

Added:
- /opt/bin/opkg (Entware armv7sf-k3.2 static installer binary, sha256 f473ba80...)
  and /opt/etc/opkg.conf, both from bin.entware.net/armv7sf-k3.2/installer/.
- /etc/init.d/entware + /etc/rc.d/S99entware. In the background it retries
  `opkg update && opkg install entware-opt` every 30 s (up to 1 h) until the
  network is up, then does the generic.sh passwd/group links and runs
  rc.unslung. Log: /tmp/entware-boot.log.
- /etc/profile.d/entware.sh puts /opt/bin:/opt/sbin on PATH.

boot-resource: config.json `enableXIAOZHIAI` true -> false; removed .fseventsd.

UDISK kept as-is (themes, /upper/data/lunch.sh, wpa_supplicant.conf with no
networks yet, whiteouts for adbd/wpa rc.d links). Wi-Fi has to be set up
from the app before Entware can bootstrap.

Not verified: never booted. Font fallback for themes that name a removed font
is untested. Whether KeyboardDevice behaves with XiaoZhi gone is untested
(the config flag is off).

Warning: `tools/flash.sh` defaults to `img/mk10-factory-raw.img`, which was
built by the old `tools/repack_mk10.py`. Its partitions sit at the wrong LBAs
(no +40960) and LBA0 is softw411. Don't flash it.
- img/mk10-20260226-slim.img sha256 38ea6731b47825a27a793aaca6f89bb2c53c68d9cf90fa3f6f3cddc7066a2833

## 2026-11-24 — Flash test, SD card compatibility, adb on macOS

Outcome
- Flashed img/mk10-20260226-slim.img to a 32 GB microSD (dd, then again with
  balenaEtcher). The MK10 dropped to FEL both times.
- Rob flashed the unmodified stock clone (img/mk10-orig-20260226-raw.img) to the
  same 32 GB card. It also drops to FEL, so that card is incompatible with the
  boot0/BROM path. The slim image itself is still untested; it needs a different card.
- Diag on the working 4 GB card: the SD card is the only storage (mmcblk0 only;
  no NAND, eMMC or SPI flash), so a card that can't be booted goes straight to
  FEL. The working card is a no-name SDHC (CID manfid 0x05, name "asdfg").
- The USB Wi-Fi adapter that shipped with the device works on the stock build.

Root cause: adb sees no device on macOS
- adb 37.0.0 (libusb backend) skips devices that report an empty USB serial,
  and the Tina gadget (18d1:d002) reports none. Trace line:
  `received empty serial from device at ...`.
- Fix: `adb kill-server; ADB_LIBUSB=0 adb start-server` (native macOS backend).
  Add `export ADB_LIBUSB=0` to the shell rc to make it permanent.

Notes
- Mainline Linux now carries T113-S3 support (sun8i-t113s.dtsi,
  MangoPi MQ-R-T113 dts). github.com/Evlers/linux_kernel_t113 (6.0.1, 2022)
  is stale. A mainline kernel would drop the vendor Cedar/disp drivers that
  KeyboardDevice needs (libVE, libvdecoder, libuapi).

Follow-up
- Flash the slim image to another small (4-16 GB) SDHC card and boot-test it.

## 2026-11-24 — Bootloader missing from clone; slim image rebuilt

Root cause of the FEL boots
- img/mk10-orig-20260226-raw.img (built from the dmg backup) is all zeros
  outside the partitions apart from LBA 0-1. boot0 (LBA 16) and boot_package
  (LBA 32800) are missing. The old slim image inherited the same hole, so every
  card flashed from either image went to FEL. The 32 GB card was fine.
- Likely cause, not verified: the dmg was made by a tool that images only the
  partitions. tools/backup-card.sh (full rdisk dd) keeps the gaps.

Outcome
- Rob re-imaged the card with a full rdisk dd: img/rdisk8.img. boot0 eGON.BT0
  checksum OK, `sunxi-package` at LBA 32800. That image boots on another card.
- Rebuilt img/mk10-20260226-slim.img on top of rdisk8.img. The old broken file
  with the same name was overwritten.
  - rootfs: tools/slim_rootfs.py on the rdisk8 rootfs extract. Removed 10328
    files and 1172 dirs, about 507 MiB. Now 47539/204800 blocks; fsck clean.
  - boot-resource: enableXIAOZHIAI set to false; removed the macOS ._bootlogo*
    AppleDouble files. "bootlogo copy.bmp" was left in place.
- Verified the head (MBR/GPT/boot0/boot_package), env..boot, UDISK and backup GPT
  regions are identical to rdisk8.img, and that the rootfs and boot-resource
  regions match the build files.
- sha256 03dddea3b4cb4622deb6e4eb97719f6f317467915c12185d370ca24b07448c68 (with logo)
- img/bootlogo.bmp: Rob's logo as a 160x160 24-bit BMP, the same format as stock.
  Now installed as ::bootlogo.bmp in the slim image.

Files
- linux/orig-rdisk8/{rootfs.ext4,boot-resource.fat}: extracts.
- linux/build-rdisk8/{rootfs.ext4,boot-resource.fat}: slim builds.
- linux/build-rdisk8.log

Don't use img/mk10-orig-20260226-raw.img or linux/orig-20260226/ as a base: no bootloader.

Not done: the slim image hasn't been booted yet.

## 2026-11-24 — Card builder (tools/build_card.py)

Outcome
- Rob booted img/mk10-20260226-slim.img: it works.
- New tools/build_card.py BASE.img OUT.img [--ssh-key PUB] [--no-slim]. It
  automates the steps that were done by hand:
  1. Refuses a BASE with no boot0 at LBA 16 (the partition-only dump trap).
  2. Reads the partition offsets from BASE's GPT and extracts rootfs and boot-resource.
  3. rootfs: slim (tools/slim_rootfs.py), then tools/overlay/ copied in with
     debugfs (root-owned, local modes kept; existing dirs untouched).
  4. Writes /root/.ssh/authorized_keys (0700/0600) from --ssh-key, default
     ~/.ssh/id_ed25519.pub. Without it sshd refuses root, since there's no
     password login.
  5. boot-resource: drops macOS litter (._*, .fseventsd...) and copies
     tools/overlay-sd/ in with mtools, verifying each file by reading it back.
  6. Assembles OUT and checks every byte outside those two partitions against BASE.
- To add things: drop files into tools/overlay/ or tools/overlay-sd/, or add a
  step function in build_card.py.
- The Entware pieces moved out of slim_rootfs.py into tools/overlay/:
  /etc/init.d/entware (+ rc.d/S99entware), /etc/profile.d/entware.sh,
  /opt/bin/opkg, /opt/etc/opkg.conf, and /etc/entware/packages.
- /etc/entware/packages: vim fdisk bash zsh openssh-server openssh-sftp-server
  (names checked against bin.entware.net armv7sf-k3.2 Packages). The init
  script installs the list once the network is up. It stores the list's md5 in
  /opt/etc/.mk10-packages, so editing the list re-runs the install.
- Every boot: logs the existing host keys, then runs /opt/bin/ssh-keygen -A
  (creates only missing key types), then starts Entware's rc.unslung, which
  starts sshd. Log: /tmp/entware-boot.log.
- Moved img/bootlogo.bmp to tools/overlay-sd/bootlogo.bmp. tools/overlay-sd/config.json
  has XiaoZhi off. Removed tools/overlay/etc/init.d/zzshell (never enabled;
  lunch.sh does the same job).
- Built img/mk10-build.img from img/rdisk8.img.
  sha256 1b9fb98d4156f3e090e81ce7469c858d9cfd958eddeeca45d238cebb645f3a70.
  Checked the modes, owners, symlink and init script content in the built rootfs.

Alpine notes
- Vendor userland is glibc 2.23 armhf (/lib/ld-linux-armhf.so.3); Alpine is musl.
  sgerrand glibc apks are x86_64 only. gcompat (armv7, 1.1.0-r4) is a shim over
  musl and is risky for glibc-built libstdc++/Qt/libVE. Plan: ship the vendor glibc
  runtime in its own directory and start KeyboardDevice through its own loader
  with --library-path. LilAlpine's closest board is Lume-T153. This is a separate
  change.

Not done: img/mk10-build.img hasn't been booted. The package install and sshd
are untested on the device.

## 2026-11-24 — LilAlpine port for the MK10 (boards/MK10-T113)

Outcome
- The MK10 runs LilAlpine (Alpine 3.24 armv7) on the stock vendor kernel and boot
  chain. The stock key-display app (KeyboardDevice) runs on top: UI, background video,
  USB serial link, and Wi-Fi via the app.
- Work is on the LilAlpine branch feat/mk10-t113 in ~/workspace/luckfox/LilAlpine,
  15 commits from c794a37 to 05d778d. Not pushed.

Design (see boards/MK10-T113/README.md)
- The image is a full card dump (img/rdisk8.img) with the Alpine ext4 written into
  p6 (UDISK, the last partition). Stock Tina stays intact on p5. Both U-Boot env
  copies are rebuilt with mkenvimage -r and diff-checked: only mmc_root changes,
  to /dev/mmcblk0p6.
- growfs (GROWFS_PART=6) grows p6 to the card's size on first boot. Tested on a copy:
  sfdisk -N 6 keeps the entry table at LBA 41462 and writes only LBA 0, 1 and 41463
  plus the backup GPT. My earlier warning that this risked FEL was wrong.
- fw_printenv/fw_setenv are set up via /etc/fw_env.config for p2/p3. Verified on the
  device: a loglevel change survived a reboot, so U-Boot reads the copy fw_setenv
  writes. `fw_setenv mmc_root /dev/mmcblk0p5` boots stock Tina.
- Vendor glibc 2.23 runs alongside musl. /lib/ld-linux-armhf.so.3 links to the vendor
  ld-2.23.so. /etc/ld.so.cache lists only the vendor dirs; fetch.sh builds it with
  Debian's armhf ldconfig in Docker. Vendor binaries run natively, with no
  LD_LIBRARY_PATH.
- fetch.sh pulls the vendor libs, Qt, tslib, /data, fonts, adbd and
  videoplayerinterfaceAPP from p5. It also merges Tina's UDISK overlay
  /upper/data, which holds the MK10 theme, 896x304 assets, plugins and KeyboardInfo.
- Services:
  - adbd: sysinit, configfs FunctionFS gadget.
  - /data/setusbconfig wrapper: keeps adb alongside the app's ACM serial (composite).
  - mk10-modeswitch: usb_modeswitch -KW for the RTL8188GU dongle.
  - keyboard-device: the app owns Wi-Fi, as on Tina, because it kill -9s other
    wpa_supplicants.
  - bootlog: writes logs to /mnt/SDCARD/alpine-log.
- The base gains util-linux-misc (fdisk) and openssh-sftp-server. vim, bash, zsh and
  openssh-server were already there.
- boards/MK10-T113/build.sh is a one-shot build with presets. At the end it offers to
  rewrite a card it wrote before, matched by p6 GUID plus the mk10-alpine label.

Root causes found along the way
- FEL boots: the dmg-based clone had no boot0/boot_package. The full rdd dump fixed it.
- Dead boot (likely cause): e2fsprogs 1.47 turns on metadata_csum/64bit by default.
  mke2fs now uses the vendor feature set.
- adb not listed on macOS: adb 37's libusb backend skips devices with an empty serial.
  Use ADB_LIBUSB=0, or (done) set a gadget serial.
- Wi-Fi flapping: KeyboardDevice kills any wpa_supplicant it didn't start, then
  runs its own on /etc/wpa_supplicant.conf.
- Black screens: the MK10 theme lives in UDISK's overlay upper, not on p5.
- No background video: the player was missing, and running the app through the
  explicit loader gave it /vendor/lib as its asset dir.

Verification
- On the device: adb, ssh over Wi-Fi, the env reboot test, UI on all screens, and the
  background video playing. The app has run from the old p5-layout image plus
  hand-applied fixes, not yet from a full rebuild.
- Not yet run end to end: a full rebuild with the p6 layout and native-exec changes
  (`REFETCH=y boards/MK10-T113/build.sh`), and growfs on a real card.

Follow-up
- Rebuild, flash, and check df -h / plus every item in config.json `_verify`.
- Push feat/mk10-t113 and open a PR when happy (mixed concerns: base pkgs + growfs
  generalization + new board).

## 2026-11-24 — MK10 LilAlpine: full boot from a clean build

- Root cause of "image boots Tina": the vendor U-Boot's "update part info" step
  resolves env `root_partition` to a GPT partition name and overwrites `mmc_root`
  with it. The fix sets `root_partition=UDISK` as well (LilAlpine c7377b9). To go
  back to stock Tina: `fw_setenv root_partition rootfs`.
- The pack container broke after the fetch step pulled `debian:trixie-slim` for
  arm/v7, which retagged the shared base image. fetch now uses
  `arm32v7/debian:trixie-slim` (58c7be6).
- Verified: `boards/MK10-T113/build.sh` built and wrote the card itself (it found
  disk5 by p6 GUID + label), and the board fully booted Alpine from p6 with the
  vendor app.
- Image sha256 114d83ea4923b6586094d8595f91a6d6c9338efd3ded82c6747957b912d84818.
- growfs verified: `df -h /` shows 28.0G on the 32 GB card. Still to check: the rest of the
  `_verify` list in config.json.

## 2026-11-24: ScreenKey host rewrite, scope + mk10-studio MVP

Outcome
- Scoping doc: `docs/screenkey-rewrite-scope.md`. No fuller vendor source exists, so this is a rewrite. Electron, per Rob.
  Several third-party RE repos are cloned under `src/community/`; only Terminus (MIT) is port-safe.
- `.Theme` fully decoded, with a byte-exact codec in Python (`tools/qtheme.py`) and Node (`app/lib/theme.js`).
  Schema is in `docs/theme-format.md`.
- New Electron app `app/` (mk10-studio): opens existing themes (stock `defaultTheme` included), previews the
  896x304 panel, edits key title and image, replaces the bg video (ffmpeg transcode), saves, and pushes. An opt-in MCP
  server (`http://127.0.0.1:47110/mcp`) shares the same session, so agent edits show live in the UI.
- Push works over USB serial only (verified against vendor KeyboardDevice V2.34 on LilAlpine; stock Tina untested): `deleteFiles`, then `saveToFile`+`setFileCRC`, then V1 reload
  cmd 2 (`"AA551234 FIXEDCMDHEAD "` framing). About 10 s for 12 MB. ssh mode is kept for LilAlpine.

Findings
- `getInfo` blanks fb0 and kills videoplayerinterfaceAPP until a reload or restart. The app never sends it.
- serialport 13 under Node 26: reads stall (cause unknown; one run got ~100 replies then hung, later runs saw replies
  only on close). It works under Electron's Node 24.22, so `npm run cli` uses `ELECTRON_RUN_AS_NODE=1 electron`.
- GD32 is its own USB HID (`4250:426F`, QMK/VIA), so hotkeys don't need the host.
- The CRC registry is `/data/file_info.json`, not `/file_info.json`.

Verification
- `npm test` (17 pass), `npm run lint` clean, web-layout greps empty.
- E2E on the device: an MCP client opened the stock theme, set a key title and image and a new bg video, then pushed
  over USB. The fb0/fb2 captures show all three. The device was then restored to stock (config.json byte-identical,
  `defaultTheme.Theme` sha unchanged, test files deleted).
- The app launches and renders, per screenshots in `docs/screenshots/`.
- Not run: UI edit paths clicked by hand (title, replace, drag-drop, save) and the MCP toggle inside the Electron
  window. The MCP module was tested standalone and in the E2E.

Follow-up
- Key events: run `python3 tools/mklisten.py --getinfo --seconds 60` and press keys. Also test whether getInfo
  followed by a V1 reload keeps events flowing with the layout up. This gates host actions (Phase 3).
- ScreenKeyMacOS was not running at the end; it holds the port if relaunched.

Follow-up commit (same day)
- Push safety: every push writes a new `mk10studio-<ts>.Theme`, reloads it, then deletes older mk10studio pushes.
  A failed push leaves the active theme intact. It never matches `defaultTheme.Theme`.
- Save refuses to overwrite a theme inside an `.app` bundle (the vendor stock theme). The UI falls back to Save As,
  and MCP `save_theme` returns an error.
- Verified in the real Electron window (`--mcp`): an MCP client edited a title, replaced the GIF key's image and the
  bg video, and pushed twice. The UI updated live (`docs/screenshots/mk10-studio-mcp-live.png`), the device rendered
  it, and the old push was removed.
- Device restored to stock. fb0 matches stock, the player runs the stock mp4, `config.json` is byte-identical,
  `defaultTheme.Theme` sha is unchanged, and the 3 orphaned extracted test assets were removed over ssh.
- Note for Rob: at the probe start the device's `config.json` had `deviceBl: 0`; it was restored to 58 from backup.
  Unknown what set it to 0.
- The first commit also swept in the pre-existing `tools/`, `README.md` and `SHA256SUMS.txt`. The repo is whitelist-ignored
  (`.gitignore` tracks only app/, docs/, tools/ and the root .md files).

## 2026-11-24 — MK10 LilAlpine polish: logging, splash, ScreenKey rewrite handoff

Outcome
- Kernel log: KeyboardDevice runs `dmesg -c` via `system()`, which clears the ring buffer. Added a `dmesg` shim at `/usr/libexec/mk10` that drops `-c`/`-C`, and the `keyboard-device` service puts it first on the app's PATH (LilAlpine 31e495b). Tested on the device (a test line survived an app restart); not yet in a rebuilt image.
- `fw_printenv` showed no devices because `growfs` re-reads the partition table and mdev loses the p2–p5 nodes. `growfs` now runs `mdev -s` after the re-read (3bb4f10, shared across boards). Takes effect on the next build.
- Small-screen splash: `mk10.bin` is a raw 240x296 RGB565 LE framebuffer dump with no header, not a sunxi format. The U-Boot boot_package contains the `mk10.bin`/`mk20-plus.bin` strings (inferred; U-Boot code not traced). `MK10_SPLASH` puts it into p1 at pack time (48279b1). Rob's `mk10.bin` is in `tools/overlay-sd/`.
- Wrote `docs/screenkey-host-rewrite-handoff.md` for a fresh session to scope a host-app rewrite. Official ScreenKey is closed source (76 MB Qt 6, Intel-only). Waveshare's open source is only a ~1,180-line Qt 5 serial demo. Layout editing was already bad on stock Tina, so it's an app limit, not a port bug.
- Device `/file_info.json` and `defaultTheme.Theme` (13,198,510 bytes, vs 13,213,899 copied from UDISK) were rewritten after the copy. Probably a ScreenKey sync; unverified.

Changed
- LilAlpine `feat/mk10-t113`: commits above, not pushed.
- waveshare-mk10: `docs/screenkey-host-rewrite-handoff.md`, `tools/overlay-sd/mk10.bin`.

Verification
- On the device: the dmesg shim, and `mdev -s` restoring the p2–p5 nodes.
- Not run: a full rebuild with the shim, the growfs `mdev -s` and the splash. Whether U-Boot actually paints `mk10.bin` is unconfirmed.

Follow-up
- Rebuild, flash, and confirm the splash, kernel log and `fw_printenv` on first boot.
- The branch mixes concerns (base pkgs, growfs, new board). Split it before a PR.

## 2026-11-24 — MK10 key events verified

Outcome
- Rob's key-press run of `tools/mklisten.py --getinfo` confirms that key events arrive after getInfo. Each press and each release sends a cmd 101 frame
  `{"method":"keyStateChanged","parameters":{"col","row","pressed"}}`, with frame ids counting down from 0xFFFFFFFF.
  All 10 keys reported, row 0..1 and col 0..4. Pages are not reported.
- `mklisten.py --reload [THEME]` sends a V1 reload (cmd 2) 1 s after getInfo. This tests the last Phase 3 gate:
  do events keep arriving once the layout is back?

Changed
- `docs/theme-format.md`, `docs/screenkey-rewrite-scope.md`, `tools/mklisten.py`.
- Also commits the LilAlpine-session PROGRESS entry above, which was uncommitted.

Verification
- `py_compile` and `--help` on mklisten.py. `--reload` has not been run against the device.
- The device is probably still in V2 with a blank layout after the key test (not checked). `--reload`, or
  `rc-service keyboard-device restart`, brings it back.

Follow-up
- Run `python3 tools/mklisten.py --getinfo --reload --seconds 60` and press keys.
  If events keep arriving: Phase 3 is a listener in the app plus a theme reload.
  If not: look at VIA raw HID, or keep the layout blank and draw with cmd 100.
- Rob ran `mklisten.py --getinfo --reload`: key events keep flowing after getInfo plus a V1 reload, with the layout up.
  An fb0 capture showed the stock layout with a live clock, and the player was running. Presses during the ~3.5 s
  reload are queued and delivered in order. The Phase 3 gate is cleared, and the device is back on its stock theme.

## 2026-11-24 — MK10 live data push verified

Outcome
- V1 cmd 1 (`SEND_SYSTEM_DATA_TO_DEVICE`), with a UTF-16BE string map keyed by `system_data_name`, updates the stock
  page's CPU/GPU/RAM text widgets at once. This was done in V2 mode after getInfo + reload. Format from Terminus-MK20.
- The type 109 ring arcs did not move for 0, 5, 42 or 95. Types 101/102 are untested.
- After a V1 reload the device sends V1 cmd 15 JSON (`wifiState`, plus the `deviceRequestSystemData` key list) and a
  V1 cmd 13 keyState frame. So MK20-style key events exist on MK10 too.
- The device had rebooted before this run (uptime 4 min, port name changed). Not caused here.

Changed
- `tools/mkv1.py` (new), `docs/theme-format.md`, `docs/screenkey-rewrite-scope.md`.

Verification
- fb0 captures after pushing 42/77/13, 5/95/50 and 0/0/0: the text changed, the rings did not.

## 2026-11-24 — mk10-studio: edit action values

Outcome
- The key inspector shows the existing **text** fields of a key's action as inputs (Url, description, pageName, password…).
  The type, field set and order never change: firmware ignores actions with extra or misordered fields (Terminus-MK20).
  Locked: `type`, `iconPath`, `parentDescription`, `keyString` (paired with the int `keycode`), `AISoundControlKeyword`.
  `pageName` must name an existing page. MCP: new tool `set_key_action_field`; `get_page` lists `action.editable`.
- Dropped the duplicate "MCP listening" log line.

Verification
- 19 tests pass; the new ones check that only the edited value changes, that type and order survive encoding, and that the guards reject bad edits.
  Lint is clean and both layout greps come back empty. Screenshot of the inspector with editable Url/description checked.
- Not run: pushing an edited action to the device and pressing the key (validation checklist §2b).

## 2026-11-24 — Action catalogue, LilAlpine build fixes, kernel/cedar sources, bg-video push bug

- Outcome
  - **Action catalogue:** decoded `allThemeTest.Theme` (pulled from the device) plus the stock themes into 17 action templates in `app/lib/action-templates.json`.
    - Field order does not matter: current ScreenKey writes alphabetical and the device loads both orders. The earlier MK20 warning was about missing or extra fields.
    - Labels are plain English (`qmk_string` = "Keyboard macro", `text` = "Type text (via Mac)"). Written `type` values are unchanged.
  - **Who runs each action:**
    - Device-run, verified with ScreenKey closed: `qmk_string`.
    - Host-run, verified: screenshot, play sound, open folder, speaker/mic volume.
    - Hotkey (`keyboard`) takes QMK keycodes, so mute, vol+ and vol− work without the host (168/169/170 — from the MK20 theme, not pressed on the device).
    - Untested: Hotkey toggle, mouse action, MK10 speaker volume, Switch page.
  - **`password` actions:** stored as 32 hex characters. Hash or encrypted is unknown.
  - **Scope doc:** `docs/screenkey-rewrite-scope.md` now splits Phase 3 into 3a resident menu-bar app with one shared serial owner, 3b running host actions, 3c drag palette. It adds a macOS permissions section and Developer ID signing/notarization to Phase 5.
  - **App fixes:** Save As no longer defaults into the `.app` bundle (now `~/Documents`). A stray `theme/MK10/mk10studio.Theme` is still inside `ScreenKeyMacOS.app`, pending Rob's call. Stale push-timing text fixed, and `docs/mk10-studio-validation.md` added.
  - **LilAlpine (`feat/mk10-t113`, private/solo, not pushed):**
    - `e841670`: tty1–6 commented out of inittab, busybox `ntpd` service dropped (chronyd only). The device was not running `ntpd`; `S98sysntpd` is only a failing call from the vendor app.
    - `75614dd`: `MK10_BASE_IMG` default is now `img/mk10-original-PRISTINE.img`. `rdisk8.img` had been compressed into the `.xz`, which I decompressed.
    - `51243d2` and `dffd5b6`: rk-camera SD storage and PicoPlus docs, repo cleaned.
  - **Kernel and cedar:**
    - No kernel source is in the repo.
    - `open-cores/tina-t113-linux-5.4-new` is a 5.4.61 tree whose `cedar_ve.c` matches the device's dmesg line numbers (552/592). The ioctl tables and the whole-kernel `#334` build were not compared.
    - Public libcedarc trees use ion directly. No dma-heap build was found. Details are in `docs/t113-kernel-cedar-sources.md`.
    - The Waveshare open-source zip holds no kernel source. I deleted the two extracted `.img` copies (the zip still has them).
  - **Stock bg video:** frame-matched on the device and it plays correctly (4.0 s, 96 frames, 24 fps loop). The black screen at about 13:05 is unexplained: the log shows `XPLAYER_COMMAND_RESET` and a zero-fill of fb0, with no timestamps to line up.
- Changed
  - Commits in waveshare-mk10: `4bf4c62`, `e91c501`, `c8ad254`, `b4a442e`, `f6bf23c`, `51d8cf7`, `37c29b7`, `21fcd7b`, `c2229b1`, `7bc4fc9`, `d8fac67`, `74e234d`, `ae82a56`.
  - `docs/theme-format.md`, `docs/t113-kernel-cedar-sources.md`, memory notes.
- Verification
  - 19 tests pass and lint is clean after the action-value work.
  - Not verified:
    - Action-value edits pushed to the device (validation checklist §2b).
    - The remaining hotkey, mouse, volume and page-switch guesses.
    - A LilAlpine rebuild with these changes.
- Open bug (in progress at compaction)
  - After Rob pushed `mk10studio.Theme` from the studio, the layout appeared but the bg video was missing.
  - Investigated the pushed theme, config, player process and log, then sent a V1 reload and restarted `keyboard-device` to see whether the player returns.
  - The result is not in the excerpt, and the root cause is unknown.

## 2026-11-24 (later): ssh-push video, UI tweaks, clipboard spec

- Outcome
  - **Missing bg video after ssh push:**
    - A V1 reload over USB brought it back (player pid 6792).
    - Three repro attempts all started the player: plain `rc-service keyboard-device restart`, an in-place theme overwrite plus restart, and a config switch from stock and back plus restart.
    - Root cause is unknown.
    - `pushSsh` now checks for `videoplayerinterfaceAPP` for up to 16 s after the restart, when page 0 has a video, and logs a warning if the player is missing.
  - **UI:**
    - Selected key/video gets an overlay ring and tint. It is an `::after` overlay, so the key image can't paint over it.
    - New **key gaps** toggle under the preview, default on, saved in localStorage. It draws a 3px black bezel per key, empty slots included.
    - Device push settings moved from the inspector into a native `popover`, opened by the **Device: <mode>** button at top right.
  - **Scope:** new phase 3d "Key clipboard" with a section describing the clipboard JSON, its detection, and cut/paste rules. The stale 3c text ("7 key types") now says 17.
- Changed: `app/lib/session.js`, `app/public/{index.html,app.js,styles.css}`, `docs/screenkey-rewrite-scope.md`, `docs/mk10-studio-validation.md`.
- Verification
  - Lint is clean. The layout greps are empty.
  - 18 of 19 tests pass. The failure is `real theme: controlData round trips on every key`: it expects 65 keys, but the fixture has 69. The fixture `/Applications/ScreenKeyMacOS.app/.../defaultTheme.Theme` was modified at 14:07 today. It is no longer stock: sha b5b75da0…, mode now rw.
  - The UI changes were not clicked through; the app needs a restart.
- Follow-up
  - Put a pristine copy of the stock defaultTheme in the repo (or `img/`) as the test fixture, so vendor-app saves can't break the tests.
- Settings dialog, added later the same day:
  - The MCP toggle and port moved out of the top bar into a native `<dialog>`. It opens from the **Settings** button, Cmd+, (custom appMenu) or the green MCP badge.
  - Sections:
    - MCP: enable, port, and the `claude mcp add` command with a copy button.
    - Editor: key gaps (moved here), and a new `reopenLast` pref saved in settings.json through the whitelisted `setPref` IPC.
    - About: version and settings file path.
  - The new `--settings` flag opens the dialog at launch, for screenshots.
  - Verified: `--screenshot` captures of the main window (key highlight, gaps) and of the open dialog. Lint is clean.
- Test fixture:
  - The bundle `defaultTheme.Theme` had been overwritten by an accidental ScreenKey save (69 keys).
  - The pristine copy (sha `88785d8b…`, 65 keys) was recovered from the 04:19 scratch backup. A second, independent scratch copy matches.
  - It is saved read-only at `img/stock/defaultTheme.Theme`, which is untracked like the rest of `img/`. The sha is in SHA256SUMS.txt.
  - `theme.test.js` now uses this copy. 19/19 tests pass.
  - The v1.1 dmg bundles no themes, so it can't serve as a source.
- HID launch keys:
  - A temporary theme pushed over serial. On macOS: Search opens Siri/Spotlight, and Mission Control and Launchpad work. WWW Home, Mail, Calculator, My Computer, Control Panel and Assistant did nothing. Recorded in `docs/theme-format.md`.
  - The device was switched back to `defaultTheme.Theme`, and `hidtest.Theme` deleted.
- IMU: none. The only I2C device on the T113 is an `atsha204a` (0x64), and there are no IIO devices.
- Device IP: it is now `10.0.1.48` (udhcpc). The app's ssh default, the checklist, the scope doc and `tools/fbcap.py` are updated. Historical logs in `docs/theme-format.md` still say 10.0.0.10.
- Phase 3a was split into 8 beads (`waveshare-mk10-phase-3a-pv0`; `.beads/` is gitignored). MCP stays off by default and is offered in a first-run dialog. The typing plan prefers the device (`keyboardInput` not yet probed).

## 2026-11-24 (later still): phase 3a beads, typing plan, HID test, device IP

- Outcome
  - **Phase 3a planned, nothing built.** Epic `waveshare-mk10-phase-3a-pv0` with 8 chained beads (.1 → .8, only .1 ready). `.beads/` is gitignored, so they exist only on this machine.
    - .1 device link (one long-lived serial owner, reconnect, test)
    - .2 USB push goes through the link
    - .3 key events on connect, opt-in (getInfo, then reload of the last-pushed theme)
    - .4 menu-bar tray, close-to-tray, single instance
    - .5 first-run onboarding dialog asking about MCP (off by default)
    - .6 start at login
    - .7 read-only permission status in Settings
    - .8 docs
  - **Decisions:**
    - Reload on connect only targets the theme the app last pushed, since nothing on the device reports the active theme and a reload rewrites `config.json`.
    - Key events are opt-in because getInfo blanks the panel for about 4 s.
    - Permission prompts at first use go to 3b.
    - The stats feed goes to Phase 4.
  - **Permissions:** no George-style wizard. Status checks are passive and prompts fire only on an explicit click. Never probe screen capture. Saved memory `george-permissions-reference.md`.
  - **Typing plan:** prefer device-side typing (`qmk_string` is verified on device). `keyboardInput` is untested, so probe it with an empty-params call once the serial port is free. macOS Accessibility is only a fallback for text the device can't type. ScreenKey's Accessibility prompt when typing is recorded in the docs.
  - **HID launch keys on macOS:** tested via a temporary theme pushed over serial.
    - Worked: Search (Siri/Spotlight), Mission Control, Launchpad.
    - Did nothing: WWW Home, Mail, Calculator, My Computer, Control Panel, Assistant. Whether macOS ignored them or the firmware never sent them is not determined.
    - QMK has no keycode for AL Internet Browser (0x196). URLs and apps stay with the Mac app (`shell.openExternal`, no permission needed).
    - The device was switched back to `defaultTheme.Theme` and `hidtest.Theme` deleted.
  - **IMU:** none on the board.
  - **Device IP:** now `10.0.1.48`. DHCP via `udhcpc`; nothing is static on the device.
- Changed
  - Commits: `746a9cd` (docs: Accessibility note on typing), `13d6a04` (HID results in `docs/theme-format.md`, IP swapped in `app/lib/session.js`, `docs/mk10-studio-validation.md`, `docs/screenkey-rewrite-scope.md`, `tools/fbcap.py`).
  - The 3a bead descriptions also use the new IP.
- Verification
  - 19/19 tests pass after the IP change.
  - HID results are Rob's hands-on observation on macOS; Karabiner-EventViewer was not used.
  - Not verified:
    - `keyboardInput` (no probe yet).
    - Any 3a code (none written).
- Follow-up
  - Rob's saved studio Device popover still holds `root@10.0.0.10` and must be changed, or ssh pushes time out. `~/.ssh/config` line 116 still lists the old IP (not touched).
  - Quit studio and ScreenKey, then run the `keyboardInput` probe.
  - Pick the next build: 3a first (recommended), or 3c then 3d.
  - Rob asked not to `open` PROGRESS.md until this thread is done.

## 2026-11-24 (evening): fb_gc9107 driver review, build and device test; atsha204a

- Outcome
  - Reviewed another agent's reconstruction of `fb_gc9107.c` (`/tmp/waveshare-kernel/`) against the vendor vmlinux.
    - Init sequence, set_addr_win (+2/+3), set_var and the `fbtft_display` descriptor all match.
    - One fix: the post-sleep-out delay is `mdelay(20)` (20 x `__const_udelay(1000*UDELAY_MULT)`, no 0x11 replay), not `mdelay(2)` x21.
  - Committed the fixed driver plus Kconfig/Makefile entries on chonk: `~/build/mk10/kernel` (Rob's fork `rgr4y/tina-t113-linux-5.4-new`), commit `50e671d`. Not pushed. The clone is shallow.
  - Device test: unbound `spi0.1` from the built-in driver, insmod `fb_gc9107t.ko` (renamed test build). It drives `fb1` correctly under the vendor app (Rob's visual check).
    - Ten GC9107 key panels: `spi0.1`-`spi1.6` = `fb1`-`fb10`. The GC9307 on `spi0.0` is `fb11`.
  - atsha204a: `KeyboardDevice` runs `Key(11) verify OK` at every start. With the chip unbound, the app still started. Mainline `atmel-sha204a` is RNG only (master adds `otp`) and has no `/dev/atsha204a`.
  - Vendor firmware upgrades are inert on LilAlpine: no swupdate, no `swu_*` env, and the app runs no `fw_setenv`. Rob keeps `/data/DeviceUpgradeFirmware`.
  - Handoff written: `docs/handoff-atsha204a-hwrng.md` (mainline atmel-sha204a as modules, temporary unbind, hwrng test).
- Verification
  - `W=1` cross-build clean (Bootlin gcc 7.3, vendor `.config` from IKCFG). Module vermagic equals the vendor's.
  - Not verified: full kernel build or link, rotations other than 0, all ten panels on our driver.
- Follow-up
  - `fb_gc9107t` stays loaded on `spi0.1` until reboot. `KeyboardDevice` was last started without the chip; restart it once checked.
  - The wifi shim lets the app relaunch `wpa_supplicant`/`udhcpc` (Wi-Fi drop on app start); that's a LilAlpine change.

## 2026-11-24 (late): fb_gc9107 validated from power-on; GC9307 handed off

- Outcome
  - All ten key panels run on the reconstructed `fb_gc9107t` from power-on. The earlier dark panels came from runtime rebinding (no reset GPIO), which also failed with the vendor driver.
  - Temporary validation setup on the device:
    - The u-boot `setargs_mmc` has `initcall_blacklist=fbtft_driver_module_init` appended. This also blocks fb_gc9307, so the info screen is dark.
    - `/etc/init.d/mk10-fbtft` (default runlevel) loads `/lib/modules/5.4.61/extra/fb_gc9107t.ko`.
    - The test module exposes `init_module`, because the blacklist name matches every `FBTFT_REGISTER_DRIVER` init, the module's included. The first boot attempt hit exactly that.
  - Env backups: `backups/` (gitignored) and `/root/mk10-bak/` on the device (raw p2/p3 plus text, sha `78c862b6…`).
  - Handoff written for the GC9307 reconstruction: `docs/handoff-fb-gc9307.md`.
- Verification
  - dmesg shows the blacklist at 0.35 s and fb1..fb10 = spi0.1..spi1.6 on `fb_gc9107t` at 14.3 s. Rob confirmed all ten keys lit.
  - Not done: rotations other than 0, a persistent install via LilAlpine, restoring the env.

## 2026-11-24 (night): custom boot logos, vendor drivers restored, own-kernel prep started

- Outcome
  - Installed Rob's custom logos on the device card (`/mnt/SDCARD`, partition 1): `mk10.bin` (sha `a0f36d60…`) and `bootlogo.bmp` (sha `1bc1ad05…`), both read back after copy. Originals are in `/root/mk10-bak/` as `mk10.bin.orig` and `bootlogo.bmp.orig`.
  - Reverted the temporary validation setup from the previous entry:
    - `setargs_mmc` restored from the backup (sorted `fw_printenv` matches the backup).
    - `mk10-fbtft` removed from the default runlevel. The script and the `.ko` stay on the device.
    - After a reboot, no blacklist on the cmdline. `fb1`-`fb10` are on the vendor `fb_gc9107`, `fb11` is on `fb_gc9307`, and `keyboard-device` started.
  - The first reboot attempt never ran (a backgrounded job died with the ssh session). It was re-sent with `nohup`.
  - `docs/handoff-fb-gc9307.md` reworded: GC9307 is the large screen, the ten GC9107s are the screenkeys. Added:
    - validation-mode steps;
    - a `bootlogo=` module-parameter plan (custom `update_display`, `kernel_read_file_from_path()`, 142,080-byte RGB565 file, module loaded after `localmount`);
    - datasheet references (`GC9307_Manual.pdf` useful; `GC9307.pdf` is a 172×320 module and not usable for geometry).
  - Why the logo vanishes at boot: fbtft-core pushes the empty framebuffer when the GC9307 registers at about 0.9 s. Hypothesis only: the logo shown was `mk10.bin` on the large screen.
  - Kernel prep for an own-kernel boot image (drivers built in, zram init back in userland) started:
    - Applied `50e671d` as a patch with `git am` onto chonk `~/workspace/waveshare-mk10/kernel`.
    - Pulled `build-modules.sh` to a scratch dir and wrote a scratch `mkbootimg.py`.
    - Plan: vendor config plus built-in `FB_TFT_GC9107`/`FB_TFT_GC9307`, mainline `HW_RANDOM`/`CRYPTO_DEV_ATMEL_SHA204A`; Android v0 repack keeping the vendor load addresses (kernel `0x40008000`, ramdisk `0x41000000`).
  - Rob's rule: never touch chonk `~/build`. My `~/build/mk10` work from earlier collided with Rob's use of it. I stopped the in-progress kernel build and removed my `kernel-build` worktree and `kbuild.log` there, plus the lenny staging dir `~/mk10-kbuild`. Saved memory `chonk-build-dir-off-limits.md`.
  - `wlan0` is on `rtl8821cu`. `rtl8710bu` registers but nothing binds, so the tree lacking it costs nothing.
- Changed
  - Commit `376bed4` (GC9307 handoff, not pushed).
  - Device: logos on `/mnt/SDCARD`; the env restore was done with `fw_setenv`.
- Verification
  - Logo files and env restored (checked as above); post-reboot driver bindings checked.
  - Not verified:
    - whether the custom `mk10.bin` is painted by U-Boot (Rob saw something briefly);
    - the own-kernel build and boot image (not built);
    - the zram init (not yet moved into userland).
- Follow-up
  - Waiting on the agent's GC9307 commit (`modtest9307/fb_gc9307t.ko` built, uncommitted) before building the kernel.
  - Userland changes: switch the GC9107/GC9307 modules to built-in and bring back the zram init.
  - Work only in `~/workspace/waveshare-mk10/kernel` on chonk, not `~/build`.

## 2026-11-24 (late): userland for own kernel, boot.img repack, p4 splice

- Outcome
  - chonk kernel tree `35ca7acae`: `mk10/mkbootimg.py` repacks the stock p4 boot.img with a new zImage. It keeps the header, the 12-byte ramdisk and the load addresses, recomputes the id, and refuses anything over 6,451,200 B. The other session's `mk10/build-kernel.sh` (`72c405fec`) calls it.
  - The other session built the kernel (chonk `0d8d542e3`; `mk10-boot-p4.img` sha `a32355d2b074`, 5,056,512 B) and modules (63, tgz `0678792b06d0`). Built in: GC9107, GC9307 (`4a924d4c1`, Makefile after GC9107, so fb1-fb10 are the keys and fb11 the large screen), HW_RANDOM, ATMEL_SHA204A, SWAP, ZSMALLOC, ZRAM, CRYPTO_LZ4. Both are copied into LilAlpine `boards/MK10-T113/` (gitignored). On the Mac: boot.img hash matches, 63 modules in `extra/`, and `modules.builtin` lists zram, fb_gc9107 and fb_gc9307.
  - LilAlpine:
    - `403cb44`: `features.zram` true; README says panel/hwrng/zram are built in.
    - `d15709c`: optional `MK10_BOOT_IMG` (default `boards/MK10-T113/boot.img`) spliced into p4 by `pack.sh`, with `card.boot` geometry (start 108008, 12600 sectors).
    - `6646ea7`: `fetch.sh` no longer copies stock modules over ours when our kernel is in use.
- Verification
  - mkbootimg round trip: stock kernel repacked matches the first 5,433,344 B of the p4 dump; the vendor id check passes.
  - The p4 splice block was run on a sparse fake card: it wrote and read back, rejected an oversize image, and left everything before p4 unchanged.
  - The copied boot.img header has load addresses kernel 0x40008000, ramdisk 0x41000000, tags 0x40000100, name t113-pro.
  - Rob flashed a LilAlpine image with the own kernel (`#12 SMP PREEMPT Tue Nov 24 17:49:14 CST 2026`) and it boots:
    - `fb1`-`fb10` are `fb_gc9107` (`spi0.1`-`spi1.6`) and `fb11` is `fb_gc9307` 240×296 (`spi0.0`), all built in, at 0.35-0.85 s.
    - hwrng: `rng_current` is `2-0064`, bound to `atmel-sha204a`; `/dev/hwrng` reads.
    - zram0 is 96M lz4 swap at priority 100.
    - 8821cu loads and `wlan0` links.
    - The cmdline has no `initcall_blacklist`, and the old `mk10-fbtft` service and `fb_gc9107t.ko` are absent.
  - The vendor app did not draw on this kernel. Writing noise to `fb1`/`fb11` showed on the panels, so the drivers were fine; the U-Boot logo also stayed up on the large screen until then.
    - Root cause: KeyboardDevice opens `/dev/atsha204a` and calls `ioctl(fd, 0x50, {slot 11, 32-byte constant})` (function `0xc7214`, caller `0x31b38`). Only a return value of 0 continues startup; anything else shows "Check HardWare Error" on fb0 and the app stops there. The mainline `atmel-sha204a` creates no such node.
    - Fix: `drivers/misc/mk10-atsha-compat.c` creates `/dev/atsha204a` and returns 0 for ioctl `0x50` without talking to the chip. Chonk `3f12a86a1` adds it (with the build-kernel.sh drift allowlist), its Kconfig `MK10_ATSHA_COMPAT`, and `=y` in `kernel-builtin.fragment`; it compiles clean with W=1.
    - Tested as an out-of-tree module (sha `0cae1bbd…`): after `insmod` and a `keyboard-device` restart, the app opened `/dev/disp`, `g2d`, `ion` and the panel framebuffers, and Rob saw the screens come alive. The MK10 launch key typed into the Mac, so the HID path works too.
- Follow-up
  - The built-in GC9307 probes before `/mnt/SDCARD` is mounted, so its logo parameter can't read `mk10.bin`. The large screen blanks until the app draws.
  - Until the next image, the device loads the stand-in as a module (`extra/mk10-atsha-compat.ko`, listed in `/etc/modules`). The rebuilt kernel (boot.img `47849bde4ca5`, modules tgz `d7d42638c280`, 63 .ko) has it built in and is staged in LilAlpine `boards/MK10-T113/`; no image built yet.
  - At boot, i2c2 logs `incomplete xfer (dev addr: 0x64)` about seven times. Hypothesis: the mainline driver's wake pulse, which the chip NACKs; the RNG works anyway.
  - The kernel warns that the backup GPT is not at the end of the card (7864319 != 61067263). Check whether growfs fixes it on the next boot.

## 2026-11-24 (night): first-run onboarding dialog
- Added `#onboard-dlg` (welcome + MCP checkbox, off by default, `#onboard-more` slot for later rows). Shows once when `onboarded` is unset; button or Esc sets `onboarded`, MCP starts only if ticked. `settings` IPC now includes `screenshot` so `--screenshot` runs skip the dialog.
- Verified: npm test, lint, layout grep, screenshot run (no dialog, exits). Unverified: the interactive first-run flow (Rob's checklist).

## 2026-11-24 (night): start at login
- `setLoginItem` IPC + `login` in the settings result (OS is the source of truth); Settings > General checkbox and onboarding row. Window starts hidden with no Dock icon when `wasOpenedAtLogin` or `--hidden`.
- Verified: npm test, lint, layout grep, `--settings` screenshot. Unverified: real login item registration, logout/login hidden start, `npm start -- --hidden`, unticking (Rob's checklist).

## 2026-11-24 Settings: read-only permissions (bead 3a-pv0.7)
- Settings has a Permissions section: Accessibility and Screen Recording status (passive, polled every 2 s only while the dialog is open) and Open buttons for the Accessibility, Screen Recording and Automation panes. Accessibility Open calls the system prompt at most once per session, then opens the pane.
- Verified: npm test (19 pass), lint clean, layout grep empty, `--settings` screenshot renders with statuses filled. `CGPreflightScreenCaptureAccess` symbol is present in the Electron framework binary, but I did not confirm that `getMediaAccessStatus('screen')` calls it.
- Unverified by hand: pane deep links, grant pickup, and that opening Settings shows no prompt.

## 2026-11-24 Docs: resident app (bead 3a-pv0.8)
- `app/README.md` gets a Resident app section (tray, close-to-tray, Cmd+Q dirty prompt, single instance, start at login/`--hidden`, read-only Permissions) and the MCP text now says off by default. Validation gets §7b; §6's close-window check became a Cmd+Q check. Scope row 3a marked built, hand checks pending.
- Verified: `grep 7b`, lint. Unverified: all §7b checks (Rob's).

## 2026-11-24: Studio onboarding defaults, spacing scale, dev login guard, auto push mode

- Outcome
  - `b596fa9`: onboarding ticks MCP and Start at login by default; `--screenshot --onboard` previews the dialog.
  - `df747c3`: every margin, padding and gap in `styles.css` uses one spacing scale (`--sp-*`, Tailwind's 4px steps). Dialog actions sit in a right-aligned footer with `--sp-6` above. Tailwind itself was not added: that needs a build step.
  - `82f5e75`: dev runs (`!app.isPackaged`, the unsigned "Electron" binary) never register a login item. The onboarding row is hidden and the Settings row is disabled. A dev launch removes a login item an earlier dev run added.
  - `3e0f9aa`: push mode `auto` is the new default. It checks the ssh host for `/etc/alpine-release`: LilAlpine pushes over ssh, otherwise an MK10 USB serial port means stock firmware and a serial push. With neither, it errors. Saved `serial`/`ssh` choices still win.
  - Finding: with the atsha stand-in loaded, KeyboardDevice on LilAlpine brings up the ACM gadget (`/dev/ttyGS0`, `acm.usb0`), so a USB serial port appears on the Mac under LilAlpine too. Ssh is checked first for that reason.
- Verification
  - `npm test` (19 pass), lint, and the layout grep were clean after each commit. Screenshots: onboarding dialog (both ticked, footer spacing), and the Settings login row disabled in dev.
  - `detectMode` against `root@10.0.1.48` returned `ssh`. Against an unused IP it returned `serial`, because the USB port is present.
  - Not run: a real push in auto mode, the dev-launch login item removal, a stock-firmware detection.

## 2026-11-25 — Kernel fork push, secrets scrub, 3a bead cleanup

- Outcome
  - Kernel pushed to the fork `rgr4y/tina-t113-linux-5.4-new` master (`150c69d4f..3f12a86a1`, 12 commits). Chonk has no HTTPS credentials, so the push went over a one-off SSH URL and the remote config is unchanged. The fork is PUBLIC; Rob was warned and has not decided what to do with it.
  - Secrets check of waveshare-mk10 (Sonnet agent, read-only): gitleaks over 25 commits found no leaks, and the manual sweep found no keys, tokens, Wi-Fi credentials or home paths. Findings accepted by Rob: the GC9307 datasheet PDFs stay, and `opkg`, the commit email and the LAN IPs were left alone.
  - Device USB serial scrubbed from history with `git filter-repo`. Both mentions in `docs/theme-format.md` became `MK10_XXXXXXXXX`. The serial line in `mk10-studio-mcp-live.png` was blanked and the redacted image swapped into the commit that added it. A case-insensitive search for the serial across all history finds nothing.
    - Every commit hash changed (HEAD `26402bb` → `7245fff`), so hashes quoted in earlier PROGRESS entries are stale. The repo has no remote, so nothing is affected downstream.
  - LilAlpine userland for the own kernel: `403cb44` (zram on, README), `d15709c` (`MK10_BOOT_IMG` p4 splice), `6646ea7` (`fetch.sh` keeps our modules). Kernel tree `35ca7acae` adds `mkbootimg.py`.
  - GC9307 (`aa0fd56ee`, applied as `4a924d4c1`) is in the kernel via `0d8d542e3`.
  - Phase 3a beads: dropped `.1`–`.3` (DeviceLink, USB push through it, key events) because the device is reached over ssh/scp. The epic's Skipped section records why, and the DeviceLink references were removed from the texts of `.4` and `.8`. `.4` tray was committed as `1d5bb08`.
  - Hardware video decoding was checked on the device. The player holds `/dev/cedar_dev`, `/dev/ion` and `/dev/g2d`, loads libVE and the vdecoder libs, and uses about 9% CPU. The load is in `KeyboardDevice` (about 84% CPU in a `top` snapshot), and Rob judged it similar to the vendor kernel, so nothing was changed.
- Verification
  - Serial scrub: history search clean. A bundle was taken before the rewrite.
  - Not verified: whether the app's frame push uses SPI DMA, and the stock-kernel CPU comparison (a judgment by Rob, not measured).
- Follow-up
  - Delete `backups/pre-serial-scrub-20261124.bundle`. It is gitignored and still contains the serial.
  - Decide where waveshare-mk10 gets a remote (none yet), and whether the kernel fork stays public.

## 2026-11-24 — Studio: clipboard, capture, page inspector

- Outcome
  - `99d2949`: header and tray show the theme name without `.Theme`.
  - `d515032`: Settings permission rows show Granted in green and other states in red, with an icon button that opens System Settings. Added `--screenshot <file> --settings` for previews (the default 3 s delay captured a blank window, so use `--screenshot-delay 7000`).
  - `45f4da2`: sidebar shows top-level pages as Page 0–5 with a "6 / 6" count. Folders nest under their parent and are named after the key that opens them. The "6 pages" limit came from Rob; it is not in the notes. Whether the device's `jumpToPage` counts these 0–5 is unverified.
  - `0e85ad1`: clicking a page or folder shows its properties in the Inspector, including a replaceable background video. The info panel image is read-only; a setter was not built.
  - `5ad20bb`: Auto push logs why the ssh probe failed before falling back to serial, and waits up to 10 s instead of 3. Cause of the earlier wrong "stock firmware detected" was never seen, because the old code discarded the error.
  - `66355d0`: action field labels are readable ("Adjust mode", "URL"), wrap when long, and keep the raw name in the tooltip.
  - `e108644` (Phase 3d key clipboard): right-click Cut/Copy/Paste/Delete Key, Edit menu shortcuts, undo (20 steps, cleared by any other edit), cross-theme paste via JSON with embedded assets, MCP `copy_key`/`paste_key`.
  - `eb31fef`: blank slots take clicks and right-clicks (a leftover `.key.empty { pointer-events: none }` was the cause). A video dropped on any slot sets the page background.
  - `ce1804c`: Electron 45's clipboard API is async. The code treated it as sync, so Paste was always disabled. Cut now copies first and removes the key only after the write succeeds.
  - `1f5451f`: Cmd+Q and tray Quit ask when edits aren't pushed to the device, with a Push to Device option.
  - `6bcb08c`, `7c64d56`: dev runs show the git commit time in place of the "MK10 Studio" title, small and muted (`*` for a dirty `app/`, branch if not main).
  - Key capture proof of concept:
    - `3dd7416`: red Capture keys button, window, and the Swift helper `app/native/hidtap.swift`, compiled on first use into `native/build/` (gitignored).
    - `68f87d6`: the first-use compile failed because `swiftc` doesn't create its output directory; the app now does.
    - `8d91692`: HID-to-QMK keycode table `app/lib/qmk-keycodes.json`, generated from upstream QMK master `80973aa0b5`, plus `app/lib/qmk.js`.
    - `71412c7`: Save log… writes JSONL.
    - `17760a1`, `5ce2bff`, `1aaffc9`: the doubled HID events. Karabiner holds every keyboard, so only its virtual keyboard reports. The doubling was our own bug: `hidtap` matched Karabiner's virtual keyboard twice, once for keyboards and once for media-key devices, under the same registry ID. The dedupe now keys on device name, element cookie and usage.
    - `9fa9009`: capture events also go to stderr as JSON lines, and to `/tmp/mk10.log` in dev runs.
- Findings
  - `IOHIDManagerOpen` returns `0xE00002C5` (`kIOReturnExclusiveAccess`, checked in the SDK header) because Karabiner holds the keyboards exclusively. It is harmless while Karabiner runs.
  - QMK basic codes 0x04–0xA4 and 0xE0–0xE7 equal the HID usage. Only 27 QMK keycodes send consumer usages, so other consumer keys can be captured but not sent by the device.
  - Host actions (Open URL and similar) never go out over HID. The device reports `keyStateChanged` as JSON over the USB serial port, so capturing them needs a serial listener (Phase 3b).
- Verification
  - `npm test` (21 pass) and lint were clean after the code commits. Screenshots checked: the Settings dialog, the sidebar, the page Inspector, and the build label.
  - Checked in `/tmp/mk10.log`: HID capture has no doubles after the fix.
  - `hidtap` was never run from the agent's shell, because it triggers an Input Monitoring prompt for the terminal app.
  - Not verified by hand:
    - the right-click menus and Edit shortcuts;
    - the quit prompt;
    - the red permission state;
    - the Inspector for a folder;
    - a video replace from the Inspector;
    - an Auto-mode push.
- Follow-up
  - Rob reported that the GIF sub-page keys show as empty in the app but not on the device. Investigation had only started (reading `renderSecondary` and the layout); there is no cause or fix yet.
  - Decisions with Rob:
    - the Phase 3b key-event path (the serial listener is the recommended option);
    - whether Auto mode should error instead of falling back to serial when ssh fails;
    - mapping keyboard-page volume/mute (0x7F–0x81) to the consumer keycodes;
    - labelling the Karabiner open error as expected;
    - whether to add an info panel image setter.

## 2026-11-25 — Studio: widgets, toggles, pull, fonts, raw JSON

- Outcome
  - `dd79885`: key-area widgets draw in the preview: clock digits, GIF images and gauges placed in key cells with no key (`backgroundType` "child", e.g. the GIF folder and the clock pages). Their cells count as occupied: the Inspector names the widget and `pasteKey` refuses the cell. Also fixed `--select` losing a race with the open handler. This resolves the 2026-11-24 "GIF keys show as empty" report.
  - `38360c4`: clock widgets tick every second.
  - `284e022`: right-click > Press Key follows openPage, oneLevelUp and pageSwitch (`pageSwitchMode` 0) in the editor.
  - `50c0477`: one push at a time. The lock is in `Session` (shared by button, menu, quit prompt and MCP) and covers detection and the confirm dialog; Push and the Device settings are disabled while it runs.
  - `65a18c0`, `35a4836`: multi-state keys (`keyboard_switch`, a toggle) keep per-state image, title and keycode in the item's `jsonData`. Preview and Inspector show the current state; Press Key steps it. State images now count as asset references, so a cut or image replace can't drop one in use, and copy/paste carries them. Labelled "toggle" in the Inspector.
  - `32313a0`: Pull from device: reads `config.json` `defaultTheme` over ssh, copies it to a chosen file, opens it. Stock firmware's serial API has no file read, so pull is ssh only. Capture keys moved into Settings.
  - `aa0a9b8`, `d2c22c4`, `aa5539c`, `b8637c7`: clock digits. With a glyph directory (`displayType` 1) the device draws the dot images, aspect kept in a `w/displayNum` slot; without one (`displayType` 0) it draws `text_font`'s family (Microsoft YaHei) in regular weight. Both checked against the device framebuffers.
  - `66fb770`: Studio copies the device's `/usr/share/fonts` (191 files, 91 families, ~85 MB, ~50 s) into `~/Library/Application Support/mk10-studio/device-fonts` after the first ssh push or pull (or from Settings), reads family/weight/italic from each font's name and OS/2 tables (`app/lib/fonts.js`), and registers them as FontFaces served over `mk10font://`. Nothing is shipped with the app.
  - `ffdbfd2`: frame animations (`paths` directory of `frame_N.png` plus `frameDelays`) play on keys, toggle states, widgets and the Inspector thumbnail.
  - `a13ba08`: raw JSON editor above Activity for keys the form doesn't cover (int/bool action fields, toggle states, no or undecodable action). controlData shows as its QVariantMap fields, jsonData and titleParam as parsed JSON. Apply checks types, slot, item type and new image paths, keeps field order, and is undoable.
  - `825795f`: openPage's target is a page picker in sidebar order instead of a raw UUID field.
  - `3935e6f`, `6416b0c`: device and app checks recorded in `docs/mk10-studio-validation.md`.
- Findings
  - On LilAlpine the key cells are separate framebuffers: `/dev/fb1`–`fb10` (128x128 RGB565, gc9107), `fb11` the info panel (240x296), `fb0` the 896x608 main buffer. Reading them over ssh gives a screenshot of what the device draws.
  - pageSwitch `jumpToPage` counts top-level pages (no `parentPageName`) in theme order, not the theme page index: confirmed on the device.
  - The device's Qt uses `QT_QPA_FONTDIR=/usr/share/fonts`. A theme's `text_font` point size (e.g. 12) is not what it draws.
  - Pulled theme on 2026-11-24 came from the vendor app's save at 20:43 (`defaultTheme.Theme`, config re-pointed to it), not from anything Studio wrote.
- Verification
  - `npm test` (24 pass) and lint clean at each code commit. Screenshots checked for widgets, clocks, toggle key, animations, raw JSON and the font cache.
  - On the device (Rob): jumpToPage numbering, raw JSON int edit pushed, cross-page openPage and back, push lock, Auto mode on LilAlpine.
  - In the app (Rob): paste after cut, paste refused on widget cells, Press Key, quit prompt, font re-copy, capture QMK column. Pull confirmed working.
- Follow-up
  - Gauges (types 101/109) render nothing like the device; needs its own pass.
  - Text clock size not re-measured after the last trim.
  - Open decisions from 2026-11-24 still stand (Phase 3b serial key events, Auto mode fallback, volume keycode mapping, Karabiner error label, info panel image setter), plus repo remote and the backup bundle.
