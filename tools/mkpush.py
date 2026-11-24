#!/usr/bin/env python3
"""Push a JPEG frame to the MK10 over the serial protocol (CMD_VALUE_SHOW_JPG)."""
import sys, time, argparse
from PIL import Image
from mkproto import pack, parse, reader, open_port, find_port, CMD_SHOW_JPG, CMD_JSON

ap = argparse.ArgumentParser()
ap.add_argument("image", nargs="?", help="image file; omit to draw a test pattern")
ap.add_argument("-p", "--port", default=None)
ap.add_argument("--wait", type=float, default=6.0, help="seconds to await ack")
a = ap.parse_args()

W, H = 896, 304
if a.image:
    img = Image.open(a.image).convert("RGB").resize((W, H))
else:
    img = Image.new("RGB", (W, H), (8, 8, 24))
    from PIL import ImageDraw
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W - 1, 127], outline=(0, 160, 255), width=2)
    d.rectangle([0, 128, 639, H - 1], outline=(0, 160, 255), width=2)
    d.rectangle([656, 0, 895, 295], outline=(255, 120, 0), width=2)
    for c in range(5):
        for r in range(2):
            d.text((c * 128 + 4, r * 128 + 4), f"key {c},{r}", fill=(200, 200, 200))
    d.text((664, 8), "240x296 SIDE", fill=(255, 120, 0))
    d.text((8, H - 20), "MK10 live serial push - " + time.strftime("%H:%M:%S"), fill=(120, 255, 120))

import io
buf = io.BytesIO()
img.save(buf, "JPEG", quality=85)
jpg = buf.getvalue()
print(f"JPEG {len(jpg)} bytes {W}x{H}")

p = open_port(a.port or find_port())
p.reset_input_buffer()
p.write(pack(CMD_SHOW_JPG, jpg))
rbuf = bytearray()
deadline = time.monotonic() + a.wait
for mid, cmd, data in reader(p, rbuf, deadline):
    print(f"ack id={mid} cmd={cmd} data={data[:120]!r}")
    if cmd == CMD_SHOW_JPG:
        print("device finished drawing the frame")
        break
else:
    print("no SHOW_JPG ack within wait window")
