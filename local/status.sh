#!/usr/bin/env bash
# Is the local Rabbithole running, and who can you sign in as?
set -euo pipefail
. "$(dirname "$0")/lib.sh"
guard_no_cloud
up() { pid_alive "$1" && echo "running" || echo "stopped"; }
say "Local backend (ports $CLOUD_PORT/$SITE_PORT): $(up convex)"
say "Web app (port $WEB_PORT):              $(up next)"
if pid_alive convex; then
  # grep exits 1 on zero matches; with pipefail that would end the script.
  n="$(dev_users | { grep -o '"username"' || true; } | wc -l | tr -d ' ')"
  say "People you can sign in as:             $n"
  if (cd "$ROOT" && npx convex env get ANTHROPIC_API_KEY 2>/dev/null | grep -q .); then
    say "Tutor key:                             set"
  else
    say "Tutor key:                             not set (add one at http://localhost:$WEB_PORT/tutor-key)"
  fi
fi
pid_alive next && say "" && say "Open http://localhost:$WEB_PORT/dev-login"
exit 0
