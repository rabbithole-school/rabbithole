# shellcheck shell=bash
# Shared paths, settings, and safety checks for the kit's scripts. Sourced by
# bin/*, never run directly. Written for macOS's bash 3.2 as well as Linux.

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$KIT/rabbithole"   # the public Rabbithole snapshot, checked out by bin/setup.sh
RUN="$APP/local/.run"   # the snapshot's own logs and process ids (pnpm local:setup)

CLOUD_PORT="${CLOUD_PORT:-3210}"
SITE_PORT="${SITE_PORT:-3211}"
WEB_PORT="${WEB_PORT:-3000}"

# The snapshot's pnpm local:* scripts read these ports too.
export CLOUD_PORT SITE_PORT WEB_PORT

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

pid_alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

# Run one of the snapshot's own pnpm local:* scripts, e.g.  app_run stop
app_run() { local s="$1"; shift; (cd "$APP" && pnpm --silent "local:$s" "$@"); }

# Stop only what this kit started; the snapshot's local:stop does exactly that.
# A key set before the local database is up waits here (owner-only) until
# setup hands it over.
PENDING_KEY="$KIT/.pending-key"
hand_over_key() {
  [ -f "$PENDING_KEY" ] || return 0
  (cd "$APP" && npx convex env set ANTHROPIC_API_KEY <"$PENDING_KEY" >/dev/null) || return 1
  rm -f "$PENDING_KEY"
  say "Handed your Anthropic key to Rabbithole."
}

stop_all() { [ ! -f "$APP/local/stop.sh" ] || app_run stop >/dev/null; }
