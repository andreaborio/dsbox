#!/usr/bin/env bash

set -euo pipefail

PROVENANCE_MODE="release"
if [[ "${1:-}" == "--development" ]]; then
  PROVENANCE_MODE="development"
  shift
fi

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
CONTRACT="$ROOT_DIR/scripts/macos-package-contract.json"
PRODUCT_NAME=$(node -p "require('$CONTRACT').productName")
BUNDLE_IDENTIFIER=$(node -p "require('$CONTRACT').bundleIdentifier")
EXPECTED_EXECUTABLE=$(node -p "require('$CONTRACT').executableName")
EXPECTED_ICON=$(node -p "require('$CONTRACT').iconFile")
CANONICAL_ICON="$ROOT_DIR/$(node -p "require('$CONTRACT').brandMark.appIcon")"
EXPECTED_ARCHITECTURE=$(node -p "require('$CONTRACT').architecture")
ARTIFACT_BASE_NAME=$(node -p "require('$CONTRACT').artifactBaseName")
EXPECTED_DMG_NAME="${ARTIFACT_BASE_NAME}-${VERSION}-macOS-${EXPECTED_ARCHITECTURE}.dmg"
ARTIFACT=${1:-"$ROOT_DIR/release/${ARTIFACT_BASE_NAME}-${VERSION}-macOS-${EXPECTED_ARCHITECTURE}.dmg"}
MOUNT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dsbox-release.XXXXXX")
APP_PATH=""
APP_PROCESS=""
ATTACHED=0
LAUNCH_ROOT=""

cleanup() {
  if [[ -n "$APP_PROCESS" ]] && kill -0 "$APP_PROCESS" 2>/dev/null; then
    kill "$APP_PROCESS" 2>/dev/null || true
    wait "$APP_PROCESS" 2>/dev/null || true
  fi
  if [[ "$ATTACHED" -eq 1 ]]; then
    hdiutil detach "$MOUNT_DIR" -quiet || true
  fi
  if [[ -n "$LAUNCH_ROOT" && -d "$LAUNCH_ROOT" ]]; then
    rm -r "$LAUNCH_ROOT"
  fi
  rmdir "$MOUNT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

if [[ ! -e "$ARTIFACT" ]]; then
  echo "Package not found: $ARTIFACT" >&2
  exit 1
fi
if [[ "$PROVENANCE_MODE" == "development" && "${DSBOX_VERIFY_CHECKSUMS:-0}" == "1" ]]; then
  echo "Development package verification cannot authorize release checksums." >&2
  exit 1
fi

case "$ARTIFACT" in
  *.dmg)
    [[ "$(basename "$ARTIFACT")" == "$EXPECTED_DMG_NAME" ]] || {
      echo "Unexpected disk image filename: $(basename "$ARTIFACT")" >&2
      exit 1
    }
    if [[ "${DSBOX_VERIFY_CHECKSUMS:-0}" == "1" ]]; then
      CHECKSUM_FILE="$(dirname "$ARTIFACT")/SHA256SUMS.txt"
      [[ -f "$CHECKSUM_FILE" ]] || {
        echo "Checksum file is missing: $CHECKSUM_FILE" >&2
        exit 1
      }
      node "$ROOT_DIR/scripts/validate-release-checksums.mjs" "$(dirname "$ARTIFACT")"
    fi
    echo "Verifying disk image structure..."
    hdiutil verify "$ARTIFACT" >/dev/null
    if [[ "$PROVENANCE_MODE" == "release" ]]; then
      codesign --verify --verbose=2 "$ARTIFACT"
      DMG_SIGNATURE_DETAILS=$(codesign -dv --verbose=4 "$ARTIFACT" 2>&1)
      grep -q "^Authority=Developer ID Application:" <<<"$DMG_SIGNATURE_DETAILS" || {
        echo "Release DMG is not signed with a Developer ID Application certificate." >&2
        exit 1
      }
      grep -Eq "^TeamIdentifier=[A-Z0-9]{10}$" <<<"$DMG_SIGNATURE_DETAILS" || {
        echo "Release DMG has no valid Apple signing team identifier." >&2
        exit 1
      }
      xcrun stapler validate "$ARTIFACT"
    fi
    hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_DIR" "$ARTIFACT" >/dev/null
    ATTACHED=1
    APP_PATH="$MOUNT_DIR/${PRODUCT_NAME}.app"
    ;;
  *.app)
    if [[ "$PROVENANCE_MODE" == "release" ]]; then
      echo "Release verification requires the final notarized and stapled DMG, not a loose app bundle." >&2
      exit 1
    fi
    APP_PATH=${ARTIFACT%/}
    ;;
  *)
    echo "Expected a .app bundle or .dmg disk image: $ARTIFACT" >&2
    exit 1
    ;;
