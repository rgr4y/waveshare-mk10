#!/usr/bin/env bash
# Flash an MK10 image to a card using a remote Linux box as the writer
# (e.g. your T31X/Thingino camera over ssh).
#   tools/flash-remote.sh root@cam img/mk10-factory-raw.img /dev/mmcblk0
set -euo pipefail
HOST="${1:?user@host}"; IMG="${2:?image}"; DEV="${3:-/dev/mmcblk0}"
[ -f "$IMG" ] || { echo "no image: $IMG"; exit 1; }
echo "image: $IMG ($(du -h "$IMG" | cut -f1))  ->  $HOST:$DEV"
read -r -p "DESTROYS $DEV on $HOST. Continue? [y/N] " ok; [ "$ok" = y ] || exit 1
echo ">> copying image to $HOST:/tmp/$(basename "$IMG") ..."
scp -q "$IMG" "$HOST:/tmp/$(basename "$IMG")"
echo ">> writing card ..."
ssh "$HOST" bash -c "'
  set -e
  for p in ${DEV}*; do umount \"\$p\" 2>/dev/null || true; done
  dd if=/tmp/$(basename "$IMG") of=$DEV bs=4M conv=fsync status=progress
  sync; partprobe $DEV 2>/dev/null || true
'"
echo ">> done"
