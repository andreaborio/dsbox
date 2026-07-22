#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage:
  npm run verify:upgrade-rollback:e2e -- --source
  npm run verify:upgrade-rollback:e2e -- --release
  npm run verify:upgrade-rollback:e2e -- --development

--source builds the frozen legacy checkpoint and current commit in disposable
worktrees for normal CI. --release builds only the frozen legacy checkpoint,
then tests the application mounted from the already-built final DMG and writes
an atomic, versioned report and log under release/.

--development also builds only the frozen legacy checkpoint, but accepts only
an exact-current-commit development DMG and writes explicitly non-release
evidence under release/development-evidence/. It never reads an SBOM or public
checksums and cannot authorize a release.

Environment overrides:
  DSBOX_UPGRADE_E2E_OLD_REF   Frozen legacy checkpoint
  DSBOX_UPGRADE_E2E_NEW_REF   Current checkpoint for --source only
  HEBRUS_RELEASE_DMG          Final DMG for --release
  HEBRUS_RELEASE_ATTESTATION  Signed/notarized release attestation for --release
  HEBRUS_RELEASE_SBOM         Final SBOM for --release
  HEBRUS_VERIFY_COMMIT        Expected source commit for --release
  HEBRUS_VERIFY_TAG           Expected source tag for --release
  HEBRUS_DEVELOPMENT_DMG      Already-built development DMG for --development
EOF
  exit 0
fi

mode="${1:---source}"
if [[ "$mode" != "--source" && "$mode" != "--release" && "$mode" != "--development" ]]; then
  echo "Unknown mode: $mode (use --help)" >&2
  exit 2
fi
if [[ "$#" -gt 1 ]]; then
  echo "Unexpected argument: $2 (use --help)" >&2
  exit 2
fi

repo_root="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
old_ref="${DSBOX_UPGRADE_E2E_OLD_REF:-595e9952c4fd1197de3aa3ccde66a5ddccddd397}"
old_commit="$(git -C "$repo_root" rev-parse --verify "${old_ref}^{commit}")"
build_root="$(mktemp -d "${TMPDIR:-/tmp}/hebrus-package-e2e.XXXXXX")"
old_tree="$build_root/old"
old_log="$build_root/old-build.log"
new_tree=""

cleanup() {
  git -C "$repo_root" worktree remove --force "$old_tree" >/dev/null 2>&1 || true
  if [[ -n "$new_tree" ]]; then
    git -C "$repo_root" worktree remove --force "$new_tree" >/dev/null 2>&1 || true
  fi
  rm -rf "$build_root"
}
trap cleanup EXIT INT TERM

if [[ "$mode" == "--source" ]]; then
  new_ref="${DSBOX_UPGRADE_E2E_NEW_REF:-HEAD}"
  new_commit="$(git -C "$repo_root" rev-parse --verify "${new_ref}^{commit}")"
  new_tree="$build_root/new"
  new_log="$build_root/new-build.log"
  echo "Preparing isolated package sources:"
  echo "  legacy:        $old_commit"
  echo "  Hebrus Studio: $new_commit"
  git -C "$repo_root" worktree add --detach "$old_tree" "$old_commit" >/dev/null
  git -C "$repo_root" worktree add --detach "$new_tree" "$new_commit" >/dev/null
  echo "Building both arm64 app bundles in parallel..."
  (
    cd "$old_tree"
    npm ci
    npm run pack:mac
  ) >"$old_log" 2>&1 &
  old_pid=$!
  (
    cd "$new_tree"
    npm ci
    npm run pack:mac
  ) >"$new_log" 2>&1 &
  new_pid=$!
  set +e
  wait "$old_pid"; old_status=$?
  wait "$new_pid"; new_status=$?
  set -e
  if [[ "$old_status" -ne 0 || "$new_status" -ne 0 ]]; then
    if [[ "$old_status" -ne 0 ]]; then echo "Legacy package build failed:" >&2; tail -200 "$old_log" >&2; fi
    if [[ "$new_status" -ne 0 ]]; then echo "Hebrus Studio package build failed:" >&2; tail -200 "$new_log" >&2; fi
    exit 1
  fi
  node "$repo_root/scripts/verify-upgrade-rollback-e2e.mjs" \
    --old-app "$old_tree/release/mac-arm64/DSBox.app" \
    --new-app "$new_tree/release/mac-arm64/Hebrus Studio.app"
  exit 0
