#!/usr/bin/env python3
"""Build a custom MK10 SD image from a full card dump.

  tools/build_card.py BASE.img OUT.img [--ssh-key PUB] [--no-slim]

BASE must be a full raw dump of a working card (tools/backup-card.sh or
`dd if=/dev/rdiskN`): boot0 and boot_package live outside the partitions, so
partition-only images (Disk Utility .dmg) have no bootloader.

Steps (add new ones as functions and call them from main):
  1. extract boot-resource + rootfs from BASE (offsets read from its GPT)
  2. rootfs: slim (tools/slim_rootfs.py), then copy tools/overlay/ on top
  3. rootfs: root's authorized_keys from --ssh-key (default ~/.ssh/id_ed25519.pub)
  4. boot-resource: drop macOS litter, copy tools/overlay-sd/ on top
  5. OUT = BASE with those two partitions replaced; every other byte is checked
     against BASE

Work files go to linux/build/.
"""
import argparse
import hashlib
import os
import shutil
import stat
import struct
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slim_rootfs import dbg, exists, fsck, slim  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OVERLAY = os.path.join(ROOT, "tools", "overlay")
OVERLAY_SD = os.path.join(ROOT, "tools", "overlay-sd")
WORK = os.path.join(ROOT, "linux", "build")
SKIP = (".DS_Store",)
SEC = 512


def gpt_parts(img):
    """{name: (first_lba, end_lba_exclusive)} from the primary GPT."""
    with open(img, "rb") as f:
        f.seek(SEC)
        h = f.read(92)
        assert h[:8] == b"EFI PART", "no GPT header at LBA 1"
        lba, n, size = struct.unpack("<QII", h[72:88])
        f.seek(lba * SEC)
        tab = f.read(n * size)
    parts = {}
    for i in range(n):
        e = tab[i * size:(i + 1) * size]
        first, last = struct.unpack("<QQ", e[32:48])
        if first:
            parts[e[56:128].decode("utf-16-le").rstrip("\0")] = (first, last + 1)
    return parts


def copy_region(src, dst, first, end, seek=None):
    """Copy sectors [first, end) of src to dst (new file, or at `seek` in place)."""
    with open(src, "rb") as fi, open(dst, "r+b" if seek is not None else "wb") as fo:
        fi.seek(first * SEC)
        if seek is not None:
            fo.seek(seek * SEC)
        n = (end - first) * SEC
        while n:
            d = fi.read(min(n, 1 << 24))
            fo.write(d)
            n -= len(d)


def sha(path, first=0, end=None):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        f.seek(first * SEC)
        n = None if end is None else (end - first) * SEC
        while n is None or n:
            d = f.read(1 << 24 if n is None else min(n, 1 << 24))
            if not d:
                break
            h.update(d)
            if n is not None:
                n -= len(d)
    return h.digest()


def overlay_ext4(img, tree):
    """Copy a local tree into the ext4 image: root-owned, local modes kept."""
    cmds, count = [], 0
    for dirpath, dirnames, filenames in os.walk(tree):
        dirnames.sort()
        rel = "/" + os.path.relpath(dirpath, tree).lstrip(".")
        rel = rel.rstrip("/") or "/"
        for name in sorted(dirnames) + sorted(filenames):
            if name in SKIP or name.startswith("._"):
                continue
            lp = os.path.join(dirpath, name)
            rp = f"{rel.rstrip('/')}/{name}"
            st = os.lstat(lp)
            if stat.S_ISDIR(st.st_mode):
                if exists(img, rp):
                    continue  # never touch modes of existing dirs like /etc
                cmds += [f'mkdir "{rp}"']
            elif stat.S_ISLNK(st.st_mode):
                cmds += [f'rm "{rp}"', f'symlink "{rp}" "{os.readlink(lp)}"']
            else:
                cmds += [f'rm "{rp}"', f'write "{lp}" "{rp}"']
            if not stat.S_ISLNK(st.st_mode):
                cmds += [f'sif "{rp}" mode 0{st.st_mode:o}']
            cmds += [f'sif "{rp}" uid 0', f'sif "{rp}" gid 0']
            print(f"   + {rp}")
            count += 1
    dbg(img, cmds, write=True)
    return count


def add_ssh_key(img, pub):
    if not pub or not os.path.isfile(pub):
        print(f">> no ssh key ({pub}); sshd will refuse root (no password login)")
        return
    with tempfile.TemporaryDirectory() as t:
        keys = os.path.join(t, "authorized_keys")
        shutil.copyfile(pub, keys)
        cmds = [] if exists(img, "/root/.ssh") else ['mkdir /root/.ssh']
        cmds += ['sif /root/.ssh mode 040700', 'sif /root/.ssh uid 0', 'sif /root/.ssh gid 0',
                 'rm /root/.ssh/authorized_keys', f'write "{keys}" /root/.ssh/authorized_keys',
                 'sif /root/.ssh/authorized_keys mode 0100600',
                 'sif /root/.ssh/authorized_keys uid 0', 'sif /root/.ssh/authorized_keys gid 0']
        dbg(img, cmds, write=True)
    print(f">> /root/.ssh/authorized_keys <- {pub}")


