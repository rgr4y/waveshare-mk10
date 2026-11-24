#!/usr/bin/env python3
"""Decode/encode Waveshare ScreenKey *.Theme files (byte-exact round trip).

The file is a bare Qt QDataStream (big-endian, no magic, no version header;
the stream version is not recorded, but every type used here encodes the same
in Qt 4.x..5.x) holding five consecutive objects:

    1. QVariantMap            u32 n, n * (QString key, QVariant value)
    2. u32 0                  (guess: empty QMap/QList, or padding; must be 0)
    3. QByteArray             UTF-8 JSON text (pages / items / canvas), indented
    4. QMap<QString,QByteArray>  u32 n, n * (QString path, QByteArray blob)
                              png/gif/mp4 blobs keyed by device-style paths
    5. u32 0                  (same guess as 2)

QString:    u32 byte length (0xffffffff = null), UTF-16BE code units
QByteArray: u32 length (0xffffffff = null), raw bytes
QVariant:   u32 type id, u8 is_null, payload  (1 bool u8, 2 int i32,
            10 QString, 12 QByteArray; anything else is an error)

CLI:
    qtheme.py decode X.Theme outdir/   -> outdir/theme.json, pages.json, assets/...
    qtheme.py encode outdir/ Y.Theme
    qtheme.py schema X.Theme           -> key tree with types and sizes

Progress goes to stderr. Python stdlib only.
"""
import argparse
import hashlib
import json
import os
import struct
import sys

