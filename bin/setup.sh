#!/usr/bin/env bash
# Set up Rabbithole on this computer from the pinned public snapshot:
# check out the snapshot, install the web app's packages, start a local Convex
# backend (no account, no cloud), add sign-in keys, seed a fictional school,
# and start the web app in the background. Safe to run again: it reuses what's
# there and picks up where it stopped.
#
#   bin/setup.sh             set up and start; returns once Rabbithole is ready
#   bin/setup.sh --no-serve  set up, then stop the backend (used by CI)
#
# Ports: CLOUD_PORT=3210 SITE_PORT=3211 WEB_PORT=3000 (override any of them).
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"

SERVE=1
[ "${1:-}" = "--no-serve" ] && SERVE=0

step() { printf '\n[drink-me %4ss] %s\n' "$SECONDS" "$*"; }

guard_not_nested
guard_no_cloud
mkdir -p "$STATE"

if pid_alive next && pid_alive convex; then
  say "Rabbithole is already running. Stop it with bin/stop.sh, or open:"
  say "  http://localhost:$WEB_PORT/dev-login"
  exit 0
fi
stop_all
for p in "$CLOUD_PORT" "$SITE_PORT" "$WEB_PORT"; do
  if ! wait_port_free "$p"; then
    die "port $p is already in use by another program.
  Stop it, or choose free ports, for example:
    CLOUD_PORT=3310 SITE_PORT=3311 WEB_PORT=3100 bin/setup.sh"
  fi
done

REPO="$(lock repo)"
COMMIT="$(lock commit)"

step "1/6  Check out Rabbithole ${COMMIT:0:7} from $REPO"
if [ ! -d "$APP/.git" ]; then
  git init -q "$APP"
  git -C "$APP" remote add origin "$REPO"
fi
if [ "$(git -C "$APP" rev-parse HEAD 2>/dev/null || true)" != "$COMMIT" ]; then
  git -C "$APP" fetch -q --depth 1 origin "$COMMIT"
  git -C "$APP" checkout -q --detach FETCH_HEAD
fi
[ "$(git -C "$APP" rev-parse HEAD)" = "$COMMIT" ] || die "the checkout isn't at the pinned commit $COMMIT"
cd "$APP"

if [ -d node_modules ]; then
  step "2/6  Check the web app's packages"
else
  step "2/6  Install the web app's packages (about 1 GB; this first time can take several minutes)"
fi
# --filter skips the iPad app's packages, which a web-only trial doesn't need.
if ! pnpm install --frozen-lockfile --filter rabbithole >"$STATE/install.log" 2>&1; then
  tail -n 20 "$STATE/install.log" >&2
  die "installing packages failed. The full log is in .kit/install.log"
fi
tail -n 1 "$STATE/install.log"

step "3/6  Add the kit's two small files to the checkout"
for f in "$KIT"/overlay/convex/*.ts; do
  name="$(basename "$f")"
  if git ls-files --error-unmatch "convex/$name" >/dev/null 2>&1; then
    say "  the snapshot now ships convex/$name itself; using its version"
  else
    cp "$f" "convex/$name"
    say "  convex/$name"
  fi
done

start_backend() {
  : >"$STATE/convex.log"
  # Typechecking the snapshot adds about 90 seconds and catches nothing here:
  # the published snapshot already passed its own typecheck.
  nohup npx convex dev --local-cloud-port "$CLOUD_PORT" --local-site-port "$SITE_PORT" \
    --typecheck disable </dev/null >>"$STATE/convex.log" 2>&1 &
  echo $! >"$STATE/convex.pid"
}
backend_ready() {
  local i
  for i in $(seq 1 300); do
    grep -q "Convex functions ready" "$STATE/convex.log" && return 0
    pid_alive convex || return 1
    grep -qE "✖|Unable to start push" "$STATE/convex.log" && return 1
    sleep 1
  done
  return 1
}

step "4/6  Start the local Convex backend and load Rabbithole's functions"
set -m # each background job gets its own process group, so stop_all can end it cleanly
start_backend
if ! backend_ready; then
  # Known hiccup: the Convex CLI can crash right after its first backend
  # download and leave the backend holding the port. One clean retry fixes it.
  say "  the backend didn't come up; retrying once"
  stop_all
  wait_port_free "$CLOUD_PORT" || true
  start_backend
  backend_ready || {
    say ""
    tail -n 15 "$STATE/convex.log" >&2
    die "the local backend didn't start. The full log is in .kit/convex.log"
  }
fi
guard_no_cloud
say "  functions loaded"

step "5/6  Sign-in keys and local settings"
node "$KIT/lib/auth-keys.mjs" "$APP"
npx convex env set SITE_URL "http://localhost:$WEB_PORT" >/dev/null
npx convex env set RABBITHOLE_ALLOW_DEV_LOGIN true >/dev/null
npx convex env set RABBITHOLE_ALLOW_DEV_FIXTURES true >/dev/null
if ! grep -q '^NEXT_PUBLIC_DEV_LOGIN_SECRET=' .env.local; then
  secret="$(openssl rand -hex 16)"
  printf %s "$secret" | npx convex env set DEV_TEST_LOGIN_SECRET >/dev/null
  printf 'NEXT_PUBLIC_DEV_LOGIN_SECRET=%s\n' "$secret" >>.env.local
  unset secret
fi
grep -q '^NEXT_PUBLIC_SITE_URL=' .env.local ||
  printf 'NEXT_PUBLIC_SITE_URL=http://localhost:%s\n' "$WEB_PORT" >>.env.local
say "  done"

step "6/6  Seed the fictional school"
if dev_users | grep -q '"kawena"'; then
  say "  already seeded; keeping your pretend school as it is"
else
  bash "$KIT/lib/seed.sh" "$APP"
fi

if [ "$SERVE" -eq 0 ]; then
  stop_all
  step "Set up. Start it with: bin/setup.sh"
  exit 0
fi

step "Start the web app on port $WEB_PORT"
: >"$STATE/next.log"
nohup ./node_modules/.bin/next dev -p "$WEB_PORT" </dev/null >>"$STATE/next.log" 2>&1 &
echo $! >"$STATE/next.pid"
for i in $(seq 1 120); do
  grep -q "Ready in" "$STATE/next.log" && break
  pid_alive next || { tail -n 20 "$STATE/next.log" >&2; die "the web app didn't start. The log is in .kit/next.log"; }
  sleep 1
done
# Compile the sign-in page now, and the main pages in the background, so the
# first clicks don't wait 10-15 seconds each for the dev server to build them.
curl -s -o /dev/null --max-time 120 "http://localhost:$WEB_PORT/dev-login" || true
(for p in /teacher /scholar /parent; do curl -s -o /dev/null --max-time 120 "http://localhost:$WEB_PORT$p"; done) >/dev/null 2>&1 &

step "READY"
cat <<EOF

  Rabbithole is running on this computer, with a pretend school.

  Pick a pretend person:  http://localhost:$WEB_PORT/dev-login
  A teacher's view:       http://localhost:$WEB_PORT/dev-login?u=kawena&to=/teacher
  A scholar's view:       http://localhost:$WEB_PORT/dev-login?u=leilani_park&to=/scholar
  A parent's view:        http://localhost:$WEB_PORT/dev-login?u=parent_park&to=/parent

  Let the tutor answer:   bin/set-key.sh   (run it yourself; it asks for an Anthropic key)
  Stop:                   bin/stop.sh      Start again: bin/setup.sh
  Logs:                   .kit/convex.log and .kit/next.log
EOF
