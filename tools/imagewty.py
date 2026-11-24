#!/usr/bin/env python3
"""List or extract items from an unencrypted Allwinner IMAGEWTY v3 image.

File headers are 1024 bytes each starting at 0x400:
  +0x000 u32 filename_len (0x100)   +0x004 u32 header_size (0x400)
  +0x008 maintype[8]                +0x010 subtype[16]
  +0x024 filename[256]
  +0x124 u32 stored_len  +0x12C u32 original_len  +0x134 u32 offset
Usage: imagewty.py IMAGE [OUTDIR]   (no OUTDIR = list only)
"""
import os
import struct
import sys


def items(f):
    f.seek(0)
    head = f.read(16)
    if head[:8] != b"IMAGEWTY":
        sys.exit("not IMAGEWTY (encrypted images are not supported)")
    if struct.unpack_from("<I", head, 8)[0] != 0x300:
        sys.exit("only header version 0x300 is supported")
    pos = 0x400
    while True:
        f.seek(pos)
        h = f.read(0x400)
        if len(h) < 0x400 or struct.unpack_from("<II", h, 0) != (0x100, 0x400):
            return
        name = h[0x24:0x124].split(b"\0")[0].decode()
        stored, orig, off = (struct.unpack_from("<I", h, o)[0] for o in (0x124, 0x12C, 0x134))
        yield h[8:16].decode().strip(), h[16:32].decode().strip("\0 "), name, stored, orig, off
        pos += 0x400


def main():
    img, out = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None
    with open(img, "rb") as f:
        for main_t, sub_t, name, stored, orig, off in items(f):
            print(f"{main_t:8s} {sub_t:16s} {name:28s} {orig:>12,}B @0x{off:x}")
            if out:
                os.makedirs(out, exist_ok=True)
                f.seek(off)
                with open(os.path.join(out, os.path.basename(name)), "wb") as o:
                    o.write(f.read(orig))
    if out:
        print(f"extracted to {out}")


if __name__ == "__main__":
    main()
