#!/usr/bin/env bash
# Run Rabbithole from this checkout on this computer, with no accounts: install
# the web app's packages, start a local Convex backend (no cloud), add sign-in
# keys, seed a fictional school, and start the web app in the background. Safe
# to run again: it reuses what's there and picks up where it stopped.
#
#   pnpm local:setup             set up and start; returns once the app is ready
#   pnpm local:setup --no-serve  set up, then stop the backend (for CI)
#   pnpm local:setup --no-summary  print nothing after the READY line (for
#                                  scripts that wrap this one)
#
# A run leaves the checkout as it found it: everything it writes is in
# local/.run/, .convex/, .env.local, next-env.d.ts, or .next/, all ignored by git.
#
# Ports: CLOUD_PORT=3210 SITE_PORT=3211 WEB_PORT=3000 (override any of them).
set -euo pipefail
. "$(dirname "$0")/lib.sh"

SERVE=1
SUMMARY=1
for arg in "$@"; do
  case "$arg" in
    --no-serve) SERVE=0 ;;
    --no-summary) SUMMARY=0 ;;
    *) die "unknown option $arg (expected --no-serve or --no-summary)" ;;
  esac
done

step() { printf '\n[local %4ss] %s\n' "$SECONDS" "$*"; }
# Run a command silently, showing its output only if it fails. The Convex CLI
# reports success on stderr, so redirecting stdout alone isn't enough.
quiet() {
  local out
  out="$("$@" 2>&1)" || { printf '%s\n' "$out" >&2; return 1; }
}

guard_no_cloud
mkdir -p "$STATE"
cd "$ROOT"

if pid_alive next && pid_alive convex; then
  say "Rabbithole is already running. Stop it with pnpm local:stop, or open:"
  say "  http://localhost:$WEB_PORT/dev-login"
  exit 0
fi
stop_all
for p in "$CLOUD_PORT" "$SITE_PORT" "$WEB_PORT"; do
  if ! wait_port_free "$p"; then
    die "port $p is already in use by another program.
  Stop it, or choose free ports, for example:
    CLOUD_PORT=3310 SITE_PORT=3311 WEB_PORT=3100 pnpm local:setup"
  fi
done

if [ -d node_modules ]; then
  step "1/5  Check the web app's packages"
else
  step "1/5  Install the web app's packages (about 1 GB; the first time can take several minutes)"
fi
# --filter skips the iPad app's packages, which the web app doesn't need.
if ! pnpm install --frozen-lockfile --filter rabbithole >"$STATE/install.log" 2>&1; then
  tail -n 20 "$STATE/install.log" >&2
  die "installing packages failed. The full log is in local/.run/install.log"
fi
# pnpm ends its output with a blank line; show its last real one.
say "  $(grep -v '^[[:space:]]*$' "$STATE/install.log" | tail -n 1)"

start_backend() {
  : >"$STATE/convex.log"
  # Typechecking adds about 90 seconds and isn't needed to run the app;
  # `pnpm typecheck` is the check for that. Codegen is off because the checkout
  # already has convex/_generated/, and regenerating it would change tracked
  # files.
  #
  # The backend listens on every network interface, not just this computer:
  # the Convex CLI starts it without --interface and has no option to pass one
  # (TRA-526). The web app, which holds the password-less /dev-login page, is
  # loopback-only (step 5).
  nohup npx convex dev --local-cloud-port "$CLOUD_PORT" --local-site-port "$SITE_PORT" \
    --typecheck disable --codegen disable </dev/null >>"$STATE/convex.log" 2>&1 &
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

step "2/5  Start the local Convex backend and load Rabbithole's functions"
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
    die "the local backend didn't start. The full log is in local/.run/convex.log"
  }
fi
guard_no_cloud
say "  functions loaded"

step "3/5  Sign-in keys and local settings"
node local/auth-keys.mjs
quiet npx convex env set SITE_URL "http://localhost:$WEB_PORT"
quiet npx convex env set RABBITHOLE_ALLOW_DEV_LOGIN true
quiet npx convex env set RABBITHOLE_ALLOW_DEV_FIXTURES true
if ! grep -q '^NEXT_PUBLIC_DEV_LOGIN_SECRET=' .env.local; then
  secret="$(openssl rand -hex 16)"
  printf %s "$secret" | quiet npx convex env set DEV_TEST_LOGIN_SECRET
  printf 'NEXT_PUBLIC_DEV_LOGIN_SECRET=%s\n' "$secret" >>.env.local
  unset secret
fi
# Rewritten every run so a changed WEB_PORT takes effect.
grep -v '^NEXT_PUBLIC_SITE_URL=' .env.local >"$STATE/env.tmp" || true
printf 'NEXT_PUBLIC_SITE_URL=http://localhost:%s\n' "$WEB_PORT" >>"$STATE/env.tmp"
cat "$STATE/env.tmp" >.env.local
rm -f "$STATE/env.tmp"
say "  done"