def mtools(*args):
    r = subprocess.run(list(args), capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"{args[0]} failed: {r.stderr.strip()}")
    return r.stdout


def overlay_fat(img, tree):
    """Drop macOS litter from the FAT root, then copy a local tree on top."""
    litter = (".fseventsd", ".Trashes", ".Spotlight-V100", ".DS_Store")
    for n in mtools("mdir", "-b", "-a", "-i", img, "::").splitlines():
        base = n.rsplit("/", 1)[-1]
        if base.startswith("._") or base in litter:
            r = subprocess.run(["mdel", "-i", img, n], capture_output=True)
            if r.returncode:
                mtools("mdeltree", "-i", img, n)
            print(f"   - {n}")
    with tempfile.TemporaryDirectory() as t:
        for name in sorted(os.listdir(tree)):
            if name in SKIP or name.startswith("._"):
                continue
            lp = os.path.join(tree, name)
            mtools("mcopy", "-o", "-s", "-i", img, lp, "::")
            if os.path.isfile(lp):
                back = os.path.join(t, name)
                mtools("mcopy", "-n", "-i", img, f"::{name}", back)
                assert open(back, "rb").read() == open(lp, "rb").read(), f"FAT readback differs: {name}"
            print(f"   + ::/{name}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("base")
    ap.add_argument("out")
    ap.add_argument("--ssh-key", default=os.path.expanduser("~/.ssh/id_ed25519.pub"))
    ap.add_argument("--no-slim", action="store_true", help="skip junk removal")
    a = ap.parse_args()

    os.makedirs(WORK, exist_ok=True)
    mtoolsrc = os.path.join(WORK, "mtoolsrc")
    with open(mtoolsrc, "w") as f:
        f.write("mtools_skip_check=1\n")
    os.environ["MTOOLSRC"] = mtoolsrc

    # 0. base must carry a bootloader, or every card flashed from OUT lands in FEL
    with open(a.base, "rb") as f:
        f.seek(16 * SEC + 4)
        assert f.read(8) == b"eGON.BT0", "BASE has no boot0 at LBA 16 (partition-only dump?)"
    parts = gpt_parts(a.base)
    print(">> GPT:", ", ".join(f"{k} {v[0]}-{v[1] - 1}" for k, v in parts.items()))
    rootfs = os.path.join(WORK, "rootfs.ext4")
    bres = os.path.join(WORK, "boot-resource.fat")

    # 1. extract
    copy_region(a.base, rootfs, *parts["rootfs"])
    copy_region(a.base, bres, *parts["boot-resource"])

    # 2-3. rootfs
    if not a.no_slim:
        slim(rootfs)
    print(">> rootfs overlay", OVERLAY)
    overlay_ext4(rootfs, OVERLAY)
    add_ssh_key(rootfs, a.ssh_key)
    fsck(rootfs)

    # 4. boot-resource
    print(">> boot-resource overlay", OVERLAY_SD)
    overlay_fat(bres, OVERLAY_SD)

    # 5. assemble + verify
    print(f">> assemble {a.out}")
    shutil.copyfile(a.base, a.out)
    copy_region(rootfs, a.out, 0, parts["rootfs"][1] - parts["rootfs"][0], seek=parts["rootfs"][0])
    copy_region(bres, a.out, 0, parts["boot-resource"][1] - parts["boot-resource"][0],
                seek=parts["boot-resource"][0])
    total = os.path.getsize(a.base) // SEC
    changed = sorted([parts["boot-resource"], parts["rootfs"]])
    gaps, pos = [], 0
    for s, e in changed:
        gaps.append((pos, s))
        pos = e
    gaps.append((pos, total))
    for s, e in gaps:
        assert sha(a.out, s, e) == sha(a.base, s, e), f"sectors {s}-{e} differ from BASE"
    assert sha(a.out, *parts["rootfs"]) == sha(rootfs)
    assert sha(a.out, *parts["boot-resource"]) == sha(bres)
    print(">> verified: only boot-resource and rootfs differ from BASE")
    h = hashlib.sha256()
    with open(a.out, "rb") as f:
        for d in iter(lambda: f.read(1 << 24), b""):
            h.update(d)
    print(f">> done: {a.out}\n   sha256 {h.hexdigest()}")


if __name__ == "__main__":
    main()
