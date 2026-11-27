# Handoff (LilAlpine): install vplayer as the background video launcher

Date: 2026-11-25. For the LilAlpine agent. Source: `tools/vplayer/` in this repo (`vplayer.c`, `build.sh`).

## What it is

A drop-in replacement for `/vendor/bin/videoplayerinterfaceAPP`. KeyboardDevice launches the background video player through `/usr/bin/videoplayerinterfaceAPP`, which is currently a symlink to that vendor binary.

- It takes the same args: `-x -y -w -h -f -r`.
- It makes the same calls into `/vendor/lib/libvideoplayerinterface.so` (cedar hardware decode, DE layer ch0).
- It adds two signals:
  - `SIGUSR1`: toggles pause/play (the frame freezes in place).
  - `SIGUSR2`: plays the file named in `/run/mk10-background`, or its own `-f` file when that file is empty or missing. It removes `/run/mk10-background` at start.
  - `/run/mk10-vplayer-state` holds `playing` or `paused`. It is written at start and on every change, and removed at exit. Studio reads it to show the state; anything unreadable counts as playing. Added in the second build: the 18:20 install predates it, so reinstall from `tools/vplayer/build.sh`.
- INT/TERM/QUIT/HUP/PIPE destroy the player and exit 1, like the stock launcher.

MK10 Studio's "Swap background" and "Freeze background" keys use these signals over ssh. Studio refuses to signal unless `readlink /proc/<pid>/exe` ends in `/vplayer`, because the stock launcher exits on SIGUSR1/SIGUSR2.

## Install

1. Build it on the Mac: `tools/vplayer/build.sh`. You need `zig` (Homebrew). It writes `tools/vplayer/build/vplayer`: ARM EABI5, interpreter `/lib/ld-linux-armhf.so.3`, needs only GLIBC_2.4 plus `libvideoplayerinterface.so`. `/vendor/lib` is already in `/etc/ld.so.conf`.
2. Put the binary in the board overlay as `/usr/libexec/mk10/vplayer`, mode 0755. The basename must stay `vplayer`, because Studio's check matches on it.
3. Repoint `/usr/bin/videoplayerinterfaceAPP` to `/usr/libexec/mk10/vplayer`. Keep `/vendor/bin/videoplayerinterfaceAPP` untouched, so going back is just the old symlink.
4. Restart the device app: `rc-service keyboard-device restart`.

## Verified on the device (2026-11-25, run by hand from /tmp; not installed)

- Playback starts exactly like the stock player. Layer ch0 shows frame `[0, 0, 640, 256]`, and the buffer address changes from frame to frame.
- SIGUSR1 logs `XPLAYER_COMMAND_PAUSE` and the ch0 address holds. A second SIGUSR1 logs `XPLAYER_COMMAND_START` and playback runs again.
- SIGUSR2 with `/tmp/still.mp4`, then with another MainScreen mp4: `setDataSource rc 0`, and the new file plays in the same rect. An empty file goes back to `-f`. An unreadable path is refused, and the video keeps playing.
- CPU was about 4% while playing and 0% while paused.
- After each test, `rc-service keyboard-device restart` brought back the stock player.

## Checks after install

- `readlink /proc/$(pidof videoplayerinterfaceAPP)/exe` prints `/usr/libexec/mk10/vplayer`.
- `kill -USR1 $(pidof videoplayerinterfaceAPP)` freezes the background. Send it again to resume.
- Rob looks at the panel for both.
