#!/usr/bin/env bash
# Set up Rabbithole on this computer from the pinned public snapshot: check out
# exactly the commit in rabbithole.lock, then hand over to the snapshot's own
# `pnpm local:setup`, which installs packages, starts a local Convex backend
# (no account, no cloud), adds sign-in keys, seeds a fictional school, and
# starts the web app in the background. Safe to run again: it reuses what's
# there and picks up where it stopped.
#
#   bin/setup.sh             set up and start; returns once Rabbithole is ready
#   bin/setup.sh --no-serve  set up, then stop the backend (used by CI)
#
# Ports: CLOUD_PORT=3210 SITE_PORT=3211 WEB_PORT=3000 (override any of them).
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"

guard_not_nested
guard_no_cloud

ready() {
  cat <<EOF

  Rabbithole is running on this computer, with a pretend school.

  Pick a pretend person:  http://localhost:$WEB_PORT/dev-login
  A teacher's view:       http://localhost:$WEB_PORT/dev-login?u=kawena&to=/teacher
  A scholar's view:       http://localhost:$WEB_PORT/dev-login?u=leilani_park&to=/scholar
  A parent's view:        http://localhost:$WEB_PORT/dev-login?u=parent_park&to=/parent

  Stop:                   bin/stop.sh      Start again: bin/setup.sh
  Logs:                   rabbithole/local/.run/convex.log and next.log
EOF
  # Not grep -q: under pipefail its early exit would fail the pipeline.
  if app_run status 2>/dev/null | grep 'Tutor key: *not set' >/dev/null; then
    say "  Let the tutor answer:   bin/set-key.sh   (opens Rabbithole's page for an Anthropic key)"
  fi
}

if pid_alive next && pid_alive convex; then
  say "Rabbithole is already running."
  ready
  exit 0
fi

REPO="$(lock repo)"
COMMIT="$(lock commit)"

printf '\n[drink-me] Check out Rabbithole %s from %s\n' "${COMMIT:0:7}" "$REPO"
if [ ! -d "$APP/.git" ]; then
  git init -q "$APP"
  git -C "$APP" remote add origin "$REPO"
fi
if [ "$(git -C "$APP" rev-parse HEAD 2>/dev/null || true)" != "$COMMIT" ]; then
  stop_all # an older snapshot may still be running
  git -C "$APP" fetch -q --depth 1 origin "$COMMIT"
  git -C "$APP" checkout -q --force --detach FETCH_HEAD
fi
[ "$(git -C "$APP" rev-parse HEAD)" = "$COMMIT" ] || die "the checkout isn't at the pinned commit $COMMIT"
guard_no_cloud

# The snapshot's own runner does the rest. Its closing summary names its own
# pnpm commands, so the kit prints its own instead.
app_run setup "$@" | awk '/\] READY$/ { done = 1 } !done { print; fflush() }' ||
  die "setup stopped early. Its logs are in rabbithole/local/.run/; read the one named above, fix the cause, and run bin/setup.sh again."

[ "${1:-}" = "--no-serve" ] && { say ""; say "Set up. Start it with: bin/setup.sh"; exit 0; }
printf '\n[drink-me] READY\n'
ready
