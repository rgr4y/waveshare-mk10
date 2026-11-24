# T113 / sun8iw20 kernel and cedar sources (web research)

Date: 2026-11-24. Web only, nothing cloned or run. Tags: [verified: saw ...] means a fetched page or raw file showed it. [claimed by page] means a README, search snippet or forum post said it and I did not see the underlying file. Fetches went through a summarizing tool, so "verified" means the fetched content stated it, not that I read the bytes myself.

## 1. Best find: a public 5.4.61 kernel with the vendor cedar driver

Repo: https://github.com/open-cores/tina-t113-linux-5.4-new ("linux kernel for longan t113", fork of https://github.com/guanglun/longan-t113-linux-5.4).

| Item | Finding | Tag |
|---|---|---|
| Version | VERSION=5, PATCHLEVEL=4, SUBLEVEL=61, EXTRAVERSION empty (https://raw.githubusercontent.com/open-cores/tina-t113-linux-5.4-new/master/Makefile) | [verified: saw Makefile lines] |
| Branch | `master` only shown | [verified: saw branch label] |
| Flavour | Longan (Android-common-kernel based), not a Tina-branded tree. Root has `abi_gki_whitelist`, `build.config.*`, `android/`, `rootfs.cpio.gz`; README.md is the Android Common Kernels patch guide | [verified: saw root listing] |
| Cedar driver | `drivers/media/cedar-ve/` holds Kconfig, Makefile, cedar_ve.c, cedar_ve.h, flush_cache.S, ve_mem_list.h (https://github.com/open-cores/tina-t113-linux-5.4-new/tree/master/drivers/media/cedar-ve) | [verified: saw dir listing] |
| cedar_ve.c | Char region "cedar_dev", class "cedar_ve", platform driver "sunxi-cedar", of_match "allwinner,sunxi-cedar-ve", default major 150 (CEDARDEV_MAJOR, module param), MODULE_LICENSE "GPL", Allwinner 2010-2016 header with GPL v2+ notice, ~1400 lines, `CONFIG_ARCH_SUN8IW20` guards in probe/suspend/resume (https://raw.githubusercontent.com/open-cores/tina-t113-linux-5.4-new/master/drivers/media/cedar-ve/cedar_ve.c) | [verified: saw file via summarizer] |
| Memory model | No ION API calls in cedar_ve.c; it uses dma-buf (dma_buf_get/attach/map_attachment) plus IOMMU ioctls (IOCTL_GET_IOMMU_ADDR, IOCTL_MAP_DMA_BUF, IOCTL_FLUSH_CACHE_RANGE, ~36 ioctls total) | [verified: saw file via summarizer] |
| Kconfig | "sunxi video encoder and decoder support", default on, depends on sunxi + dma-buf, buildable as module `cedar_dev` (https://raw.githubusercontent.com/open-cores/tina-t113-linux-5.4-new/master/drivers/media/cedar-ve/Kconfig) | [verified: saw file via summarizer] |
| ION | `drivers/staging/android/ion/` has ion.c, ion_buffer.c, ion_dma_buf.c, ion_heap.c, heaps/ (https://github.com/open-cores/tina-t113-linux-5.4-new/tree/master/drivers/staging/android/ion) | [verified: saw dir listing] |
| DT | `arch/arm/boot/dts/sun8iw20p1.dtsi` has `ve@1c0e000`: compatible "allwinner,sunxi-cedar-ve", reg 0x01c0e000/0x03000000/0x03001000, SPI 66, clocks bus_ve/ve/mbus_ve, reset RST_BUS_VE, power-domain R528_PD_VE, iommus `<&mmu_aw 0 1>`. No `ion` node and no ion CMA heap in that dtsi (only a dsp0 reserved region) (https://raw.githubusercontent.com/open-cores/tina-t113-linux-5.4-new/master/arch/arm/boot/dts/sun8iw20p1.dtsi) | [verified: saw file via summarizer] |
| License | COPYING + LICENSES present; GPL-2.0 kernel. No login needed, plain `git clone` | [verified: saw files; license type inferred from Linux tree] |
| Size / history | Not checked. Parent guanglun repo shows 1 commit, 14 forks | [verified: saw page] |

Caveats and open questions:
- This is Longan's t113 kernel, not Tina #334. Your running kernel is "5.4.61 ... #334 SMP PREEMPT" built with GCC 6.4 (OpenWrt/Linaro), so the Tina tree may differ in cedar_ve.c ioctl set or ion heap setup. Whether this ioctl ABI matches the userland in your firmware: unknown. Diff the ioctl list against strings from `libcedarc`/`libcdc_*` on the device.
- No ion node in the dtsi: /dev/ion heaps (system/CMA/carveout) must be set up elsewhere (heaps/ dir, Kconfig, or a board dts). Not checked. [unverified]
- Longan t113 vs Tina differ in userland packaging, and the device /dev/ion + /dev/cedar_dev layout in your firmware is what to match.
- The repo's drivers/media was listed truncated ("View all files"); other media dirs exist (`google-ve`).
- A kernel built from this still has to boot on MK10 hardware (device tree, panel, GD32 link). That is a larger job than the cedar driver.

Other Tina/Longan T113 5.4 trees found (not checked for cedar):
- https://github.com/guanglun/longan-t113-linux-5.4 : parent of the above, 1 commit, same Android-style README [verified: saw page].
- https://github.com/paulwratt/mangopi-sbc-tina-linux-5.4 : "tina sdk linux 5.4 for d1-h, d1s, t113", also Android-style root (Documentation, android, arch, drivers...), 7 commits, no `bsp/` dir in the top-level listing [verified: saw page]. Whether it has drivers/media/cedar-ve: not checked.
- https://github.com/paulwratt/mangopi-sbc-Tina-Linux : Tina SDK mirror (fork of https://github.com/uncommon-ljl/Tina-Linux, also https://github.com/afu120/Tina-Linux). `lichee/linux-5.4` is a git submodule: uncommon-ljl pins df2321f of `mangopi-sbc/tina-linux-5.4`; paulwratt pins 0d4903e of the same URL [verified: saw submodule entries]. `package` submodule points at mangopi-sbc/tina-package.
- Dead links: https://github.com/mangopi-sbc/Tina-Linux, https://github.com/mangopi-sbc/tina-linux-5.4, https://github.com/mangopi-sbc/tina-package, https://github.com/mangopi-sbc and https://github.com/Tina-Linux/tina-d1x-linux-5.4 all returned 404 for me [verified: HTTP 404]. The paulwratt fork of tina-linux-5.4 (above) is probably the surviving copy of the mangopi one. The linux-sunxi wiki lists Tina-Linux/tina-d1x-linux-5.4 as the D1 BSP kernel (https://linux-sunxi.org/Allwinner_Nezha) [claimed by search snippet; 404 on fetch].
- 100ask T113-Pro: https://gitee.com/weidongshan/eLinuxCore_100ask-t113-pro has a `linux` submodule (linux-5.4, `sun8iw20p1smp_defconfig`) hosted on e.coding.net under the 100ask_t113-pro group; no LICENSE file declared; one branch master [verified: saw .gitmodules summary and page]. The e.coding.net URL was not fetched, may need login.
- DongshanPI Tina SDKs: https://github.com/DongshanPI/100ASK_T113-PRO_TinaSDK5 (overlay pack, only `kernel/linux-5.4/drivers/net/wireless/aic8800` plus configs; full Tina5 SDK is a 3-volume split archive from the vendor docs site) and https://github.com/DongshanPI/100ASK_T113-Pro_TinaSDK (Tina4 overlay: device/config, lichee, package, prebuilt submodule, target; full SDK via Baidu Netdisk) [verified: saw pages]. Not a pure git route.
- Allwinner official Tina5 doc (T113-i listed as Linux-5.15 there): https://server7.whycan.com/files/allwinner/h135/a/Software软件类文档/SDK模块开发指南/Tina5.0_Linux_开发指南.pdf [claimed by search snippet]. So Tina5 may ship 5.15, Tina4-era T113 ships 5.4.
- Build-experience post saying the github clone route is unreliable/slow: https://blog.csdn.net/qq_28877125/article/details/126684892 [claimed by search snippet; fetch returned 521].

Not found: any Allwinner-official public GitHub/gitee repo for sun8iw20 5.4 with `bsp/drivers/ve`; no OpenIXCLOUD, YuzukiHD, Lckfb, Sipeed, or aw-ol repo checked (not searched individually, budget).

## 2. Standalone cedar driver ports

| Repo | Kernel | SoCs | Notes | Tag |
|---|---|---|---|---|
| https://gitee.com/abigpad/cedar (fork of prtemly/cedar; same lineage as https://github.com/aodzip/cedar) | "Mainline Linux 5.4", staging tree layout `drivers/staging/media/sunxi/cedar/{ve,ion}` | V3/V3s/S3L/S3, F1C100s/F1C200s | VE driver based on Allwinner H6 Homlet BSP, ion based on Google Android ion; DT cedarx node at 0x01c0e000; no LICENSE file; major/device node not stated; 17 commits | [verified: saw page] |
| https://gitee.com/fly100fans/sunxi-cedar-mainline (origin uboborov/sunxi-cedar-mainline) | 4.11+ ; dirs 4.20.17, 5.6, 5.7 | A20, H3 DT example | cedar_ve.c, GPL-2.0, uses CMA dma_alloc_coherent instead of ION; no statement about libcedarc compat | [verified: saw page] |
| uboborov/sunxi-cedar-mainline | 5.8, 5.10 reported | T113 (jpeg) reported by a forum user | https://forum.armbian.com/topic/26551-video-encoder-using-mainline-kernel/ returned 403; claim comes from the search summary | [claimed by search snippet] |

None targets sun8iw20 in its README. The sun8iw20 hardware differs from V3/H3 (IOMMU, power domain, three reg ranges, per the dtsi above), so a straight port is not drop-in. The Longan cedar_ve.c in section 1 is closer to your vendor driver than any of these. Porting that file (plus dma-buf/ion pieces) to 6.x is the realistic route, not fetched or tested here.

Also: https://github.com/Jookia/linux and https://github.com/smaeul/linux (d1/all) are mainline D1/T113 work, no vendor cedar [claimed by search snippet]. https://gitee.com/dubilu/t113s3_linux_v6.12-rc1 and https://github.com/Evlers/linux_kernel_t113 (6.0.1, MangoPi Dual, 2 commits) are mainline-ish T113 trees; the Evlers README doesn't mention cedar/ion/cedrus [verified: saw README].

## 3. Userland blobs / libcedarc

- https://github.com/aodzip/libcedarc : "Allwinner CedarX userspace library (Not Official)", based on lindenis-v536 SDK, Buildroot packaging, ffmpeg OMX via `--enable-omx`. Dirs base, library, vdecoder, openmax, memory suggest source. SoC list, libc, license, device node: not stated [verified: saw page].
- Official partial source: https://github.com/allwinner-zh/media-codec (2015 release: MPEG2/MPEG4/MJPEG/H264 only; per https://linux-sunxi.org/CedarX and https://groups.google.com/g/linux-sunxi/c/IHwrVxjJMUo) [claimed by search snippet]. Not sun8iw20 era.
- Tina SDK multimedia package (`package/allwinner/...libcedarc` / `platform/allwinner/multimedia`): I did not find a public repo. mangopi-sbc/tina-package is 404. 100ask TinaSDK repos are overlays and don't show it. Full SDK drops are via archives/Baidu. Source vs .so-only for sun8iw20: unknown.
- Your device already has the arm blobs (`libcdc_*`, `libvencoder`) which match the firmware's own libc; extract them from the device image rather than hunting externally. libc type (glibc vs musl) not determined from the web; check the device.

## 4. 6.x T113 kernel with a vendor-style cedar/ion shim

Not found. No 6.x T113 tree I could see carries cedar_ve/ion for sun8iw20. The Evlers 6.0.1 and dubilu 6.12-rc1 listings don't mention one (I did not browse their drivers/ dirs).

## 5. Waveshare MK10/MK20 source / GPL

- Product page: https://www.waveshare.com/product/displays/usb-monitor/mk10-b.htm : no kernel/GPL download seen in search results [claimed by search snippet; page not fetched].
- CNX Software on MK20 (https://www.cnx-software.com/2025/10/29/waveshare-mk20-macro-keyboard-features-twenty-mechanical-keys-with-0-85-inch-color-lcd-keycaps/): author says "source code" is a 720 MB zip, mostly two 848 MB "firmware" files (MK10 and MK20) plus a small C++ demo app; "not quite what I would call open source". Link to wiki https://www.waveshare.com/wiki/MK20 (Download Software section) and https://github.com/waveshareteam/Waveshare-ScreenKey [verified: saw comment/article text via summarizer; zip contents themselves unverified].
- No GPL offer or kernel tree for MK10/MK20 found. Worth checking the wiki download zip for a kernel tarball or a GPL notice, and, if absent, sending a GPL written-source request to Waveshare. The kernel is Allwinner-derived GPL code, so they owe source on request (not legal advice).

## Follow-up checks (main session, 2026-11-24)

**Lead 1 matches the device's cedar driver [verified].** The device dmesg prints `enable_cedar_hw_clk,552` and `disable_cedar_hw_clk,592`, which are `printk("%s,%d", __func__, __LINE__)`. In `open-cores/tina-t113-linux-5.4-new` (HEAD 150c69d, 2022-06-10, "change to tina kernel"), `drivers/media/cedar-ve/cedar_ve.c` has those same printks at lines 552 and 592. Its `VE_LOGD("enable hw clock")`, `VE_LOGD("disable hw clock")` and `VE_LOGW("VE real_freq=%ld")` strings also match the dmesg lines `VE: enable hw clock` and `VE: VE real_freq=576000000`. Matching `__LINE__` values mean the file is the same source file, or one with an identical layout up to line 592, as the device's kernel. That makes an ioctl ABI match likely. The ioctl tables themselves are not diffed yet.
The tree also carries `drivers/staging/android/ion` (with Allwinner heaps).

**dma-heap cedarc: not found [verified negative for two trees].** `CalvinXu17/libcedarc` (A133) and `aodzip/libcedarc` (lindenis-v536) both open `/dev/ion` directly. `AW_ION_DMA_HEAP_MASK` there is an ion heap type, not the dma-buf heap API. Neither has `/dev/dma_heap`. My earlier claim that newer SDKs use dma-heap is unconfirmed. The Radxa A733 (5.15) images expose `/dev/dma_heap/system` alongside `/dev/cedar_dev*`, but that libcedarc's source wasn't checked.
Useful structure: in libcedarc the allocator (`memory/ionMemory/ionAlloc.c`), `vdecoder.c` and `CdcIonUtil.c` are **source**. Only the codec cores (`libawh264.so` etc.) are prebuilt per toolchain (`toolchain-sunxi-arm-glibc` and others). So moving the allocator to dma-heap means patching source, not a blob.
