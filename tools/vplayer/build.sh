#!/bin/sh
# Cross-compile vplayer for the MK10 (armhf, vendor glibc 2.23 in /vendor/lib).
# Links against a copy of the device's libvideoplayerinterface.so (fetched over ssh if missing).
set -eu
cd "$(dirname "$0")"
DEV=${DEV:-root@10.0.1.48}
mkdir -p build
if [ ! -f build/libvideoplayerinterface.so ]; then
  echo "fetching libvideoplayerinterface.so from $DEV"
  scp -q "$DEV:/vendor/lib/libvideoplayerinterface.so" build/
fi
echo "compiling build/vplayer"
zig cc -target arm-linux-gnueabihf.2.23 -mcpu=cortex_a7 -Os -Wall -Wextra \
  -o build/vplayer vplayer.c -Lbuild -lvideoplayerinterface -Wl,--allow-shlib-undefined
file build/vplayer
