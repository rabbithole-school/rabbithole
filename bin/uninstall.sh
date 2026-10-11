#!/usr/bin/env bash
# Remove everything the kit created: the Rabbithole checkout, its local
# database and uploads, logs, and installed packages. Then you can delete this
# folder. Pass --all to also remove the downloaded Convex backend (it's shared
# with any other Convex project on this computer, which would download it again).
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
stop_all
rm -rf "$APP" "$STATE"
say "Removed $APP (the app, its local database, and its packages) and $STATE."
if [ "${1:-}" = "--all" ]; then
  for d in "$HOME/.cache/convex/binaries" "$HOME/Library/Caches/convex/binaries"; do
    [ -d "$d" ] && rm -rf "$d" && say "Removed $d"
  done
fi
say "To finish, delete this folder: rm -rf \"$KIT\""
