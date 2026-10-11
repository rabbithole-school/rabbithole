# shellcheck shell=bash
# Shared paths, settings, and safety checks for the kit's scripts. Sourced by
# bin/*, never run directly. Written for macOS's bash 3.2 as well as Linux.

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$KIT/rabbithole"   # the public Rabbithole snapshot, checked out by bin/setup.sh
STATE="$KIT/.kit"       # logs and process ids

CLOUD_PORT="${CLOUD_PORT:-3210}"
SITE_PORT="${SITE_PORT:-3211}"
WEB_PORT="${WEB_PORT:-3000}"

# Local only: the Convex CLI runs an anonymous local backend, with no account
# and no cloud deployment. A CONVEX_DEPLOYMENT left over in the shell would
# point the CLI somewhere else, so it never survives into the kit.
export CONVEX_AGENT_MODE=anonymous
export NEXT_TELEMETRY_DISABLED=1
unset CONVEX_DEPLOYMENT

say() { printf '%s\n' "$*"; }
die() { printf '\ndrink-me: %s\n' "$*" >&2; exit 1; }
lock() { sed -n "s/^$1=//p" "$KIT/rabbithole.lock"; }

# Someone is already listening on this local port.
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# The kit must live in a folder of its own, never inside another project.
guard_not_nested() {
  local outer
  # A home directory kept in git (dotfiles) doesn't count.
  if outer="$(cd "$KIT/.." && git rev-parse --show-toplevel 2>/dev/null)" && [ "$outer" != "$HOME" ]; then
    die "this kit is inside another git repository ($outer).
  Move it to a folder of its own first, for example:
    mv \"$KIT\" ~/rabbithole-drink-me"
  fi
}

# Never touch a cloud Convex deployment.
guard_no_cloud() {
  [ -z "${CONVEX_DEPLOY_KEY:-}" ] ||
    die "CONVEX_DEPLOY_KEY is set in this shell. This kit only runs locally; open a new shell without it."
  if [ -f "$APP/.env.local" ] && grep -q '^CONVEX_DEPLOYMENT=' "$APP/.env.local" &&
    ! grep -q '^CONVEX_DEPLOYMENT=anonymous:' "$APP/.env.local"; then
    die "$APP/.env.local points at a cloud Convex deployment. Refusing to go on."
  fi
}

pid_alive() { [ -f "$STATE/$1.pid" ] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }

# Stop only what this kit started: its own process groups, and a backend whose
# storage lives inside this kit's checkout.
stop_all() {
  local name pid
  for name in next convex; do
    if [ -f "$STATE/$name.pid" ]; then
      pid="$(cat "$STATE/$name.pid")"
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      rm -f "$STATE/$name.pid"
    fi
  done
  pkill -f "convex-local-backend.*--local-storage $APP/" 2>/dev/null || true
}

# The pretend people /dev-login offers, as JSON (empty if the school isn't seeded).
dev_users() {
  local secret
  secret="$(sed -n 's/^NEXT_PUBLIC_DEV_LOGIN_SECRET=//p' "$APP/.env.local" 2>/dev/null)"
  [ -n "$secret" ] || return 0
  (cd "$APP" && npx convex run users:listDevLoginUsers "{\"secret\":\"$secret\"}" 2>/dev/null) || true
}
