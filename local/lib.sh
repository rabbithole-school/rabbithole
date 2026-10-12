# shellcheck shell=bash
# Shared paths, settings, and safety checks for the local runner. Sourced by
# local/*.sh, never run directly. Written for macOS's bash 3.2 as well as Linux:
# no GNU-only flags (sed -i, setsid, readlink -f) and no bash 4 features.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$ROOT/local/.run" # logs and process ids

CLOUD_PORT="${CLOUD_PORT:-3210}"
SITE_PORT="${SITE_PORT:-3211}"
WEB_PORT="${WEB_PORT:-3000}"

# Local only: the Convex CLI runs an anonymous local backend, with no account
# and no cloud deployment. A CONVEX_DEPLOYMENT left over in the shell would
# point the CLI somewhere else, so it never survives into the runner.
export CONVEX_AGENT_MODE=anonymous
export NEXT_TELEMETRY_DISABLED=1
unset CONVEX_DEPLOYMENT

say() { printf '%s\n' "$*"; }
die() { printf '\nlocal: %s\n' "$*" >&2; exit 1; }

# Someone is already listening on this local port.
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# Never touch a cloud Convex deployment.
guard_no_cloud() {
  [ -z "${CONVEX_DEPLOY_KEY:-}" ] ||
    die "CONVEX_DEPLOY_KEY is set in this shell. The local runner never deploys; open a new shell without it."
  if [ -f "$ROOT/.env.local" ] && grep -q '^CONVEX_DEPLOYMENT=' "$ROOT/.env.local" &&
    ! grep -q '^CONVEX_DEPLOYMENT=anonymous:' "$ROOT/.env.local"; then
    die "$ROOT/.env.local points at a cloud Convex deployment. Refusing to go on."
  fi
}

pid_alive() { [ -f "$STATE/$1.pid" ] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }

# After stopping, a port can stay busy for a few seconds. Wait up to 15s.
wait_port_free() {
  local i
  for i in $(seq 1 15); do port_busy "$1" || return 0; sleep 1; done
  return 1
}

# Stop only what this runner started: its own process groups, and a backend
# whose storage lives inside this checkout.
stop_all() {
  local name pid
  for name in next convex; do
    if [ -f "$STATE/$name.pid" ]; then
      pid="$(cat "$STATE/$name.pid")"
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      rm -f "$STATE/$name.pid"
    fi
  done
  pkill -f "convex-local-backend.*--local-storage $ROOT/" 2>/dev/null || true
}

# The seeded people /dev-login offers, as JSON (empty if nothing is seeded).
dev_users() {
  local secret
  secret="$(sed -n 's/^NEXT_PUBLIC_DEV_LOGIN_SECRET=//p' "$ROOT/.env.local" 2>/dev/null)"
  [ -n "$secret" ] || return 0
  (cd "$ROOT" && npx convex run users:listDevLoginUsers "{\"secret\":\"$secret\"}" 2>/dev/null) || true
}