esac

if [[ ! -d "$APP_PATH" ]]; then
  echo "${PRODUCT_NAME}.app is missing: $APP_PATH" >&2
  exit 1
fi

INFO_PLIST="$APP_PATH/Contents/Info.plist"
if [[ ! -f "$INFO_PLIST" ]]; then
  echo "Info.plist is missing from $APP_PATH." >&2
  exit 1
fi

BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$INFO_PLIST")
DISPLAY_NAME=$(/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "$INFO_PLIST")
BUNDLE_NAME=$(/usr/libexec/PlistBuddy -c "Print :CFBundleName" "$INFO_PLIST")
BUNDLE_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$INFO_PLIST")
SHORT_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INFO_PLIST")
EXECUTABLE_NAME=$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$INFO_PLIST")
ICON_NAME=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIconFile" "$INFO_PLIST")
EXECUTABLE="$APP_PATH/Contents/MacOS/$EXECUTABLE_NAME"

[[ "$(basename "$APP_PATH")" == "${PRODUCT_NAME}.app" ]] || {
  echo "Unexpected application bundle name: $(basename "$APP_PATH")" >&2
  exit 1
}
[[ "$DISPLAY_NAME" == "$PRODUCT_NAME" && "$BUNDLE_NAME" == "$PRODUCT_NAME" ]] || {
  echo "Unexpected product name: display=$DISPLAY_NAME bundle=$BUNDLE_NAME" >&2
  exit 1
}
[[ "$BUNDLE_ID" == "$BUNDLE_IDENTIFIER" ]] || {
  echo "Unexpected bundle identifier: $BUNDLE_ID" >&2
  exit 1
}
[[ "$SHORT_VERSION" == "$VERSION" && "$BUNDLE_VERSION" == "$VERSION" ]] || {
  echo "Bundle versions short=$SHORT_VERSION build=$BUNDLE_VERSION do not match package version $VERSION." >&2
  exit 1
}
[[ "$EXECUTABLE_NAME" == "$EXPECTED_EXECUTABLE" ]] || {
  echo "Unexpected executable name: $EXECUTABLE_NAME" >&2
  exit 1
}
[[ "$ICON_NAME" == "$EXPECTED_ICON" && -f "$APP_PATH/Contents/Resources/$EXPECTED_ICON" ]] || {
  echo "Unexpected or missing application icon: plist=$ICON_NAME expected=$EXPECTED_ICON" >&2
  exit 1
}
[[ -f "$CANONICAL_ICON" ]] || {
  echo "Canonical application icon is missing: $CANONICAL_ICON" >&2
  exit 1
}
cmp -s "$CANONICAL_ICON" "$APP_PATH/Contents/Resources/$EXPECTED_ICON" || {
  echo "Packaged application icon differs from the current Hebrus Studio app icon." >&2
  exit 1
}
[[ -x "$EXECUTABLE" ]] || {
  echo "The declared executable is missing or not executable: $EXECUTABLE" >&2
  exit 1
}

