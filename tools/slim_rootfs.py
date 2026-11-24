#!/usr/bin/env python3
"""Slim an MK10 Tina rootfs ext4 image (debugfs -w). Used by build_card.py;
added files (Entware etc.) come from tools/overlay, not from here.

  tools/slim_rootfs.py SRC.ext4 OUT.ext4    # standalone: copy SRC, slim OUT

Removes:
  - vendor demo/test packages (DEMO_PKGS), using their opkg .list files
  - Qt build tooling under /arm-qt (bin, include, examples, mkspecs, qml, *.a ...)
    KeyboardDevice only needs Core/Gui/Widgets/Xml/Charts/SerialPort + plugins
  - /usr/share/fonts: Windows font-folder dump; keeps msyh.ttc as the CJK
    fallback plus every TTF/OTF under 3 MB (theme-style fonts)
  - XiaoZhi cloud helpers /data/xiaozhiAIControl, /data/xiaozhiAISound
  - macOS litter (.fseventsd) from an earlier r/w mount
"""
import os
import re
import shutil
import subprocess
import sys

DEBUGFS = "/opt/homebrew/opt/e2fsprogs/sbin/debugfs"
E2FSCK = "/opt/homebrew/opt/e2fsprogs/sbin/e2fsck"
FONT_DIR = "/usr/share/fonts"
FONT_KEEP = {"msyh.ttc"}
FONT_SMALL = 3 * 1024 * 1024

DEMO_PKGS = [
    "tinatest", "directfb", "directfb-examples", "camerademo", "tplayerdemo",
    "softap-demo", "wifimanager-demo", "jpegdecodedemo", "awrpaf_demo",
    "libsec_key-demo", "gpio_ir_test", "xr819s-rftest", "iozone3", "memtester",
    "stress", "rwcheck", "mtop", "cpu_monitor",
]
QT_TREES = ["/arm-qt/bin", "/arm-qt/include", "/arm-qt/examples",
            "/arm-qt/mkspecs", "/arm-qt/doc", "/arm-qt/qml",
            "/arm-qt/lib/cmake", "/arm-qt/lib/pkgconfig"]
QT_LIB_JUNK = re.compile(r"\.(a|prl|la)$")
EXTRA_PATHS = ["/data/xiaozhiAIControl", "/data/xiaozhiAISound", "/.fseventsd"]

def dbg(img, cmds, write=False):
    if len(cmds) == 1 and not write:  # -R: no command echo, stdout = file data
        r = subprocess.run([DEBUGFS, "-R", cmds[0], img], capture_output=True, text=True)
        return r.stdout + (r.stderr.split("\n", 1)[1] if "\n" in r.stderr else "")
    args = [DEBUGFS] + (["-w"] if write else []) + ["-f", "-", img]
    r = subprocess.run(args, input="\n".join(cmds) + "\n", capture_output=True, text=True)
    return r.stdout + r.stderr


def walk(img, root):
    """Return [(path, is_dir, size)] under root, depth-first, children first."""
    out = []
    listing = dbg(img, [f'ls -p "{root}"'])
    for line in listing.splitlines():
        f = line.split("/")
        if len(f) < 7 or not f[1].strip().isdigit():
            continue
        mode, name, size = f[2], f[5], f[6]
        if name in (".", ".."):
            continue
        p = f"{root.rstrip('/')}/{name}"
        is_dir = (int(mode, 8) & 0o170000) == 0o040000
        if is_dir:
            out += walk(img, p)
        out.append((p, is_dir, int(size or 0)))
    return out


def exists(img, path):
    return "File not found" not in dbg(img, [f'stat "{path}"'])


