#!/usr/bin/env python3
"""fbcap.py TAG [fbN...] : ssh-cat device fbs -> $FBCAP_DIR/TAG_fbN.png (fb0 = first 896x304 page). Verbose on stderr."""
import sys, subprocess, zlib, struct, os
D=os.environ.get("FBCAP_DIR",".")+"/"
H="root@10.0.0.10"
def sh(c,**k): return subprocess.run(["ssh",H,c],capture_output=True,timeout=60,**k).stdout
def png(w,h,rgb,path):
    raw=b"".join(b"\0"+rgb[y*w*3:(y+1)*w*3] for y in range(h))
    def ch(t,d): c=struct.pack(">I",len(d))+t+d; return c+struct.pack(">I",zlib.crc32(t+d))
    open(path,"wb").write(b"\x89PNG\r\n\x1a\n"+ch(b"IHDR",struct.pack(">IIBBBBB",w,h,8,2,0,0,0))+ch(b"IDAT",zlib.compress(raw))+ch(b"IEND",b""))
tag=sys.argv[1]; fbs=sys.argv[2:] or ["fb0","fb11"]
for fb in fbs:
    b=sh(f"cd /sys/class/graphics/{fb}; cat virtual_size bits_per_pixel stride").split()
    vw,vh=map(int,b[0].decode().split(",")); bpp=int(b[1]); st=int(b[2])
    data=sh(f"cat /dev/{fb}")
    h=vh if fb!="fb0" else 304  # fb0 virtual 608 = 2x304; show first page
    out=bytearray()
    for y in range(h):
        row=data[y*st:y*st+vw*bpp//8]
        if bpp==32:
            out+=b"".join(row[i+2:i+3]+row[i+1:i+2]+row[i:i+1] for i in range(0,len(row),4))  # BGRA->RGB
        else:
            for i in range(0,len(row),2):
                v=row[i]|row[i+1]<<8; out+=bytes(((v>>11)*255//31,((v>>5)&63)*255//63,(v&31)*255//31))
    p=f"{D}{tag}_{fb}.png"; png(vw,h,bytes(out),p); print(f"[fbcap] {fb} {vw}x{h} bpp{bpp} {len(data)}B -> {p}",file=sys.stderr)