while IFS= read -r REQUIRED_NOTICE; do
  [[ -n "$REQUIRED_NOTICE" ]] || continue
  [[ -f "$APP_PATH/Contents/Resources/$REQUIRED_NOTICE" ]] || {
    echo "Required legal notice is missing: $REQUIRED_NOTICE" >&2
    exit 1
  }
done < <(node -p "require('$CONTRACT').requiredLegalNotices.join('\n')")

PROVENANCE_FILE=$(node -p "require('$CONTRACT').provenance.embeddedFile")
PROVENANCE_PATH="$APP_PATH/Contents/Resources/$PROVENANCE_FILE"
[[ -f "$PROVENANCE_PATH" ]] || {
  echo "Release provenance is missing from the packaged application: $PROVENANCE_FILE" >&2
  exit 1
}
EXPECTED_COMMIT="${HEBRUS_VERIFY_COMMIT:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
EXPECTED_TAG="${HEBRUS_VERIFY_TAG:-v${VERSION}}"
(
cd "$ROOT_DIR"
node --input-type=module - "$PROVENANCE_PATH" "$CONTRACT" "$ROOT_DIR/package.json" "$EXPECTED_COMMIT" "$EXPECTED_TAG" "$PROVENANCE_MODE" <<'NODE'
import { readFile } from "node:fs/promises";
import { validateReleaseProvenance } from "./scripts/release-artifact-utils.mjs";

const [, , provenancePath, contractPath, packagePath, expectedCommit, expectedTag, mode] = process.argv;
const [provenance, contract, packageJson] = await Promise.all(
  [provenancePath, contractPath, packagePath].map(async (filePath) => JSON.parse(await readFile(filePath, "utf8")))
);
if (mode === "release") {
  validateReleaseProvenance(provenance, { packageJson, contract, expectedCommit, expectedTag });
} else {
  const valid = provenance?.schemaVersion === 1
    && provenance?.subject?.name === contract.productName
    && provenance?.subject?.packageName === packageJson.name
    && provenance?.subject?.version === packageJson.version
    && provenance?.subject?.architecture === contract.architecture
    && provenance?.source?.commit === expectedCommit
    && provenance?.source?.tag === null
    && provenance?.source?.treeState === "development"
    && provenance?.build?.provider === "local-development"
    && provenance?.build?.workflow === "local-development";
  if (!valid) throw new Error("Invalid local-development package provenance");
}
NODE
)

ARCHITECTURES=$(lipo -archs "$EXECUTABLE")
[[ "$ARCHITECTURES" == "$EXPECTED_ARCHITECTURE" ]] || {
  echo "Unexpected app architecture: $ARCHITECTURES" >&2
  exit 1
}

ASAR_PATH="$APP_PATH/Contents/Resources/app.asar"
if [[ ! -f "$ASAR_PATH" ]]; then
  echo "The packaged application payload is not an ASAR archive." >&2
  exit 1
fi
ASAR_INTEGRITY=$(/usr/libexec/PlistBuddy -c "Print :ElectronAsarIntegrity:Resources/app.asar:hash" "$INFO_PLIST")

node - "$ASAR_PATH" "$CONTRACT" "$VERSION" "$ASAR_INTEGRITY" <<'NODE'
const { createHash } = require("node:crypto");
const path = require("node:path");
const asar = require("@electron/asar");

const [, , archivePath, contractPath, expectedVersion, expectedIntegrity] = process.argv;
const contract = require(contractPath);
const packaged = JSON.parse(asar.extractFile(archivePath, "package.json").toString("utf8"));

if (packaged.name !== contract.packageName || packaged.version !== expectedVersion) {
  throw new Error(`Unexpected packaged metadata: ${packaged.name}@${packaged.version}`);
}

