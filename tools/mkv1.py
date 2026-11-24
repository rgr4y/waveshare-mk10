#!/usr/bin/env python3
"""Old-style (V1) frames on MK10, verbose raw dump.

    mkv1.py reload                     # V1 cmd 2 reload of defaultTheme, dump 8 s of replies
    mkv1.py '{"CPU Usage":"42%"}'      # V1 cmd 1 SEND_SYSTEM_DATA_TO_DEVICE (verified 2026-11-24)
"""
import glob, struct, sys, time, zlib, json
sys.path.insert(0, __import__('os').path.dirname(__file__))
from mkproto import open_port
HEAD = b"AA551234 FIXEDCMDHEAD "
def v1(cmd, pl): return HEAD + struct.pack("<4I", 0, cmd, len(pl), zlib.crc32(pl)) + pl
def s(x): b = x.encode('utf-16-be'); return struct.pack(">I", len(b)) + b
def smap(d): return struct.pack(">I", len(d)) + b"".join(s(k) + s(v) for k, v in d.items())
def drain(port, secs, label):
    t = time.monotonic(); buf = b""
    while time.monotonic() - t < secs: buf += port.read(4096)
    print(f"[{label}] {len(buf)}B raw"); 
    if buf: print("  ascii:", buf.decode('latin1').encode('unicode_escape').decode()[:1500])
name = glob.glob('/dev/cu.usbmodemMK10*')[0]; port = open_port(name); print("port", name)
mode = sys.argv[1]
if mode == 'reload':
    port.write(v1(2, b"/data/theme/MK10/defaultTheme.Theme")); drain(port, 8, "after reload")
else:
    vals = json.loads(mode); port.write(v1(1, smap(vals))); print("sent", vals); drain(port, 2, "after sysdata")
