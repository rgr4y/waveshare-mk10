#!/usr/bin/env bash
# Image a whole SD card to a file (full-card dd), with verification.
#   tools/backup-card.sh            # auto-pick the only removable disk
#   tools/backup-card.sh disk4       # mac
#   tools/backup-card.sh /dev/sdb    # linux
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
DEV="${1:-}"; OUT="${2:-$ROOT/img/card-$(date +%Y%m%d-%H%M%S).img}"
OS="$(uname -s)"
[ -n "$DEV" ] || { echo "give a device:"; [ "$OS" = Darwin ] && diskutil list external physical || lsblk -d -o NAME,SIZE,TRAN,MODEL; exit 1; }
if [ "$OS" = Darwin ]; then DISK=/dev/$DEV; SRC=${DISK/disk/rdisk}; diskutil unmountDisk "$DISK" || true
else DISK=$DEV; SRC=$DEV; for p in "$DISK"?*; do umount "$p" 2>/dev/null || true; done; fi
echo ">> reading $SRC -> $OUT"
sudo dd if="$SRC" of="$OUT" bs=4m conv=fsync status=progress
echo ">> sha256:"; shasum -a 256 "$OUT"
echo ">> size:   $(du -h "$OUT" | cut -f1)   (full device capacity, so it ends in GPT backup header)"
