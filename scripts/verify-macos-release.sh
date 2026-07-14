#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
DMG=${1:-"$ROOT_DIR/release/DSBox-${VERSION}-macOS-arm64.dmg"}
MOUNT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dsbox-release.XXXXXX")
APP_PATH="$MOUNT_DIR/DSBox.app"
APP_PROCESS=""
ATTACHED=0

cleanup() {
  if [[ -n "$APP_PROCESS" ]] && kill -0 "$APP_PROCESS" 2>/dev/null; then
    kill "$APP_PROCESS" 2>/dev/null || true
    wait "$APP_PROCESS" 2>/dev/null || true
  fi
  if [[ "$ATTACHED" -eq 1 ]]; then
    hdiutil detach "$MOUNT_DIR" -quiet || true
  fi
  rmdir "$MOUNT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

if [[ ! -f "$DMG" ]]; then
  echo "DMG not found: $DMG" >&2
  exit 1
fi

echo "Verifying disk image checksum..."
hdiutil verify "$DMG" >/dev/null
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_DIR" "$DMG" >/dev/null
ATTACHED=1

if [[ ! -d "$APP_PATH" ]]; then
  echo "DSBox.app is missing from the disk image." >&2
  exit 1
fi

INFO_PLIST="$APP_PATH/Contents/Info.plist"
EXECUTABLE="$APP_PATH/Contents/MacOS/DSBox"
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$INFO_PLIST")
BUNDLE_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INFO_PLIST")
ARCHITECTURES=$(lipo -archs "$EXECUTABLE")

[[ "$BUNDLE_ID" == "com.dsbox.desktop" ]] || {
  echo "Unexpected bundle identifier: $BUNDLE_ID" >&2
  exit 1
}
[[ "$BUNDLE_VERSION" == "$VERSION" ]] || {
  echo "Bundle version $BUNDLE_VERSION does not match package version $VERSION." >&2
  exit 1
}
[[ " $ARCHITECTURES " == *" arm64 "* ]] || {
  echo "The app executable is not arm64: $ARCHITECTURES" >&2
  exit 1
}

echo "Verifying the sealed ad-hoc bundle..."
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
SIGNATURE_DETAILS=$(codesign -dv --verbose=4 "$APP_PATH" 2>&1)
grep -q "^Signature=adhoc$" <<<"$SIGNATURE_DETAILS" || {
  echo "Expected an ad-hoc signature." >&2
  exit 1
}
grep -q "^TeamIdentifier=not set$" <<<"$SIGNATURE_DETAILS" || {
  echo "Unexpected signing team in the community build." >&2
  exit 1
}

if [[ "${DSBOX_VERIFY_LAUNCH:-0}" == "1" ]]; then
  PORT=${DSBOX_VERIFY_PORT:-4343}
  LOG_FILE=$(mktemp "${TMPDIR:-/tmp}/dsbox-release-launch.XXXXXX.log")
  DSBOX_PORT="$PORT" "$EXECUTABLE" >"$LOG_FILE" 2>&1 &
  APP_PROCESS=$!

  READY=0
  for _ in {1..30}; do
    if curl --silent --show-error --fail "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      READY=1
      break
    fi
    if ! kill -0 "$APP_PROCESS" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  if [[ "$READY" -ne 1 ]]; then
    echo "The packaged app did not expose a healthy control plane." >&2
    sed -n '1,160p' "$LOG_FILE" >&2
    rm -f "$LOG_FILE"
    exit 1
  fi
  rm -f "$LOG_FILE"
fi

echo "Verified DSBox ${VERSION}: ${BUNDLE_ID}, ${ARCHITECTURES}, ad-hoc signed."