step "4/5  Seed the fictional school"
if dev_users | grep -q '"kawena"'; then
  say "  already seeded; keeping the school as it is"
else
  failed=0
  run() {
    local t0=$SECONDS out
    if out=$(npx convex run "$1" 2>&1); then
      printf '  ok    %3ss  %s\n' $((SECONDS - t0)) "$1"
    else
      printf '  FAIL  %3ss  %s\n' $((SECONDS - t0)) "$1"
      printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n 3 | sed 's/^/          /'
      failed=$((failed + 1))
    fi
  }
  # Not run: practiceGen:prewarmConceptualItems, which needs an Anthropic key.
  for fn in \
    seedData:seedAll \
    onboarding:seedOnboarding \
    standardsImport:importCommonCoreMath \
    standardsImport:importCommonCoreELA \
    standardsImport:importNGSS \
    standardsImport:importUCLAHistoricalThinking \
    knowledgeNodes:rebuild \
    seed/stretchItems:seedStretchItems \
    practiceSkills:seedDefaultManipulativePractice \
    instruction:seedAuthoredInstruction \
    knowledgeNodes:rebuildTree \
    externalApps:seedPressReader \
    seedRichCohort:seedAll \
    seedBadgeArt:attach \
    seedRoboticsMedia:attach \
    seed/institutions:seedDevInstitutions \
    seed/devPersonas:seedDevPersonas \
    seed/physicalEnvironment:seedDevPhysicalEnvironment \
    scholarApps:seedPressReaderForAllScholars \
    practiceSkills:seedFadedWorkedExamples; do
    run "$fn"
  done
  if [ "$failed" -eq 0 ]; then say "  seeded"
  else say "  $failed seed step(s) failed; the app still works, minus that data"; fi
fi

if [ "$SERVE" -eq 0 ]; then
  stop_all
  step "Set up. Start it with: pnpm local:setup"
  exit 0
fi

step "5/5  Start the web app on port $WEB_PORT"
: >"$STATE/next.log"
# When next dev thinks an AI coding agent is running it, it writes a Next.js
# block into AGENTS.md (or CLAUDE.md), which would change tracked files. Keep
# copies and put them back once the server is up.
for f in AGENTS.md CLAUDE.md; do
  rm -f "$STATE/$f.orig" "$STATE/$f.absent"
  if [ -e "$f" ]; then cp "$f" "$STATE/$f.orig"; else : >"$STATE/$f.absent"; fi
done
restore_agent_files() {
  local f
  for f in AGENTS.md CLAUDE.md; do
    if [ -f "$STATE/$f.orig" ]; then
      cmp -s "$STATE/$f.orig" "$f" || cat "$STATE/$f.orig" >"$f"
    elif [ -f "$STATE/$f.absent" ]; then
      rm -f "$f"
    fi
    rm -f "$STATE/$f.orig" "$STATE/$f.absent"
  done
}
# Loopback only: /dev-login signs anyone in without a password, so the web app
# must not be reachable from other machines on the network.
nohup ./node_modules/.bin/next dev -H 127.0.0.1 -p "$WEB_PORT" </dev/null >>"$STATE/next.log" 2>&1 &
echo $! >"$STATE/next.pid"
for i in $(seq 1 120); do
  grep -q "Ready in" "$STATE/next.log" && break
  pid_alive next || { tail -n 20 "$STATE/next.log" >&2; die "the web app didn't start. The log is in local/.run/next.log"; }
  sleep 1
done
# Compile the sign-in page now, and the main pages in the background, so the
# first clicks don't wait 10-15 seconds each for the dev server to build them.
curl -s -o /dev/null --max-time 120 "http://localhost:$WEB_PORT/dev-login" || true
# next dev answers a request only after it has written the agent files, so
# they are final by now.
restore_agent_files
(for p in /teacher /scholar /parent; do curl -s -o /dev/null --max-time 120 "http://localhost:$WEB_PORT$p"; done) >/dev/null 2>&1 &

step "READY"
[ "$SUMMARY" -eq 1 ] || exit 0
cat <<EOF

  Rabbithole is running on this computer, with a fictional school.

  Pick a person:      http://localhost:$WEB_PORT/dev-login
  A teacher's view:   http://localhost:$WEB_PORT/dev-login?u=kawena&to=/teacher
  A scholar's view:   http://localhost:$WEB_PORT/dev-login?u=leilani_park&to=/scholar
  A parent's view:    http://localhost:$WEB_PORT/dev-login?u=parent_park&to=/parent

  The tutor answers once the local backend has an Anthropic key (it asks for it):
                      CONVEX_AGENT_MODE=anonymous npx convex env set ANTHROPIC_API_KEY
  Status:             pnpm local:status
  Stop:               pnpm local:stop      Start again: pnpm local:setup
  Logs:               local/.run/convex.log and local/.run/next.log
EOF