def slim(out):
    """Remove the junk from ext4 image OUT in place."""
    files, dirs, freed = [], [], 0

    def take(path):
        nonlocal freed
        if not exists(out, path):
            print(f"   (missing) {path}")
            return
        kids = walk(out, path)
        if kids or dbg(out, [f'stat "{path}"']).find("Type: directory") >= 0:
            for p, d, s in kids:
                (dirs if d else files).append(p)
                freed += 0 if d else s
            dirs.append(path)
        else:
            m = re.search(r"Size: (\d+)", dbg(out, [f'stat "{path}"']))
            freed += int(m.group(1)) if m else 0
            files.append(path)

    # 1. demo packages
    info = "/usr/lib/opkg/info"
    for pkg in DEMO_PKGS:
        lst = dbg(out, [f'cat "{info}/{pkg}.list"'])
        paths = [l.strip() for l in lst.splitlines() if l.startswith("/")]
        print(f">> pkg {pkg}: {len(paths)} paths")
        for p in paths:
            if exists(out, p):
                take(p)
        for suf in ("list", "control", "postinst", "prerm", "postrm", "preinst", "conffiles"):
            if exists(out, f"{info}/{pkg}.{suf}"):
                files.append(f"{info}/{pkg}.{suf}")
    # rc.d links whose init.d target is going away
    for line in dbg(out, ['ls -l /etc/rc.d']).splitlines():
        name = line.split()[-1] if line.split() else ""
        if re.match(r"^[SK]\d\d", name):
            tgt = dbg(out, [f'stat "/etc/rc.d/{name}"'])
            m = re.search(r'Fast link dest: "([^"]+)"', tgt)
            if m:
                t = os.path.normpath(os.path.join("/etc/rc.d", m.group(1)))
                if t in files:
                    files.append(f"/etc/rc.d/{name}")

    # 2. Qt tooling
    for t in QT_TREES:
        take(t)
    for p, d, s in walk(out, "/arm-qt/lib"):
        if not d and QT_LIB_JUNK.search(p) and p not in files:
            files.append(p); freed += s

    # 3. fonts
    for p, d, s in walk(out, FONT_DIR):
        base = os.path.basename(p)
        keep = base in FONT_KEEP or (base.lower().endswith((".ttf", ".otf")) and s < FONT_SMALL)
        if not d and not keep:
            files.append(p); freed += s

    # 4. extras
    for p in EXTRA_PATHS:
        take(p)

    files = list(dict.fromkeys(files))
    dirs = list(dict.fromkeys(dirs))
    print(f">> removing {len(files)} files, {len(dirs)} dirs, ~{freed / 1048576:.1f} MiB")
    cmds = [f'rm "{p}"' for p in files] + [f'rmdir "{p}"' for p in dirs]
    res = dbg(out, cmds, write=True)
    errs = [l for l in res.splitlines() if l.strip() and not l.startswith("debugfs")]
    for e in errs[:20]:
        print("   !", e)

    # 5. status file: drop removed package stanzas
    status = subprocess.run([DEBUGFS, "-R", "cat /usr/lib/opkg/status", out],
                            capture_output=True, text=True).stdout
    stanzas = [s for s in status.strip().split("\n\n")
               if not any(re.search(rf"^Package: {re.escape(p)}$", s, re.M) for p in DEMO_PKGS)]
    tmp = out + ".status"
    with open(tmp, "w") as f:
        f.write("\n\n".join(stanzas) + "\n")
    os.chmod(tmp, 0o644)
    dbg(out, ["rm /usr/lib/opkg/status", f'write "{tmp}" /usr/lib/opkg/status',
              'sif /usr/lib/opkg/status uid 0', 'sif /usr/lib/opkg/status gid 0'], write=True)
    os.remove(tmp)


def fsck(out):
    print(">> e2fsck -fy")
    r = subprocess.run([E2FSCK, "-fy", out], capture_output=True, text=True)
    print(r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr)
    if r.returncode not in (0, 1):  # 1 = errors corrected
        sys.exit(f"e2fsck failed ({r.returncode}) on {out}")


if __name__ == "__main__":
    src, out = sys.argv[1:3]
    print(f">> copy {src} -> {out}")
    shutil.copyfile(src, out)
    slim(out)
    fsck(out)
