#!/usr/bin/env bash
# Show disks that look like a removable SD card on this machine.
OS="$(uname -s)"
if [ "$OS" = Darwin ]; then
  echo "== external / removable =="; diskutil list external physical 2>/dev/null || echo "(none)"
  echo; echo "== built-in SD reader =="; system_profiler SPCardReaderDataType 2>/dev/null | sed -n '1,12p'
else
  echo "== whole disks =="; lsblk -d -o NAME,SIZE,TYPE,TRAN,MODEL,MOUNTPOINT 2>/dev/null | grep -vE 'loop|zd'
fi
