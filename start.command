#!/bin/zsh
set -euo pipefail

cd "${0:A:h}"

node_candidates=(
  "$(command -v node 2>/dev/null || true)"
  /opt/homebrew/bin/node
  /usr/local/bin/node
  "$HOME/.volta/bin/node"
  "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  "$HOME"/.nvm/versions/node/*/bin/node(N)
)

node_bin=""
for candidate in "${node_candidates[@]}"; do
  [[ -x "$candidate" ]] || continue
  major_version="$($candidate -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
  if [[ "$major_version" == <-> ]] && (( major_version >= 22 )); then
    node_bin="$candidate"
    export PATH="${candidate:h}:$PATH"
    break
  fi
done

if [[ -z "$node_bin" ]]; then
  print -u2 "DSBox needs Node.js 22 or later. Install the current LTS release from https://nodejs.org and open DSBox again."
  print -u2 "Press Return to close."
  read -r
  exit 1
fi

if [[ ! -d node_modules ]]; then
  npm ci
fi

npm run build

export DSBOX_OPEN_BROWSER=1
exec npm start
