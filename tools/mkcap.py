#!/usr/bin/env python3
"""Ask the MK10 for a screen snapshot and save the returned JPEG.

Requesting any ACK forces KeyboardDevice to re-push its current framebuffer as
a CMD_VALUE_SHOW_JPG frame; we grab that frame instead of the JSON reply.
"""
import argparse, time, json
from mkproto import pack, reader, open_port, find_port, CMD_SHOW_JPG, CMD_JSON

ap = argparse.ArgumentParser()
ap.add_argument("out", nargs="?", default="mk10-screen.jpg")
ap.add_argument("-p", "--port", default=None)
ap.add_argument("--wait", type=float, default=8.0)
a = ap.parse_args()

p = open_port(a.port or find_port())
p.reset_input_buffer()
p.write(pack(CMD_JSON, json.dumps({"method": "getInfo"}).encode()))

rbuf = bytearray()
deadline = time.monotonic() + a.wait
saved = 0
for mid, cmd, data in reader(p, rbuf, deadline):
    if cmd == CMD_JSON:
        print("JSON:", json.loads(data).get("ack_method"))
    elif cmd == CMD_SHOW_JPG:
        open(a.out, "wb").write(data)
        print(f"frame id={mid} {len(data)} bytes -> {a.out}")
        saved += 1
        if saved >= 1:
            break
if not saved:
    print("no SHOW_JPG frame received")
