# MK10 display pipeline (stock KeyboardDevice) and DRM notes

Date: 2026-11-25. Exploration only; nothing changed on the device. Sources: live device tree, debugfs, `strace` on the running `KeyboardDevice` for 1–3 s, and the kernel tree in `kernel/`.

## Summary

`lcd0` drives no physical panel. It is a virtual 896x304 output that the display engine (DE2) composes into, and that `KeyboardDevice` captures back about 16 times a second. Every visible screen is an SPI panel driven by fbtft:

- `fb1`-`fb10`: ten GC9107 key panels, 128x128 RGB565.
- `fb11`: one GC9307 info panel, 240x296.

Per frame, `KeyboardDevice`:

1. Commits a DE capture of the composed output (`ioctl(/dev/disp, DISP_CAPTURE_COMMIT)`).
2. Blits it with G2D (`ioctl(/dev/g2d, G2D_CMD_BITBLT_H)`).
3. For each of `fb1`..`fb11`: `open(O_WRONLY|O_TRUNC)`, `write` the RGB565 tile, `close`.

## Evidence

### `lcd0` is not wired to anything

- DT node `soc@3000000/lcd0@5461000`:
  - `compatible` is `allwinner,sunxi-lcd0` and `status` is `okay`.
  - `lcd_driver_name` is `default_lcd` and `lcd_model_name` is `896x304`.
  - `lcd_if` is 0, which is HV (parallel RGB). `lcd_dclk_freq` is 50.
- `pinctrl-names` is `active sleep`, but the node has **no `pinctrl-0` or `pinctrl-1`**. No LCD pin function is ever muxed.
- `/sys/kernel/debug/pinctrl/pio/pinmux-pins` lists no pin owned by an LCD or `disp` device.
- The PD pins, which carry the T113 parallel RGB bus, are used as plain GPIOs. They are SPI chip-select and `dc` lines for the key panels: PD1, PD2, PD4, PD5, PD7, PD8, PD10, PD13, PD15, PD16, PD18-PD21. PD11 and PD12 belong to `spi1`.
- `pwm-7` is requested as `lcd` and is enabled (10 ms period, duty 8.9 ms). Its pin is not in the pinmux list, so the "backlight" (228) drives nothing visible.
- The `disp` debug dump reports `lcd output 896x 304 fps:163.9`. The DE runs the virtual output at about 164 Hz.

### Layers in the composed frame (`/sys/class/disp/disp/attr/sys`)

- ch0 lyr0, z0: the background video, YUV (`fmt 77`), 640x256 at 0,0. This is `videoplayerinterfaceAPP` through libtplayer/cedar.
- ch1 lyr0, z16: the Qt UI (`linuxfb` on `fb0`), RGB, 896x304, alpha per pixel.

### `KeyboardDevice` runtime (strace, 2 s window)

- 32 calls of `ioctl(31, _IOC(_IOC_NONE, 0x1, 0x42, 0))` (fd 31 is `/dev/disp`). That is `DISP_CAPTURE_COMMIT` (0x142, `include/video/sunxi_display2.h:939`).
- 30 calls of `ioctl(29, _IOC(_IOC_NONE, 0, 0x55, 0))` (fd 29 is `/dev/g2d`). That is `G2D_CMD_BITBLT_H` (0x55, `include/linux/g2d_driver.h:509`).
- 32 of each `open("/dev/fbN", O_WRONLY|O_CREAT|O_TRUNC…)` for N = 1..11, with RGB565 data written to fd 25, then a close.
- The binary's strings back this up: class `ScreenCapture` (`parseImage(QImage)`), `/dev/disp`, `/dev/g2d`, `/dev/ion`, `/dev/fb%1`, `/sys/kernel/debug/dispdbg/*`.
- Earlier observation: `KeyboardDevice` uses about 84% CPU. The capture, blit and per-frame open/write/close of 11 framebuffers is a likely large share of that. This is not profiled.

## What this means for DRM, cedrus and mpv

Today's speed comes from the DE2 hardware layer plus `disp` capture. The video is scaled and mixed for free, and then one capture feeds every panel. The SPI panels themselves have no scan-out hardware.

### On the vendor 5.4 kernel (`kernel/`)

- There is no sunxi DRM for sun8iw20. `drivers/gpu/drm/sun4i/sun8i_mixer.c` compatibles end at H6.
- `drivers/gpu/drm/tiny` has `mipi_dbi` drivers (ili9341, st7735r, mi0283qt…). GC9107/GC9307 tiny drivers would be small, but would gain nothing over fbtft.
- `drivers/staging/media/sunxi/cedrus` has no D1/T113 compatible.
- The tree's stateless H264 uAPI predates the stable one (5.11), so current FFmpeg v4l2-request patches would not match it.
- Conclusion: stay on `/dev/disp`, `/dev/cedar_dev` and libtplayer on 5.4.

### On mainline 6.x (not verified here)

These come from web search and were not confirmed against a tree:

- DE2 mixer support for D1/T113.
- `panel-mipi-dbi` (5.18+, init sequence from a firmware file) for the GC9107/GC9307.
- cedrus with the `allwinner,sun20i-d1-video-engine` variant. The merge version is unconfirmed.

Open questions:

- **Capture.** Is there a DRM writeback connector for the sun8i mixer? If not, nothing replaces `DISP_CAPTURE`. Without capture, a mainline stack has to compose in software or on the GPU (the T113 has none), then crop and push 11 SPI buffers.
- **G2D.** Mainline has no G2D driver.
- **Video output target.** DRM has no output that feeds the SPI panels. Decoded video would have to be copied into the panel buffers through a writeback loop, or by the CPU.
- **KeyboardDevice.** It needs the vendor `/dev/disp`, `/dev/g2d`, `/dev/ion` and `/dev/cedar_dev`. It will not run on mainline. The host rewrite (`docs/screenkey-host-rewrite-handoff.md`) would have to replace it first.

Cheapest experiment if this comes back: on mainline, check whether the sun8i mixer can target a virtual or no-pin TCON output with writeback. That is what decides whether the vendor design can be reproduced.

## Related

- The library exports a real `videoplayerinterface::pause()`/`play()`, but the stock `videoplayerinterfaceAPP` launcher never calls them. Its "pause" is libc `pause(2)` in its idle loop. A replacement launcher (same `-x -y -w -h -f -r` args, SIGUSR1 = pause, SIGUSR2 = play) was proposed and not built.
- `docs/t113-kernel-cedar-sources.md`: kernel and cedar source research.
