#!/usr/bin/env python3
"""Listen on the MK10 serial port and print every frame, decoded (verbose).

    mklisten.py [--getinfo] [--reload [THEME]] [--seconds N] [-p PORT] [--raw]

Run it, press keys / turn the knob, watch the output. JSON frames (cmd 101) are
pretty-printed; anything else is hex-dumped. Nothing is assumed about the key
event format: whatever the device sends is shown as-is.

NOTE: getInfo switches the device to V2 mode (verified 2026-11-24: layout fb0
goes black, videoplayerinterfaceAPP is stopped, and neither comes back when the
port closes -- `rc-service keyboard-device restart` or --reload brings it back).
Key events (keyStateChanged, cmd 101) arrive after getInfo (verified 2026-11-24).
--getinfo --reload tests whether they keep arriving once the layout is reloaded.
"""
import argparse, json, struct, sys, time, zlib
from mkproto import pack, parse, open_port, find_port, CMD_JSON

ap = argparse.ArgumentParser()
ap.add_argument("-p", "--port", default=None)
ap.add_argument("--getinfo", action="store_true", help="send getInfo first (switches device to V2)")
ap.add_argument("--reload", nargs="?", const="/data/theme/MK10/defaultTheme.Theme", default=None,
                help="after getInfo, send V1 reload (cmd 2) of THEME to bring the layout back")
ap.add_argument("--seconds", type=float, default=60)
ap.add_argument("--raw", action="store_true", help="also hex-dump every raw chunk read")
a = ap.parse_args()

import glob
name = a.port or (glob.glob('/dev/cu.usbmodemMK10*') or [None])[0] or find_port()
print(f"[mklisten] opening {name}", file=sys.stderr)
port = open_port(name)
t0 = time.monotonic()
ts = lambda: f"+{time.monotonic() - t0:7.2f}s"

if a.getinfo:
    print(f"[mklisten] {ts()} --> getInfo", file=sys.stderr)
    port.write(pack(CMD_JSON, b'{"method":"getInfo"}', 1))

if a.reload:
    # V1 frame: magic + type u32 + cmd u32 + len u32 + crc32(payload) + payload (LE); cmd 2 = SET_DEVICE_RELOAD
    time.sleep(1)
    pl = a.reload.encode()
    print(f"[mklisten] {ts()} --> V1 reload {a.reload}", file=sys.stderr)
    port.write(b"AA551234 FIXEDCMDHEAD " + struct.pack("<4I", 0, 2, len(pl), zlib.crc32(pl)) + pl)

print(f"[mklisten] listening {a.seconds:.0f}s, Ctrl-C to stop", file=sys.stderr)
buf = bytearray()
nframes = 0
try:
    while time.monotonic() - t0 < a.seconds:
        chunk = port.read(4096)
        if chunk and a.raw:
            print(f"{ts()} RAW {len(chunk)}B {chunk.hex()}")
        buf += chunk
        for fid, cmd, data in parse(buf):
            nframes += 1
            if cmd == CMD_JSON:
                try:
                    body = json.dumps(json.loads(data), indent=2)
                except ValueError:
                    body = repr(data)
                print(f"{ts()} FRAME id={fid} cmd={cmd} len={len(data)}\n{body}", flush=True)
            else:
                print(f"{ts()} FRAME id={fid} cmd={cmd} len={len(data)} hex={data[:64].hex()}", flush=True)
except KeyboardInterrupt:
    pass
print(f"[mklisten] done: {nframes} frame(s), undecoded leftover {len(buf)}B", file=sys.stderr)
