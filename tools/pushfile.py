#!/usr/bin/env python3
"""Write a local file onto the device filesystem over the serial protocol
(method saveToFile, chunked as the vendor demo does)."""
import argparse, base64, json, os, time, zlib
from mkproto import pack, reader, open_port, find_port, CMD_JSON

CHUNK = 64 * 1024

def crc32(b): return zlib.crc32(b) & 0xFFFFFFFF

ap = argparse.ArgumentParser()
ap.add_argument("local"); ap.add_argument("remote")
ap.add_argument("-p", "--port", default=None); ap.add_argument("--wait", type=float, default=4.0)
a = ap.parse_args()

data = open(a.local, "rb").read()
p = open_port(a.port or find_port())

def call(method, params, mid):
    p.write(pack(CMD_JSON, json.dumps({"method": method, "parameters": params}).encode(), mid))
    buf = bytearray(); deadline = time.monotonic() + a.wait
    for _id, cmd, d in reader(p, buf, deadline):
        if cmd == CMD_JSON:
            try: return json.loads(d)
            except ValueError: pass
    return None

pos = 0; mid = 1
while pos < len(data):
    seg = data[pos:pos+CHUNK]
    r = call("saveToFile", {"filePath": a.remote, "seek": pos,
                            "data": base64.b64encode(seg).decode()}, mid); mid += 1
    ack = (r or {}).get("result", {}).get("seek") if isinstance(r, dict) else None
    print(f"  wrote {pos}..{pos+len(seg)}  ack={ack}")
    pos += len(seg)
r = call("setFileCRC", {"filePath": a.remote, "crc": str(crc32(data))}, mid)
print("setFileCRC ->", r)
print(f"done: {a.remote}  {len(data)} bytes  crc32={crc32(data):08x}")
