# Handoff: reconstruct fb_gc9307 (MK10 large screen) from the vendor kernel

Date: 2026-11-24. For the agent that reconstructed `fb_gc9107.c` (your work is in `/tmp/waveshare-kernel/`).

## Status of your GC9107 work

- It was reviewed, fixed, built and validated on hardware. All ten key panels run on it from power-on.
- **One fix was needed: the post-sleep-out delay.** The vendor binary writes `0x11` once, then loops `__const_udelay(0x0ccccb60)` 20 times.
  - `0x0ccccb60` = 1000 × UDELAY_MULT at HZ=100, so each pass is `udelay(1000)`.
  - The `mov r5,#21` / `subs` / `bne` structure runs the body 20 times. It is the generic `mdelay(20)` expansion, because `MAX_UDELAY_MS` on ARM is 2.
  - Your source had `mdelay(2)` ×21, and REVIEW Q3 described a 0x11 replay and `udelay(2000)`. Neither is in the binary.
  - Compiling `mdelay(20)` gives the vendor loop instruction for instruction.
- **REVIEW Q1 (set_var) was a misread.** Rotate 0, and any value other than 90/180/270, branches straight to `mov r0,#0` and writes nothing. There is no stale-r3 path.
- Committed as `50e671d` in `chonk:~/build/mk10/kernel` (Rob's fork `rgr4y/tina-t113-linux-5.4-new`, shallow clone, not pushed).
- Lessons for this one:
  - Compile your source and diff its disassembly against the vendor function before calling it done.
  - Count loop iterations by the branch structure, not by the counter's initial value.
  - Check every literal-pool constant.

## Goal

Write `drivers/staging/fbtft/fb_gc9307.c` for the 240×296 large screen (the ten GC9107s are the screenkeys). It should match the vendor binary function for function. Then build it as a test module and validate it on the device (Rob checks the screen visually).

## Facts (verified 2026-11-24)

### Vendor `fbtft_display` for GC9307 at `c0d570b8`
Same `fbtft.h` layout as GC9107. The tree's header is byte-identical to your `/tmp/waveshare-kernel/fbtft.h`.

| field | value |
|---|---|
| width, height | 240 (0xf0), 296 (0x128) |
| regwidth | 8 |
| `fbtftops.set_addr_win` (word 9) | `c0633f78` |
| `fbtftops.init_display` (word 13) | `c0633a6c` (your `gc9307_init.asm` covers c0633a6c..c0633f74) |
| `fbtftops.set_var` (word 20) | `c0634004` |
| `fbtftops.set_gamma` (word 21) | `c063400c` |
| txbuflen | 0x4000 |
| gamma | `c0a93757`, the same string as GC9107 |
| gamma_num, gamma_len | 2, 15 |

- Probe glue references `fb_gc9307` (string at `c0a937b1`) from `c0d57140` and `c0d571c8`.
- `syk,gc9307` is at `c09519b4`. It lives inline in an `of_device_id`, so nothing points at it.
- Disassemble `set_addr_win`, `set_var` and `set_gamma` yourself. Don't assume the GC9107 offsets or MADCTL bits carry over.

### Live device tree node `spi0.0`
- compatible `syk,gc9307`
- rotate 0, `bgr` present (boolean), fps 60, buswidth 8
- spi-max-frequency 80 MHz
- `dc-gpios` present; no `reset-gpios`, no `led-gpios`

In the vendor kernel's normal setup it registers as `fb11`, after the ten GC9107s.

### Delay macros (5.4 ARM)
- `MAX_UDELAY_MS` is 2, so `mdelay(n>2)` becomes a `while (n--) udelay(1000)` loop.
- `udelay(x)` compiles to `arm_delay_ops.const_udelay(x * UDELAY_MULT)`, where `UDELAY_MULT` = 214748 at HZ=100 and `const_udelay` sits at offset 4 of `arm_delay_ops`.

### Vendor config
- Extracted from the vmlinux IKCFG blob: `chonk:~/build/mk10/mk10.config`.
- `CONFIG_FB_TFT_GC9307=y` in the vendor build. The tree has no Kconfig symbol for it, so add one. Copy the `FB_TFT_GC9107` entry `50e671d` added after WATTEROTT.

## Build (chonk)
- Tree: `~/build/mk10/kernel`, HEAD `50e671d`. Put the driver plus Kconfig/Makefile entries there, as one commit on top. Never push.
- Toolchain: `T=$HOME/build/mk10/armv7-eabihf--glibc--stable-2018.11-1/bin/arm-linux-`.
  - Pass it as `CROSS_COMPILE=$T`, never on PATH: its bison breaks kconfig.
  - It's gcc 7.3; the vendor used Linaro 6.4. Expect register allocation to differ, but logic, constants and call order must match.
- Always pass `LOCALVERSION=`. Otherwise vermagic gets a `+` and the device rejects the module.
- Use `W=1`; it must be clean.
- In-tree check: `make -j32 ARCH=arm CROSS_COMPILE=$T LOCALVERSION= W=1 drivers/staging/fbtft/fb_gc9307.o`. Then disassemble with `${T}objdump -d` and compare against the vendor functions.
- **Test module** (out of tree, like `~/build/mk10/modtest/fb_gc9107t.c`):
  - Copy the source and rename `DRVNAME` to `fb_gc9307t`.
  - Apply the same `init_module` workaround as `modtest/patch_init.py`, which produces the block below. The device boots with `initcall_blacklist=fbtft_driver_module_init`, and that name also matches any module using `FBTFT_REGISTER_DRIVER`, so the module's init must be exposed as `init_module`:
    ```c
    #undef module_init
    #undef module_exit
    #define module_init(x)
    #define module_exit(x)
    FBTFT_REGISTER_DRIVER(DRVNAME, "syk,gc9307", &display);
    int __init init_module(void) { return fbtft_driver_module_init(); }
    void __exit cleanup_module(void) { fbtft_driver_module_exit(); }
    ```
  - Build with `make … LOCALVERSION= KBUILD_MODPOST_WARN=1 W=1 M=<dir> modules`.
  - `vermagic` must be exactly `5.4.61 SMP preempt mod_unload ARMv7 p2v8 ` (trailing space).
  - `${T}nm` must show `init_module` and no `fbtft_driver_module_init`.

## Test (device, `ssh root@10.0.1.48`)

**State as of handoff: the vendor drivers are back.** The u-boot env is the original, and `mk10-fbtft` is not in any runlevel. Before you test, ask Rob to switch the device into validation mode and reboot:
```sh
fw_setenv setargs_mmc "$(fw_printenv -n setargs_mmc) initcall_blacklist=fbtft_driver_module_init"
rc-update add mk10-fbtft default
reboot
```
- In that mode, `/etc/init.d/mk10-fbtft` loads `fb_gc9107t.ko` for the ten screenkeys, and `spi0.0` stays **unbound and never initialised that boot**. Loading your module there is a clean power-on test.
- To leave validation mode, restore `setargs_mmc` from `/root/mk10-bak/uboot-env-20261124.txt` and `rc-update del mk10-fbtft default`.
- Runtime *re*binding is not a valid test. Panels re-initialised after another driver had run came up dark, even with the vendor driver.

```sh
scp fb_gc9307t.ko root@10.0.1.48:/tmp/
ssh root@10.0.1.48 'readlink /sys/bus/spi/devices/spi0.0/driver; insmod /tmp/fb_gc9307t.ko; dmesg | tail -5; ls /sys/bus/spi/devices/spi0.0/graphics; cat /proc/fb'
```
- Expected: `fbN: fb_gc9307t frame buffer, 240x296`. N is probably `fb11`; check it.
- The vendor app (`keyboard-device`) draws the large screen through a framebuffer. If the fb number differs from the vendor's fb11, say so; don't remap anything.
- Then ask Rob to look at the large screen. Is the image right-side up, at the correct offset, in the right colours (bgr), with no garbage at the edges?
- If the app doesn't redraw it, ask Rob before restarting `keyboard-device`. A restart drops Wi-Fi for a few seconds, so run anything that spans one detached and write its output to a file.

## Boot logo: `bootlogo=` module parameter (Rob's request)

U-Boot paints `mk10.bin` on the large screen. The kernel blanks it at about 0.9 s: fbtft-core pushes the zeroed framebuffer to the panel when it registers the fb. The goal is to keep a logo on screen until the app draws.

- **Hook.** Set `.fbtftops.update_display` in your `fbtft_display`.
  - `fbtft-core.c:506` copies it over the default, and `fbtft-core.c:832` calls it once for the whole screen inside `fbtft_register_framebuffer`.
  - The default `fbtft_update_display` is `static` (`fbtft-core.c:240`), so not callable. Your version has to do `set_addr_win(par, 0, start, xres-1, end)` plus `write_vmem(par, offset, len)` itself. Read the core's version and copy its logic, minus the timing/debug parts.
- **`bootlogo=<path>`.** Load a raw image into `info->screen_buffer` before that first update, using `kernel_read_file_from_path()`.
  - It is exported GPL in this 5.4 tree (`fs/exec.c:985`), and the symbol name is in the vendor vmlinux. The module is GPL.
  - Accept only a file of exactly `width*height*2` bytes. Otherwise log it and fall back.
  - `mk10.bin` is raw RGB565 little-endian, 240×296, 142,080 bytes, which matches the fb exactly, so copy it as is. The path on the device is `/mnt/SDCARD/mk10.bin` (FAT p1); Rob's custom version is installed there.
  - This only works as a module loaded after `localmount` (the `mk10-fbtft` service is). A built-in driver probes before the filesystem is mounted.
- **No parameter.** Consider skipping the first full update so the panel keeps what U-Boot drew.
  - That needs the init sequence to leave GRAM intact. Check SLPOUT, DISPON and the vendor registers in `docs/GC9307_Manual.pdf` before relying on it.
  - If it can't be guaranteed, keep the vendor behaviour (blank) as the default.
- Report which of these you implemented, and what Rob saw at boot.

## References
- `docs/GC9307_Manual.pdf`: the GC9307 controller datasheet (V1.01, 190 pages).
  - §6.1 command list.
  - §6.2.18 MADCTL (36h), for decoding `set_var`.
  - §6.4 vendor registers: FEh/EFh inter-register enable, F0h–F3h gamma, E8h frame rate.
  - Sleep-out timing: wait 5 ms before the next command, 120 ms before SLPIN. If the vendor's delays are shorter, keep the vendor's and note it.
- `docs/GC9307.pdf`: **do not use it for geometry.** It is a 1.47" 172×320 module. The MK10 panel is 240×296 (from the vendor `fbtft_display`).

## Rules
- Allowed device writes: `/tmp/fb_gc9307t.ko`, and `insmod`/`rmmod fb_gc9307t`. Nothing else.
- No `fw_setenv`, no flashing, no edits to `/etc` or `/lib/modules`, no package installs. Rob decides how it gets installed for boot.
- Don't touch `fb_gc9107t` or the ten key panels.
- Commands get a timeout of 60 s or less. Background anything longer and write its output to a file.
- Never push.

## Report back
- Source path and commit hash.
- A per-function comparison against the vendor: init sequence (with a `verify.py`-style check), `set_addr_win` offsets, `set_var` MADCTL per rotation, `set_gamma`, and the delays with the literal-pool constants decoded.
- Test-module sha256 and vermagic.
- `dmesg` from the `insmod`, the fb number, and Rob's visual result.
