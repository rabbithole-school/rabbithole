#!/usr/bin/env bash
# Is Rabbithole running, and who can you sign in as?
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
guard_no_cloud
up() { pid_alive "$1" && echo "running" || echo "stopped"; }
say "Local backend (ports $CLOUD_PORT/$SITE_PORT): $(up convex)"
say "Web app (port $WEB_PORT):              $(up next)"
if pid_alive convex; then
  users="$(dev_users)"
  n="$(printf '%s' "$users" | grep -o '"username"' | wc -l | tr -d ' ')"
  say "Pretend people you can sign in as:     $n"
  key="$(cd "$APP" && npx convex env get ANTHROPIC_API_KEY 2>/dev/null || true)"
  if [ -n "$key" ]; then
    say "Tutor key:                             set"
  else
    say "Tutor key:                             not set (bin/set-key.sh)"
  fi
  unset key
fi
pid_alive next && say "" && say "Open http://localhost:$WEB_PORT/dev-login"
exit 0
