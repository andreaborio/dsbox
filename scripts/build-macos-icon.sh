#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUTPUT="$ROOT_DIR/build/icon.icns"

ICON_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/hebrus-icon.XXXXXX")
ICONSET="$ICON_ROOT/Hebrus.iconset"

cleanup() {
  rm -r "$ICON_ROOT"
}
trap cleanup EXIT

mkdir "$ICONSET"
python3 - "$ICONSET" <<'PY'
import os
import struct
import sys
import zlib

iconset = sys.argv[1]
sizes = [
    (16, "icon_16x16.png"),
    (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"),
    (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"),
    (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"),
    (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"),
    (1024, "icon_512x512@2x.png"),
]

def chunk(kind, payload):
    data = kind + payload
    return struct.pack(">I", len(payload)) + data + struct.pack(">I", zlib.crc32(data) & 0xFFFFFFFF)

def png_bytes(width, height, rgba):
    rows = []
    stride = width * 4
    for y in range(height):
        rows.append(b"\x00" + rgba[y * stride:(y + 1) * stride])
    return b"".join([
        b"\x89PNG\r\n\x1a\n",
        chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)),
        chunk(b"IDAT", zlib.compress(b"".join(rows), 9)),
        chunk(b"IEND", b""),
    ])

def mix(a, b, t):
    return tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3))

def in_rect(x, y, left, top, right, bottom):
    return left <= x <= right and top <= y <= bottom

def in_round_rect(x, y, radius):
    if radius <= x <= 1 - radius:
        return True
    if radius <= y <= 1 - radius:
        return True
    cx = radius if x < radius else 1 - radius
    cy = radius if y < radius else 1 - radius
    return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= radius * radius

def glyph_alpha(x, y, offset=0):
    x -= offset
    y -= offset
    if in_rect(x, y, 0.305, 0.268, 0.398, 0.735):
        return 1
    if in_rect(x, y, 0.602, 0.268, 0.695, 0.735):
        return 1
    if in_rect(x, y, 0.375, 0.462, 0.625, 0.555):
        return 1
    return 0

def blend(base, overlay, alpha):
    return tuple(round(base[i] * (1 - alpha) + overlay[i] * alpha) for i in range(3))

def render(size):
    pixels = bytearray()
    light = (255, 255, 255)
    blue = (21, 87, 255)
    deep = (12, 48, 158)
    for py in range(size):
        y = (py + 0.5) / size
        for px in range(size):
            x = (px + 0.5) / size
            if not in_round_rect(x, y, 0.205):
                pixels.extend((0, 0, 0, 0))
                continue
            t = max(0, min(1, (x + y) / 2))
            color = mix(blue, deep, t * 0.72)
            if glyph_alpha(x, y, 0.018):
                color = blend(color, (3, 10, 32), 0.22)
            if glyph_alpha(x, y, 0):
                color = blend(color, light, 0.94)
            pixels.extend((*color, 255))
    return bytes(pixels)

for size, filename in sizes:
    with open(os.path.join(iconset, filename), "wb") as handle:
        handle.write(png_bytes(size, size, render(size)))
PY

mkdir -p "$(dirname "$OUTPUT")"
iconutil -c icns "$ICONSET" -o "$OUTPUT"
echo "Built $OUTPUT from the temporary Hebrus Studio H mark."