const archiveEntries = asar.listPackage(archivePath);
const embeddedEngine = archiveEntries.find((entry) =>
  contract.forbiddenEmbeddedEngineExecutables.includes(path.posix.basename(entry))
);
if (embeddedEngine) throw new Error(`Engine executable embedded in app.asar: ${embeddedEngine}`);

const { headerString } = asar.getRawHeader(archivePath);
const actualIntegrity = createHash("sha256").update(headerString).digest("hex");
if (actualIntegrity !== expectedIntegrity) {
  throw new Error(`ASAR integrity mismatch: plist=${expectedIntegrity} archive=${actualIntegrity}`);
}
NODE

PHYSICAL_ENGINE=$(find "$APP_PATH/Contents" -type f -print | awk -F/ '
  $NF ~ /^(hebrus|hebrus-server|hebrus-agent|hebrus-bench|hebrus-eval|ds4|ds4-server|ds4-agent|ds4-bench|ds4-eval)([.]exe)?$/ { print; exit }
')
if [[ -n "$PHYSICAL_ENGINE" ]]; then
  echo "Engine executable embedded outside app.asar: $PHYSICAL_ENGINE" >&2
  exit 1
fi

echo "Verifying the sealed ${PROVENANCE_MODE} bundle..."
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
SIGNATURE_DETAILS=$(codesign -dv --verbose=4 "$APP_PATH" 2>&1)
if [[ "$PROVENANCE_MODE" == "development" ]]; then
  grep -q "^Signature=adhoc$" <<<"$SIGNATURE_DETAILS" || {
    echo "Development package must use an ad-hoc signature." >&2
    exit 1
  }
  grep -q "^TeamIdentifier=not set$" <<<"$SIGNATURE_DETAILS" || {
    echo "Development package unexpectedly has a signing team." >&2
    exit 1
  }
else
  grep -q "^Authority=Developer ID Application:" <<<"$SIGNATURE_DETAILS" || {
    echo "Release package is not signed with a Developer ID Application certificate." >&2
    exit 1
  }
  grep -Eq "^TeamIdentifier=[A-Z0-9]{10}$" <<<"$SIGNATURE_DETAILS" || {
    echo "Release package has no valid Apple signing team identifier." >&2
    exit 1
  }
  grep -q "^Runtime Version=" <<<"$SIGNATURE_DETAILS" || {
    echo "Release package does not enable the hardened runtime." >&2
    exit 1
  }
  spctl --assess --type execute --verbose=4 "$APP_PATH"
fi

if [[ "${DSBOX_VERIFY_LAUNCH:-0}" == "1" ]]; then
  PORT=${DSBOX_VERIFY_PORT:-4343}
  if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
    echo "DSBOX_VERIFY_PORT must be an unprivileged TCP port." >&2
    exit 1
  fi
  LAUNCH_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/dsbox-release-launch.XXXXXX")
  LOG_FILE="$LAUNCH_ROOT/launch.log"
  DSBOX_HOME="$LAUNCH_ROOT/state" DSBOX_PORT="$PORT" \
    "$EXECUTABLE" --user-data-dir="$LAUNCH_ROOT/electron" >"$LOG_FILE" 2>&1 &
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
    exit 1
  fi
fi

if [[ "$PROVENANCE_MODE" == "development" ]]; then
  echo "Verified local-development ${PRODUCT_NAME} ${VERSION}: ${BUNDLE_ID}, ${ARCHITECTURES}, ${EXECUTABLE_NAME}, ${ICON_NAME}, development provenance, legal notices, external engine, ad-hoc signed."
  echo "Developer ID signing and notarization are intentionally not asserted for this non-release build."
else
  echo "Verified release ${PRODUCT_NAME} ${VERSION}: ${BUNDLE_ID}, ${ARCHITECTURES}, ${EXECUTABLE_NAME}, ${ICON_NAME}, exact-commit provenance, legal notices, external engine, Developer ID, hardened runtime, Gatekeeper, and stapled DMG."
fi
