#!/usr/bin/env python3
"""Minimal host-side client for the MK10 ScreenKey serial protocol.

Frame layout (little-endian), reverse-derived from the vendor's
OpenSourceLicenseDemo mainwindow.cpp:

    A1 A5 5A 5E | id u32 | cmd u32 | size u32 | crc32(size_le) u32 | data[size] | crc32(data) u32

crc32 is the standard IEEE reflected CRC-32 (zlib.crc32), seeded 0xffffffff
and finalized with ^0xffffffff -- exactly what the demo's CRC32.cpp does.
cmd 100 = CMD_VALUE_SHOW_JPG (raw JPEG payload), cmd 101 = CMD_VALUE_JSON
(UTF-8 JSON method call / response).

The device is the USB ACM gadget the vendor's setusbconfig calls "serial"
(1d6b:0104, /dev/ttyACM*), 115200 8N1. It speaks the same framing the
firmware uses on /dev/ttyS1 toward the GD32 and on /dev/ttyGS0 toward the
official host app.
"""
import argparse
import json
import struct
import sys
import time
import zlib

try:
    import serial
except ImportError:
    sys.exit("needs pyserial")

HEADER = b"\xa1\xa5\x5a\x5e"
CMD_SHOW_JPG = 100
CMD_JSON = 101
MIN_FRAME = len(HEADER) + 4 * 4  # id, cmd, size, size_crc


def crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def pack(cmd: int, data: bytes, msg_id: int = 1) -> bytes:
    out = bytearray(HEADER)
    out += struct.pack("<I", msg_id)
    out += struct.pack("<I", cmd)
    out += struct.pack("<I", len(data))
    out += struct.pack("<I", crc32(struct.pack("<I", len(data))))
    out += data
    out += struct.pack("<I", crc32(data))
    return bytes(out)


def parse(buf: bytearray):
    """Yield (id, cmd, data) for every complete, CRC-valid frame in buf."""
    frames = []
    while len(buf) >= MIN_FRAME:
        i = buf.find(HEADER)
        if i < 0:
            buf.clear()
            break
        if i:
            del buf[:i]
        if len(buf) < MIN_FRAME:
            break
        msg_id, cmd, size, size_crc = struct.unpack_from("<IIII", buf, 4)
        if size_crc != crc32(struct.pack("<I", size)):
            del buf[:MIN_FRAME]
            continue
        end = MIN_FRAME + size + 4
        if len(buf) < end:
            break
        data = bytes(buf[MIN_FRAME:MIN_FRAME + size])
        got = struct.unpack_from("<I", buf, MIN_FRAME + size)[0]
        del buf[:end]
        if crc32(data) == got:
            frames.append((msg_id, cmd, data))
    return frames


def reader(port, buf, deadline):
    while time.monotonic() < deadline:
        chunk = port.read(4096)
        if chunk:
            buf += chunk
        for f in parse(buf):
            yield f


def find_port() -> str:
    import glob
    cands = sorted(glob.glob("/dev/serial/by-id/*Allwinner*"))
    if cands:
        return cands[0]
    cands = sorted(glob.glob("/dev/ttyACM*"))
    if cands:
        return cands[0]
    sys.exit("no /dev/ttyACM* (is the gadget in 'serial' mode?)")


def call(port, method: str, params=None, msg_id=1, wait=3.0):
    payload = {"method": method}
    if params is not None:
        payload["parameters"] = params
    port.reset_input_buffer()
    port.write(pack(CMD_JSON, json.dumps(payload, separators=(",", ":")).encode(), msg_id))
    buf = bytearray()
    deadline = time.monotonic() + wait
    for _id, cmd, data in reader(port, buf, deadline):
        if cmd != CMD_JSON:
            continue
        try:
            obj = json.loads(data)
        except ValueError:
            continue
        return obj
    return None


def open_port(name):
    p = serial.Serial(name, 115200, timeout=0.2, write_timeout=5)
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-p", "--port", default=None)
    ap.add_argument("method", nargs="?", default="getInfo")
    ap.add_argument("json_params", nargs="?", default=None,
                    help="JSON object of parameters")
    ap.add_argument("--raw", action="store_true", help="dump frames, don't parse JSON")
    ap.add_argument("--listen", type=float, default=0.0,
                    help="listen N seconds after the call")
    a = ap.parse_args()

    port = open_port(a.port or find_port())
    params = json.loads(a.json_params) if a.json_params else None

    if a.raw:
        port.reset_input_buffer()
        if params is not None or a.method != "getInfo":
            port.write(pack(CMD_JSON, json.dumps({"method": a.method, "parameters": params}).encode()))
        buf = bytearray()
        deadline = time.monotonic() + max(a.listen, 3.0)
        for _id, cmd, data in reader(port, buf, deadline):
            print(f"id={_id} cmd={cmd} len={len(data)} {data[:200]!r}")
        return

    print(f"--> {a.method} {params or ''}")
    res = call(port, a.method, params)
    print(json.dumps(res, indent=2) if res else "(no JSON reply)")
    if a.listen:
        buf = bytearray()
        deadline = time.monotonic() + a.listen
        for _id, cmd, data in reader(port, buf, deadline):
            print(f"[{cmd}] {data[:300]!r}")


if __name__ == "__main__":
    main()
