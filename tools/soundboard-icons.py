# 128x128 key faces for the soundboard: speaker (top half, title goes at the bottom), next, home.
import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
S = 4  # supersample for smooth edges
def canvas(bg):
    im = Image.new('RGB', (128 * S, 128 * S), bg)
    return im, ImageDraw.Draw(im)
def save(im, name):
    im.resize((128, 128), Image.LANCZOS).save(f'{out}/{name}.png')
def P(pts): return [(x * S, y * S) for x, y in pts]
W = (255, 255, 255)

# speaker: purple tile, speaker + 2 waves in the upper part
im, d = canvas((88, 40, 160))
d.polygon(P([(34, 30), (48, 30), (66, 14), (66, 74), (48, 58), (34, 58)]), fill=W)
for r in (14, 26):
    d.arc([(74 - r) * S, (44 - r) * S, (74 + r) * S, (44 + r) * S], -50, 50, fill=W, width=6 * S)
save(im, 'speaker')

# next: green tile, right arrow
im, d = canvas((24, 120, 72))
d.rectangle(P([(28, 54), (72, 74)]), fill=W)
d.polygon(P([(68, 34), (102, 64), (68, 94)]), fill=W)
save(im, 'next')

# home: blue tile, house
im, d = canvas((32, 80, 160))
d.polygon(P([(64, 26), (104, 62), (92, 62), (92, 100), (36, 100), (36, 62), (24, 62)]), fill=W)
d.rectangle(P([(56, 76), (72, 100)]), fill=(32, 80, 160))
save(im, 'home')
print('icons:', out)
