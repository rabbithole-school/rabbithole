#!/usr/bin/env bash
# Remove everything the kit created: the Rabbithole checkout, its local
# database and uploads, logs, and installed packages. Then you can delete this
# folder. Pass --all to also remove the downloaded Convex backend (it's shared
# with any other Convex project on this computer, which would download it again).
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
stop_all
rm -rf "$APP" "$KIT/.kit" "$KIT/.pending-key" # .kit/ held logs for kits older than October 2026
say "Removed $APP (the app, its local database, its packages, and its logs)."
if [ "${1:-}" = "--all" ]; then
  for d in "$HOME/.cache/convex/binaries" "$HOME/Library/Caches/convex/binaries"; do
    [ -d "$d" ] && rm -rf "$d" && say "Removed $d"
  done
fi
say "To finish, delete this folder: rm -rf \"$KIT\""
say "Shared caches stay: pnpm's package store (pnpm store prune trims it) and, unless you passed --all, the Convex backend download."
