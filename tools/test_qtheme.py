#!/usr/bin/env python3
"""Round-trip check: decode -> encode must be byte-identical on the real theme.

    python3 tools/test_qtheme.py [path/to/defaultTheme.Theme]
"""
import hashlib
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import qtheme  # noqa: E402

SRC = sys.argv[1] if len(sys.argv) > 1 else \
    "/Applications/ScreenKeyMacOS.app/Contents/MacOS/theme/MK10/defaultTheme.Theme"
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()

# in-memory
assert qtheme.dumps(qtheme.load(SRC)) == open(SRC, "rb").read(), "memory round trip differs"
# via CLI + on-disk tree
with tempfile.TemporaryDirectory() as t:
    out, back = os.path.join(t, "out"), os.path.join(t, "back.Theme")
    cli = [sys.executable, os.path.join(HERE, "qtheme.py")]
    subprocess.run(cli + ["decode", SRC, out], check=True)
    subprocess.run(cli + ["encode", out, back], check=True)
    assert sha(SRC) == sha(back), f"sha256 differs: {sha(SRC)} vs {sha(back)}"
print("OK byte-identical", sha(SRC))
