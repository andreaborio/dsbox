#!/bin/zsh
set -euo pipefail

cd "${0:A:h}"

if [[ ! -d node_modules ]]; then
  npm ci
fi

npm run build

export DSBOX_OPEN_BROWSER=1
exec npm start