fi

if [[ "$mode" == "--development" ]]; then
  version="$(node -p "require('$repo_root/package.json').version")"
  release_dir="$repo_root/release"
  evidence_dir="$release_dir/development-evidence"
  dmg="${HEBRUS_DEVELOPMENT_DMG:-$release_dir/Hebrus-Studio-${version}-macOS-arm64.dmg}"
  report="$evidence_dir/Hebrus-Studio-${version}-Development-Upgrade-Rollback-E2E.json"
  log="$evidence_dir/Hebrus-Studio-${version}-Development-Upgrade-Rollback-E2E.log"
  provenance="$repo_root/build/release-provenance.json"
  expected_commit="$(git -C "$repo_root" rev-parse HEAD)"

  [[ -f "$dmg" ]] || { echo "Final development DMG is missing: $dmg" >&2; exit 1; }
  [[ -f "$provenance" ]] || { echo "Development provenance is missing: $provenance" >&2; exit 1; }

  echo "Building frozen legacy package $old_commit for development final-DMG qualification..."
  git -C "$repo_root" worktree add --detach "$old_tree" "$old_commit" >/dev/null
  (
    cd "$old_tree"
    npm ci
    npm run pack:mac
  ) >"$old_log" 2>&1

  node "$repo_root/scripts/run-development-dmg-upgrade-rollback-e2e.mjs" \
    --old-app "$old_tree/release/mac-arm64/DSBox.app" \
    --old-commit "$old_commit" \
    --old-build-log "$old_log" \
    --dmg "$dmg" \
    --expected-commit "$expected_commit" \
    --report "$report" \
    --log "$log"

  node "$repo_root/scripts/validate-development-upgrade-rollback-report.mjs" "$report" \
    --dmg "$dmg" \
    --log "$log" \
    --provenance "$provenance" \
    --expected-commit "$expected_commit"
  exit 0
fi

version="$(node -p "require('$repo_root/package.json').version")"
release_dir="$repo_root/release"
dmg="${HEBRUS_RELEASE_DMG:-$release_dir/Hebrus-Studio-${version}-macOS-arm64.dmg}"
sbom="${HEBRUS_RELEASE_SBOM:-$release_dir/Hebrus-Studio-${version}-SBOM.cdx.json}"
attestation="${HEBRUS_RELEASE_ATTESTATION:-$release_dir/Hebrus-Studio-${version}-Release-Attestation.json}"
report="$release_dir/Hebrus-Studio-${version}-Upgrade-Rollback-E2E.json"
log="$release_dir/Hebrus-Studio-${version}-Upgrade-Rollback-E2E.log"
provenance="$repo_root/build/release-provenance.json"
expected_commit="${HEBRUS_VERIFY_COMMIT:-$(git -C "$repo_root" rev-parse HEAD)}"
expected_tag="${HEBRUS_VERIFY_TAG:-v${version}}"

[[ -f "$dmg" ]] || { echo "Final release DMG is missing: $dmg" >&2; exit 1; }
[[ -f "$sbom" ]] || { echo "Final release SBOM is missing: $sbom" >&2; exit 1; }
[[ -f "$attestation" ]] || { echo "Final release attestation is missing: $attestation" >&2; exit 1; }
[[ -f "$provenance" ]] || { echo "Release provenance is missing: $provenance" >&2; exit 1; }

echo "Building frozen legacy package $old_commit for final-DMG qualification..."
git -C "$repo_root" worktree add --detach "$old_tree" "$old_commit" >/dev/null
(
  cd "$old_tree"
  npm ci
  npm run pack:mac
) >"$old_log" 2>&1

node "$repo_root/scripts/run-final-dmg-upgrade-rollback-e2e.mjs" \
  --old-app "$old_tree/release/mac-arm64/DSBox.app" \
  --old-commit "$old_commit" \
  --old-build-log "$old_log" \
  --dmg "$dmg" \
  --attestation "$attestation" \
  --sbom "$sbom" \
  --expected-commit "$expected_commit" \
  --expected-tag "$expected_tag" \
  --report "$report" \
  --log "$log"

node "$repo_root/scripts/validate-upgrade-rollback-report.mjs" "$report" \
  --dmg "$dmg" \
  --attestation "$attestation" \
  --sbom "$sbom" \
  --log "$log" \
  --provenance "$provenance" \
  --expected-commit "$expected_commit" \
  --expected-tag "$expected_tag"
