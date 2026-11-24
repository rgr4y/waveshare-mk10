#!/usr/bin/env bash
# Flash an MK10 raw image to an SD card. Mac or Linux.
#
#   tools/flash.sh                 # list candidate disks, then flash the factory image
#   tools/flash.sh disk4           # mac: whole disk
#   tools/flash.sh /dev/sdb        # linux: whole disk
#   tools/flash.sh disk4 img/x.img # explicit image
#
# Usage:  flash.sh [device] [image]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
IMG="${2:-$ROOT/img/mk10-factory-raw.img}"
DEV="${1:-}"

OS="$(uname -s)"

list_mac() { diskutil list external physical 2>/dev/null; }
list_linux() { lsblk -d -o NAME,SIZE,TYPE,TRAN,MODEL 2>/dev/null | grep -vE 'loop|zd'; }

if [ -z "$DEV" ]; then
  echo "No device given. Candidates:"
  if [ "$OS" = Darwin ]; then list_mac; else list_linux; fi
  echo
  read -r -p "Device (e.g. $( [ "$OS" = Darwin ] && echo disk4 || echo /dev/sdb )): " DEV
fi

[ -f "$IMG" ] || { echo "image not found: $IMG"; exit 1; }
SIZE=$(du -h "$IMG" | cut -f1)
echo "image : $IMG ($SIZE)"
echo "device: $DEV"
echo

read -r -p "DESTROYS ALL DATA on $DEV. Continue? [y/N] " ok
[ "$ok" = y ] || [ "$ok" = Y ] || exit 1

if [ "$OS" = Darwin ]; then
  DISK="$DEV"; case "$DISK" in /dev/*) ;; *) DISK="/dev/$DISK";; esac
  diskutil unmountDisk "$DISK" || true
  echo ">> dd (raw rdisk) ..."
  sudo dd if="$IMG" of="${DISK/disk/rdisk}" bs=4m
  sync
  diskutil eject "$DISK" || true
elif [ "$OS" = Linux ]; then
  DISK="$DEV"; case "$DISK" in /dev/*) ;; *) DISK="/dev/$DISK";; esac
  # unmount all partitions
  for p in "$DISK"?*; do umount "$p" 2>/dev/null || true; done
  echo ">> dd ..."
  sudo dd if="$IMG" of="$DISK" bs=4M conv=fsync status=progress
  sync
  sudo partprobe "$DISK" 2>/dev/null || true
else
  echo "unsupported OS: $OS"; exit 1
fi
echo ">> done. Insert card into the MK10 and power on."
