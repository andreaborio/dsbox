#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage: npm run verify:upgrade-rollback:e2e

Builds the frozen DSBox compatibility checkpoint and the current commit in
disposable worktrees, then runs the packaged upgrade/rollback E2E.

Environment overrides:
  DSBOX_UPGRADE_E2E_OLD_REF   Old committed DSBox checkpoint
  DSBOX_UPGRADE_E2E_NEW_REF   New committed Hebrus Studio checkpoint
EOF
  exit 0
fi
if [[ "$#" -ne 0 ]]; then
  echo "Unknown argument: $1 (use --help)" >&2
  exit 2
fi

repo_root="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
old_ref="${DSBOX_UPGRADE_E2E_OLD_REF:-595e9952c4fd1197de3aa3ccde66a5ddccddd397}"
new_ref="${DSBOX_UPGRADE_E2E_NEW_REF:-HEAD}"
build_root="$(mktemp -d "${TMPDIR:-/tmp}/hebrus-package-e2e.XXXXXX")"
old_tree="$build_root/old"
new_tree="$build_root/new"
old_log="$build_root/old-build.log"
new_log="$build_root/new-build.log"

cleanup() {
  git -C "$repo_root" worktree remove --force "$old_tree" >/dev/null 2>&1 || true
  git -C "$repo_root" worktree remove --force "$new_tree" >/dev/null 2>&1 || true
  rm -rf "$build_root"
}
trap cleanup EXIT INT TERM

old_commit="$(git -C "$repo_root" rev-parse --verify "${old_ref}^{commit}")"
new_commit="$(git -C "$repo_root" rev-parse --verify "${new_ref}^{commit}")"

echo "Preparing isolated package sources:"
echo "  DSBox:        $old_commit"
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
wait "$old_pid"
old_status=$?
wait "$new_pid"
new_status=$?
set -e
if [[ "$old_status" -ne 0 || "$new_status" -ne 0 ]]; then
  if [[ "$old_status" -ne 0 ]]; then
    echo "DSBox package build failed:" >&2
    tail -200 "$old_log" >&2
  fi
  if [[ "$new_status" -ne 0 ]]; then
    echo "Hebrus Studio package build failed:" >&2
    tail -200 "$new_log" >&2
  fi
  exit 1
fi

node "$repo_root/scripts/verify-upgrade-rollback-e2e.mjs" \
  --old-app "$old_tree/release/mac-arm64/DSBox.app" \
  --new-app "$new_tree/release/mac-arm64/Hebrus Studio.app"
