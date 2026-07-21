#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE="$ROOT_DIR/src/assets/hebrus-logo.png"
OUTPUT="$ROOT_DIR/build/icon.icns"
EXPECTED_SHA256="4be8949c73bd52e7abef58396dcd57f636165a8bb6cd6d536a600bcbf880594c"
ACTUAL_SHA256=$(shasum -a 256 "$SOURCE" | awk '{print $1}')

if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  echo "Refusing to build an icon from a modified Hebrus logo: $ACTUAL_SHA256" >&2
  exit 1
fi

ICON_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/hebrus-icon.XXXXXX")
ICONSET="$ICON_ROOT/Hebrus.iconset"

cleanup() {
  rm -r "$ICON_ROOT"
}
trap cleanup EXIT

mkdir "$ICONSET"
while read -r size filename; do
  sips -z "$size" "$size" "$SOURCE" --out "$ICONSET/$filename" >/dev/null
done <<'SIZES'
16 icon_16x16.png
32 icon_16x16@2x.png
32 icon_32x32.png
64 icon_32x32@2x.png
128 icon_128x128.png
256 icon_128x128@2x.png
256 icon_256x256.png
512 icon_256x256@2x.png
512 icon_512x512.png
1024 icon_512x512@2x.png
SIZES

mkdir -p "$(dirname "$OUTPUT")"
iconutil -c icns "$ICONSET" -o "$OUTPUT"
echo "Built $OUTPUT from the unchanged Hebrus logo ($ACTUAL_SHA256)."