NULL = 0xFFFFFFFF
T_BOOL, T_INT, T_MAP, T_STRING, T_BYTES = 1, 2, 8, 10, 12
TYPE_NAMES = {T_BOOL: "bool", T_INT: "int", T_MAP: "QVariantMap",
              T_STRING: "QString", T_BYTES: "QByteArray"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class Reader:
    def __init__(self, data):
        self.d, self.p = data, 0

    def take(self, n):
        if n < 0 or self.p + n > len(self.d):
            raise ValueError(f"truncated: need {n} at {self.p}, have {len(self.d) - self.p}")
        b = self.d[self.p:self.p + n]
        self.p += n
        return b

    def u32(self):
        return struct.unpack(">I", self.take(4))[0]

    def string(self):
        n = self.u32()
        if n == NULL:
            return None
        return self.take(n).decode("utf-16-be")

    def bytes_(self):
        n = self.u32()
        return None if n == NULL else self.take(n)

    def variant(self):
        t = self.u32()
        null = self.take(1)[0]
        if t == T_BOOL:
            v = self.take(1)[0]
            if v > 1:
                raise ValueError(f"bool byte {v} at {self.p - 1}")
            v = bool(v)
        elif t == T_INT:
            v = struct.unpack(">i", self.take(4))[0]
        elif t == T_STRING:
            v = self.string()
        elif t == T_BYTES:
            v = self.bytes_()
        elif t == T_MAP:
            v = self.vmap()
        else:
            raise ValueError(f"unsupported QVariant type id {t} at offset {self.p - 5}")
        return {"type": t, "null": null, "value": v}

    def vmap(self):
        return [(self.string(), self.variant()) for _ in range(self.u32())]


def w_u32(n):
    return struct.pack(">I", n)


def w_string(s):
    if s is None:
        return w_u32(NULL)
    b = s.encode("utf-16-be")  # ponytail: lone surrogates would raise; none present
    return w_u32(len(b)) + b


def w_bytes(b):
    return w_u32(NULL) if b is None else w_u32(len(b)) + b


def w_variant(v):
    t, out = v["type"], w_u32(v["type"]) + bytes([v["null"]])
    x = v["value"]
    if t == T_BOOL:
        return out + bytes([1 if x else 0])
    if t == T_INT:
        return out + struct.pack(">i", x)
    if t == T_STRING:
        return out + w_string(x)
    if t == T_BYTES:
        return out + w_bytes(x)
    if t == T_MAP:
        return out + w_vmap(x)
    raise ValueError(f"unsupported QVariant type id {t}")


def w_vmap(items):
    return w_u32(len(items)) + b"".join(w_string(k) + w_variant(v) for k, v in items)


def load(path):
    """Parse a .Theme file -> dict(header=[(key, variant)], json=bytes, assets=[(path, bytes|None)])."""
    with open(path, "rb") as f:
        r = Reader(f.read())
    header = r.vmap()
    z1 = r.u32()
    js = r.bytes_()
    assets = [(r.string(), r.bytes_()) for _ in range(r.u32())]
    z2 = r.u32()
    if z1 or z2:
        raise ValueError(f"reserved u32s not zero ({z1}, {z2}); format guess wrong")
    if r.p != len(r.d):
        raise ValueError(f"{len(r.d) - r.p} trailing bytes after offset {r.p}")
    return {"header": header, "json": js, "assets": assets}


def dumps(obj):
    return (w_vmap(obj["header"]) + w_u32(0) + w_bytes(obj["json"]) +
            w_u32(len(obj["assets"])) +
            b"".join(w_string(k) + w_bytes(v) for k, v in obj["assets"]) + w_u32(0))


def dump(obj, path):
    with open(path, "wb") as f:
        f.write(dumps(obj))


def sniff(b):
    if b is None:
        return "null"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if b[:4] == b"GIF8":
        return "gif"
    if b[4:8] == b"ftyp":
        return "mp4"
    if b[:2] == b"\xff\xd8":
        return "jpg"
    return "unknown"


def safe_rel(key):
    parts = [p for p in key.split("/") if p]
    if not parts or any(p in (".", "..") for p in parts) or "\0" in key:
        raise ValueError(f"unsafe asset key {key!r}")
    return "/".join(parts)


def jvar(v):
    x = v["value"]
    if v["type"] == T_BYTES and x is not None:
        x = {"latin1": x.decode("latin-1")}
    elif v["type"] == T_MAP:
        x = [[k, jvar(i)] for k, i in x]
    return {"type": v["type"], "type_name": TYPE_NAMES[v["type"]], "null": v["null"], "value": x}


def unjvar(j):
    x = j["value"]
    if j["type"] == T_BYTES and x is not None:
        x = x["latin1"].encode("latin-1")
    elif j["type"] == T_MAP:
        x = [(k, unjvar(i)) for k, i in x]
    return {"type": j["type"], "null": j["null"], "value": x}


def cmd_decode(a):
    log(f"[decode] reading {a.theme}")
    raw = open(a.theme, "rb").read()
    obj = load(a.theme)
    if dumps(obj) != raw:
        sys.exit("decode: in-memory re-encode differs from input; refusing")
    os.makedirs(a.outdir, exist_ok=True)
    with open(os.path.join(a.outdir, "pages.json"), "wb") as f:
        f.write(obj["json"])
    log(f"[decode] pages.json {len(obj['json'])} bytes (verbatim QByteArray payload)")
    seen, assets = {}, []
    for i, (k, b) in enumerate(obj["assets"]):
        rel = "assets/" + safe_rel(k)
        low = rel.lower()
        if low in seen:
            sys.exit(f"asset path collision (case-insensitive FS?): {k!r} vs {seen[low]!r}")
        seen[low] = k
        e = {"key": k, "file": None, "size": None, "sha256": None, "kind": sniff(b)}
        if b is not None:
            dst = os.path.join(a.outdir, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.isdir(dst):
                sys.exit(f"asset path {rel} is both file and dir")
            with open(dst, "wb") as f:
                f.write(b)
            e.update(file=rel, size=len(b), sha256=hashlib.sha256(b).hexdigest())
        assets.append(e)
        if i % 100 == 0:
            log(f"[decode] asset {i + 1}/{len(obj['assets'])} {k} ({e['kind']}, {e['size']})")
    meta = {"source_sha256": hashlib.sha256(raw).hexdigest(), "source_size": len(raw),
            "header": [[k, jvar(v)] for k, v in obj["header"]],
            "json_file": "pages.json", "assets": assets}
    with open(os.path.join(a.outdir, "theme.json"), "w") as f:
        json.dump(meta, f, indent=1, ensure_ascii=False)
    log(f"[decode] wrote theme.json: {len(assets)} assets, source sha256 {meta['source_sha256']}")


def cmd_encode(a):
    meta = json.load(open(os.path.join(a.outdir, "theme.json")))
    log(f"[encode] {a.outdir} -> {a.theme}")
    assets = []
    for e in meta["assets"]:
        b = None
        if e["file"] is not None:
            b = open(os.path.join(a.outdir, e["file"]), "rb").read()
            if hashlib.sha256(b).hexdigest() != e["sha256"]:
                log(f"[encode] note: {e['key']} differs from decoded sha256 (edited)")
        assets.append((e["key"], b))
    keys = [k for k, _ in assets]
    if keys != sorted(keys, key=lambda s: s.encode("utf-16-be")):
        log("[encode] warning: asset keys not in QMap (UTF-16) order")
    obj = {"header": [(k, unjvar(v)) for k, v in meta["header"]],
           "json": open(os.path.join(a.outdir, meta["json_file"]), "rb").read(),
           "assets": assets}
    dump(obj, a.theme)
    h = hashlib.sha256(open(a.theme, "rb").read()).hexdigest()
    log(f"[encode] wrote {a.theme} sha256 {h}" +
        (" (matches source)" if h == meta["source_sha256"] else " (differs from source)"))


def cmd_schema(a):
    obj = load(a.theme)
    print("QVariantMap header")
    for k, v in obj["header"]:
        x = v["value"]
        print(f"  {k}: {TYPE_NAMES[v['type']]} null={v['null']} "
              f"{'len=' + str(len(x)) if isinstance(x, (bytes, str)) else repr(x)}")
    print(f"u32 reserved = 0\nQByteArray json  len={len(obj['json'])}")
    j = json.loads(obj["json"])

    def walk(v, path, acc):
        if isinstance(v, dict):
            for k, x in v.items():
                walk(x, f"{path}.{k}", acc)
        elif isinstance(v, list):
            for x in v:
                walk(x, path + "[]", acc)
        else:
            c = acc.setdefault(path, {})
            c[type(v).__name__] = c.get(type(v).__name__, 0) + 1
    acc = {}
    walk(j, "", acc)
    for p, c in acc.items():
        print(f"  {p}: " + ", ".join(f"{t} x{n}" for t, n in c.items()))
    kinds = {}
    for k, b in obj["assets"]:
        s = kinds.setdefault(sniff(b), [0, 0])
        s[0] += 1
        s[1] += len(b or b"")
    print(f"QMap<QString,QByteArray> assets n={len(obj['assets'])}")
    for t, (n, sz) in kinds.items():
        print(f"  {t}: {n} blobs, {sz} bytes")
    print("u32 reserved = 0")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("decode")
    d.add_argument("theme"); d.add_argument("outdir"); d.set_defaults(f=cmd_decode)
    e = sub.add_parser("encode")
    e.add_argument("outdir"); e.add_argument("theme"); e.set_defaults(f=cmd_encode)
    s = sub.add_parser("schema")
    s.add_argument("theme"); s.set_defaults(f=cmd_schema)
    a = ap.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
