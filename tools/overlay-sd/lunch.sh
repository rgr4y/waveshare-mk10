#!/bin/sh
# --- MK10 shell enabler -------------------------------------------------
# Copy to the card as /lunch.sh (its boot-resource FAT mounts at /mnt/SDCARD
# and qt_app1 runs /mnt/SDCARD/lunch.sh at every boot, before the UI).
#
# KeyboardDevice re-asserts `setusbconfig serial` when it starts, which kicks
# adb back off -- so we wait for the UI to settle, then take the gadget over.
# Backgrounded, so the UI still comes up normally.
#
# Result: USB re-enumerates as 18d1:d002 ("Tina ADB"), then:  adb shell
# root shell, password 'tina', no ScreenKey serial app while adb is active.
#
# Remove this file (or drop a file named noshell next to it) for stock behaviour.

(
  sleep 20
  /data/setusbconfig adb
  /bin/adbd -D
  # babysit: if something tears adb down, put it back
  while :; do
    sleep 10
    pgrep -x adbd >/dev/null || /bin/adbd -D
  done
) >/dev/null 2>&1 &

echo "[lunch] shell enabler armed (adb ~20s after boot)"
