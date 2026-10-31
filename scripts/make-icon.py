from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)

S = 4
SIZE = 512
canvas = Image.new("RGBA", (SIZE * S, SIZE * S), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)


def sc(value):
    return value * S


# Deep rounded-square app tile.
draw.rounded_rectangle(
    (sc(10), sc(10), sc(SIZE - 10), sc(SIZE - 10)),
    radius=sc(8),
    fill=(9, 10, 10, 255),
    outline=(238, 240, 234, 38),
    width=sc(2),
)

# Ambient glow.
glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
glow_draw = ImageDraw.Draw(glow)
glow_draw.ellipse((sc(62), sc(70), sc(450), sc(430)), fill=(238, 240, 234, 20))
glow = glow.filter(ImageFilter.GaussianBlur(sc(52)))
canvas.alpha_composite(glow)
draw = ImageDraw.Draw(canvas)

# Fine pixel grid inside the tile.
for y in range(56, 456, 24):
    for x in range(56, 456, 24):
        shade = 255 if (x + y) // 24 % 7 == 0 else 200
        draw.rectangle((sc(x), sc(y), sc(x + 2), sc(y + 2)), fill=(238, 240, 234, 12 if shade == 200 else 20))

# Isometric grass block.
cx = SIZE / 2
top_y = 139
half_w = 146
half_h = 82
block_h = 154
top = [(cx, top_y), (cx + half_w, top_y + half_h), (cx, top_y + half_h * 2), (cx - half_w, top_y + half_h)]
left = [
    (cx - half_w, top_y + half_h),
    (cx, top_y + half_h * 2),
    (cx, top_y + half_h * 2 + block_h),
    (cx - half_w, top_y + half_h + block_h),
]
right = [
    (cx, top_y + half_h * 2),
    (cx + half_w, top_y + half_h),
    (cx + half_w, top_y + half_h + block_h),
    (cx, top_y + half_h * 2 + block_h),
]

draw.polygon([(sc(x), sc(y)) for x, y in left], fill=(126, 130, 124, 255))
draw.polygon([(sc(x), sc(y)) for x, y in right], fill=(73, 77, 72, 255))
draw.polygon([(sc(x), sc(y)) for x, y in top], fill=(232, 234, 228, 255))

# Pixel grass fringe hanging from the two upper side edges.
for i in range(9):
    x = cx - half_w + 10 + i * 16
    edge_y = top_y + half_h + ((x - (cx - half_w)) / half_w) * half_h
    height = 15 + ((i * 29) % 17)
    draw.polygon(
        [
            (sc(x), sc(edge_y)),
            (sc(x + 11), sc(edge_y + 5)),
            (sc(x + 11), sc(edge_y + 5 + height)),
            (sc(x), sc(edge_y + height)),
        ],
        fill=(161, 165, 158, 255),
    )

for i in range(9):
    x = cx + 8 + i * 16
    edge_y = top_y + half_h * 2 - ((x - cx) / half_w) * half_h
    height = 15 + ((i * 41) % 19)
    draw.polygon(
        [
            (sc(x), sc(edge_y + 3)),
            (sc(x + 10), sc(edge_y - 2)),
            (sc(x + 10), sc(edge_y - 2 + height)),
            (sc(x), sc(edge_y + 3 + height)),
        ],
        fill=(100, 104, 98, 255),
    )

# Opaque pixel specks for texture. (ImageDraw replaces RGBA pixels instead of blending them,
# so translucent decorative shapes are intentionally avoided here.)
for x, y in [(180, 275), (209, 309), (154, 341), (290, 282), (326, 314), (300, 377), (382, 303)]:
    draw.rectangle((sc(x), sc(y), sc(x + 9), sc(y + 7)), fill=(189, 192, 186, 255))

for x, y in [(242, 186), (284, 208), (224, 238), (312, 242)]:
    draw.rectangle((sc(x), sc(y), sc(x + 10), sc(y + 6)), fill=(205, 207, 201, 255))

# Soft inner rim.
draw.rounded_rectangle(
    (sc(10), sc(10), sc(SIZE - 10), sc(SIZE - 10)),
    radius=sc(8),
    outline=(238, 240, 234, 46),
    width=sc(3),
)

canvas = canvas.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
canvas.save(ASSETS / "icon.png", optimize=True)
canvas.resize((256, 256), Image.Resampling.LANCZOS).save(ASSETS / "icon-256.png", optimize=True)
print(f"wrote {ASSETS / 'icon.png'}")
